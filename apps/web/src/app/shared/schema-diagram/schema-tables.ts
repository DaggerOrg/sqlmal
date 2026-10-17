import type { DatabaseSchema, Table } from '@sqlmal/contracts';
import { layoutTables, type DiagramBox } from './schema-layout';

/** Lays out the tables of a schema for the diagram. */
export function layoutSchemaTables(tables: readonly Table[]): Record<string, DiagramBox> {
  return layoutTables(
    tables.map((table) => ({
      name: table.name,
      columnCount: table.columns.length,
      referencedTableNames: table.foreignKeys.map((foreignKey) => foreignKey.referencedTable),
    })),
  );
}

/** Tables from every schema in the list, newest definition winning, so one layout fits all of them. */
export function mergeTablesAcrossSchemas(schemas: readonly DatabaseSchema[]): Table[] {
  const tablesByName = new Map<string, Table>();
  for (const schema of schemas) for (const table of schema.tables) tablesByName.set(table.name, table);
  return [...tablesByName.values()];
}
