import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Migration } from '../migration-files/migration';
import { loadMigrations } from '../migration-files/migration-loader';

/** A temporary migrations directory for tests. */
export class MigrationDirectory {
  readonly path = mkdtempSync(join(tmpdir(), 'sqlmal-test-'));

  writeFile(name: string, body: string): this {
    writeFileSync(join(this.path, name), body);
    return this;
  }

  removeFile(name: string): this {
    rmSync(join(this.path, name));
    return this;
  }

  load(): Migration[] {
    return loadMigrations(this.path);
  }

  /** Users, orders (references users), and an index on orders. */
  writeBaseMigrations(): this {
    return this.writeFile('0001_users.up.sql', 'CREATE TABLE users (id serial PRIMARY KEY, email text NOT NULL);')
      .writeFile('0001_users.down.sql', 'DROP TABLE users;')
      .writeFile(
        '0002_orders.up.sql',
        'CREATE TABLE orders (id serial PRIMARY KEY, user_id int NOT NULL REFERENCES users(id));',
      )
      .writeFile('0002_orders.down.sql', 'DROP TABLE orders;')
      .writeFile('0003_idx.up.sql', 'CREATE INDEX idx_orders_user ON orders (user_id);')
      .writeFile('0003_idx.down.sql', 'DROP INDEX idx_orders_user;');
  }
}
