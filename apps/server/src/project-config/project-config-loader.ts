import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

import { describeFileSystemError } from '../shared/file-system-error-message';
import type { DatabaseConfig, ProjectConfig } from './project-config';
import { ProjectConfigError } from './project-config.error';

const DATABASE_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,40}$/;
const CONFIG_KEYS = new Set(['databases', 'shadow_admin_dsn_env']);
const DATABASE_KEYS = new Set(['name', 'dsn_env', 'dsn', 'migrations']);

function describeJsonType(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

function readOptionalString(entry: Record<string, unknown>, key: string, path: string): string {
  const value = entry[key];
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value !== 'string') {
    throw new ProjectConfigError(
      `${path}: json: cannot unmarshal ${describeJsonType(value)} into field "${key}" of type string`,
    );
  }
  return value;
}

function rejectUnknownKeys(entry: Record<string, unknown>, allowedKeys: Set<string>, path: string): void {
  for (const key of Object.keys(entry)) {
    if (!allowedKeys.has(key)) {
      throw new ProjectConfigError(`${path}: json: unknown field "${key}"`);
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseConfigJson(raw: string, path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ProjectConfigError(`${path}: ${reason}`);
  }
  if (!isPlainObject(parsed)) {
    throw new ProjectConfigError(`${path}: json: cannot unmarshal ${describeJsonType(parsed)} into the config`);
  }
  return parsed;
}

/**
 * Reads sqlmal.json. Relative migration directories are resolved from the file's own
 * directory. Connection strings are read from environment variables by default, so a
 * password never has to sit in a file that gets committed.
 */
export function loadProjectConfig(path: string): ProjectConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new ProjectConfigError(describeFileSystemError(error, 'open', path));
  }
  const parsed = parseConfigJson(raw, path);
  rejectUnknownKeys(parsed, CONFIG_KEYS, path);
  const rawDatabases = parsed['databases'] ?? [];
  if (!Array.isArray(rawDatabases)) {
    throw new ProjectConfigError(
      `${path}: json: cannot unmarshal ${describeJsonType(rawDatabases)} into field "databases" of type array`,
    );
  }
  const databases: DatabaseConfig[] = rawDatabases.map((rawDatabase: unknown) => {
    if (!isPlainObject(rawDatabase)) {
      throw new ProjectConfigError(
        `${path}: json: cannot unmarshal ${describeJsonType(rawDatabase)} into a database entry`,
      );
    }
    rejectUnknownKeys(rawDatabase, DATABASE_KEYS, path);
    const dsnEnvironmentVariable = readOptionalString(rawDatabase, 'dsn_env', path);
    const dsn = readOptionalString(rawDatabase, 'dsn', path);
    return {
      name: readOptionalString(rawDatabase, 'name', path),
      ...(dsnEnvironmentVariable === '' ? {} : { dsnEnvironmentVariable }),
      ...(dsn === '' ? {} : { dsn }),
      migrationsDirectory: readOptionalString(rawDatabase, 'migrations', path),
    };
  });
  const shadowAdminDsnEnvironmentVariable = readOptionalString(parsed, 'shadow_admin_dsn_env', path);

  if (databases.length === 0) {
    throw new ProjectConfigError('the config lists no databases');
  }
  const seenNames = new Set<string>();
  databases.forEach((database, index) => {
    if (!DATABASE_NAME_PATTERN.test(database.name)) {
      throw new ProjectConfigError(
        `database ${index + 1}: name must be lower case letters, digits, - or _`,
      );
    }
    if (seenNames.has(database.name)) {
      throw new ProjectConfigError(`database name "${database.name}" is used twice`);
    }
    seenNames.add(database.name);
    if (database.dsn === undefined && database.dsnEnvironmentVariable === undefined) {
      throw new ProjectConfigError(`database "${database.name}" needs dsn_env (or dsn)`);
    }
    if (database.migrationsDirectory === '') {
      throw new ProjectConfigError(`database "${database.name}" needs a migrations directory`);
    }
    if (!isAbsolute(database.migrationsDirectory)) {
      database.migrationsDirectory = join(dirname(path), database.migrationsDirectory);
    }
  });
  return {
    databases,
    ...(shadowAdminDsnEnvironmentVariable === '' ? {} : { shadowAdminDsnEnvironmentVariable }),
  };
}

/** Returns the connection URL for a database, preferring its environment variable. */
export function resolveDatabaseDsn(database: DatabaseConfig): string {
  const variableName = database.dsnEnvironmentVariable;
  if (variableName !== undefined) {
    const fromEnvironment = process.env[variableName];
    if (fromEnvironment !== undefined && fromEnvironment !== '') {
      return fromEnvironment;
    }
    if (database.dsn === undefined) {
      throw new ProjectConfigError(
        `environment variable ${variableName} is not set (needed for database "${database.name}")`,
      );
    }
  }
  return database.dsn ?? '';
}

/** Builds a one-database config from flags, for quick use without a file. */
export function createSingleDatabaseConfig(dsn: string, migrationsDirectory: string): ProjectConfig {
  return { databases: [{ name: 'default', dsn, migrationsDirectory }] };
}
