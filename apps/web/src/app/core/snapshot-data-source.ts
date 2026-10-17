import type {
  CreateMigrationResponse,
  DatabaseSnapshot,
  DriftMigrationProposal,
  RunMigrationsResponse,
  ServerInfo,
} from '@sqlmal/contracts';
import type { SqlmalDataSource } from './sqlmal-data-source';
import { SqlmalApiError } from './sqlmal-api.error';

/** Serves a saved `DatabaseSnapshot`. Everything is read only. */
export class SnapshotDataSource implements SqlmalDataSource {
  readonly serverInfo: ServerInfo;
  readonly databaseName: string;

  constructor(private readonly snapshot: DatabaseSnapshot) {
    this.databaseName = snapshot.databaseName;
    this.serverInfo = {
      version: 'snapshot',
      isReadOnly: true,
      isStaticSnapshot: true,
      databases: [{ name: snapshot.databaseName }],
    };
  }

  loadMigrations(): Promise<DatabaseSnapshot['migrations']> {
    return Promise.resolve(this.snapshot.migrations);
  }

  loadStatuses(): Promise<DatabaseSnapshot['statuses']> {
    return Promise.resolve(this.snapshot.statuses);
  }

  loadSchema(): Promise<DatabaseSnapshot['schema']> {
    return Promise.resolve(this.snapshot.schema);
  }

  loadTimeline(): Promise<DatabaseSnapshot['timeline']> {
    return Promise.resolve(this.snapshot.timeline);
  }

  loadDrift(): Promise<DatabaseSnapshot['drift']> {
    return Promise.resolve(this.snapshot.drift);
  }

  loadHistory(): Promise<DatabaseSnapshot['history']> {
    return Promise.resolve(this.snapshot.history);
  }


  generateDriftMigration(): Promise<DriftMigrationProposal> {
    const { driftMigration } = this.snapshot;
    return driftMigration
      ? Promise.resolve(driftMigration)
      : Promise.reject(new SqlmalApiError(404, 'not_found', 'There is no drift, so nothing to generate.'));
  }

  runMigrations(): Promise<RunMigrationsResponse> {
    return Promise.reject(createReadOnlyError());
  }

  createMigration(): Promise<CreateMigrationResponse> {
    return Promise.reject(createReadOnlyError());
  }
}

function createReadOnlyError(): SqlmalApiError {
  return new SqlmalApiError(
    403,
    'read_only',
    'This is a saved snapshot. Run SQLMal against your own database to use this.',
  );
}
