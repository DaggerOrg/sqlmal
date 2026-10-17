import type {
  DriftMigrationProposal,
  DriftReport,
  MigrationDirection,
  MigrationHistoryEntry,
  MigrationRunResult,
  MigrationStatus,
  MigrationSummary,
  MigrationTimeline,
} from './migration.contract';
import type { DatabaseSchema } from './schema.contract';

export interface DatabaseReference {
  name: string;
}

/** `GET /api/info` */
export interface ServerInfo {
  version: string;
  isReadOnly: boolean;
  /** True only for a saved snapshot loaded without a server. */
  isStaticSnapshot: boolean;
  databases: DatabaseReference[];
}

/**
 * `POST /api/:database/run`. Like every write, it must carry the header `X-SQLMal: 1`,
 * which a cross-site form cannot set.
 */
export interface RunMigrationsRequest {
  direction: MigrationDirection;
  /** How many to run: 0 means all for up and one for down. */
  steps?: number;
  /** Stop after this version (up), or roll back to it while keeping it applied (down). */
  targetVersion?: number;
  isDryRun?: boolean;
  /** Run even when applied migrations were edited or are missing. */
  allowDriftedHistory?: boolean;
}

export interface RunMigrationsResponse {
  results: MigrationRunResult[];
  /** Set when there was nothing to do. */
  message?: string;
  /** Set, with status 422, when a migration ran and failed. */
  errorMessage?: string;
}

/** `POST /api/:database/migrations` */
export interface CreateMigrationRequest {
  name: string;
  upSql?: string;
  downSql?: string;
}

export interface CreateMigrationResponse {
  fileName: string;
  migrationCount: number;
}

/** Everything the web UI shows for one database. `sqlmal export` writes it to a file. */
export interface DatabaseSnapshot {
  /** ISO 8601. */
  generatedAt: string;
  databaseName: string;
  migrations: MigrationSummary[];
  statuses: MigrationStatus[];
  schema: DatabaseSchema;
  timeline: MigrationTimeline;
  drift: DriftReport;
  /** The migration that would catch the files up with the live database, if they differ. */
  driftMigration: DriftMigrationProposal | null;
  history: MigrationHistoryEntry[];
}

export type ApiErrorCode =
  | 'unauthorized'
  | 'read_only'
  | 'bad_origin'
  | 'missing_header'
  | 'bad_request'
  | 'unknown_database'
  | 'locked'
  | 'not_allowed'
  | 'timeout'
  | 'not_found'
  | 'failed';

/** The body of every non-2xx API response. */
export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
  };
}
