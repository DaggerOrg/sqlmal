import type { DatabaseSchema, DatabaseSnapshot } from '@sqlmal/contracts';

const EMPTY_SCHEMA: DatabaseSchema = { tables: [], enums: [] };

/** A small, valid snapshot for tests. */
export function createDatabaseSnapshot(overrides: Partial<DatabaseSnapshot> = {}): DatabaseSnapshot {
  return {
    generatedAt: '2026-10-10T09:45:41Z',
    databaseName: 'shop',
    migrations: [],
    statuses: [],
    schema: EMPTY_SCHEMA,
    timeline: { steps: [], finalSchema: EMPTY_SCHEMA, isFullyReversible: true },
    drift: {
      appliedMigrationCount: 0,
      isInSync: true,
      changes: [],
      expectedSchema: EMPTY_SCHEMA,
      liveSchema: EMPTY_SCHEMA,
    },
    driftMigration: null,
    history: [],
    ...overrides,
  };
}
