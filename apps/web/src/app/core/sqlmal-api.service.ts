import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import type { DatabaseSnapshot, ServerInfo } from '@sqlmal/contracts';
import { firstValueFrom } from 'rxjs';
import { LiveDataSource } from './live-data-source';
import { requestSqlmalApi } from './sqlmal-api-request';
import { SqlmalApiError } from './sqlmal-api.error';
import type { SqlmalDataSource } from './sqlmal-data-source';
import { SnapshotDataSource } from './snapshot-data-source';

const DEFAULT_DATABASE_NAME = 'default';
const SNAPSHOT_PATH = 'demo.json';

/**
 * The only way the UI reaches its data. It talks to a live server when there is one, and otherwise
 * falls back to the saved snapshot `demo.json`; components cannot tell the difference.
 */
@Injectable({ providedIn: 'root' })
export class SqlmalApiService {
  private readonly httpClient = inject(HttpClient);
  private readonly connectedDataSource = signal<SqlmalDataSource | undefined>(undefined);

  readonly isConnected = computed(() => this.connectedDataSource() !== undefined);
  readonly serverInfo = computed(() => this.connectedDataSource()?.serverInfo);
  readonly databaseName = computed(() => this.connectedDataSource()?.databaseName ?? '');

  /** The connected data source. Only call this after `connect()` has resolved. */
  get dataSource(): SqlmalDataSource {
    const dataSource = this.connectedDataSource();
    if (!dataSource) throw new Error('SqlmalApiService.dataSource was read before connect() finished.');
    return dataSource;
  }

  /** Connects to a live server if there is one; otherwise loads the snapshot. */
  async connect(): Promise<SqlmalDataSource> {
    const dataSource = await this.findDataSource();
    this.connectedDataSource.set(dataSource);
    return dataSource;
  }

  private async findDataSource(): Promise<SqlmalDataSource> {
    try {
      const serverInfo = await requestSqlmalApi<ServerInfo>(this.httpClient, 'api/info');
      return new LiveDataSource(
        this.httpClient,
        serverInfo,
        serverInfo.databases[0]?.name ?? DEFAULT_DATABASE_NAME,
      );
    } catch (error: unknown) {
      if (error instanceof SqlmalApiError && error.code === 'unauthorized') throw error;
    }
    try {
      const snapshot = await firstValueFrom(this.httpClient.get<DatabaseSnapshot>(SNAPSHOT_PATH));
      return new SnapshotDataSource(snapshot);
    } catch {
      throw new SqlmalApiError(0, 'no_backend', 'No SQLMal server was found, and there is no demo snapshot.');
    }
  }
}
