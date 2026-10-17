import type { Column, DatabaseSchema, Table } from '@sqlmal/contracts';
import { Client } from 'pg';

import { describeWithDatabase, itWithDatabase, type TestDatabase } from '../testing/test-database';
import { readSchema } from './schema-introspection';

const INTROSPECTION_FIXTURE_SQL = `
CREATE TYPE order_status AS ENUM ('new', 'paid', 'shipped');
COMMENT ON TYPE order_status IS 'ignored';

CREATE TABLE users (
    id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email    text NOT NULL UNIQUE,
    name     text DEFAULT 'anonymous',
    age      int CHECK (age >= 0),
    created  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE users IS 'People who can sign in';
COMMENT ON COLUMN users.email IS 'Login name';

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
    sku      text NOT NULL REFERENCES products(sku) ON DELETE SET NULL (sku),
    qty      int NOT NULL DEFAULT 1,
    PRIMARY KEY (order_id, sku)
);

CREATE TABLE events (id int, at date) PARTITION BY RANGE (at);
CREATE TABLE events_2026 PARTITION OF events FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');

CREATE VIEW active_users AS SELECT * FROM users;
CREATE TABLE schema_migrations (version bigint);
`;

async function readFrom(database: TestDatabase, setupSql: string, options = {}): Promise<DatabaseSchema> {
  const client = new Client({ connectionString: database.dsn });
  await client.connect();
  try {
    if (setupSql !== '') {
      await client.query(setupSql);
    }
    return await readSchema(client, options);
  } finally {
    await client.end();
  }
}

function findTable(schema: DatabaseSchema, name: string): Table {
  const table = schema.tables.find((candidate) => candidate.name === name);
  if (table === undefined) {
    throw new Error(`no table ${name}`);
  }
  return table;
}

function findColumn(table: Table, name: string): Column {
  return table.columns.find((column) => column.name === name)!;
}

describeWithDatabase('readSchema', (context) => {
  let schema: DatabaseSchema;

  beforeAll(async () => {
    if (context.isAvailable) {
      schema = await readFrom(await context.createDatabase(), INTROSPECTION_FIXTURE_SQL);
    }
  });

  itWithDatabase(context, 'reads tables and columns and hides partitions, views and bookkeeping', async () => {
    expect(schema.tables.map((table) => table.name)).toEqual(['events', 'order_items', 'orders', 'products', 'users']);
    const users = findTable(schema, 'users');
    expect(users.comment).toBe('People who can sign in');
    expect(findColumn(users, 'id')).toEqual({ name: 'id', type: 'bigint', isNotNull: true, identity: 'always' });
    expect(findColumn(users, 'email')).toMatchObject({ comment: 'Login name', isNotNull: true });
    expect(findColumn(users, 'name')).toMatchObject({ defaultExpression: "'anonymous'::text", isNotNull: false });
    expect(findColumn(users, 'created')).toMatchObject({ type: 'timestamp with time zone', defaultExpression: 'now()' });
    const products = findTable(schema, 'products');
    expect(findColumn(products, 'net').generatedExpression).toBeTruthy();
    expect(findColumn(products, 'price').type).toBe('numeric(10,2)');
    expect(findColumn(products, 'tags').type).toBe('text[]');
    expect(findTable(schema, 'events').isPartitioned).toBe(true);
  });

  itWithDatabase(context, 'reads constraints and indexes', async () => {
    const users = findTable(schema, 'users');
    expect(users.primaryKey).toEqual(['id']);
    expect(users.uniqueConstraints.map((unique) => unique.columns)).toEqual([['email']]);
    expect(users.checkConstraints.map((check) => check.expression)).toEqual(['((age >= 0))']);
    const orders = findTable(schema, 'orders');
    expect(orders.foreignKeys).toEqual([
      {
        name: 'orders_user_id_fkey',
        columns: ['user_id'],
        referencedTable: 'users',
        referencedColumns: ['id'],
        onDelete: 'CASCADE',
        onUpdate: 'RESTRICT',
      },
    ]);
    expect(orders.uniqueConstraints[0]!.columns).toEqual(['user_id', 'status']);
    expect(findTable(schema, 'order_items').primaryKey).toEqual(['order_id', 'sku']);
    const indexesByName = new Map(orders.indexes.map((index) => [index.name, index]));
    expect(indexesByName.get('orders_pkey')).toMatchObject({ isPrimary: true, isUnique: true, method: 'btree' });
    expect(indexesByName.get('idx_orders_new')).toMatchObject({ columns: ['user_id'], isUnique: false });
    expect(indexesByName.get('idx_orders_new')!.definition).not.toBe('');
    expect(indexesByName.get('idx_orders_lower')!.columns).toEqual(['(expr)']);
  });

  itWithDatabase(context, 'reads enums in declared order', async () => {
    expect(schema.enums).toEqual([{ name: 'order_status', labels: ['new', 'paid', 'shipped'] }]);
  });

  itWithDatabase(context, 'keeps the bookkeeping tables when asked', async () => {
    const database = await context.createDatabase();
    const setup = 'CREATE TABLE schema_migrations (version bigint); CREATE TABLE a (id int)';
    const hidden = await readFrom(database, setup);
    const shown = await readFrom(database, '', { includeBookkeepingTables: true });
    expect(hidden.tables).toHaveLength(1);
    expect(shown.tables).toHaveLength(2);
  });

  itWithDatabase(context, 'reads the same database identically twice', async () => {
    const database = await context.createDatabase();
    const strip = (read: DatabaseSchema): DatabaseSchema => ({
      ...read,
      tables: read.tables.map((table) => ({ ...table, estimatedRowCount: 0, totalSizeBytes: 0 })),
    });
    const first = strip(await readFrom(database, INTROSPECTION_FIXTURE_SQL));
    const second = strip(await readFrom(database, ''));
    expect(second).toEqual(first);
  });
});
