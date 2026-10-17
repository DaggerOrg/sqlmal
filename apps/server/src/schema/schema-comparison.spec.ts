import type { Column, DatabaseSchema, SchemaChange, Table } from '@sqlmal/contracts';

import { compareSchemas } from './schema-comparison';
import { generateSchemaSql } from './schema-sql-generator';

function buildColumn(name: string, type: string, isNotNull: boolean): Column {
  return { name, type, isNotNull };
}

function buildTable(name: string, ...columns: Column[]): Table {
  return {
    name,
    isPartitioned: false,
    columns,
    primaryKey: [],
    uniqueConstraints: [],
    foreignKeys: [],
    checkConstraints: [],
    indexes: [],
    estimatedRowCount: 0,
    totalSizeBytes: 0,
  };
}

function describeKinds(changes: readonly SchemaChange[]): string {
  return changes.map((change) => `${change.kind}:${change.tableName ?? ''}.${change.objectName ?? ''}`).join(' ');
}

describe('compareSchemas', () => {
  const before: DatabaseSchema = {
    tables: [
      buildTable('users', buildColumn('id', 'integer', true), buildColumn('email', 'text', true), buildColumn('old', 'text', false)),
      buildTable('gone', buildColumn('id', 'integer', true)),
    ],
    enums: [{ name: 'status', labels: ['a', 'b'] }],
  };
  const after: DatabaseSchema = {
    tables: [
      buildTable('users', buildColumn('id', 'bigint', true), buildColumn('email', 'text', false), buildColumn('age', 'integer', false)),
      buildTable('fresh', buildColumn('id', 'integer', true)),
    ],
    enums: [
      { name: 'status', labels: ['a', 'b', 'c'] },
      { name: 'kind', labels: ['x'] },
    ],
  };

  it('finds each kind of change and marks the ones that can lose data', () => {
    const changes = compareSchemas(before, after);
    const kinds = describeKinds(changes);
    for (const expected of [
      'enum_value_added:.status',
      'enum_added:.kind',
      'table_added:fresh.',
      'table_removed:gone.',
      'column_added:users.age',
      'column_changed:users.email',
      'column_changed:users.id',
      'column_removed:users.old',
    ]) {
      expect(kinds).toContain(expected);
    }
    const byKey = new Map(changes.map((change) => [`${change.kind}:${change.objectName ?? change.tableName ?? ''}`, change]));
    expect(byKey.get('table_removed:gone')!.isDestructive).toBe(true);
    expect(byKey.get('column_removed:old')!.isDestructive).toBe(true);
    expect(byKey.get('column_changed:email')!.isDestructive).toBe(false);
    expect(byKey.get('column_changed:id')!.isDestructive).toBe(true);
  });

  it('finds nothing between a schema and itself, and is deterministic', () => {
    expect(compareSchemas(before, before)).toEqual([]);
    expect(describeKinds(compareSchemas(before, after))).toBe(describeKinds(compareSchemas(before, after)));
  });

  it('reports changed constraints and indexes as a removal then an addition', () => {
    const orders = buildTable('orders', buildColumn('id', 'integer', true), buildColumn('user_id', 'integer', true));
    const previous: Table = {
      ...orders,
      foreignKeys: [{ name: 'fk', columns: ['user_id'], referencedTable: 'users', referencedColumns: ['id'], onDelete: 'NO ACTION', onUpdate: 'NO ACTION' }],
      indexes: [{ name: 'idx', definition: 'CREATE INDEX idx ON public.orders USING btree (user_id)', columns: ['user_id'], isUnique: false, isPrimary: false, method: 'btree' }],
    };
    const next: Table = {
      ...orders,
      foreignKeys: [{ name: 'fk', columns: ['user_id'], referencedTable: 'users', referencedColumns: ['id'], onDelete: 'CASCADE', onUpdate: 'NO ACTION' }],
      indexes: [{ name: 'idx', definition: 'CREATE INDEX idx ON public.orders USING btree (user_id, id)', columns: ['user_id', 'id'], isUnique: false, isPrimary: false, method: 'btree' }],
    };
    const kinds = describeKinds(compareSchemas({ tables: [previous], enums: [] }, { tables: [next], enums: [] }));
    for (const expected of ['foreign_key_removed:orders.fk', 'foreign_key_added:orders.fk', 'index_removed:orders.idx', 'index_added:orders.idx']) {
      expect(kinds).toContain(expected);
    }
  });
});

describe('generateSchemaSql', () => {
  it('writes serial columns and adds foreign keys after every CREATE TABLE', () => {
    const users: Table = {
      ...buildTable('users', { name: 'id', type: 'integer', isNotNull: true, defaultExpression: "nextval('users_id_seq'::regclass)" }, buildColumn('email', 'text', true)),
      primaryKey: ['id'],
      primaryKeyName: 'users_pkey',
    };
    const posts: Table = {
      ...buildTable('posts', buildColumn('id', 'integer', true), buildColumn('user_id', 'integer', true)),
      foreignKeys: [{ name: 'posts_user_id_fkey', columns: ['user_id'], referencedTable: 'users', referencedColumns: ['id'], onDelete: 'CASCADE', onUpdate: 'NO ACTION' }],
    };
    const { sql } = generateSchemaSql({ tables: [], enums: [] }, { tables: [posts, users], enums: [] });
    expect(sql).toMatch(/id serial[,\n]/);
    expect(sql).not.toContain('nextval');
    expect(sql.indexOf('ADD CONSTRAINT posts_user_id_fkey')).toBeGreaterThan(sql.lastIndexOf('CREATE TABLE'));
    expect(sql).toContain('ON DELETE CASCADE');
    expect(sql).not.toContain('ON UPDATE NO ACTION');
  });

  it('drops constraints before tables and warns about data loss', () => {
    const users = buildTable('users', buildColumn('id', 'integer', true));
    const orders: Table = {
      ...buildTable('orders', buildColumn('id', 'integer', true), buildColumn('user_id', 'integer', true)),
      foreignKeys: [{ name: 'fk', columns: ['user_id'], referencedTable: 'users', referencedColumns: ['id'], onDelete: 'NO ACTION', onUpdate: 'NO ACTION' }],
    };
    const from: DatabaseSchema = { tables: [orders, users], enums: [] };
    const to: DatabaseSchema = { tables: [buildTable('orders', buildColumn('id', 'integer', true))], enums: [] };
    const generated = generateSchemaSql(from, to);
    const dropForeignKey = generated.sql.indexOf('DROP CONSTRAINT fk');
    const dropTable = generated.sql.indexOf('DROP TABLE users');
    expect(dropForeignKey).toBeGreaterThanOrEqual(0);
    expect(dropForeignKey).toBeLessThan(dropTable);
    expect(generated.warnings.length).toBeGreaterThanOrEqual(2);
    expect(generateSchemaSql(from, from).sql).toBe('');
  });
});
