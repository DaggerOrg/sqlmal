import { layout, type Box } from "./layout";
import type { Schema, Table } from "./types";

export function boxesFor(tables: Table[]): Record<string, Box> {
  return layout(tables.map((t) => ({ name: t.name, rows: t.columns.length, refs: t.foreign_keys.map((f) => f.ref_table) })));
}

/** Tables from every schema in the list, newest definition winning, so one layout fits all of them. */
export function unionTables(schemas: Schema[]): Table[] {
  const m = new Map<string, Table>();
  for (const s of schemas) for (const t of s.tables) m.set(t.name, t);
  return [...m.values()];
}
