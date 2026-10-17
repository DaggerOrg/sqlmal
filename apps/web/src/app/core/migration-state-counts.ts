import type { MigrationState, MigrationStatus } from '@sqlmal/contracts';

export type MigrationStateCounts = Record<MigrationState, number>;

/** How many migrations are in each state. */
export function countMigrationStates(statuses: readonly MigrationStatus[]): MigrationStateCounts {
  const counts: MigrationStateCounts = { applied: 0, pending: 0, modified: 0, missing: 0 };
  for (const status of statuses) counts[status.state]++;
  return counts;
}
