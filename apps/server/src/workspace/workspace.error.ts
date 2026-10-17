/** The request names a database the config does not list. */
export class UnknownDatabaseError extends Error {
  override readonly name = 'UnknownDatabaseError';

  constructor(databaseName: string) {
    super(`unknown database ${JSON.stringify(databaseName)}`);
  }
}

/** The drift cannot be turned into a migration; the message says why. */
export class DriftUnavailableError extends Error {
  override readonly name = 'DriftUnavailableError';
}
