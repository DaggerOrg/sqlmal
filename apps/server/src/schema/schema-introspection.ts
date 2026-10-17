import type {
  Column,
  DatabaseSchema,
  EnumType,
  ReferentialAction,
  Table,
} from '@sqlmal/contracts';
import type { ClientBase } from 'pg';

/**
 * Reads a PostgreSQL schema from the system catalogs into a plain, sorted, comparable
 * model. Catalog arrays are cast to `text[]` so the driver parses them, and oids travel as
 * text.
 */

export interface SchemaReadOptions {
  /** Schemas to read. Defaults to `['public']`. */
  schemaNames?: string[];
  /** Keep SQLMal's own bookkeeping tables in the result. */
  includeBookkeepingTables?: boolean;
}

const BOOKKEEPING_TABLE_NAMES = new Set(['schema_migrations', 'migration_history']);

const REFERENTIAL_ACTIONS_BY_CODE: Record<string, ReferentialAction> = {
  a: 'NO ACTION',
  r: 'RESTRICT',
  c: 'CASCADE',
  n: 'SET NULL',
  d: 'SET DEFAULT',
};

interface TableRow {
  oid: string;
  name: string;
  is_partitioned: boolean;
  estimated_row_count: string;
  total_size_bytes: string;
  comment: string;
}

interface ColumnRow {
  table_oid: string;
  name: string;
  type: string;
  is_not_null: boolean;
  default_expression: string;
  identity: string;
  generated: string;
  comment: string;
}

interface ConstraintRow {
  table_oid: string;
  name: string;
  type: string;
  columns: string[];
  referenced_table: string;
  referenced_columns: string[];
  on_delete: string;
  on_update: string;
  definition: string;
}

interface IndexRow {
  table_oid: string;
  name: string;
  definition: string;
  is_unique: boolean;
  is_primary: boolean;
  method: string;
  columns: string[];
}

interface EnumRow {
  name: string;
  label: string;
}

/** Reads the schema inside a read-only transaction that is always rolled back. */
export async function readSchema(client: ClientBase, options: SchemaReadOptions = {}): Promise<DatabaseSchema> {
  await client.query('BEGIN READ ONLY');
  try {
    return await readSchemaInTransaction(client, options);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
  }
}

/**
 * Reads inside a transaction the caller already has, so it can see schema changes that have
 * not been committed.
 */
export async function readSchemaInTransaction(
  client: ClientBase,
  options: SchemaReadOptions = {},
): Promise<DatabaseSchema> {
  const schemaNames = options.schemaNames ?? ['public'];
  const tablesResult = await client.query<TableRow>(
    `SELECT c.oid::text AS oid, c.relname::text AS name, c.relkind = 'p' AS is_partitioned,
            GREATEST(c.reltuples, 0)::bigint AS estimated_row_count,
            pg_total_relation_size(c.oid) AS total_size_bytes,
            COALESCE(obj_description(c.oid, 'pg_class'), '') AS comment
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ANY($1::text[]) AND c.relkind IN ('r','p') AND NOT c.relispartition
     ORDER BY c.relname`,
    [schemaNames],
  );
  const tables: Table[] = [];
  const tablesByOid = new Map<string, Table>();
  for (const row of tablesResult.rows) {
    if (options.includeBookkeepingTables !== true && BOOKKEEPING_TABLE_NAMES.has(row.name)) {
      continue;
    }
    const table: Table = {
      name: row.name,
      isPartitioned: row.is_partitioned,
      columns: [],
      primaryKey: [],
      uniqueConstraints: [],
      foreignKeys: [],
      checkConstraints: [],
      indexes: [],
      estimatedRowCount: Number(row.estimated_row_count),
      totalSizeBytes: Number(row.total_size_bytes),
    };
    if (row.comment !== '') {
      table.comment = row.comment;
    }
    tables.push(table);
    tablesByOid.set(row.oid, table);
  }
  const tableOids = [...tablesByOid.keys()].sort((left, right) => Number(left) - Number(right));
  const findTable = (oid: string): Table => {
    const table = tablesByOid.get(oid);
    if (table === undefined) {
      throw new Error(`introspection returned a row for unknown table oid ${oid}`);
    }
    return table;
  };

  const columnsResult = await client.query<ColumnRow>(
    `SELECT a.attrelid::text AS table_oid, a.attname::text AS name,
            format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS is_not_null,
            COALESCE(pg_get_expr(d.adbin, d.adrelid), '') AS default_expression,
            a.attidentity::text AS identity, a.attgenerated::text AS generated,
            COALESCE(col_description(a.attrelid, a.attnum), '') AS comment
     FROM pg_attribute a
     LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = ANY($1::oid[]) AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY a.attrelid, a.attnum`,
    [tableOids],
  );
  for (const row of columnsResult.rows) {
    const column: Column = { name: row.name, type: row.type, isNotNull: row.is_not_null };
    if (row.identity === 'a') {
      column.identity = 'always';
    } else if (row.identity === 'd') {
      column.identity = 'by default';
    }
    if (row.generated === 's') {
      if (row.default_expression !== '') {
        column.generatedExpression = row.default_expression;
      }
    } else if (column.identity === undefined && row.default_expression !== '') {
      column.defaultExpression = row.default_expression;
    }
    if (row.comment !== '') {
      column.comment = row.comment;
    }
    findTable(row.table_oid).columns.push(column);
  }

  const constraintsResult = await client.query<ConstraintRow>(
    `SELECT c.conrelid::text AS table_oid, c.conname::text AS name, c.contype::text AS type,
            ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY k(n, o)
                  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n ORDER BY k.o)::text[] AS columns,
            COALESCE(rt.relname::text, '') AS referenced_table,
            ARRAY(SELECT a.attname FROM unnest(c.confkey) WITH ORDINALITY k(n, o)
                  JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.n ORDER BY k.o)::text[] AS referenced_columns,
            c.confdeltype::text AS on_delete, c.confupdtype::text AS on_update,
            CASE WHEN c.contype = 'c' THEN pg_get_constraintdef(c.oid) ELSE '' END AS definition
     FROM pg_constraint c LEFT JOIN pg_class rt ON rt.oid = c.confrelid
     WHERE c.conrelid = ANY($1::oid[]) AND c.contype IN ('p','u','f','c')
     ORDER BY c.conrelid, c.conname`,
    [tableOids],
  );
  for (const row of constraintsResult.rows) {
    const table = findTable(row.table_oid);
    if (row.type === 'p') {
      table.primaryKey = row.columns;
      table.primaryKeyName = row.name;
    } else if (row.type === 'u') {
      table.uniqueConstraints.push({ name: row.name, columns: row.columns });
    } else if (row.type === 'f') {
      table.foreignKeys.push({
        name: row.name,
        columns: row.columns,
        referencedTable: row.referenced_table,
        referencedColumns: row.referenced_columns,
        onDelete: REFERENTIAL_ACTIONS_BY_CODE[row.on_delete] ?? 'NO ACTION',
        onUpdate: REFERENTIAL_ACTIONS_BY_CODE[row.on_update] ?? 'NO ACTION',
      });
    } else {
      const expression = row.definition.startsWith('CHECK ') ? row.definition.slice('CHECK '.length) : row.definition;
      table.checkConstraints.push({ name: row.name, expression });
    }
  }

  const indexesResult = await client.query<IndexRow>(
    `SELECT i.indrelid::text AS table_oid, ic.relname::text AS name,
            pg_get_indexdef(i.indexrelid) AS definition, i.indisunique AS is_unique,
            i.indisprimary AS is_primary, am.amname::text AS method,
            ARRAY(SELECT CASE WHEN k.n = 0 THEN '(expr)' ELSE a.attname::text END
                  FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(n, o)
                  LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.n
                  WHERE k.o <= i.indnkeyatts ORDER BY k.o)::text[] AS columns
     FROM pg_index i
     JOIN pg_class ic ON ic.oid = i.indexrelid
     JOIN pg_am am ON am.oid = ic.relam
     WHERE i.indrelid = ANY($1::oid[])
     ORDER BY i.indrelid, ic.relname`,
    [tableOids],
  );
  for (const row of indexesResult.rows) {
    findTable(row.table_oid).indexes.push({
      name: row.name,
      definition: row.definition,
      isUnique: row.is_unique,
      isPrimary: row.is_primary,
      method: row.method,
      columns: row.columns,
    });
  }

  const enumsResult = await client.query<EnumRow>(
    `SELECT t.typname::text AS name, e.enumlabel::text AS label FROM pg_type t
     JOIN pg_namespace n ON n.oid = t.typnamespace
     JOIN pg_enum e ON e.enumtypid = t.oid
     WHERE n.nspname = ANY($1::text[]) ORDER BY t.typname, e.enumsortorder`,
    [schemaNames],
  );
  const enums: EnumType[] = [];
  for (const row of enumsResult.rows) {
    const last = enums.at(-1);
    if (last?.name === row.name) {
      last.labels.push(row.label);
    } else {
      enums.push({ name: row.name, labels: [row.label] });
    }
  }
  return { tables, enums };
}
