import { writeFileSync } from 'node:fs';

import { Inject, Injectable } from '@nestjs/common';
import { Client } from 'pg';
import type {
  DatabaseSchema,
  DatabaseSnapshot,
  DriftMigrationProposal,
  DriftReport,
  MigrationDirection,
  MigrationHistoryEntry,
  MigrationRunResult,
  MigrationStatus,
  MigrationSummary,
  MigrationTimeline,
} from '@sqlmal/contracts';

import { lintMigration } from '../lint/lint-rules';
import type { Migration } from '../migration-files/migration';
import { createMigrationFiles, loadMigrations } from '../migration-files/migration-loader';
import type { MigrationRunOptions } from '../migration-runner/migration-run-options';
import { MigrationRunner } from '../migration-runner/migration-runner';
import type { DatabaseConfig, ProjectConfig } from '../project-config/project-config';
import { resolveDatabaseDsn } from '../project-config/project-config-loader';
import { generateSchemaSql } from '../schema/schema-sql-generator';
import { deriveAdminDsn } from '../scratch-database/database-dsn';
import { detectDrift } from '../scratch-database/drift-detector';
import { buildMigrationTimeline } from '../scratch-database/migration-timeline-builder';
import { readSchema } from '../schema/schema-introspection';
import { describeError } from '../shared/error-message';
import { DatabaseConnectionError } from '../migration-runner/migration-runner.error';
import { computeMigrationFingerprint } from './migration-fingerprint';
import { TtlCache } from './ttl-cache';
import { DriftUnavailableError, UnknownDatabaseError } from './workspace.error';

export const PROJECT_CONFIG = Symbol('PROJECT_CONFIG');

const TIMELINE_CACHE_TTL_MS = 10 * 60 * 1000;
const SNAPSHOT_HISTORY_LIMIT = 200;

/**
 * The layer the CLI and the HTTP API share: it knows the configured databases and offers each
 * operation as one call.
 */
@Injectable()
export class WorkspaceService {
  private readonly databasesByName = new Map<string, DatabaseConfig>();
  private readonly shadowAdminDsn: string;
  private readonly cache = new TtlCache();

  constructor(@Inject(PROJECT_CONFIG) config: ProjectConfig) {
    for (const database of config.databases) {
      this.databasesByName.set(database.name, database);
    }
    const variableName = config.shadowAdminDsnEnvironmentVariable;
    this.shadowAdminDsn = variableName === undefined ? '' : (process.env[variableName] ?? '');
  }

  listDatabaseNames(): string[] {
    return [...this.databasesByName.keys()];
  }

  /** How many results the cache holds, for tests. */
  get cachedResultCount(): number {
    return this.cache.entryCount;
  }

  getMigrationsDirectory(databaseName: string): string {
    return this.findDatabase(databaseName).migrationsDirectory;
  }

  loadMigrations(databaseName: string): Migration[] {
    return loadMigrations(this.getMigrationsDirectory(databaseName));
  }

  /** The migration files with their lint findings. File paths are left out. */
  listMigrations(databaseName: string): MigrationSummary[] {
    return this.loadMigrations(databaseName).map((migration) => ({
      version: migration.version,
      name: migration.name,
      upSql: migration.upSql,
      downSql: migration.downSql,
      checksum: migration.checksum,
      isNonTransactional: migration.isNonTransactional,
      hasDown: migration.hasDown,
      isIrreversible: migration.isIrreversible,
      lintFindings: lintMigration(migration),
    }));
  }

  async readStatuses(databaseName: string): Promise<MigrationStatus[]> {
    return this.withRunner(databaseName, (runner) => runner.readStatuses());
  }

  async readHistory(databaseName: string, limit: number): Promise<MigrationHistoryEntry[]> {
    return this.withRunner(databaseName, (runner) => runner.readHistory(limit));
  }

  /** Reads the live schema. */
  async readSchema(databaseName: string): Promise<DatabaseSchema> {
    const client = new Client({ connectionString: this.resolveDsn(databaseName) });
    client.on('error', () => undefined);
    try {
      await client.connect();
    } catch (error) {
      throw new DatabaseConnectionError(`connect: ${describeError(error)}`, { cause: error });
    }
    try {
      return await readSchema(client);
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  /** Replays the migrations in a scratch database. Cached until a migration file changes. */
  async buildTimeline(databaseName: string): Promise<MigrationTimeline> {
    const migrations = this.loadMigrations(databaseName);
    const adminDsn = this.resolveAdminDsn(this.resolveDsn(databaseName));
    const cacheKey = `${databaseName}:timeline:${computeMigrationFingerprint(migrations)}`;
    return this.cache.remember(cacheKey, TIMELINE_CACHE_TTL_MS, () => buildMigrationTimeline(adminDsn, migrations));
  }

  /** Compares the live database with what its applied migrations produce. */
  async detectDrift(databaseName: string): Promise<DriftReport> {
    const migrations = this.loadMigrations(databaseName);
    const dsn = this.resolveDsn(databaseName);
    return detectDrift(dsn, this.resolveAdminDsn(dsn), migrations);
  }

  /** Applies or rolls back migrations. */
  async runMigrations(
    databaseName: string,
    direction: MigrationDirection,
    options: MigrationRunOptions,
  ): Promise<MigrationRunResult[]> {
    return this.withChangingRunner(databaseName, (runner) =>
      direction === 'up' ? runner.migrateUp(options) : runner.migrateDown(options),
    );
  }

  async migrateTo(databaseName: string, targetVersion: number, options: MigrationRunOptions): Promise<MigrationRunResult[]> {
    return this.withChangingRunner(databaseName, (runner) => runner.migrateTo(targetVersion, options));
  }

  async recordBaseline(databaseName: string, version: number): Promise<void> {
    await this.withChangingRunner(databaseName, (runner) => runner.recordBaseline(version));
  }

  /**
   * Proposes a migration from the drift: up turns the expected schema into the live one,
   * down goes back.
   */
  async proposeDriftMigration(databaseName: string): Promise<DriftMigrationProposal> {
    const report = await this.detectDrift(databaseName);
    if (report.skippedReason !== undefined) {
      throw new DriftUnavailableError(report.skippedReason);
    }
    return buildDriftProposal(report);
  }

  /** Writes a new migration pair with the given SQL and returns the up file's path. */
  createMigration(databaseName: string, label: string, upSql: string, downSql: string): string {
    const directory = this.getMigrationsDirectory(databaseName);
    const { upPath, downPath } = createMigrationFiles(directory, label, new Date());
    if (upSql !== '') {
      writeFileSync(upPath, upSql, { mode: 0o644 });
    }
    if (downSql !== '') {
      writeFileSync(downPath, downSql, { mode: 0o644 });
    }
    this.forgetDatabase(databaseName);
    return upPath;
  }

  /** Everything the web UI shows for one database. `export` writes it to a file. */
  async buildSnapshot(databaseName: string): Promise<DatabaseSnapshot> {
    const generatedAt = new Date().toISOString();
    const migrations = this.listMigrations(databaseName);
    const statuses = await this.readStatuses(databaseName);
    const schema = await this.readSchema(databaseName);
    const timeline = await this.buildTimeline(databaseName);
    const drift = await this.detectDrift(databaseName);
    const driftMigration = !drift.isInSync && drift.skippedReason === undefined ? buildDriftProposal(drift) : null;
    const history = (await this.readHistory(databaseName, SNAPSHOT_HISTORY_LIMIT)).sort(
      (left, right) => right.id - left.id,
    );
    return { generatedAt, databaseName, migrations, statuses, schema, timeline, drift, driftMigration, history };
  }

  private findDatabase(databaseName: string): DatabaseConfig {
    const database = this.databasesByName.get(databaseName);
    if (database === undefined) {
      throw new UnknownDatabaseError(databaseName);
    }
    return database;
  }

  private resolveDsn(databaseName: string): string {
    return resolveDatabaseDsn(this.findDatabase(databaseName));
  }

  private resolveAdminDsn(targetDsn: string): string {
    return this.shadowAdminDsn !== '' ? this.shadowAdminDsn : deriveAdminDsn(targetDsn);
  }

  private forgetDatabase(databaseName: string): void {
    this.cache.forgetByPrefix(`${databaseName}:`);
  }

  private async withRunner<TResult>(
    databaseName: string,
    operation: (runner: MigrationRunner) => Promise<TResult>,
  ): Promise<TResult> {
    const migrations = this.loadMigrations(databaseName);
    const runner = await MigrationRunner.open(this.resolveDsn(databaseName), migrations);
    try {
      return await operation(runner);
    } finally {
      await runner.close();
    }
  }

  private async withChangingRunner<TResult>(
    databaseName: string,
    operation: (runner: MigrationRunner) => Promise<TResult>,
  ): Promise<TResult> {
    try {
      return await this.withRunner(databaseName, operation);
    } finally {
      this.forgetDatabase(databaseName);
    }
  }
}

function buildDriftProposal(report: DriftReport): DriftMigrationProposal {
  return {
    up: generateSchemaSql(report.expectedSchema, report.liveSchema),
    down: generateSchemaSql(report.liveSchema, report.expectedSchema),
    changes: report.changes,
  };
}
