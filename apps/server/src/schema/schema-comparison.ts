import type {
  CheckConstraint,
  Column,
  DatabaseSchema,
  EnumType,
  ForeignKey,
  Index,
  SchemaChange,
  SchemaChangeKind,
  Table,
  UniqueConstraint,
} from '@sqlmal/contracts';

export function createEmptySchema(): DatabaseSchema {
  return { tables: [], enums: [] };
}

function buildChange(
  kind: SchemaChangeKind,
  fields: { tableName?: string; objectName?: string; detail?: string; isDestructive?: boolean },
): SchemaChange {
  const change: SchemaChange = { kind, isDestructive: fields.isDestructive ?? false };
  if (fields.tableName !== undefined && fields.tableName !== '') {
    change.tableName = fields.tableName;
  }
  if (fields.objectName !== undefined && fields.objectName !== '') {
    change.objectName = fields.objectName;
  }
  if (fields.detail !== undefined && fields.detail !== '') {
    change.detail = fields.detail;
  }
  return change;
}

/** One line, for the CLI and tests: `column_added users.age (integer)`. */
export function describeSchemaChange(change: SchemaChange): string {
  const tableName = change.tableName ?? '';
  const objectName = change.objectName ?? '';
  let target = tableName;
  if (objectName !== '' && tableName !== '') {
    target += `.${objectName}`;
  } else if (objectName !== '') {
    target = objectName;
  }
  let text = `${change.kind} ${target}`;
  if (change.detail !== undefined && change.detail !== '') {
    text += ` (${change.detail})`;
  }
  return text;
}

export function compareByteOrder(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

export function indexByName<TItem extends { name: string }>(items: readonly TItem[]): Map<string, TItem> {
  return new Map(items.map((item) => [item.name, item]));
}

/** Every key of both maps, sorted. */
export function listSortedNames(left: ReadonlyMap<string, unknown>, right: ReadonlyMap<string, unknown>): string[] {
  return [...new Set([...left.keys(), ...right.keys()])].sort(compareByteOrder);
}

export function areListsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, position) => item === right[position]);
}

/**
 * The plain indexes only: primary keys and unique constraints have their own entries, and
 * listing their backing index again would double count. Keeps the table's (name) order.
 */
export function listPlainIndexes(table: Table): Index[] {
  const backingNames = new Set<string>([table.primaryKeyName ?? '']);
  for (const unique of table.uniqueConstraints) {
    backingNames.add(unique.name);
  }
  return table.indexes.filter((index) => !index.isPrimary && !backingNames.has(index.name));
}

function describeOrNone(value: string | undefined): string {
  return value === undefined || value === '' ? 'none' : value;
}

function describeColumnDifference(before: Column, after: Column): string {
  const differences: string[] = [];
  if (before.type !== after.type) {
    differences.push(`type ${before.type} to ${after.type}`);
  }
  if (before.isNotNull !== after.isNotNull) {
    differences.push(after.isNotNull ? 'now NOT NULL' : 'now nullable');
  }
  if ((before.defaultExpression ?? '') !== (after.defaultExpression ?? '')) {
    differences.push(
      `default ${describeOrNone(before.defaultExpression)} to ${describeOrNone(after.defaultExpression)}`,
    );
  }
  if ((before.identity ?? '') !== (after.identity ?? '')) {
    differences.push(`identity ${describeOrNone(before.identity)} to ${describeOrNone(after.identity)}`);
  }
  if ((before.generatedExpression ?? '') !== (after.generatedExpression ?? '')) {
    differences.push('generated expression changed');
  }
  return differences.join('; ');
}

function describeColumn(column: Column): string {
  let summary = column.type;
  if (column.isNotNull) {
    summary += ' NOT NULL';
  }
  if (column.defaultExpression !== undefined && column.defaultExpression !== '') {
    summary += ` DEFAULT ${column.defaultExpression}`;
  }
  return summary;
}

function describeForeignKey(foreignKey: ForeignKey): string {
  return `(${foreignKey.columns.join(', ')}) references ${foreignKey.referencedTable}(${foreignKey.referencedColumns.join(', ')}) on delete ${foreignKey.onDelete.toLowerCase()}`;
}

export function areForeignKeysEqual(left: ForeignKey, right: ForeignKey): boolean {
  return (
    left.name === right.name &&
    areListsEqual(left.columns, right.columns) &&
    left.referencedTable === right.referencedTable &&
    areListsEqual(left.referencedColumns, right.referencedColumns) &&
    left.onDelete === right.onDelete &&
    left.onUpdate === right.onUpdate
  );
}

/**
 * Lists what changed going from `before` to `after`. The result is ordered so that the same
 * two schemas always give the same list.
 */
export function compareSchemas(before: DatabaseSchema, after: DatabaseSchema): SchemaChange[] {
  const changes: SchemaChange[] = [];
  const enumsBefore = indexByName<EnumType>(before.enums);
  const enumsAfter = indexByName<EnumType>(after.enums);
  for (const enumType of after.enums) {
    const previous = enumsBefore.get(enumType.name);
    if (previous === undefined) {
      changes.push(buildChange('enum_added', { objectName: enumType.name, detail: enumType.labels.join(', ') }));
      continue;
    }
    const previousLabels = new Set(previous.labels);
    for (const label of enumType.labels) {
      if (!previousLabels.has(label)) {
        changes.push(buildChange('enum_value_added', { objectName: enumType.name, detail: label }));
      }
    }
  }
  for (const enumType of before.enums) {
    if (!enumsAfter.has(enumType.name)) {
      changes.push(buildChange('enum_removed', { objectName: enumType.name, isDestructive: true }));
    }
  }

  const tablesBefore = indexByName(before.tables);
  const tablesAfter = indexByName(after.tables);
  for (const tableName of listSortedNames(tablesBefore, tablesAfter)) {
    const previous = tablesBefore.get(tableName);
    const next = tablesAfter.get(tableName);
    if (previous === undefined && next !== undefined) {
      changes.push(buildChange('table_added', { tableName, detail: `${next.columns.length} columns` }));
    } else if (next === undefined) {
      changes.push(buildChange('table_removed', { tableName, isDestructive: true }));
    } else if (previous !== undefined) {
      changes.push(...compareTables(previous, next));
    }
  }
  return changes;
}

function compareNamedItems<TItem extends { name: string }>(
  before: readonly TItem[],
  after: readonly TItem[],
  areEqual: (left: TItem, right: TItem) => boolean,
  onAdded: (item: TItem) => SchemaChange,
  onRemoved: (item: TItem, isReplaced: boolean) => SchemaChange,
): SchemaChange[] {
  const changes: SchemaChange[] = [];
  const itemsBefore = indexByName(before);
  const itemsAfter = indexByName(after);
  for (const name of listSortedNames(itemsBefore, itemsAfter)) {
    const previous = itemsBefore.get(name);
    const next = itemsAfter.get(name);
    if (previous === undefined && next !== undefined) {
      changes.push(onAdded(next));
    } else if (next === undefined && previous !== undefined) {
      changes.push(onRemoved(previous, false));
    } else if (previous !== undefined && next !== undefined && !areEqual(previous, next)) {
      changes.push(onRemoved(previous, true), onAdded(next));
    }
  }
  return changes;
}

function compareTables(before: Table, after: Table): SchemaChange[] {
  const changes: SchemaChange[] = [];
  const tableName = after.name;
  const columnsBefore = indexByName(before.columns);
  const columnsAfter = indexByName(after.columns);
  for (const column of after.columns) {
    const previous = columnsBefore.get(column.name);
    if (previous === undefined) {
      changes.push(
        buildChange('column_added', { tableName, objectName: column.name, detail: describeColumn(column) }),
      );
      continue;
    }
    const difference = describeColumnDifference(previous, column);
    if (difference !== '') {
      changes.push(
        buildChange('column_changed', {
          tableName,
          objectName: column.name,
          detail: difference,
          isDestructive: previous.type !== column.type,
        }),
      );
    }
  }
  for (const column of before.columns) {
    if (!columnsAfter.has(column.name)) {
      changes.push(buildChange('column_removed', { tableName, objectName: column.name, isDestructive: true }));
    }
  }
  if (!areListsEqual(before.primaryKey, after.primaryKey)) {
    changes.push(
      buildChange('primary_key_changed', {
        tableName,
        detail: `(${before.primaryKey.join(', ')}) to (${after.primaryKey.join(', ')})`,
      }),
    );
  }
  changes.push(
    ...compareNamedItems<UniqueConstraint>(
      before.uniqueConstraints,
      after.uniqueConstraints,
      (left, right) => areListsEqual(left.columns, right.columns),
      (unique) => buildChange('unique_added', { tableName, objectName: unique.name, detail: unique.columns.join(', ') }),
      (unique, isReplaced) =>
        buildChange('unique_removed', {
          tableName,
          objectName: unique.name,
          ...(isReplaced ? {} : { detail: unique.columns.join(', ') }),
        }),
    ),
    ...compareNamedItems<ForeignKey>(
      before.foreignKeys,
      after.foreignKeys,
      areForeignKeysEqual,
      (foreignKey) =>
        buildChange('foreign_key_added', {
          tableName,
          objectName: foreignKey.name,
          detail: describeForeignKey(foreignKey),
        }),
      (foreignKey) =>
        buildChange('foreign_key_removed', {
          tableName,
          objectName: foreignKey.name,
          detail: describeForeignKey(foreignKey),
        }),
    ),
    ...compareNamedItems<CheckConstraint>(
      before.checkConstraints,
      after.checkConstraints,
      (left, right) => left.expression === right.expression,
      (check) => buildChange('check_added', { tableName, objectName: check.name, detail: check.expression }),
      (check) => buildChange('check_removed', { tableName, objectName: check.name, detail: check.expression }),
    ),
    ...compareNamedItems<Index>(
      listPlainIndexes(before),
      listPlainIndexes(after),
      (left, right) => left.definition === right.definition,
      (index) => buildChange('index_added', { tableName, objectName: index.name, detail: index.columns.join(', ') }),
      (index) =>
        buildChange('index_removed', { tableName, objectName: index.name, detail: index.columns.join(', ') }),
    ),
  );
  return changes;
}
