/** Options for one run. The empty object is a safe default. */
export interface MigrationRunOptions {
  /** How many migrations run: 0 or absent means all for up and one for down. */
  steps?: number;
  /** Stop after this version (up), or roll back to it while keeping it applied (down). */
  targetVersion?: number;
  isDryRun?: boolean;
  /** Run even when applied migrations were edited or are missing. */
  allowDriftedHistory?: boolean;
  /** Apply a pending migration older than the newest applied one. */
  allowOutOfOrder?: boolean;
  /** How long to wait for another migrator. Default 10 s. */
  lockWaitMs?: number;
  /** Bounds waiting for table locks inside a migration. Default 10 s. */
  lockTimeoutMs?: number;
  /** Bounds each migration. Default none. */
  statementTimeoutMs?: number;
}

export const DEFAULT_LOCK_WAIT_MS = 10_000;
export const DEFAULT_LOCK_TIMEOUT_MS = 10_000;

export function resolveLockWaitMs(options: MigrationRunOptions): number {
  return options.lockWaitMs !== undefined && options.lockWaitMs > 0 ? options.lockWaitMs : DEFAULT_LOCK_WAIT_MS;
}

export function resolveLockTimeoutMs(options: MigrationRunOptions): number {
  return options.lockTimeoutMs !== undefined && options.lockTimeoutMs > 0
    ? options.lockTimeoutMs
    : DEFAULT_LOCK_TIMEOUT_MS;
}
