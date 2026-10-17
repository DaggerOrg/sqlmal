import { Client } from 'pg';

import { MigrationRunner } from '../migration-runner/migration-runner';
import { describeSchemaChange } from '../schema/schema-comparison';
import { MigrationDirectory } from '../testing/migration-directory';
import {
  describeWithDatabase,
  getTestAdminDsn,
  itWithDatabase,
  replaceTestDatabaseName,
} from '../testing/test-database';
import { detectDrift } from './drift-detector';
import { buildMigrationTimeline } from './migration-timeline-builder';

function createBaseDirectory(): MigrationDirectory {
  return new MigrationDirectory()
    .writeFile('0001_users.up.sql', 'CREATE TABLE users (id serial PRIMARY KEY, email text NOT NULL);')
    .writeFile('0001_users.down.sql', 'DROP TABLE users;')
    .writeFile('0002_orders.up.sql', 'CREATE TABLE orders (id serial PRIMARY KEY, user_id int NOT NULL REFERENCES users(id));')
    .writeFile('0002_orders.down.sql', 'DROP TABLE orders;')
    .writeFile('0003_idx.up.sql', 'CREATE INDEX idx_orders_user ON orders (user_id);\nALTER TABLE users ADD COLUMN name text;')
    .writeFile('0003_idx.down.sql', 'ALTER TABLE users DROP COLUMN name;\nDROP INDEX idx_orders_user;');
}

function getAdminDsn(): string {
  return replaceTestDatabaseName(getTestAdminDsn(), 'postgres');
}

describeWithDatabase('buildMigrationTimeline', (context) => {
  itWithDatabase(context, 'shows the schema after each migration and checks every down', async () => {
    const timeline = await buildMigrationTimeline(getAdminDsn(), createBaseDirectory().load());
    expect(timeline.steps).toHaveLength(3);
    expect(timeline.failedVersion).toBeUndefined();
    expect(timeline.steps[0]!.changes).toEqual([
      { kind: 'table_added', tableName: 'users', detail: '2 columns', isDestructive: false },
    ]);
    expect(timeline.steps[0]!.schema.tables).toHaveLength(1);
    expect(timeline.steps[1]!.schema.tables).toHaveLength(2);
    const kinds = timeline.steps[2]!.changes.map((change) => change.kind);
    expect(kinds).toEqual(expect.arrayContaining(['index_added', 'column_added']));
    expect(timeline.isFullyReversible).toBe(true);
    expect(timeline.steps.map((step) => step.isReversible)).toEqual([true, true, true]);
  });

  itWithDatabase(context, 'catches a down that does not undo its up', async () => {
    const directory = createBaseDirectory().writeFile('0003_idx.down.sql', 'ALTER TABLE users DROP COLUMN name;');
    const timeline = await buildMigrationTimeline(getAdminDsn(), directory.load());
    const step = timeline.steps[2]!;
    expect(step.isReversible).toBe(false);
    expect(timeline.isFullyReversible).toBe(false);
    expect(step.reverseDifferences).toHaveLength(1);
    expect(step.reverseDifferences[0]).toMatchObject({ kind: 'index_added', objectName: 'idx_orders_user' });
  });

  itWithDatabase(context, 'reports missing downs as unknown and stops at a failing up', async () => {
    const withoutDown = createBaseDirectory().removeFile('0002_orders.down.sql');
    let timeline = await buildMigrationTimeline(getAdminDsn(), withoutDown.load());
    expect(timeline.steps[1]!.isReversible).toBeNull();
    expect(timeline.steps[1]!.reversibilityNote).toContain('no down');
    expect(timeline.isFullyReversible).toBe(false);

    const failing = createBaseDirectory().writeFile('0002_orders.up.sql', 'CREATE TABLE orders (id serial PRIMARY KEY);\nSELECT 1/0;');
    timeline = await buildMigrationTimeline(getAdminDsn(), failing.load());
    expect(timeline.failedVersion).toBe(2);
    expect(timeline.steps).toHaveLength(2);
    expect(timeline.steps[1]!.errorMessage).toContain('division by zero');
    expect(timeline.steps[1]!.errorMessage).toContain('line 2');
    expect(timeline.steps[1]!.schema.tables).toHaveLength(1);
  });

  itWithDatabase(context, 'leaves no scratch database behind', async () => {
    await buildMigrationTimeline(getAdminDsn(), createBaseDirectory().load());
    const admin = new Client({ connectionString: getAdminDsn() });
    await admin.connect();
    try {
      const result = await admin.query<{ count: string }>(
        "SELECT count(*) FROM pg_database WHERE datname LIKE 'ms_shadow_%'",
      );
      expect(Number(result.rows[0]!.count)).toBe(0);
    } finally {
      await admin.end();
    }
  });
});

describeWithDatabase('detectDrift', (context) => {
  async function applyMigrations(dsn: string, directory: MigrationDirectory, steps?: number): Promise<void> {
    const runner = await MigrationRunner.open(dsn, directory.load());
    try {
      await runner.migrateUp(steps === undefined ? {} : { steps });
    } finally {
      await runner.close();
    }
  }

  itWithDatabase(context, 'finds changes made by hand', async () => {
    const live = await context.createDatabase();
    const directory = createBaseDirectory();
    await applyMigrations(live.dsn, directory);
    let report = await detectDrift(live.dsn, getAdminDsn(), directory.load());
    expect(report.isInSync).toBe(true);
    expect(report.appliedMigrationCount).toBe(3);

    await live.query(
      'ALTER TABLE users ADD COLUMN hotfix int; CREATE INDEX idx_hand_made ON orders (id); DROP INDEX idx_orders_user;',
    );
    report = await detectDrift(live.dsn, getAdminDsn(), directory.load());
    expect(report.isInSync).toBe(false);
    const described = report.changes.map(describeSchemaChange).join('; ');
    for (const expected of [
      'column_added users.hotfix',
      'index_added orders.idx_hand_made',
      'index_removed orders.idx_orders_user',
    ]) {
      expect(described).toContain(expected);
    }
  });

  itWithDatabase(context, 'only expects the migrations that were applied', async () => {
    const live = await context.createDatabase();
    const directory = createBaseDirectory();
    await applyMigrations(live.dsn, directory, 2);
    const report = await detectDrift(live.dsn, getAdminDsn(), directory.load());
    expect(report.isInSync).toBe(true);
    expect(report.appliedMigrationCount).toBe(2);
  });

  itWithDatabase(context, 'explains when it cannot compare', async () => {
    const live = await context.createDatabase();
    const directory = createBaseDirectory();
    await applyMigrations(live.dsn, directory);
    directory.removeFile('0002_orders.up.sql').removeFile('0002_orders.down.sql');
    const report = await detectDrift(live.dsn, getAdminDsn(), directory.load());
    expect(report.skippedReason).toContain('0002_orders');
  });
});
