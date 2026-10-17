import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  computeMigrationChecksum,
  createMigrationFiles,
  hasNoTransactionDirective,
  loadMigrations,
  normalizeNewlines,
} from './migration-loader';

function createDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'sqlmal-migrations-'));
}

function writeFile(directory: string, name: string, body: string): void {
  writeFileSync(join(directory, name), body);
}

describe('loadMigrations', () => {
  it('sorts by version and pairs up and down files', () => {
    const directory = createDirectory();
    writeFile(directory, '0010_add_index.up.sql', 'CREATE INDEX i ON t(a);');
    writeFile(directory, '0002_create_t.up.sql', 'CREATE TABLE t (a int);');
    writeFile(directory, '0002_create_t.down.sql', 'DROP TABLE t;');
    writeFile(directory, '0010_add_index.down.sql', '-- nothing to do yet\n');
    writeFile(directory, 'README.md', 'ignored');
    const migrations = loadMigrations(directory);
    expect(migrations.map((migration) => migration.version)).toEqual([2, 10]);
    expect(migrations[0]!.hasDown).toBe(true);
    expect(migrations[1]!.hasDown).toBe(false);
  });

  it.each<[string, (directory: string) => void]>([
    ['a bad file name', (directory) => writeFile(directory, 'create_users.sql', 'SELECT 1;')],
    ['a down file only', (directory) => writeFile(directory, '0001_a.down.sql', 'SELECT 1;')],
    [
      'mismatched names',
      (directory) => {
        writeFile(directory, '0001_a.up.sql', 'SELECT 1;');
        writeFile(directory, '0001_b.down.sql', 'SELECT 1;');
      },
    ],
    ['an empty up file', (directory) => writeFile(directory, '0001_a.up.sql', '-- todo\n')],
    [
      'two up files',
      (directory) => {
        writeFile(directory, '0001_a.up.sql', 'SELECT 1;');
        writeFile(directory, '00001_a.up.sql', 'SELECT 1;');
      },
    ],
    ['a missing directory', (directory) => rmSync(directory, { recursive: true })],
    ['an upper-case extension', (directory) => writeFile(directory, '0001_a.UP.sql', 'SELECT 1;')],
  ])('rejects a directory with %s', (_label, prepare) => {
    const directory = createDirectory();
    prepare(directory);
    expect(() => loadMigrations(directory)).toThrow();
  });

  it('marks a migration one-way only when the down file says so', () => {
    const directory = createDirectory();
    writeFile(directory, '0001_a.up.sql', "ALTER TYPE s ADD VALUE 'x';");
    writeFile(directory, '0001_a.down.sql', '-- migrate:irreversible\n-- cannot remove an enum value\n');
    writeFile(directory, '0002_b.up.sql', 'SELECT 1;');
    writeFile(directory, '0002_b.down.sql', '-- todo\n');
    const [first, second] = loadMigrations(directory);
    expect(first!.isIrreversible).toBe(true);
    expect(first!.hasDown).toBe(false);
    expect(second!.isIrreversible).toBe(false);
  });
});

describe('computeMigrationChecksum', () => {
  it('ignores line endings and trailing blank lines but not real edits', () => {
    const unix = computeMigrationChecksum('CREATE TABLE t (a int);\n');
    expect(computeMigrationChecksum(normalizeNewlines('CREATE TABLE t (a int);\r\n\r\n\r\n'))).toBe(unix);
    expect(computeMigrationChecksum('CREATE TABLE t (b int);\n')).not.toBe(unix);
  });

  it('hashes the trimmed text plus one newline, like the Go version', () => {
    expect(computeMigrationChecksum('SELECT 1;  \n\n')).toBe(
      'b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd',
    );
  });
});

describe('hasNoTransactionDirective', () => {
  it('only honours the directive in the leading comments', () => {
    expect(hasNoTransactionDirective('-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY i ON t(a);')).toBe(
      true,
    );
    expect(hasNoTransactionDirective('\n-- note\n-- migrate:no-transaction\nSELECT 1;')).toBe(true);
    expect(hasNoTransactionDirective('SELECT 1;\n-- migrate:no-transaction\n')).toBe(false);
  });
});

describe('createMigrationFiles', () => {
  const now = new Date(Date.UTC(2026, 9, 10, 12, 0, 0));

  it('numbers sequential directories and timestamps timestamped ones', () => {
    const directory = join(createDirectory(), 'migrations');
    const first = createMigrationFiles(directory, 'Create Users', now);
    expect(first.upPath.endsWith('0001_create_users.up.sql')).toBe(true);
    expect(first.downPath.endsWith('0001_create_users.down.sql')).toBe(true);
    writeFile(directory, '0001_create_users.up.sql', 'CREATE TABLE users (id int);');
    expect(createMigrationFiles(directory, 'add_email', now).upPath.endsWith('0002_add_email.up.sql')).toBe(true);

    const timestamped = createDirectory();
    writeFile(timestamped, '20260101000000_a.up.sql', 'SELECT 1;');
    expect(createMigrationFiles(timestamped, 'b', now).upPath).toContain('20261010120000_b.up.sql');

    expect(() => createMigrationFiles(directory, 'Bad-Name!', now)).toThrow(/name must be/);
  });
});
