const PLAIN_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

const RESERVED_WORDS = new Set([
  'all', 'analyse', 'analyze', 'and', 'any', 'array', 'as', 'asc', 'both', 'case', 'cast', 'check',
  'collate', 'column', 'constraint', 'create', 'current_date', 'current_user', 'default', 'desc',
  'distinct', 'do', 'else', 'end', 'except', 'false', 'fetch', 'for', 'foreign', 'from', 'grant',
  'group', 'having', 'in', 'initially', 'intersect', 'into', 'leading', 'limit', 'not', 'null',
  'offset', 'on', 'only', 'or', 'order', 'placing', 'primary', 'references', 'returning', 'select',
  'session_user', 'some', 'symmetric', 'table', 'then', 'to', 'trailing', 'true', 'union', 'unique',
  'user', 'using', 'variadic', 'when', 'where', 'window', 'with',
]);

/** Quotes an identifier only when it has to be. */
export function quoteIdentifier(name: string): string {
  if (PLAIN_IDENTIFIER.test(name) && !RESERVED_WORDS.has(name)) {
    return name;
  }
  return `"${name.replaceAll('"', '""')}"`;
}

export function quoteIdentifiers(names: readonly string[]): string {
  return names.map(quoteIdentifier).join(', ');
}

/** Writes a string literal, doubling single quotes. */
export function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
