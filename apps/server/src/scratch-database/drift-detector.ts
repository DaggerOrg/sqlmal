import type { DriftReport } from '@sqlmal/contracts';

import type { Migration } from '../migration-files/migration';
import { findMigrationByVersion } from '../migration-files/migration-loader';
import { MigrationRunner } from '../migration-runner/migration-runner';
import { formatMigrationLabel } from '../migration-runner/migration-status-builder';
import { compareSchemas, createEmptySchema } from '../schema/schema-comparison';
import { describeError } from '../shared/error-message';
import { readSchemaFromDsn, SCRATCH_LOCK_WAIT_MS } from './migration-timeline-builder';
import { ScratchDatabase } from './scratch-database';

/**
 * Builds the schema the applied migrations should give, in a scratch database, and compares
 * it with the live one. A change listed means the live database has it and the migrations do
 * not (someone changed it by hand), or the other way round.
 */
export async function detectDrift(
  liveDsn: string,
  adminDsn: string,
  migrations: readonly Migration[],
): Promise<DriftReport> {
  const live = await MigrationRunner.open(liveDsn, migrations);
  let statuses;
  try {
    statuses = await live.readStatuses();
  } finally {
    await live.close();
  }
  const appliedMigrations: Migration[] = [];
  for (const status of statuses) {
    if (status.state === 'missing') {
      return {
        appliedMigrationCount: 0,
        skippedReason: `migration ${formatMigrationLabel(status.version, status.name)} was applied but its file is missing, so the expected schema cannot be rebuilt`,
        isInSync: false,
        changes: [],
        expectedSchema: createEmptySchema(),
        liveSchema: createEmptySchema(),
      };
    }
    if (status.state === 'applied' || status.state === 'modified') {
      const migration = findMigrationByVersion(migrations, status.version);
      if (migration !== undefined) {
        appliedMigrations.push(migration);
      }
    }
  }
  const liveSchema = await readSchemaFromDsn(liveDsn);
  const scratch = await ScratchDatabase.create(adminDsn);
  try {
    const runner = await MigrationRunner.open(scratch.dsn, appliedMigrations);
    try {
      if (appliedMigrations.length > 0) {
        try {
          await runner.migrateUp({ lockWaitMs: SCRATCH_LOCK_WAIT_MS });
        } catch (error) {
          throw new Error(`rebuild the expected schema: ${describeError(error)}`, { cause: error });
        }
      }
    } finally {
      await runner.close();
    }
    const expectedSchema = await readSchemaFromDsn(scratch.dsn);
    const changes = compareSchemas(expectedSchema, liveSchema);
    return {
      appliedMigrationCount: appliedMigrations.length,
      isInSync: changes.length === 0,
      changes,
      expectedSchema,
      liveSchema,
    };
  } finally {
    await scratch.drop();
  }
}
