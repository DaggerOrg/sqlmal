import type { DatabaseSchema } from '@sqlmal/contracts';
import { Client } from 'pg';

import { describeWithDatabase, itWithDatabase, type TestDatabase } from '../testing/test-database';
import { compareSchemas } from './schema-comparison';
import { readSchema } from './schema-introspection';
import { generateSchemaSql } from './schema-sql-generator';

const FIXTURE_SQL = `
CREATE TYPE order_status AS ENUM ('new', 'paid', 'shipped');
CREATE TABLE users (
    id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email    text NOT NULL UNIQUE,
    name     text DEFAULT 'anonymous',
    age      int CHECK (age >= 0),
    created  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE products (
    sku    text PRIMARY KEY,
    price  numeric(10,2) NOT NULL,
    tags   text[] NOT NULL DEFAULT '{}',
    net    numeric GENERATED ALWAYS AS (price / 1.07) STORED
);
CREATE TABLE orders (
    id        serial PRIMARY KEY,
    user_id   bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE RESTRICT,
    status    order_status NOT NULL DEFAULT 'new',
    note      text,
    CONSTRAINT orders_user_status UNIQUE (user_id, status)
);
CREATE INDEX idx_orders_new ON orders (user_id) WHERE status = 'new';
CREATE INDEX idx_orders_lower ON orders (lower(note));
CREATE TABLE order_items (
    order_id int NOT NULL REFERENCES orders(id),
    sku      text NOT NULL REFERENCES products(sku),
    qty      int NOT NULL DEFAULT 1,
    PRIMARY KEY (order_id, sku)
);
CREATE TABLE "user" (id bigserial PRIMARY KEY, "Display Name" text);
`;

async function runSql(database: TestDatabase, sql: string): Promise<void> {
  const client = new Client({ connectionString: database.dsn });
  await client.connect();
  try {
    await client.query(sql);
  } catch (error) {
    throw new Error(`${String(error)}\n--- SQL ---\n${sql}`, { cause: error });
  } finally {
    await client.end();
  }
}

async function readStableSchema(database: TestDatabase): Promise<DatabaseSchema> {
  const client = new Client({ connectionString: database.dsn });
  await client.connect();
  try {
    const schema = await readSchema(client);
    return {
      ...schema,
      tables: schema.tables.map((table) => ({ ...table, estimatedRowCount: 0, totalSizeBytes: 0 })),
    };
  } finally {
    await client.end();
  }
}

describeWithDatabase('generateSchemaSql against PostgreSQL', (context) => {
  // The strongest check there is: SQL generated from nothing must rebuild exactly the schema.
  itWithDatabase(context, 'rebuilds a schema exactly from nothing', async () => {
    const source = await context.createDatabase();
    await runSql(source, FIXTURE_SQL);
    const expected = await readStableSchema(source);
    const generated = generateSchemaSql({ tables: [], enums: [] }, expected);
    const target = await context.createDatabase();
    await runSql(target, generated.sql);
    expect(compareSchemas(expected, await readStableSchema(target))).toEqual([]);
  });

  itWithDatabase(context, 'turns one live schema into another', async () => {
    const before = await context.createDatabase();
    const after = await context.createDatabase();
    await runSql(before, FIXTURE_SQL);
    await runSql(after, FIXTURE_SQL);
    await runSql(
      after,
      `ALTER TABLE users ADD COLUMN nickname text NOT NULL DEFAULT '';
       ALTER TABLE users DROP COLUMN age;
       ALTER TABLE users ALTER COLUMN name SET NOT NULL;
       ALTER TABLE users ALTER COLUMN name SET DEFAULT 'guest';
       ALTER TABLE users ALTER COLUMN email TYPE varchar(255);
       ALTER TABLE products ADD CONSTRAINT price_positive CHECK (price > 0);
       DROP INDEX idx_orders_new;
       CREATE INDEX idx_orders_user ON orders (user_id, status);
       ALTER TABLE orders DROP CONSTRAINT orders_user_status;
       ALTER TABLE orders ADD CONSTRAINT orders_unique_note UNIQUE (note);
       ALTER TABLE order_items DROP CONSTRAINT order_items_order_id_fkey;
       ALTER TABLE order_items ADD CONSTRAINT items_order_fk FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE;
       ALTER TYPE order_status ADD VALUE 'refunded';
       CREATE TABLE audit (id bigserial PRIMARY KEY, order_id int REFERENCES orders(id), at timestamptz NOT NULL DEFAULT now());
       CREATE INDEX idx_audit_order ON audit (order_id);
       DROP TABLE "user";`,
    );
    const from = await readStableSchema(before);
    const to = await readStableSchema(after);
    const generated = generateSchemaSql(from, to);
    expect(generated.sql).not.toBe('');
    // ALTER TYPE ADD VALUE cannot share a transaction with its use, so run it apart.
    const blocks = generated.sql.split('\n\n');
    await runSql(before, blocks.filter((block) => block.includes('ADD VALUE')).join('\n'));
    await runSql(before, blocks.filter((block) => !block.includes('ADD VALUE')).join('\n\n'));
    expect(compareSchemas(to, await readStableSchema(before))).toEqual([]);
    expect(generated.warnings.length).toBeGreaterThan(0);
  });
});
