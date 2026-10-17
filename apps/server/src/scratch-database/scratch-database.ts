import { randomBytes } from 'node:crypto';

import { Client } from 'pg';

import { describeError } from '../shared/error-message';
import { replaceDatabaseName } from './database-dsn';
import { ScratchDatabaseError } from './scratch-database.error';

/** A temporary `ms_shadow_<12 hex>` database. Always drop it. */
export class ScratchDatabase {
  private constructor(
    readonly dsn: string,
    private readonly name: string,
    private readonly admin: Client,
  ) {}

  /** Creates an empty database on the server behind `adminDsn`. */
  static async create(adminDsn: string): Promise<ScratchDatabase> {
    const admin = new Client({ connectionString: adminDsn });
    admin.on('error', () => undefined);
    try {
      await admin.connect();
    } catch (error) {
      throw new ScratchDatabaseError(`connect to create a scratch database: ${describeError(error)}`, {
        cause: error,
      });
    }
    const name = `ms_shadow_${randomBytes(6).toString('hex')}`;
    try {
      await admin.query(`CREATE DATABASE ${name}`);
    } catch (error) {
      await admin.end().catch(() => undefined);
      throw new ScratchDatabaseError(
        `create scratch database (this needs the CREATEDB privilege): ${describeError(error)}`,
        { cause: error },
      );
    }
    return new ScratchDatabase(replaceDatabaseName(adminDsn, name), name, admin);
  }

  async drop(): Promise<void> {
    await this.admin.query(`DROP DATABASE IF EXISTS ${this.name} WITH (FORCE)`).catch(() => undefined);
    await this.admin.end().catch(() => undefined);
  }
}
