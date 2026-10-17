import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { loadProjectConfig, resolveDatabaseDsn } from './project-config-loader';

function writeConfig(body: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'sqlmal-config-')), 'sqlmal.json');
  writeFileSync(path, body);
  return path;
}

describe('loadProjectConfig', () => {
  it('resolves relative migration directories from the config file', () => {
    const path = writeConfig(
      '{"databases":[{"name":"shop","dsn_env":"SHOP_URL","migrations":"./migrations"}]}',
    );
    expect(loadProjectConfig(path).databases[0]!.migrationsDirectory).toBe(join(dirname(path), 'migrations'));
  });

  it.each([
    ['no databases', '{"databases":[]}'],
    ['a bad name', '{"databases":[{"name":"My DB","dsn_env":"X","migrations":"m"}]}'],
    [
      'a duplicate name',
      '{"databases":[{"name":"a","dsn_env":"X","migrations":"m"},{"name":"a","dsn_env":"X","migrations":"m"}]}',
    ],
    ['no dsn', '{"databases":[{"name":"a","migrations":"m"}]}'],
    ['no directory', '{"databases":[{"name":"a","dsn_env":"X"}]}'],
    ['an unknown field', '{"databases":[{"name":"a","dsn_env":"X","migrations":"m","passwrd":"oops"}]}'],
    ['text that is not JSON', 'databases: []'],
  ])('rejects a config with %s', (_label, body) => {
    expect(() => loadProjectConfig(writeConfig(body))).toThrow();
  });
});

describe('resolveDatabaseDsn', () => {
  const variableName = 'MS_TEST_DSN';
  afterEach(() => {
    delete process.env[variableName];
  });

  it('prefers the environment, falls back to dsn, and names an unset variable', () => {
    const database = {
      name: 'a',
      dsnEnvironmentVariable: variableName,
      dsn: 'postgres://fallback/db',
      migrationsDirectory: 'm',
    };
    process.env[variableName] = 'postgres://from-env/db';
    expect(resolveDatabaseDsn(database)).toBe('postgres://from-env/db');
    process.env[variableName] = '';
    expect(resolveDatabaseDsn(database)).toBe('postgres://fallback/db');
    expect(() => resolveDatabaseDsn({ ...database, dsn: undefined })).toThrow(/MS_TEST_DSN/);
  });
});
