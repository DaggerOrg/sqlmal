import type { LintFinding } from '@sqlmal/contracts';

import type { Migration } from '../migration-files/migration';
import { countLintFindings, lintMigration } from './lint-rules';

function buildMigration(overrides: Partial<Migration>): Migration {
  return {
    version: 1,
    name: 't',
    upSql: '',
    downSql: '',
    upPath: '0001_t.up.sql',
    checksum: '',
    isNonTransactional: false,
    isDownNonTransactional: false,
    hasDown: false,
    isIrreversible: false,
    ...overrides,
  };
}

function buildUpOnly(upSql: string): Migration {
  return buildMigration({ upSql, hasDown: true, downSql: 'SELECT 1;' });
}

function countByRule(findings: readonly LintFinding[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const finding of findings) {
    counts[finding.ruleId] = (counts[finding.ruleId] ?? 0) + 1;
  }
  return counts;
}

describe('lintMigration', () => {
  it.each([
    ['drop table', 'DROP TABLE orders;', 'L001'],
    ['drop column', 'ALTER TABLE users DROP COLUMN legacy;', 'L001'],
    ['type change', 'ALTER TABLE users ALTER COLUMN age TYPE bigint;', 'L002'],
    ['type change long form', 'alter table users alter column age set data type bigint;', 'L002'],
    ['not null no default', 'ALTER TABLE users ADD COLUMN email text NOT NULL;', 'L003'],
    ['set not null', 'ALTER TABLE users ALTER COLUMN email SET NOT NULL;', 'L010'],
    ['index without concurrently', 'CREATE INDEX idx_u ON users (email);', 'L004'],
    ['unique index', 'CREATE UNIQUE INDEX idx_u ON users (email);', 'L004'],
    ['fk without not valid', 'ALTER TABLE orders ADD CONSTRAINT fk FOREIGN KEY (user_id) REFERENCES users(id);', 'L005'],
    ['truncate', 'TRUNCATE users;', 'L006'],
    ['delete all', 'DELETE FROM users;', 'L006'],
    ['update all', 'UPDATE users SET active = false;', 'L006'],
    ['rename column', 'ALTER TABLE users RENAME COLUMN a TO b;', 'L008'],
    ['concurrently in a transaction', 'CREATE INDEX CONCURRENTLY idx ON users (email);', 'L009'],
  ])('fires on %s', (_label, sql, ruleId) => {
    expect(countByRule(lintMigration(buildUpOnly(sql)))[ruleId]).toBeGreaterThan(0);
  });

  it.each([
    'CREATE TABLE users (id serial PRIMARY KEY, email text NOT NULL);',
    'ALTER TABLE users ADD COLUMN age int;',
    'ALTER TABLE users ADD COLUMN active boolean NOT NULL DEFAULT true;',
    'ALTER TABLE users ADD COLUMN id2 serial NOT NULL;',
    'ALTER TABLE orders ADD CONSTRAINT fk FOREIGN KEY (user_id) REFERENCES users(id) NOT VALID;',
    'DELETE FROM users WHERE id = 1;',
    'UPDATE users SET active = false WHERE id = 1;',
    "INSERT INTO log (msg) VALUES ('DROP TABLE users; TRUNCATE x;');",
    '-- DROP TABLE users;\nSELECT 1;',
    '/* TRUNCATE users */ SELECT 1;',
  ])('stays silent on %p', (sql) => {
    expect(lintMigration(buildUpOnly(sql))).toEqual([]);
  });

  it('accepts CONCURRENTLY with the no-transaction directive', () => {
    const migration = {
      ...buildUpOnly('CREATE INDEX CONCURRENTLY idx ON users (email);'),
      isNonTransactional: true,
    };
    expect(lintMigration(migration)).toEqual([]);
  });

  it('does not flag statements on a table created in the same file', () => {
    const sql = `CREATE TABLE orders (id serial PRIMARY KEY, user_id int);
CREATE INDEX idx_orders_user ON orders (user_id);
ALTER TABLE orders ADD COLUMN note text NOT NULL;
ALTER TABLE orders ADD CONSTRAINT fk FOREIGN KEY (user_id) REFERENCES users(id);`;
    expect(lintMigration(buildUpOnly(sql))).toEqual([]);
  });

  it('reports a missing down and orders findings by file then line', () => {
    const findings = lintMigration(buildMigration({ upSql: 'DROP TABLE a;\nTRUNCATE b;' }));
    expect(countByRule(findings)['L007']).toBe(1);
    expect(findings[0]!.file).toBe('up');
    expect(findings[0]!.line).toBeLessThanOrEqual(findings[1]!.line);
    expect(countLintFindings(findings)).toEqual({ errorCount: 0, warningCount: 3, infoCount: 0 });
  });

  it('reports the line of the statement', () => {
    expect(lintMigration(buildUpOnly('-- header\n\nSELECT 1;\nDROP TABLE x;'))[0]!.line).toBe(4);
  });

  it('expects drops in a down file and treats one-way migrations as a decision', () => {
    const normal = buildMigration({ upSql: 'CREATE TABLE a (id int);', downSql: 'DROP TABLE a;', hasDown: true });
    expect(lintMigration(normal)).toEqual([]);
    const oneWay = buildMigration({
      upSql: "ALTER TYPE s ADD VALUE 'x';",
      downSql: '-- migrate:irreversible\n',
      isIrreversible: true,
    });
    expect(lintMigration(oneWay)).toEqual([]);
    const forgotten = buildMigration({ upSql: "ALTER TYPE s ADD VALUE 'x';" });
    expect(countByRule(lintMigration(forgotten))['L007']).toBe(1);
  });
});
