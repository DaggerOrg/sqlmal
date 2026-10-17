import type {
  CreateMigrationRequest,
  CreateMigrationResponse,
  DatabaseSchema,
  DriftMigrationProposal,
  DriftReport,
  MigrationHistoryEntry,
  MigrationStatus,
  MigrationSummary,
  MigrationTimeline,
  RunMigrationsRequest,
  RunMigrationsResponse,
  ServerInfo,
} from '@sqlmal/contracts';

/** One interface for both modes: a live server, or a saved snapshot (the demo). */
export interface SqlmalDataSource {
  readonly serverInfo: ServerInfo;
  readonly databaseName: string;
  loadMigrations(): Promise<MigrationSummary[]>;
  loadStatuses(): Promise<MigrationStatus[]>;
  loadSchema(): Promise<DatabaseSchema>;
  loadTimeline(): Promise<MigrationTimeline>;
  loadDrift(): Promise<DriftReport>;
  loadHistory(): Promise<MigrationHistoryEntry[]>;
  generateDriftMigration(): Promise<DriftMigrationProposal>;
  runMigrations(request: RunMigrationsRequest): Promise<RunMigrationsResponse>;
  createMigration(request: CreateMigrationRequest): Promise<CreateMigrationResponse>;
}
