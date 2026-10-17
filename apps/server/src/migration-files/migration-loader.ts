import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, type Dirent } from 'node:fs';
import { basename, join } from 'node:path';

import { describeFileSystemError } from '../shared/file-system-error-message';
import type { Migration } from './migration';
import { MigrationFilesError, MigrationNameError } from './migration-files.error';

const MIGRATION_FILE_PATTERN = /^(\d{1,14})_([A-Za-z0-9][A-Za-z0-9_]*)\.(up|down)\.sql$/;
const NEW_MIGRATION_NAME_PATTERN = /^[a-z][a-z0-9_]{0,60}$/;
const NO_TRANSACTION_DIRECTIVE = 'migrate:no-transaction';
const IRREVERSIBLE_DIRECTIVE = 'migrate:irreversible';
/** Versions at or above this are timestamps rather than sequence numbers. */
const FIRST_TIMESTAMP_VERSION = 100_000;

function readDirectory(directory: string): Dirent[] {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    throw new MigrationFilesError(
      `read migrations directory: ${describeFileSystemError(error, 'open', directory)}`,
    );
  }
}

function compareByteOrder(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

/** Reads and validates every migration in a directory, sorted by version. */
export function loadMigrations(directory: string): Migration[] {
  const entries = readDirectory(directory).sort((left, right) => compareByteOrder(left.name, right.name));
  const migrationsByVersion = new Map<number, Migration>();
  for (const entry of entries) {
    if (entry.isDirectory() || !entry.name.endsWith('.sql')) {
      continue;
    }
    const match = MIGRATION_FILE_PATTERN.exec(entry.name);
    if (match === null) {
      throw new MigrationFilesError(`${entry.name}: file name must look like 0001_create_users.up.sql`);
    }
    const [, versionText = '', name = '', direction] = match;
    const version = Number.parseInt(versionText, 10);
    const path = join(directory, entry.name);
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (error) {
      throw new MigrationFilesError(describeFileSystemError(error, 'open', path));
    }
    const text = normalizeNewlines(raw);
    let migration = migrationsByVersion.get(version);
    if (migration === undefined) {
      migration = {
        version,
        name,
        upSql: '',
        downSql: '',
        upPath: '',
        checksum: '',
        isNonTransactional: false,
        isDownNonTransactional: false,
        hasDown: false,
        isIrreversible: false,
      };
      migrationsByVersion.set(version, migration);
    } else if (migration.name !== name) {
      throw new MigrationFilesError(
        `version ${version} has two different names: "${migration.name}" and "${name}"`,
      );
    }
    if (direction === 'up') {
      if (migration.upPath !== '') {
        throw new MigrationFilesError(`version ${version} has two up files`);
      }
      migration.upSql = text;
      migration.upPath = path;
      migration.isNonTransactional = hasNoTransactionDirective(text);
      migration.checksum = computeMigrationChecksum(text);
    } else {
      migration.downSql = text;
      migration.downPath = path;
      migration.isDownNonTransactional = hasNoTransactionDirective(text);
      migration.hasDown = stripLineComments(text).trim() !== '';
      migration.isIrreversible = !migration.hasDown && text.includes(IRREVERSIBLE_DIRECTIVE);
    }
  }
  const migrations: Migration[] = [];
  for (const migration of migrationsByVersion.values()) {
    if (migration.upPath === '') {
      throw new MigrationFilesError(
        `version ${migration.version} (${migration.name}) has a down file but no up file`,
      );
    }
    if (stripLineComments(migration.upSql).trim() === '') {
      throw new MigrationFilesError(`${basename(migration.upPath)} is empty`);
    }
    migrations.push(migration);
  }
  return migrations.sort((left, right) => left.version - right.version);
}

export function normalizeNewlines(text: string): string {
  return text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

/**
 * Ignores line-ending style and trailing blank lines, so a Windows checkout does not look
 * like an edited migration.
 */
export function computeMigrationChecksum(text: string): string {
  const trimmed = text.replace(/[ \t\n]+$/, '');
  return createHash('sha256').update(`${trimmed}\n`, 'utf8').digest('hex');
}

/** Directives are only honoured in the leading comment block. */
export function hasNoTransactionDirective(text: string): boolean {
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '') {
      continue;
    }
    if (!line.startsWith('--')) {
      return false;
    }
    if (line.includes(NO_TRANSACTION_DIRECTIVE)) {
      return true;
    }
  }
  return false;
}

function stripLineComments(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const commentStart = line.indexOf('--');
      return (commentStart >= 0 ? line.slice(0, commentStart) : line) + '\n';
    })
    .join('');
}

export function findMigrationByVersion(
  migrations: readonly Migration[],
  version: number,
): Migration | undefined {
  return migrations.find((migration) => migration.version === version);
}

function formatUtcTimestamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    String(now.getUTCFullYear()).padStart(4, '0') +
    pad(now.getUTCMonth() + 1) +
    pad(now.getUTCDate()) +
    pad(now.getUTCHours()) +
    pad(now.getUTCMinutes()) +
    pad(now.getUTCSeconds())
  );
}

/**
 * Picks the version for a new migration. Sequential directories (all versions below
 * 100000) get max+1; anything else gets a UTC timestamp.
 */
export function chooseNextVersion(migrations: readonly Migration[], now: Date): number {
  if (migrations.length === 0) {
    return 1;
  }
  const highestVersion = Math.max(...migrations.map((migration) => migration.version));
  const isSequential = migrations.every((migration) => migration.version < FIRST_TIMESTAMP_VERSION);
  if (isSequential) {
    return highestVersion + 1;
  }
  return Number.parseInt(formatUtcTimestamp(now), 10);
}

/** Formats a version like Go's `%0Nd`. */
export function formatVersion(version: number, width = 4): string {
  if (version < 0) {
    return `-${String(-version).padStart(width - 1, '0')}`;
  }
  return String(version).padStart(width, '0');
}

export interface CreatedMigrationFiles {
  upPath: string;
  downPath: string;
}

/** Writes an empty up/down pair for a new migration and returns the paths. */
export function createMigrationFiles(directory: string, requestedName: string, now: Date): CreatedMigrationFiles {
  const name = requestedName.trim().replaceAll(' ', '_').toLowerCase();
  if (!NEW_MIGRATION_NAME_PATTERN.test(name)) {
    throw new MigrationNameError(
      'name must be lower case letters, digits and underscores, starting with a letter',
    );
  }
  try {
    mkdirSync(directory, { recursive: true, mode: 0o755 });
  } catch (error) {
    throw new MigrationFilesError(describeFileSystemError(error, 'mkdir', directory));
  }
  const version = chooseNextVersion(loadMigrations(directory), now);
  const width = version >= FIRST_TIMESTAMP_VERSION ? 14 : 4;
  const baseName = `${formatVersion(version, width)}_${name}`;
  const upPath = join(directory, `${baseName}.up.sql`);
  const downPath = join(directory, `${baseName}.down.sql`);
  writeFileSync(upPath, '-- Write the change here.\n', { mode: 0o644 });
  writeFileSync(downPath, '-- Write how to undo it here.\n', { mode: 0o644 });
  return { upPath, downPath };
}
