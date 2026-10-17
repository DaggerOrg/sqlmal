import type { MigrationRunResult } from '@sqlmal/contracts';

/** Another migrator holds the advisory lock on this database. */
export class MigrationLockedError extends Error {
  override readonly name = 'MigrationLockedError';

  constructor() {
    super('another migration is already running on this database');
  }
}

/** Applied migrations were edited or their files are gone. */
export class DriftedHistoryError extends Error {
  override readonly name = 'DriftedHistoryError';

  constructor(problems: readonly string[]) {
    super(
      `applied migrations no longer match the files: ${problems.join('; ')}. Restore the files, or re-run with force if you are sure`,
    );
  }
}

/** A rollback reached a migration without a down file. */
export class MissingDownMigrationError extends Error {
  override readonly name = 'MissingDownMigrationError';

  constructor(migrationLabel: string) {
    super(`there is no down migration for ${migrationLabel}: roll back stops here`);
  }
}

/** Everything asked for is already done. */
export class NothingToDoError extends Error {
  override readonly name = 'NothingToDoError';

  constructor() {
    super('nothing to do');
  }
}

/** A pending migration is older than one already applied. */
export class OutOfOrderMigrationError extends Error {
  override readonly name = 'OutOfOrderMigrationError';

  constructor(migrationLabel: string) {
    super(
      `a pending migration is older than one already applied: ${migrationLabel}. Renumber it, or allow out-of-order migrations`,
    );
  }
}

/** A version given on the command line or in a request has no migration file. */
export class UnknownVersionError extends Error {
  override readonly name = 'UnknownVersionError';

  constructor(version: number) {
    super(`version ${version} does not exist`);
  }
}

/** A migration ran and failed. `results` says what ran before it and how it failed. */
export class MigrationFailedError extends Error {
  override readonly name = 'MigrationFailedError';

  constructor(
    message: string,
    readonly results: MigrationRunResult[],
  ) {
    super(message);
  }
}

/** The database could not be reached. */
export class DatabaseConnectionError extends Error {
  override readonly name = 'DatabaseConnectionError';
}
