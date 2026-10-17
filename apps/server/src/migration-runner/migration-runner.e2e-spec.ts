import type { MigrationRunResult, MigrationStatus } from '@sqlmal/contracts';
import { Client } from 'pg';

import { MigrationDirectory } from '../testing/migration-directory';
import { describeWithDatabase, itWithDatabase, type TestDatabase } from '../testing/test-database';
import { MigrationRunner } from './migration-runner';
import {
  DriftedHistoryError,
  MigrationFailedError,
  MigrationLockedError,
  MissingDownMigrationError,
  NothingToDoError,
  OutOfOrderMigrationError,
} from './migration-runner.error';

function describeStates(statuses: readonly MigrationStatus[]): string {
  return statuses.map((status) => status.state).join(',');
}

async function captureFailure(run: Promise<unknown>): Promise<unknown> {
  try {
    await run;
  } catch (error) {
    return error;
  }
  throw new Error('expected the run to fail');
}

describeWithDatabase('MigrationRunner', (context) => {
  const openRunners: MigrationRunner[] = [];

  async function openRunner(database: TestDatabase, directory: MigrationDirectory): Promise<MigrationRunner> {
    const runner = await MigrationRunner.open(database.dsn, directory.load());
    openRunners.push(runner);
    return runner;
  }

  afterEach(async () => {
    for (const runner of openRunners.splice(0)) {
      await runner.close();
    }
  });

  itWithDatabase(context, 'applies everything in order and records it', async () => {
    const database = await context.createDatabase();
    const runner = await openRunner(database, new MigrationDirectory().writeBaseMigrations());
    expect(await runner.migrateUp()).toHaveLength(3);
    expect(await database.hasTable('users')).toBe(true);
    expect(await database.hasTable('orders')).toBe(true);
    expect(describeStates(await runner.readStatuses())).toBe('applied,applied,applied');
    const history = await runner.readHistory(10);
    expect(history.map((entry) => entry.version)).toEqual([3, 2, 1]);
    expect(history[0]).toMatchObject({ isSuccess: true, direction: 'up' });
    await expect(runner.migrateUp()).rejects.toBeInstanceOf(NothingToDoError);
  });

  itWithDatabase(context, 'rolls a failing migration back completely and stops the run', async () => {
    const database = await context.createDatabase();
    const directory = new MigrationDirectory()
      .writeBaseMigrations()
      .writeFile('0002_orders.up.sql', 'CREATE TABLE orders (id serial PRIMARY KEY);\n\nCREATE TABLE half_done (id int);\nSELECT 1/0;');
    const runner = await openRunner(database, directory);
    const failure = await captureFailure(runner.migrateUp());
    expect(failure).toBeInstanceOf(MigrationFailedError);
    const results = (failure as MigrationFailedError).results;
    expect(results).toHaveLength(2);
    expect(results[1]!.errorMessage).toContain('division by zero');
    expect(results[1]!.errorLine).toBe(4);
    expect(await database.hasTable('orders')).toBe(false);
    expect(await database.hasTable('half_done')).toBe(false);
    expect(await database.hasTable('users')).toBe(true);
    expect(describeStates(await runner.readStatuses())).toBe('applied,pending,pending');
    const history = await runner.readHistory(10);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ isSuccess: false, version: 2 });
    expect(history[0]!.errorMessage).toContain('division by zero');
  });

  itWithDatabase(context, 'rolls back one by default, to a target, and to a version with goto', async () => {
    const database = await context.createDatabase();
    const runner = await openRunner(database, new MigrationDirectory().writeBaseMigrations());
    await runner.migrateUp();
    const versions = (results: MigrationRunResult[]): number[] => results.map((result) => result.version);
    expect(versions(await runner.migrateDown())).toEqual([3]);
    expect(versions(await runner.migrateTo(1))).toEqual([2]);
    expect(await database.hasTable('orders')).toBe(false);
    expect(await runner.migrateTo(3)).toHaveLength(2);
    expect(await database.hasTable('orders')).toBe(true);
    await expect(runner.migrateTo(3)).rejects.toBeInstanceOf(NothingToDoError);
    await expect(runner.migrateTo(99)).rejects.toThrow('version 99 does not exist');
    expect(await runner.migrateTo(0)).toHaveLength(3);
    expect(await database.hasTable('users')).toBe(false);
    expect(await runner.migrateUp({ steps: 1 })).toHaveLength(1);
  });

  itWithDatabase(context, 'detects and blocks on an edited applied migration', async () => {
    const database = await context.createDatabase();
    const directory = new MigrationDirectory().writeBaseMigrations();
    await (await openRunner(database, directory)).migrateUp({ steps: 2 });
    directory.writeFile('0001_users.up.sql', 'CREATE TABLE users (id serial PRIMARY KEY, email text NOT NULL, extra int);');
    const runner = await openRunner(database, directory);
    const statuses = await runner.readStatuses();
    expect(describeStates(statuses)).toBe('modified,applied,pending');
    expect(statuses[0]!.checksum).not.toBe(statuses[0]!.appliedChecksum);
    const failure = await captureFailure(runner.migrateUp());
    expect(failure).toBeInstanceOf(DriftedHistoryError);
    expect((failure as Error).message).toContain('0001_users was edited');
    await expect(runner.migrateDown()).rejects.toBeInstanceOf(DriftedHistoryError);
    await expect(runner.migrateUp({ allowDriftedHistory: true })).resolves.toHaveLength(1);
  });

  itWithDatabase(context, 'reports a missing file and refuses to run', async () => {
    const database = await context.createDatabase();
    const directory = new MigrationDirectory().writeBaseMigrations();
    await (await openRunner(database, directory)).migrateUp();
    directory.removeFile('0002_orders.up.sql').removeFile('0002_orders.down.sql');
    const runner = await openRunner(database, directory);
    const statuses = await runner.readStatuses();
    expect(describeStates(statuses)).toBe('applied,missing,applied');
    expect(statuses[1]!.name).toBe('orders');
    await expect(runner.migrateUp()).rejects.toBeInstanceOf(DriftedHistoryError);
  });

  itWithDatabase(context, 'refuses out-of-order migrations unless allowed', async () => {
    const database = await context.createDatabase();
    const directory = new MigrationDirectory()
      .writeFile('0001_a.up.sql', 'CREATE TABLE a (id int);')
      .writeFile('0003_c.up.sql', 'CREATE TABLE c (id int);');
    await (await openRunner(database, directory)).migrateUp();
    directory.writeFile('0002_b.up.sql', 'CREATE TABLE b (id int);');
    const runner = await openRunner(database, directory);
    expect((await runner.readStatuses())[1]).toMatchObject({ state: 'pending', isOutOfOrder: true });
    await expect(runner.migrateUp()).rejects.toBeInstanceOf(OutOfOrderMigrationError);
    expect(await runner.migrateUp({ allowOutOfOrder: true })).toHaveLength(1);
    expect(await database.hasTable('b')).toBe(true);
  });

  itWithDatabase(context, 'lets only one migrator run at a time', async () => {
    const database = await context.createDatabase();
    const directory = new MigrationDirectory().writeBaseMigrations();
    const holder = await MigrationRunner.open(database.dsn, directory.load());
    await holder.acquireLock(1000);
    const waiter = await openRunner(database, directory);
    const startMs = Date.now();
    await expect(waiter.migrateUp({ lockWaitMs: 400 })).rejects.toBeInstanceOf(MigrationLockedError);
    expect(Date.now() - startMs).toBeLessThan(3000);
    expect(await database.hasTable('users')).toBe(false);
    await holder.close();
    await expect((await openRunner(database, directory)).migrateUp()).resolves.toHaveLength(3);
  });

  itWithDatabase(context, 'never applies the same migration twice under concurrent runs', async () => {
    const database = await context.createDatabase();
    const directory = new MigrationDirectory().writeBaseMigrations();
    const runners = await Promise.all([1, 2, 3, 4].map(() => openRunner(database, directory)));
    const counts = await Promise.all(
      runners.map(async (runner) => {
        try {
          return (await runner.migrateUp({ lockWaitMs: 10_000 })).length;
        } catch (error) {
          if (error instanceof NothingToDoError) {
            return 0;
          }
          throw error;
        }
      }),
    );
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(3);
    expect(await database.countRows('SELECT count(*) FROM schema_migrations')).toBe(3);
  });

  itWithDatabase(context, 'runs no-transaction migrations statement by statement', async () => {
    const database = await context.createDatabase();
    const directory = new MigrationDirectory()
      .writeBaseMigrations()
      .writeFile(
        '0003_idx.up.sql',
        '-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY idx_orders_user ON orders (user_id);\nCREATE INDEX CONCURRENTLY idx_orders_id ON orders (id, user_id);',
      );
    expect(await (await openRunner(database, directory)).migrateUp()).toHaveLength(3);
    expect(
      await database.countRows("SELECT count(*) FROM pg_indexes WHERE indexname IN ('idx_orders_user','idx_orders_id')"),
    ).toBe(2);

    // Forgetting the directive is an error PostgreSQL reports, and it rolls back cleanly.
    const other = await context.createDatabase();
    const forgetful = new MigrationDirectory()
      .writeBaseMigrations()
      .writeFile('0003_idx.up.sql', 'CREATE INDEX CONCURRENTLY idx_orders_user ON orders (user_id);');
    await expect((await openRunner(other, forgetful)).migrateUp()).rejects.toThrow(/CONCURRENTLY/);
  });

  itWithDatabase(context, 'changes nothing in a dry run, and finds errors in one', async () => {
    const database = await context.createDatabase();
    const directory = new MigrationDirectory().writeBaseMigrations();
    const results = await (await openRunner(database, directory)).migrateUp({ isDryRun: true });
    expect(results).toHaveLength(3);
    expect(results[0]!.isDryRun).toBe(true);
    for (const table of ['users', 'schema_migrations', 'migration_history']) {
      expect(await database.hasTable(table)).toBe(false);
    }
    directory.writeFile('0003_idx.up.sql', 'CREATE INDEX idx ON orders (no_such_column);');
    const failure = await captureFailure((await openRunner(database, directory)).migrateUp({ isDryRun: true }));
    const failedResults = (failure as MigrationFailedError).results;
    expect(failedResults.at(-1)!.version).toBe(3);
    expect(failedResults.at(-1)!.errorMessage).toContain('no_such_column');

    directory.writeFile('0003_idx.up.sql', 'CREATE INDEX idx_orders_user ON orders (user_id);');
    const runner = await openRunner(database, directory);
    await runner.migrateUp();
    await runner.migrateDown({ isDryRun: true, steps: 3 });
    expect(await database.hasTable('users')).toBe(true);
    expect(await database.countRows('SELECT count(*) FROM schema_migrations')).toBe(3);
  });

  itWithDatabase(context, 'gives up on a table lock after the lock timeout', async () => {
    const database = await context.createDatabase();
    const directory = new MigrationDirectory()
      .writeFile('0001_users.up.sql', 'CREATE TABLE users (id int);')
      .writeFile('0002_alter.up.sql', 'ALTER TABLE users ADD COLUMN name text;');
    const runner = await openRunner(database, directory);
    await runner.migrateUp({ steps: 1 });
    const holder = new Client({ connectionString: database.dsn });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE users IN ACCESS EXCLUSIVE MODE');
      const startMs = Date.now();
      await expect(runner.migrateUp({ lockTimeoutMs: 300 })).rejects.toThrow(/lock timeout/);
      expect(Date.now() - startMs).toBeLessThan(5000);
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
    }
  });

  itWithDatabase(context, 'stops a slow migration at the statement timeout', async () => {
    const database = await context.createDatabase();
    const directory = new MigrationDirectory().writeFile('0001_slow.up.sql', 'SELECT pg_sleep(5);');
    const startMs = Date.now();
    await expect((await openRunner(database, directory)).migrateUp({ statementTimeoutMs: 300 })).rejects.toThrow(
      /statement timeout/,
    );
    expect(Date.now() - startMs).toBeLessThan(3000);
  });

  itWithDatabase(context, 'adopts an existing database with a baseline', async () => {
    const database = await context.createDatabase();
    await database.query(
      'CREATE TABLE users (id serial PRIMARY KEY, email text NOT NULL); CREATE TABLE orders (id serial PRIMARY KEY, user_id int NOT NULL REFERENCES users(id));',
    );
    const runner = await openRunner(database, new MigrationDirectory().writeBaseMigrations());
    await runner.recordBaseline(2);
    expect(describeStates(await runner.readStatuses())).toBe('applied,applied,pending');
    const results = await runner.migrateUp();
    expect(results.map((result) => result.version)).toEqual([3]);
  });

  itWithDatabase(context, 'needs a down file to roll back', async () => {
    const database = await context.createDatabase();
    const runner = await openRunner(database, new MigrationDirectory().writeFile('0001_a.up.sql', 'CREATE TABLE a (id int);'));
    await runner.migrateUp();
    await expect(runner.migrateDown()).rejects.toBeInstanceOf(MissingDownMigrationError);
    expect(await database.hasTable('a')).toBe(true);
  });
});
