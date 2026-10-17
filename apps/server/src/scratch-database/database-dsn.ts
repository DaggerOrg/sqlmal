import { ScratchDatabaseError } from './scratch-database.error';

function parsePostgresUrl(dsn: string): URL | undefined {
  try {
    const url = new URL(dsn);
    return url.protocol === 'postgres:' || url.protocol === 'postgresql:' ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The DSN of the maintenance database on the same server as `targetDsn`, which is where
 * scratch databases are created.
 */
export function deriveAdminDsn(targetDsn: string): string {
  const url = parsePostgresUrl(targetDsn);
  if (url === undefined) {
    throw new ScratchDatabaseError('the database URL must look like postgres://user:pass@host:5432/dbname');
  }
  url.pathname = '/postgres';
  return url.toString();
}

/** `dsn` pointing at another database on the same server. */
export function replaceDatabaseName(dsn: string, databaseName: string): string {
  const url = parsePostgresUrl(dsn);
  if (url === undefined) {
    return dsn;
  }
  url.pathname = `/${databaseName}`;
  return url.toString();
}
