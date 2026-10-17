import type { MigrationDirection, MigrationStatus } from '@sqlmal/contracts';

import type { Migration } from '../migration-files/migration';
import { formatVersion } from '../migration-files/migration-loader';
import type { MigrationRunOptions } from './migration-run-options';
import { DriftedHistoryError, OutOfOrderMigrationError } from './migration-runner.error';

/** One row of `schema_migrations`. */
export interface AppliedMigrationRecord {
  version: number;
  name: string;
  checksum: string;
  appliedAt: Date;
  durationMs: number;
  appliedBy: string;
}

export function formatMigrationLabel(version: number, name: string): string {
  return `${formatVersion(version)}_${name}`;
}

/** Joins the files with what the database has recorded, sorted by version. */
export function buildMigrationStatuses(
  migrations: readonly Migration[],
  appliedByVersion: ReadonlyMap<number, AppliedMigrationRecord>,
): MigrationStatus[] {
  let highestAppliedVersion = 0;
  for (const version of appliedByVersion.keys()) {
    highestAppliedVersion = Math.max(highestAppliedVersion, version);
  }
  const statuses: MigrationStatus[] = [];
  const seenVersions = new Set<number>();
  for (const migration of migrations) {
    seenVersions.add(migration.version);
    const status: MigrationStatus = {
      version: migration.version,
      name: migration.name,
      state: 'pending',
      checksum: migration.checksum,
      hasDown: migration.hasDown,
      isNonTransactional: migration.isNonTransactional,
      isOutOfOrder: false,
    };
    const applied = appliedByVersion.get(migration.version);
    if (applied !== undefined) {
      Object.assign(status, describeApplied(applied));
      status.state = applied.checksum === migration.checksum ? 'applied' : 'modified';
    } else if (migration.version < highestAppliedVersion) {
      status.isOutOfOrder = true;
    }
    statuses.push(status);
  }
  for (const applied of appliedByVersion.values()) {
    if (seenVersions.has(applied.version)) {
      continue;
    }
    statuses.push({
      version: applied.version,
      name: applied.name,
      state: 'missing',
      ...describeApplied(applied),
      hasDown: false,
      isNonTransactional: false,
      isOutOfOrder: false,
    });
  }
  return statuses.sort((left, right) => left.version - right.version);
}

function describeApplied(applied: AppliedMigrationRecord): Partial<MigrationStatus> {
  return {
    appliedChecksum: applied.checksum,
    appliedAt: applied.appliedAt.toISOString(),
    durationMs: applied.durationMs,
    appliedBy: applied.appliedBy,
  };
}

/** Refuses to run on top of a history that no longer matches the files. */
export function guardMigrationHistory(
  statuses: readonly MigrationStatus[],
  options: MigrationRunOptions,
  direction: MigrationDirection,
): void {
  if (options.allowDriftedHistory === true) {
    return;
  }
  const problems: string[] = [];
  for (const status of statuses) {
    const label = formatMigrationLabel(status.version, status.name);
    if (status.state === 'modified') {
      problems.push(`${label} was edited after it was applied`);
    } else if (status.state === 'missing') {
      problems.push(`${label} was applied but its file is missing`);
    }
  }
  if (problems.length > 0) {
    throw new DriftedHistoryError(problems);
  }
  if (direction === 'up' && options.allowOutOfOrder !== true) {
    const outOfOrder = statuses.find((status) => status.state === 'pending' && status.isOutOfOrder);
    if (outOfOrder !== undefined) {
      throw new OutOfOrderMigrationError(formatMigrationLabel(outOfOrder.version, outOfOrder.name));
    }
  }
}
