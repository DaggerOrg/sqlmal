import { setTimeout as sleep } from 'node:timers/promises';

import type {
  MigrationDirection,
  MigrationHistoryEntry,
  MigrationRunResult,
  MigrationStatus,
} from '@sqlmal/contracts';
import { Client } from 'pg';

import type { Migration } from '../migration-files/migration';
import { findMigrationByVersion } from '../migration-files/migration-loader';
import { describeError } from '../shared/error-message';
import { splitSqlStatements } from '../sql/sql-splitter';
import { computeAdvisoryLockKey } from './advisory-lock-key';
import { describeDatabaseError } from './database-error-description';
import {
  resolveLockTimeoutMs,
  resolveLockWaitMs,
  type MigrationRunOptions,
} from './migration-run-options';
import {
  DatabaseConnectionError,
  MigrationFailedError,
  MigrationLockedError,
  MissingDownMigrationError,
  NothingToDoError,
  UnknownVersionError,
} from './migration-runner.error';
import {
  buildMigrationStatuses,
  formatMigrationLabel,
  guardMigrationHistory,
  type AppliedMigrationRecord,
} from './migration-status-builder';

const LOCK_POLL_INTERVAL_MS = 150;
const BASELINE_LOCK_WAIT_MS = 10_000;
const DEFAULT_HISTORY_LIMIT = 100;
const MAX_HISTORY_LIMIT = 500;
const NON_TRANSACTIONAL_DRY_RUN_REASON = 'runs outside a transaction, so it cannot be tried safely';

const BOOKKEEPING_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
    version     bigint PRIMARY KEY,
    name        text NOT NULL,
    checksum    text NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now(),
    duration_ms integer NOT NULL DEFAULT 0,
    applied_by  text NOT NULL DEFAULT current_user
);
CREATE TABLE IF NOT EXISTS migration_history (
    id          bigserial PRIMARY KEY,
    version     bigint NOT NULL,
    name        text NOT NULL,
    direction   text NOT NULL CHECK (direction IN ('up', 'down')),
    success     boolean NOT NULL,
    error       text NOT NULL DEFAULT '',
    started_at  timestamptz NOT NULL DEFAULT now(),
    duration_ms integer NOT NULL DEFAULT 0,
    applied_by  text NOT NULL DEFAULT current_user,
    checksum    text NOT NULL DEFAULT ''
);`;

const RECORD_UP_SQL = `
WITH ins AS (INSERT INTO schema_migrations (version, name, checksum, duration_ms) VALUES ($1,$2,$3,$4))
INSERT INTO migration_history (version, name, direction, success, duration_ms, checksum) VALUES ($1,$2,'up',true,$4,$3)`;

const RECORD_DOWN_SQL = `
WITH del AS (DELETE FROM schema_migrations WHERE version = $1)
INSERT INTO migration_history (version, name, direction, success, duration_ms, checksum) VALUES ($1,$2,'down',true,$3,$4)`;

interface AppliedRow {
  version: string;
  name: string;
  checksum: string;
  applied_at: Date;
  duration_ms: number;
  applied_by: string;
}

interface HistoryRow {
  id: string;
  version: string;
  name: string;
  direction: MigrationDirection;
  success: boolean;
  error: string;
  started_at: Date;
  duration_ms: number;
  applied_by: string;
}

function measureSince(startMs: number): number {
  return Math.floor(performance.now() - startMs);
}

function buildResult(migration: Migration, direction: MigrationDirection, isDryRun: boolean): MigrationRunResult {
  return { version: migration.version, name: migration.name, direction, isDryRun, durationMs: 0 };
}

function recordError(result: MigrationRunResult, message: string, line: number): void {
  result.errorMessage = message;
  if (line > 0) {
    result.errorLine = line;
  } else {
    delete result.errorLine;
  }
}

/**
 * Applies and rolls back migrations on one PostgreSQL database over one dedicated
 * connection.
 *
 * - One migration runs at a time per database (advisory lock).
 * - Each migration runs in its own transaction, so a failure leaves no half-applied schema
 *   (unless it asked for `-- migrate:no-transaction`).
 * - Applied migrations are checksummed, so editing history is detected.
 * - A lock_timeout stops a migration from queueing behind a long query and blocking the
 *   whole application.
 */
export class MigrationRunner {
  private isLocked = false;
  private lockKey: string | undefined;

  private constructor(
    private readonly client: Client,
    private readonly migrations: readonly Migration[],
  ) {}

  static async open(dsn: string, migrations: readonly Migration[]): Promise<MigrationRunner> {
    const client = new Client({ connectionString: dsn });
    // A terminated backend must not crash the process; the next query reports it.
    client.on('error', () => undefined);
    try {
      await client.connect();
    } catch (error) {
      throw new DatabaseConnectionError(`connect: ${describeError(error)}`, { cause: error });
    }
    return new MigrationRunner(client, migrations);
  }

  async close(): Promise<void> {
    await this.releaseLock();
    await this.client.end().catch(() => undefined);
  }

  /** Lists every migration, from the files and from the database. */
  async readStatuses(): Promise<MigrationStatus[]> {
    return buildMigrationStatuses(this.migrations, await this.loadApplied());
  }

  /** Applies pending migrations in version order. */
  async migrateUp(options: MigrationRunOptions = {}): Promise<MigrationRunResult[]> {
    return this.withLock(resolveLockWaitMs(options), async () => {
      const statuses = buildMigrationStatuses(this.migrations, await this.loadApplied());
      guardMigrationHistory(statuses, options, 'up');
      const pending: Migration[] = [];
      for (const status of statuses) {
        if (status.state !== 'pending') {
          continue;
        }
        if (options.targetVersion !== undefined && options.targetVersion > 0 && status.version > options.targetVersion) {
          break;
        }
        const migration = findMigrationByVersion(this.migrations, status.version);
        if (migration !== undefined) {
          pending.push(migration);
        }
        if (options.steps !== undefined && options.steps > 0 && pending.length >= options.steps) {
          break;
        }
      }
      if (pending.length === 0) {
        throw new NothingToDoError();
      }
      if (options.isDryRun === true) {
        return this.dryRun(pending, 'up', options);
      }
      await this.client.query(BOOKKEEPING_TABLES_SQL);
      const results: MigrationRunResult[] = [];
      for (const migration of pending) {
        const result = await this.applyUp(migration, options);
        results.push(result);
        if (result.errorMessage !== undefined) {
          throw new MigrationFailedError(result.errorMessage, results);
        }
      }
      return results;
    });
  }

  /** Rolls back applied migrations, newest first. Without steps or a target it rolls back one. */
  async migrateDown(options: MigrationRunOptions = {}): Promise<MigrationRunResult[]> {
    return this.withLock(resolveLockWaitMs(options), async () => {
      const statuses = buildMigrationStatuses(this.migrations, await this.loadApplied());
      guardMigrationHistory(statuses, options, 'down');
      const targetVersion = options.targetVersion ?? 0;
      const steps = options.steps ?? 0;
      const limit = steps === 0 && targetVersion === 0 ? 1 : steps;
      const toRollBack: Migration[] = [];
      for (const status of [...statuses].reverse()) {
        if (status.state !== 'applied' && status.state !== 'modified') {
          continue;
        }
        if (targetVersion > 0 && status.version <= targetVersion) {
          break;
        }
        const migration = findMigrationByVersion(this.migrations, status.version);
        if (migration === undefined) {
          continue;
        }
        if (!migration.hasDown) {
          throw new MissingDownMigrationError(formatMigrationLabel(migration.version, migration.name));
        }
        toRollBack.push(migration);
        if (limit > 0 && toRollBack.length >= limit) {
          break;
        }
      }
      if (toRollBack.length === 0) {
        throw new NothingToDoError();
      }
      if (options.isDryRun === true) {
        return this.dryRun(toRollBack, 'down', options);
      }
      const results: MigrationRunResult[] = [];
      for (const migration of toRollBack) {
        const result = await this.applyDown(migration, options);
        results.push(result);
        if (result.errorMessage !== undefined) {
          throw new MigrationFailedError(result.errorMessage, results);
        }
      }
      return results;
    });
  }

  /** Moves the database to exactly `targetVersion` (0 means before everything). */
  async migrateTo(targetVersion: number, options: MigrationRunOptions = {}): Promise<MigrationRunResult[]> {
    const appliedByVersion = await this.loadApplied();
    let currentVersion = 0;
    for (const version of appliedByVersion.keys()) {
      currentVersion = Math.max(currentVersion, version);
    }
    if (targetVersion > 0 && findMigrationByVersion(this.migrations, targetVersion) === undefined) {
      throw new UnknownVersionError(targetVersion);
    }
    if (targetVersion === currentVersion) {
      throw new NothingToDoError();
    }
    if (targetVersion > currentVersion) {
      return this.migrateUp({ ...options, targetVersion });
    }
    return this.migrateDown({
      ...options,
      targetVersion,
      ...(targetVersion === 0 ? { steps: appliedByVersion.size } : {}),
    });
  }

  /**
   * Records migrations up to `version` as applied without running them, for adopting a
   * database whose schema already exists.
   */
  async recordBaseline(version: number): Promise<void> {
    await this.withLock(BASELINE_LOCK_WAIT_MS, async () => {
      if (findMigrationByVersion(this.migrations, version) === undefined) {
        throw new UnknownVersionError(version);
      }
      await this.client.query(BOOKKEEPING_TABLES_SQL);
      await this.runInTransaction(async () => {
        for (const migration of this.migrations) {
          if (migration.version > version) {
            break;
          }
          await this.client.query(
            'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
            [migration.version, migration.name, migration.checksum],
          );
        }
      });
    });
  }

  /** Recent runs, newest first. */
  async readHistory(limit: number): Promise<MigrationHistoryEntry[]> {
    if (!(await this.hasBookkeepingTables())) {
      return [];
    }
    const boundedLimit = limit <= 0 || limit > MAX_HISTORY_LIMIT ? DEFAULT_HISTORY_LIMIT : limit;
    const result = await this.client.query<HistoryRow>(
      `SELECT id, version, name, direction, success, error, started_at, duration_ms, applied_by
       FROM migration_history ORDER BY id DESC LIMIT $1`,
      [boundedLimit],
    );
    return result.rows.map((row) => {
      const entry: MigrationHistoryEntry = {
        id: Number(row.id),
        version: Number(row.version),
        name: row.name,
        direction: row.direction,
        isSuccess: row.success,
        startedAt: row.started_at.toISOString(),
        durationMs: row.duration_ms,
        appliedBy: row.applied_by,
      };
      if (row.error !== '') {
        entry.errorMessage = row.error;
      }
      return entry;
    });
  }

  /** Takes the advisory lock, waiting up to `waitMs`. Public so tests can hold it. */
  async acquireLock(waitMs: number): Promise<void> {
    if (this.isLocked) {
      return;
    }
    const key = await this.readLockKey();
    const deadlineMs = Date.now() + waitMs;
    for (;;) {
      const result = await this.client.query<{ is_locked: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS is_locked',
        [key],
      );
      if (result.rows[0]?.is_locked === true) {
        this.isLocked = true;
        return;
      }
      if (Date.now() > deadlineMs) {
        throw new MigrationLockedError();
      }
      await sleep(LOCK_POLL_INTERVAL_MS);
    }
  }

  private async releaseLock(): Promise<void> {
    if (!this.isLocked) {
      return;
    }
    this.isLocked = false;
    await this.client
      .query('SELECT pg_advisory_unlock($1)', [await this.readLockKey()])
      .catch(() => undefined);
  }

  /** Runs `operation` under the lock. If the lock is already held it is kept afterwards. */
  private async withLock<TResult>(waitMs: number, operation: () => Promise<TResult>): Promise<TResult> {
    if (this.isLocked) {
      return operation();
    }
    await this.acquireLock(waitMs);
    try {
      return await operation();
    } finally {
      await this.releaseLock();
    }
  }

  private async readLockKey(): Promise<string> {
    if (this.lockKey === undefined) {
      const result = await this.client.query<{ name: string }>('SELECT current_database() AS name');
      this.lockKey = computeAdvisoryLockKey(result.rows[0]?.name ?? '');
    }
    return this.lockKey;
  }

  private async hasBookkeepingTables(): Promise<boolean> {
    const result = await this.client.query<{ has_tables: boolean }>(
      "SELECT to_regclass('schema_migrations') IS NOT NULL AS has_tables",
    );
    return result.rows[0]?.has_tables === true;
  }

  private async loadApplied(): Promise<Map<number, AppliedMigrationRecord>> {
    const appliedByVersion = new Map<number, AppliedMigrationRecord>();
    if (!(await this.hasBookkeepingTables())) {
      return appliedByVersion;
    }
    const result = await this.client.query<AppliedRow>(
      'SELECT version, name, checksum, applied_at, duration_ms, applied_by FROM schema_migrations',
    );
    for (const row of result.rows) {
      const version = Number(row.version);
      appliedByVersion.set(version, {
        version,
        name: row.name,
        checksum: row.checksum,
        appliedAt: row.applied_at,
        durationMs: row.duration_ms,
        appliedBy: row.applied_by,
      });
    }
    return appliedByVersion;
  }

  private async runInTransaction(operation: () => Promise<void>): Promise<void> {
    await this.client.query('BEGIN');
    try {
      await operation();
    } catch (error) {
      await this.client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
    await this.client.query('COMMIT');
  }

  private async setLocalTimeouts(options: MigrationRunOptions): Promise<void> {
    await this.client.query(`SET LOCAL lock_timeout = '${resolveLockTimeoutMs(options)}ms'`);
    if (options.statementTimeoutMs !== undefined && options.statementTimeoutMs > 0) {
      await this.client.query(`SET LOCAL statement_timeout = '${options.statementTimeoutMs}ms'`);
    }
  }

  private async applyUp(migration: Migration, options: MigrationRunOptions): Promise<MigrationRunResult> {
    const result = buildResult(migration, 'up', false);
    const startMs = performance.now();
    let failure: unknown;
    let hasFailed = false;
    try {
      if (migration.isNonTransactional) {
        // No transaction: the SQL runs as it is and cannot be rolled back.
        await this.client.query(`SET lock_timeout = '${resolveLockTimeoutMs(options)}ms'`);
        try {
          await this.runStatementByStatement(migration.upSql);
        } finally {
          await this.client.query('RESET lock_timeout').catch(() => undefined);
        }
        result.durationMs = measureSince(startMs);
        await this.runInTransaction(async () => {
          await this.client.query(RECORD_UP_SQL, [migration.version, migration.name, migration.checksum, result.durationMs]);
        });
      } else {
        await this.runInTransaction(async () => {
          await this.setLocalTimeouts(options);
          await this.client.query(migration.upSql);
          result.durationMs = measureSince(startMs);
          await this.client.query(RECORD_UP_SQL, [migration.version, migration.name, migration.checksum, result.durationMs]);
        });
      }
    } catch (error) {
      failure = error;
      hasFailed = true;
    }
    if (hasFailed) {
      const description = describeDatabaseError(migration.upSql, failure);
      let line = description.line;
      if (line === 0 && !migration.isNonTransactional) {
        line = await this.locateFailingLine(migration.upSql, description.message);
      }
      let message = description.message;
      if (migration.isNonTransactional) {
        message +=
          ' (this migration ran outside a transaction, so it may be partly applied: check the database)';
      }
      recordError(result, message, line);
      result.durationMs = measureSince(startMs);
      await this.recordFailure(migration, 'up', message, result.durationMs);
    }
    return result;
  }

  private async applyDown(migration: Migration, options: MigrationRunOptions): Promise<MigrationRunResult> {
    const result = buildResult(migration, 'down', false);
    const startMs = performance.now();
    const recordDown = async (): Promise<void> => {
      await this.client.query(RECORD_DOWN_SQL, [
        migration.version,
        migration.name,
        measureSince(startMs),
        migration.checksum,
      ]);
    };
    let failure: unknown;
    let hasFailed = false;
    try {
      if (migration.isDownNonTransactional) {
        await this.runStatementByStatement(migration.downSql);
        await this.runInTransaction(recordDown);
      } else {
        await this.runInTransaction(async () => {
          await this.setLocalTimeouts(options);
          await this.client.query(migration.downSql);
          await recordDown();
        });
      }
    } catch (error) {
      failure = error;
      hasFailed = true;
    }
    result.durationMs = measureSince(startMs);
    if (hasFailed) {
      const description = describeDatabaseError(migration.downSql, failure);
      let line = description.line;
      if (line === 0 && !migration.isDownNonTransactional) {
        line = await this.locateFailingLine(migration.downSql, description.message);
      }
      recordError(result, description.message, line);
      await this.recordFailure(migration, 'down', description.message, result.durationMs);
    }
    return result;
  }

  /**
   * Runs every selected migration inside one transaction that is always rolled back, so later
   * migrations see earlier ones.
   */
  private async dryRun(
    migrations: readonly Migration[],
    direction: MigrationDirection,
    options: MigrationRunOptions,
  ): Promise<MigrationRunResult[]> {
    const results: MigrationRunResult[] = [];
    await this.client.query('BEGIN');
    try {
      await this.setLocalTimeouts(options);
      for (const migration of migrations) {
        const result = buildResult(migration, direction, true);
        const isNonTransactional =
          direction === 'up' ? migration.isNonTransactional : migration.isDownNonTransactional;
        if (isNonTransactional) {
          result.skippedReason = NON_TRANSACTIONAL_DRY_RUN_REASON;
          results.push(result);
          continue;
        }
        const sql = direction === 'up' ? migration.upSql : migration.downSql;
        const startMs = performance.now();
        try {
          await this.client.query(sql);
        } catch (error) {
          const description = describeDatabaseError(sql, error);
          recordError(result, description.message, description.line);
          if (direction === 'up') {
            result.durationMs = measureSince(startMs);
          }
          results.push(result);
          throw new MigrationFailedError(description.message, results);
        }
        result.durationMs = measureSince(startMs);
        results.push(result);
      }
      return results;
    } finally {
      await this.client.query('ROLLBACK').catch(() => undefined);
    }
  }

  /**
   * Runs a no-transaction file one statement at a time. PostgreSQL wraps a multi-statement
   * string in an implicit transaction, which is exactly what CREATE INDEX CONCURRENTLY
   * refuses to run inside.
   */
  private async runStatementByStatement(sql: string): Promise<void> {
    for (const statement of splitSqlStatements(sql)) {
      await this.client.query(statement.sql);
    }
  }

  /** Best effort: the migration already failed, and a history write must not hide that. */
  private async recordFailure(
    migration: Migration,
    direction: MigrationDirection,
    message: string,
    durationMs: number,
  ): Promise<void> {
    await this.client
      .query(
        `INSERT INTO migration_history (version, name, direction, success, error, duration_ms, checksum)
         VALUES ($1,$2,$3,false,$4,$5,$6)`,
        [migration.version, migration.name, direction, message, durationMs, migration.checksum],
      )
      .catch(() => undefined);
  }

  /**
   * Finds which statement of a failed script raised the error. PostgreSQL reports a position
   * only for syntax and name errors; for runtime errors (such as division by zero) it says
   * nothing. So the script is replayed statement by statement in a transaction that is
   * always rolled back. The line is trusted only when the replay fails with the very same
   * message.
   */
  private async locateFailingLine(sql: string, expectedMessage: string): Promise<number> {
    // Timeouts say nothing about which statement was at fault, and replaying one would
    // just wait on the same lock again.
    if (expectedMessage.includes('timeout') || expectedMessage.includes('canceling statement')) {
      return 0;
    }
    try {
      await this.client.query('BEGIN');
    } catch {
      return 0;
    }
    try {
      // The replay must never hang or hold locks for long.
      await this.client.query("SET LOCAL lock_timeout = '1s'; SET LOCAL statement_timeout = '5s'");
      for (const statement of splitSqlStatements(sql)) {
        try {
          await this.client.query(statement.sql);
        } catch (error) {
          const description = describeDatabaseError(sql, error);
          return description.message === expectedMessage ? statement.line : 0;
        }
      }
      return 0;
    } catch {
      return 0;
    } finally {
      await this.client.query('ROLLBACK').catch(() => undefined);
    }
  }
}
