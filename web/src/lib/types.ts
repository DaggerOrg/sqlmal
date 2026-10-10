// Mirrors the Go JSON. Keep in step with internal/{introspect,diff,engine,shadow,lint,app}.

export interface Column {
  name: string;
  type: string;
  not_null: boolean;
  default?: string;
  identity?: string;
  generated?: string;
  comment?: string;
}
export interface ForeignKey {
  name: string;
  columns: string[];
  ref_table: string;
  ref_columns: string[];
  on_delete: string;
  on_update: string;
}
export interface Unique { name: string; columns: string[] }
export interface Check { name: string; expr: string }
export interface Index { name: string; def: string; unique: boolean; primary: boolean; method: string; columns: string[] }
export interface Table {
  name: string;
  partitioned?: boolean;
  columns: Column[];
  primary_key: string[];
  primary_key_name?: string;
  uniques: Unique[];
  foreign_keys: ForeignKey[];
  checks: Check[];
  indexes: Index[];
  row_estimate: number;
  size_bytes: number;
  comment?: string;
}
export interface Enum { name: string; labels: string[] }
export interface Schema { tables: Table[]; enums: Enum[] }

export type ChangeKind =
  | "table_added" | "table_removed" | "column_added" | "column_removed" | "column_changed"
  | "primary_key_changed" | "unique_added" | "unique_removed" | "foreign_key_added" | "foreign_key_removed"
  | "check_added" | "check_removed" | "index_added" | "index_removed" | "enum_added" | "enum_removed" | "enum_value_added";

export interface Change { kind: ChangeKind; table?: string; object?: string; detail?: string; destructive?: boolean }

export type Severity = "error" | "warning" | "info";
export interface Finding { rule: string; severity: Severity; file: "up" | "down"; line: number; message: string; hint?: string }

export interface MigrationView {
  version: number;
  name: string;
  up_sql: string;
  down_sql: string;
  checksum: string;
  no_tx: boolean;
  has_down: boolean;
  one_way?: boolean;
  lint: Finding[];
}

export type State = "applied" | "pending" | "modified" | "missing";
export interface Row {
  version: number;
  name: string;
  state: State;
  checksum: string;
  applied_checksum?: string;
  applied_at?: string;
  duration_ms?: number;
  applied_by?: string;
  has_down: boolean;
  no_tx: boolean;
  out_of_order?: boolean;
}

export interface HistoryEntry {
  id: number;
  version: number;
  name: string;
  direction: "up" | "down";
  success: boolean;
  error?: string;
  started_at: string;
  duration_ms: number;
  applied_by: string;
}

export interface Step {
  version: number;
  name: string;
  schema: Schema;
  changes: Change[];
  apply_ms: number;
  error?: string;
  reversible: boolean | null;
  reverse_diff?: Change[];
  reverse_note?: string;
}
export interface Timeline { steps: Step[]; final: Schema; all_reversible: boolean; failed?: number }

export interface DriftReport {
  applied: number;
  skipped?: string;
  in_sync: boolean;
  changes: Change[];
  expected: Schema;
  live: Schema;
}

export interface Script { sql: string; warnings: string[] }
export interface Generated { up: Script; down: Script; changes: Change[] }

export interface Result {
  version: number;
  name: string;
  direction: "up" | "down";
  dry_run: boolean;
  skipped?: string;
  error?: string;
  line?: number;
  duration_ms: number;
}

export interface Bundle {
  generated_at: string;
  database: string;
  migrations: MigrationView[];
  status: Row[];
  schema: Schema;
  timeline: Timeline;
  drift: DriftReport;
  generated: Generated | null;
  history: HistoryEntry[];
}

export interface Info {
  version: string;
  read_only: boolean;
  static: boolean;
  databases: { name: string }[];
}
