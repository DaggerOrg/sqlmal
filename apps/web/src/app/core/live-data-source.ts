import type { HttpClient } from '@angular/common/http';
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
import type { SqlmalDataSource } from './sqlmal-data-source';
import { requestSqlmalApi } from './sqlmal-api-request';

const HISTORY_LIMIT = 200;

/** Reads one database from a running SQLMal server. */
export class LiveDataSource implements SqlmalDataSource {
  private readonly databasePath: string;
  /** Replaying every migration is slow, so the timeline is fetched once. A failure is not cached. */
  private pendingTimeline: Promise<MigrationTimeline> | undefined;

  constructor(
    private readonly httpClient: HttpClient,
    readonly serverInfo: ServerInfo,
    readonly databaseName: string,
  ) {
    this.databasePath = `api/${encodeURIComponent(databaseName)}`;
  }

  loadMigrations(): Promise<MigrationSummary[]> {
    return this.request(`${this.databasePath}/migrations`);
  }

  loadStatuses(): Promise<MigrationStatus[]> {
    return this.request(`${this.databasePath}/status`);
  }

  loadSchema(): Promise<DatabaseSchema> {
    return this.request(`${this.databasePath}/schema`);
  }

  loadTimeline(): Promise<MigrationTimeline> {
    this.pendingTimeline ??= this.request<MigrationTimeline>(`${this.databasePath}/timeline`).catch(
      (error: unknown) => {
        this.pendingTimeline = undefined;
        throw error;
      },
    );
    return this.pendingTimeline;
  }

  loadDrift(): Promise<DriftReport> {
    return this.request(`${this.databasePath}/drift`);
  }

  loadHistory(): Promise<MigrationHistoryEntry[]> {
    return this.request(`${this.databasePath}/history?limit=${HISTORY_LIMIT}`);
  }

  generateDriftMigration(): Promise<DriftMigrationProposal> {
    return this.request(`${this.databasePath}/generate`, { method: 'POST', body: {} });
  }

  runMigrations(request: RunMigrationsRequest): Promise<RunMigrationsResponse> {
    return this.request(`${this.databasePath}/run`, { method: 'POST', body: request });
  }

  createMigration(request: CreateMigrationRequest): Promise<CreateMigrationResponse> {
    return this.request(`${this.databasePath}/migrations`, { method: 'POST', body: request });
  }

  private request<TResponse>(path: string, options?: Parameters<typeof requestSqlmalApi>[2]): Promise<TResponse> {
    return requestSqlmalApi<TResponse>(this.httpClient, path, options);
  }
}
