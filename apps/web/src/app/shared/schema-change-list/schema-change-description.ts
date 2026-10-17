import type { SchemaChange, SchemaChangeKind } from '@sqlmal/contracts';

/** Whether a change adds, removes or alters something. */
export type SchemaChangeEffect = 'added' | 'removed' | 'changed';

export const CHANGE_EFFECT_SIGNS: Record<SchemaChangeEffect, string> = {
  added: '+',
  removed: '−',
  changed: '~',
};

export function findChangeEffect(change: SchemaChange): SchemaChangeEffect {
  switch (change.kind) {
    case 'table_added':
    case 'column_added':
    case 'unique_added':
    case 'foreign_key_added':
    case 'check_added':
    case 'index_added':
    case 'enum_added':
    case 'enum_value_added':
      return 'added';
    case 'table_removed':
    case 'column_removed':
    case 'unique_removed':
    case 'foreign_key_removed':
    case 'check_removed':
    case 'index_removed':
    case 'enum_removed':
      return 'removed';
    default:
      return 'changed';
  }
}

function labelChangeKind(kind: SchemaChangeKind): string {
  switch (kind) {
    case 'table_added':
      return 'Table added';
    case 'table_removed':
      return 'Table removed';
    case 'column_added':
      return 'Column added';
    case 'column_removed':
      return 'Column removed';
    case 'column_changed':
      return 'Column changed';
    case 'primary_key_changed':
      return 'Primary key changed';
    case 'unique_added':
      return 'Unique constraint added';
    case 'unique_removed':
      return 'Unique constraint removed';
    case 'foreign_key_added':
      return 'Foreign key added';
    case 'foreign_key_removed':
      return 'Foreign key removed';
    case 'check_added':
      return 'Check added';
    case 'check_removed':
      return 'Check removed';
    case 'index_added':
      return 'Index added';
    case 'index_removed':
      return 'Index removed';
    case 'enum_added':
      return 'Enum added';
    case 'enum_removed':
      return 'Enum removed';
    case 'enum_value_added':
      return 'Enum value added';
    default:
      // A kind added to the server after this build: show it as it is.
      return String(kind);
  }
}

/** `Column added: users.phone`. */
export function describeSchemaChange(change: SchemaChange): string {
  const location = [change.tableName, change.objectName].filter(Boolean).join('.');
  const label = labelChangeKind(change.kind);
  return location ? `${label}: ${location}` : label;
}
