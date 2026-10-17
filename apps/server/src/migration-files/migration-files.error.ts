/** The migrations directory holds a file or a pair of files that cannot be used. */
export class MigrationFilesError extends Error {
  override readonly name = 'MigrationFilesError';
}

/** A name for a new migration is not safe to use in a file name. */
export class MigrationNameError extends Error {
  override readonly name = 'MigrationNameError';
}
