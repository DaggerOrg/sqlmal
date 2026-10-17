import type { DatabaseSchema, GeneratedSql, SchemaChange } from './schema.contract';

export type MigrationDirection = 'up' | 'down';

export type LintSeverity = 'error' | 'warning' | 'info';

/** A risky statement found in a migration file. */
export interface LintFinding {
  /** Stable rule identifier, `L001` to `L010`. */
  ruleId: string;
  severity: LintSeverity;
  file: MigrationDirection;
  /** 1-based line in the file where the statement starts. */
  line: number;
  message: string;
  hint?: string;
}

/** A migration file pair as the UI shows it. File paths are deliberately left out. */
export interface MigrationSummary {
  version: number;
  name: string;
  upSql: string;
  downSql: string;
  /** SHA-256 of the normalised up file. */
  checksum: string;
  /** The up file asks, with `-- migrate:no-transaction`, to run outside a transaction. */
  isNonTransactional: boolean;
  hasDown: boolean;
  /** The down file says, with `-- migrate:irreversible`, that this is one-way on purpose. */
  isIrreversible: boolean;
  lintFindings: LintFinding[];
}

export type MigrationState = 'applied' | 'pending' | 'modified' | 'missing';

/** One migration's state, joined from the files and the database. */
export interface MigrationStatus {
  version: number;
  name: string;
  state: MigrationState;
  /** Absent when the file is missing. */
  checksum?: string;
  appliedChecksum?: string;
  /** ISO 8601. */
  appliedAt?: string;
  durationMs?: number;
  appliedBy?: string;
  hasDown: boolean;
  isNonTransactional: boolean;
  /** Pending, but older than a migration that is already applied. */
  isOutOfOrder: boolean;
}

/** One run of a migration, successful or not. */
export interface MigrationHistoryEntry {
  id: number;
  version: number;
  name: string;
  direction: MigrationDirection;
  isSuccess: boolean;
  errorMessage?: string;
  /** ISO 8601. */
  startedAt: string;
  durationMs: number;
  appliedBy: string;
}

/** What happened to one migration during an up or down run. */
export interface MigrationRunResult {
  version: number;
  name: string;
  direction: MigrationDirection;
  isDryRun: boolean;
  skippedReason?: string;
  errorMessage?: string;
  /** 1-based line of the failing statement, when it could be located. */
  errorLine?: number;
  durationMs: number;
}

/** The schema after one migration, replayed in a scratch database. */
export interface TimelineStep {
  version: number;
  name: string;
  schema: DatabaseSchema;
  changes: SchemaChange[];
  applyDurationMs: number;
  errorMessage?: string;
  /** `null` when it was not checked (no down file, or an earlier problem). */
  isReversible: boolean | null;
  /** What the down migration left behind. */
  reverseDifferences: SchemaChange[];
  reversibilityNote?: string;
}

export interface MigrationTimeline {
  steps: TimelineStep[];
  finalSchema: DatabaseSchema;
  isFullyReversible: boolean;
  /** The version whose up migration failed, if any. */
  failedVersion?: number;
}

/** The live database compared with what its applied migrations should have produced. */
export interface DriftReport {
  appliedMigrationCount: number;
  /** Why no comparison was possible. */
  skippedReason?: string;
  isInSync: boolean;
  changes: SchemaChange[];
  expectedSchema: DatabaseSchema;
  liveSchema: DatabaseSchema;
}

/** A migration that would bring the files in line with the live database. */
export interface DriftMigrationProposal {
  up: GeneratedSql;
  down: GeneratedSql;
  changes: SchemaChange[];
}
