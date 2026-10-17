import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { MigrationTimeline, RunMigrationsResponse, ServerInfo } from '@sqlmal/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabaseSnapshot } from '../../testing/database-snapshot.fixture';
import { SqlmalApiService } from './sqlmal-api.service';
import { SqlmalApiError } from './sqlmal-api.error';

const LIVE_SERVER_INFO: ServerInfo = {
  version: '1.0.0',
  isReadOnly: false,
  isStaticSnapshot: false,
  databases: [{ name: 'shop db' }],
};

/** Lets pending promise callbacks run, so the next request has been sent. */
const flushPromises = (): Promise<void> => new Promise((resolve) => setTimeout(resolve));

describe('SqlmalApiService', () => {
  let api: SqlmalApiService;
  let httpTesting: HttpTestingController;

  beforeEach(() => {
    sessionStorage.clear();
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    api = TestBed.inject(SqlmalApiService);
    httpTesting = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpTesting.verify();
  });

  it('falls back to the saved snapshot when there is no server, and keeps it read only', async () => {
    const connecting = api.connect();
    httpTesting.expectOne('api/info').flush('Not found', { status: 404, statusText: 'Not Found' });
    await flushPromises();
    httpTesting.expectOne('demo.json').flush(createDatabaseSnapshot());
    const dataSource = await connecting;

    expect(api.databaseName()).toBe('shop');
    expect(dataSource.serverInfo).toMatchObject({ isReadOnly: true, isStaticSnapshot: true });
    expect(await dataSource.loadHistory()).toEqual([]);
    await expect(dataSource.runMigrations({ direction: 'up' })).rejects.toMatchObject({ code: 'read_only' });
    await expect(dataSource.generateDriftMigration()).rejects.toMatchObject({ code: 'not_found' });
  });

  it('reports that there is no backend when neither the server nor the snapshot answers', async () => {
    const connecting = api.connect();
    httpTesting.expectOne('api/info').error(new ProgressEvent('error'));
    await flushPromises();
    httpTesting.expectOne('demo.json').flush('Not found', { status: 404, statusText: 'Not Found' });
    await expect(connecting).rejects.toMatchObject({ code: 'no_backend', status: 0 });
  });

  it('asks for a token instead of falling back when the server says unauthorized', async () => {
    const connecting = api.connect();
    httpTesting
      .expectOne('api/info')
      .flush({ error: { code: 'unauthorized', message: 'Token required.' } }, { status: 401, statusText: '' });
    const error: unknown = await connecting.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SqlmalApiError);
    expect(error).toMatchObject({ code: 'unauthorized', status: 401, message: 'Token required.' });
  });

  describe('with a live server', () => {
    beforeEach(async () => {
      sessionStorage.setItem('ms-token', 'secret');
      const connecting = api.connect();
      httpTesting.expectOne('api/info').flush(LIVE_SERVER_INFO);
      await connecting;
    });

    it('sends the token, and marks writes with X-SQLMal and a JSON body', async () => {
      const running = api.dataSource.runMigrations({ direction: 'up', isDryRun: true });
      const request = httpTesting.expectOne('api/shop%20db/run');
      expect(request.request.method).toBe('POST');
      expect(request.request.headers.get('Authorization')).toBe('Bearer secret');
      expect(request.request.headers.get('X-SQLMal')).toBe('1');
      expect(request.request.headers.get('Content-Type')).toBe('application/json');
      expect(JSON.parse(request.request.body as string)).toEqual({ direction: 'up', isDryRun: true });
      request.flush(JSON.stringify({ results: [] } satisfies RunMigrationsResponse));
      expect(await running).toEqual({ results: [] });
    });

    it('treats a 422 from a run as a result that reports the failure', async () => {
      const failedRun: RunMigrationsResponse = { results: [], errorMessage: 'syntax error' };
      const running = api.dataSource.runMigrations({ direction: 'up' });
      httpTesting
        .expectOne('api/shop%20db/run')
        .flush(JSON.stringify(failedRun), { status: 422, statusText: 'Unprocessable Content' });
      expect(await running).toEqual(failedRun);
    });

    it('turns an error response into a SqlmalApiError with its code and status', async () => {
      const loading = api.dataSource.loadSchema();
      httpTesting
        .expectOne('api/shop%20db/schema')
        .flush(JSON.stringify({ error: { code: 'timeout', message: 'Took too long.' } }), {
          status: 504,
          statusText: 'Gateway Timeout',
        });
      await expect(loading).rejects.toMatchObject({ code: 'timeout', status: 504, message: 'Took too long.' });
    });

    it('fetches the timeline once, but retries after a failure', async () => {
      const timeline: MigrationTimeline = {
        steps: [],
        finalSchema: { tables: [], enums: [] },
        isFullyReversible: true,
      };
      const firstAttempt = api.dataSource.loadTimeline();
      httpTesting.expectOne('api/shop%20db/timeline').flush('', { status: 500, statusText: 'Server Error' });
      await expect(firstAttempt).rejects.toMatchObject({ status: 500 });

      const secondAttempt = api.dataSource.loadTimeline();
      httpTesting.expectOne('api/shop%20db/timeline').flush(JSON.stringify(timeline));
      expect(await secondAttempt).toEqual(timeline);
      expect(await api.dataSource.loadTimeline()).toEqual(timeline);
    });
  });
});
