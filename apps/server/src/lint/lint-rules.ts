import type { LintFinding, LintSeverity, MigrationDirection } from '@sqlmal/contracts';

import type { Migration } from '../migration-files/migration';
import { normalizeStatement, splitSqlStatements } from '../sql/sql-splitter';

/**
 * Finds migration statements that are risky on a live database. It works on the statement
 * text, not a full SQL parser, so every rule is conservative: it names the pattern it saw
 * and why that is risky.
 */

const CREATE_TABLE_PATTERN = /^CREATE (?:UNLOGGED |TEMP(?:ORARY)? )?TABLE (?:IF NOT EXISTS )?([^ (]+)/;
const ALTER_TABLE_PATTERN = /^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?([^ ]+)/;
const CREATE_INDEX_PATTERN =
  /^CREATE (?:UNIQUE )?INDEX (CONCURRENTLY )?(?:IF NOT EXISTS )?(?:[^ ]+ )?ON (?:ONLY )?([^ (]+)/;
const ADD_COLUMN_PATTERN = /\bADD (?:COLUMN )?(?:IF NOT EXISTS )?("?[A-Z_][A-Z0-9_$]*"?) ([^,]*)/g;
const ALTER_COLUMN_TYPE_PATTERN = / ALTER (?:COLUMN )?\S+ TYPE /;

function trimQuotes(name: string): string {
  return name.replace(/^"+|"+$/g, '');
}

/** Lints one migration's up and down files, ordered by file (up first) then line. */
export function lintMigration(migration: Migration): LintFinding[] {
  const findings: LintFinding[] = lintFile('up', migration.upSql, migration.isNonTransactional);
  if (migration.hasDown) {
    findings.push(...lintFile('down', migration.downSql, migration.isDownNonTransactional));
  } else if (!migration.isIrreversible) {
    findings.push({
      ruleId: 'L007',
      severity: 'warning',
      file: 'down',
      line: 1,
      message: 'There is no down migration, so this change cannot be rolled back.',
      hint: "Write the reverse of the up file, or put '-- migrate:irreversible' in the down file to say it is one-way on purpose.",
    });
  }
  return findings.sort((left, right) => {
    if (left.file !== right.file) {
      return left.file === 'up' ? -1 : 1;
    }
    return left.line - right.line;
  });
}

function lintFile(file: MigrationDirection, sql: string, isNonTransactional: boolean): LintFinding[] {
  const findings: LintFinding[] = [];
  const addFinding = (ruleId: string, severity: LintSeverity, line: number, message: string, hint: string): void => {
    findings.push({ ruleId, severity, file, line, message, hint });
  };
  // Tables created earlier in this same file are empty, so most lock risks do not apply.
  const createdTables = new Set<string>();
  for (const statement of splitSqlStatements(sql)) {
    const normalized = normalizeStatement(statement.sql);
    const line = statement.line;
    const createTable = CREATE_TABLE_PATTERN.exec(normalized);
    if (createTable !== null) {
      createdTables.add(trimQuotes(createTable[1] ?? ''));
    }
    const alterTable = ALTER_TABLE_PATTERN.exec(normalized);
    const tableName = alterTable === null ? '' : trimQuotes(alterTable[1] ?? '');
    const isAlter = alterTable !== null;
    const isFreshTable = createdTables.has(tableName);

    // A down file is expected to drop what its up created, so L001 is for up files only.
    const isDataLossChecked = file === 'up';
    if (isDataLossChecked && normalized.startsWith('DROP TABLE')) {
      addFinding(
        'L001',
        'warning',
        line,
        'DROP TABLE permanently deletes the table and its data.',
        'Make sure a backup exists and nothing still reads this table. Consider renaming it first and dropping it in a later release.',
      );
    }
    if (isDataLossChecked && isAlter && normalized.includes(' DROP COLUMN ')) {
      addFinding(
        'L001',
        'warning',
        line,
        "DROP COLUMN permanently deletes the column's data and breaks code that still reads it.",
        'Deploy code that stops using the column first, then drop it.',
      );
    }
    const isTypeChange =
      normalized.includes(' SET DATA TYPE ') || ALTER_COLUMN_TYPE_PATTERN.test(normalized);
    if (isAlter && isTypeChange && !isFreshTable) {
      addFinding(
        'L002',
        'warning',
        line,
        "Changing a column's type can rewrite the whole table while holding a lock that blocks reads and writes.",
        'Add a new column, backfill in batches, then swap. Some widenings (for example varchar to text) do not rewrite.',
      );
    }
    if (isAlter && !isFreshTable) {
      for (const addColumn of normalized.matchAll(ADD_COLUMN_PATTERN)) {
        const columnName = addColumn[1] ?? '';
        const definition = addColumn[2] ?? '';
        if (
          definition.includes('NOT NULL') &&
          !definition.includes('DEFAULT') &&
          !definition.includes('GENERATED') &&
          !definition.includes('SERIAL')
        ) {
          addFinding(
            'L003',
            'error',
            line,
            `Adding NOT NULL column ${columnName.toLowerCase()} with no default fails when the table already has rows.`,
            'Add the column as nullable (or with a DEFAULT), backfill, then SET NOT NULL.',
          );
        }
      }
      if (normalized.includes(' SET NOT NULL')) {
        addFinding(
          'L010',
          'warning',
          line,
          'SET NOT NULL scans the whole table while holding a lock.',
          'On large tables add a CHECK (col IS NOT NULL) NOT VALID, validate it, then SET NOT NULL.',
        );
      }
      if (normalized.includes('FOREIGN KEY') && !normalized.includes('NOT VALID')) {
        addFinding(
          'L005',
          'warning',
          line,
          'Adding a foreign key validates every existing row while holding a lock.',
          'Add it NOT VALID, then run ALTER TABLE ... VALIDATE CONSTRAINT in a separate step.',
        );
      }
    }
    const createIndex = CREATE_INDEX_PATTERN.exec(normalized);
    if (createIndex !== null) {
      const isConcurrent = (createIndex[1] ?? '') !== '';
      if (!isConcurrent && !createdTables.has(trimQuotes(createIndex[2] ?? ''))) {
        addFinding(
          'L004',
          'warning',
          line,
          'CREATE INDEX without CONCURRENTLY blocks writes to the table until it finishes.',
          "Use CREATE INDEX CONCURRENTLY and put '-- migrate:no-transaction' at the top of the file.",
        );
      }
      if (isConcurrent && !isNonTransactional) {
        addFinding(
          'L009',
          'error',
          line,
          'CREATE INDEX CONCURRENTLY cannot run inside a transaction, so this migration will fail.',
          "Add '-- migrate:no-transaction' as the first line of this file.",
        );
      }
    }
    if (normalized.startsWith('TRUNCATE')) {
      addFinding(
        'L006',
        'warning',
        line,
        'TRUNCATE removes every row in the table.',
        'Confirm this is a development or reference table.',
      );
    }
    if (
      (normalized.startsWith('DELETE FROM') || normalized.startsWith('UPDATE ')) &&
      !normalized.includes(' WHERE ')
    ) {
      const verb = normalized.split(' ')[0] ?? '';
      addFinding(
        'L006',
        'warning',
        line,
        `${verb} with no WHERE clause changes every row.`,
        'Add a WHERE clause, or confirm this is intentional.',
      );
    }
    const isRename =
      (isAlter && (normalized.includes(' RENAME COLUMN ') || normalized.includes(' RENAME TO '))) ||
      (normalized.startsWith('ALTER TABLE') && normalized.includes(' RENAME '));
    if (isRename) {
      addFinding(
        'L008',
        'info',
        line,
        'Renaming breaks any running code that uses the old name.',
        'Deploy a compatibility view or column first, or accept brief downtime.',
      );
    }
  }
  return findings;
}

export interface LintFindingCounts {
  errorCount: number;
  warningCount: number;
  infoCount: number;
}

/** Summarises findings by severity. */
export function countLintFindings(findings: readonly LintFinding[]): LintFindingCounts {
  const counts: LintFindingCounts = { errorCount: 0, warningCount: 0, infoCount: 0 };
  for (const finding of findings) {
    if (finding.severity === 'error') {
      counts.errorCount++;
    } else if (finding.severity === 'warning') {
      counts.warningCount++;
    } else {
      counts.infoCount++;
    }
  }
  return counts;
}
