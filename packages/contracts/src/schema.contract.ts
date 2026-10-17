/** How an identity column assigns values. */
export type IdentityGeneration = 'always' | 'by default';

export type ReferentialAction = 'NO ACTION' | 'RESTRICT' | 'CASCADE' | 'SET NULL' | 'SET DEFAULT';

export interface Column {
  name: string;
  /** The type as PostgreSQL formats it, for example `character varying(120)`. */
  type: string;
  isNotNull: boolean;
  defaultExpression?: string;
  identity?: IdentityGeneration;
  /** The expression of a stored generated column. */
  generatedExpression?: string;
  comment?: string;
}

export interface ForeignKey {
  name: string;
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
  onDelete: ReferentialAction;
  onUpdate: ReferentialAction;
}

export interface UniqueConstraint {
  name: string;
  columns: string[];
}

export interface CheckConstraint {
  name: string;
  /** The condition, including its surrounding parentheses. */
  expression: string;
}

export interface Index {
  name: string;
  /** The full `CREATE INDEX` statement from `pg_get_indexdef`. */
  definition: string;
  isUnique: boolean;
  isPrimary: boolean;
  /** The access method, for example `btree` or `gin`. */
  method: string;
  /** Key columns in order. An expression column is written `(expr)`. */
  columns: string[];
}

export interface Table {
  name: string;
  isPartitioned: boolean;
  columns: Column[];
  primaryKey: string[];
  primaryKeyName?: string;
  uniqueConstraints: UniqueConstraint[];
  foreignKeys: ForeignKey[];
  checkConstraints: CheckConstraint[];
  indexes: Index[];
  /** From planner statistics, so approximate. */
  estimatedRowCount: number;
  totalSizeBytes: number;
  comment?: string;
}

export interface EnumType {
  name: string;
  labels: string[];
}

/** A database schema as a plain, sorted, comparable model. */
export interface DatabaseSchema {
  tables: Table[];
  enums: EnumType[];
}

export type SchemaChangeKind =
  | 'table_added'
  | 'table_removed'
  | 'column_added'
  | 'column_removed'
  | 'column_changed'
  | 'primary_key_changed'
  | 'unique_added'
  | 'unique_removed'
  | 'foreign_key_added'
  | 'foreign_key_removed'
  | 'check_added'
  | 'check_removed'
  | 'index_added'
  | 'index_removed'
  | 'enum_added'
  | 'enum_removed'
  | 'enum_value_added';

/** One difference between two schemas. */
export interface SchemaChange {
  kind: SchemaChangeKind;
  tableName?: string;
  /** The column, index, constraint or type the change is about. */
  objectName?: string;
  detail?: string;
  /** Applying the change can lose data. */
  isDestructive: boolean;
}

/** Generated SQL plus anything its author must check by hand. */
export interface GeneratedSql {
  sql: string;
  warnings: string[];
}
