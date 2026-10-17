import { randomBytes } from 'node:crypto';

import { Client } from 'pg';

/** The server used to create throwaway databases. */
export function getTestAdminDsn(): string {
  const fromEnvironment = process.env['SQLMAL_TEST_ADMIN_DSN'];
  return fromEnvironment !== undefined && fromEnvironment !== ''
    ? fromEnvironment
    : 'postgres://studio:studio@127.0.0.1:54329/postgres';
}

/** Returns `dsn` pointing at another database on the same server. */
export function replaceTestDatabaseName(dsn: string, databaseName: string): string {
  const url = new URL(dsn);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

let isServerReachable: boolean | undefined;

/**
 * Whether PostgreSQL answers. Locally the e2e suites skip without it; in CI (`CI` set) this
 * throws instead, so a missing database never passes silently.
 */
export async function checkTestServerReachable(): Promise<boolean> {
  if (isServerReachable !== undefined) {
    return isServerReachable;
  }
  const client = new Client({ connectionString: getTestAdminDsn(), connectionTimeoutMillis: 5000 });
  client.on('error', () => undefined);
  try {
    await client.connect();
    await client.end();
    isServerReachable = true;
  } catch (error) {
    if (process.env['CI'] !== undefined && process.env['CI'] !== '') {
      throw new Error(`no PostgreSQL for integration tests (${String(error)}); CI must provide one`, {
        cause: error,
      });
    }
    process.stderr.write(
      `skipping: no PostgreSQL for integration tests (${String(error)}); run \`npm run demo:db\` or set SQLMAL_TEST_ADMIN_DSN\n`,
    );
    isServerReachable = false;
  }
  return isServerReachable;
}

/** A throwaway `ms_test_<hex>` database. Drop it when the test ends. */
export class TestDatabase {
  private constructor(
    readonly name: string,
    readonly dsn: string,
  ) {}

  static async create(): Promise<TestDatabase> {
    const name = `ms_test_${randomBytes(6).toString('hex')}`;
    await runAdminStatement(`CREATE DATABASE ${name}`);
    return new TestDatabase(name, replaceTestDatabaseName(getTestAdminDsn(), name));
  }

  async drop(): Promise<void> {
    await runAdminStatement(`DROP DATABASE IF EXISTS ${this.name} WITH (FORCE)`);
  }

  /** Runs SQL on a fresh connection and returns the rows. */
  async query<TRow extends Record<string, unknown>>(sql: string, parameters: unknown[] = []): Promise<TRow[]> {
    const client = new Client({ connectionString: this.dsn });
    client.on('error', () => undefined);
    await client.connect();
    try {
      const result = await client.query<TRow>(sql, parameters);
      return result.rows;
    } finally {
      await client.end();
    }
  }

  async countRows(sql: string, parameters: unknown[] = []): Promise<number> {
    const rows = await this.query<{ count: string }>(sql, parameters);
    return Number(rows[0]?.count ?? 0);
  }

  async hasTable(tableName: string): Promise<boolean> {
    return (
      (await this.countRows('SELECT count(*) FROM information_schema.tables WHERE table_name = $1', [tableName])) ===
      1
    );
  }
}

async function runAdminStatement(sql: string): Promise<void> {
  const admin = new Client({ connectionString: getTestAdminDsn() });
  admin.on('error', () => undefined);
  await admin.connect();
  try {
    await admin.query(sql);
  } finally {
    await admin.end();
  }
}

/**
 * Declares an e2e suite that runs only when PostgreSQL is reachable. Jest cannot decide to
 * skip asynchronously, so the reachability probe runs in `beforeAll` and each test returns
 * early (logged once) when there is no server.
 */
export function describeWithDatabase(title: string, defineTests: (context: DatabaseTestContext) => void): void {
  describe(title, () => {
    const context = new DatabaseTestContext();
    beforeAll(async () => {
      context.isAvailable = await checkTestServerReachable();
    });
    afterAll(async () => {
      await context.dropAll();
    });
    defineTests(context);
  });
}

export class DatabaseTestContext {
  isAvailable = false;
  private readonly databases: TestDatabase[] = [];

  /** A new throwaway database, dropped after the suite. */
  async createDatabase(): Promise<TestDatabase> {
    const database = await TestDatabase.create();
    this.databases.push(database);
    return database;
  }

  async dropAll(): Promise<void> {
    for (const database of this.databases.splice(0)) {
      await database.drop();
    }
  }
}

/** A test that only runs against a reachable PostgreSQL. */
export function itWithDatabase(
  context: DatabaseTestContext,
  name: string,
  runTest: () => Promise<void>,
  timeoutMs?: number,
): void {
  it(
    name,
    async () => {
      if (!context.isAvailable) {
        return;
      }
      await runTest();
    },
    timeoutMs,
  );
}
