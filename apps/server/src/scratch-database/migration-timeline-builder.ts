import type { DatabaseSchema, MigrationTimeline, SchemaChange, TimelineStep } from '@sqlmal/contracts';
import { Client } from 'pg';

import type { Migration } from '../migration-files/migration';
import { MigrationRunner } from '../migration-runner/migration-runner';
import { MigrationFailedError } from '../migration-runner/migration-runner.error';
import { compareSchemas, createEmptySchema } from '../schema/schema-comparison';
import { readSchema, readSchemaInTransaction } from '../schema/schema-introspection';
import { describeError } from '../shared/error-message';
import { ScratchDatabase } from './scratch-database';

export const SCRATCH_LOCK_WAIT_MS = 5000;

/** Reads the schema of a database over a short-lived connection. */
export async function readSchemaFromDsn(dsn: string): Promise<DatabaseSchema> {
  const client = new Client({ connectionString: dsn });
  client.on('error', () => undefined);
  await client.connect();
  try {
    return await readSchema(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

interface ReversibilityCheck {
  isReversible: boolean;
  reverseDifferences: SchemaChange[];
  note: string;
}

/**
 * Runs a down migration in a transaction it then rolls back, and says whether the schema
 * ended up as it was before the migration's up.
 */
async function tryDownMigration(probe: Client, downSql: string, before: DatabaseSchema): Promise<ReversibilityCheck> {
  await probe.query('BEGIN');
  try {
    try {
      await probe.query(downSql);
    } catch (error) {
      return { isReversible: false, reverseDifferences: [], note: `the down migration failed: ${describeError(error)}` };
    }
    const after = await readSchemaInTransaction(probe);
    const differences = compareSchemas(before, after);
    if (differences.length === 0) {
      return { isReversible: true, reverseDifferences: [], note: '' };
    }
    return {
      isReversible: false,
      reverseDifferences: differences,
      note: 'after rolling back, the schema is not the same as before this migration',
    };
  } finally {
    await probe.query('ROLLBACK').catch(() => undefined);
  }
}

/**
 * Applies every migration in order to a scratch database, recording the schema after each,
 * and checks each down on its own: it runs inside a transaction that is always rolled back,
 * and is compared with the schema from just before its up.
 */
export async function buildMigrationTimeline(
  adminDsn: string,
  migrations: readonly Migration[],
): Promise<MigrationTimeline> {
  const scratch = await ScratchDatabase.create(adminDsn);
  try {
    const runner = await MigrationRunner.open(scratch.dsn, migrations);
    try {
      const probe = new Client({ connectionString: scratch.dsn });
      probe.on('error', () => undefined);
      await probe.connect();
      try {
        return await replayMigrations(runner, probe, scratch.dsn, migrations);
      } finally {
        await probe.end().catch(() => undefined);
      }
    } finally {
      await runner.close();
    }
  } finally {
    await scratch.drop();
  }
}

async function replayMigrations(
  runner: MigrationRunner,
  probe: Client,
  scratchDsn: string,
  migrations: readonly Migration[],
): Promise<MigrationTimeline> {
  let previous = createEmptySchema();
  const steps: TimelineStep[] = [];
  let isFullyReversible = true;
  let failedVersion: number | undefined;
  for (const migration of migrations) {
    const startMs = performance.now();
    let errorMessage: string | undefined;
    try {
      await runner.migrateUp({ steps: 1, lockWaitMs: SCRATCH_LOCK_WAIT_MS });
    } catch (error) {
      errorMessage = describeError(error);
      if (error instanceof MigrationFailedError) {
        const last = error.results.at(-1);
        if (last?.errorMessage !== undefined) {
          errorMessage = last.errorMessage;
          if (last.errorLine !== undefined && last.errorLine > 0) {
            errorMessage = `${errorMessage} (line ${last.errorLine})`;
          }
        }
      }
    }
    const step: TimelineStep = {
      version: migration.version,
      name: migration.name,
      schema: previous,
      changes: [],
      applyDurationMs: Math.floor(performance.now() - startMs),
      isReversible: null,
      reverseDifferences: [],
    };
    if (errorMessage !== undefined) {
      step.errorMessage = errorMessage;
      steps.push(step);
      failedVersion = migration.version;
      isFullyReversible = false;
      break;
    }
    const current = await readSchemaFromDsn(scratchDsn);
    step.schema = current;
    step.changes = compareSchemas(previous, current);
    if (migration.isIrreversible) {
      step.reversibilityNote = 'one-way by design (marked irreversible)';
    } else if (!migration.hasDown) {
      step.reversibilityNote = 'there is no down migration';
      isFullyReversible = false;
    } else if (migration.isDownNonTransactional) {
      step.reversibilityNote = 'the down runs outside a transaction, so it cannot be tried safely';
      isFullyReversible = false;
    } else {
      const check = await tryDownMigration(probe, migration.downSql, previous);
      step.isReversible = check.isReversible;
      step.reverseDifferences = check.reverseDifferences;
      if (check.note !== '') {
        step.reversibilityNote = check.note;
      }
      if (!check.isReversible) {
        isFullyReversible = false;
      }
    }
    steps.push(step);
    previous = current;
  }
  const timeline: MigrationTimeline = {
    steps,
    finalSchema: previous,
    isFullyReversible: isFullyReversible && steps.length > 0,
  };
  if (failedVersion !== undefined) {
    timeline.failedVersion = failedVersion;
  }
  return timeline;
}
