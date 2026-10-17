/**
 * Cuts a SQL script into statements without a full parser.
 *
 * It understands the parts of PostgreSQL syntax that hide semicolons and keywords:
 * single-quoted strings (including E'' escapes), double-quoted identifiers, $tag$ dollar
 * quotes, line comments, and nested block comments.
 */

/** One statement with comments removed. */
export interface SqlStatement {
  /** The statement text, comments stripped, no trailing semicolon. */
  sql: string;
  /** The 1-based line where the statement starts. */
  line: number;
}

function isSpace(character: string | undefined): boolean {
  return character === ' ' || character === '\t' || character === '\r';
}

/** Returns the statements in script order. Empty statements are dropped. */
export function splitSqlStatements(source: string): SqlStatement[] {
  const statements: SqlStatement[] = [];
  let current = '';
  let line = 1;
  let startLine = 0;
  const flush = (): void => {
    const text = current.trim();
    if (text !== '') {
      statements.push({ sql: text, line: startLine });
    }
    current = '';
    startLine = 0;
  };
  const markStart = (): void => {
    if (startLine === 0) {
      startLine = line;
    }
  };
  const length = source.length;
  let index = 0;
  while (index < length) {
    const character = source[index];
    const next = source[index + 1];
    if (character === '\n') {
      line++;
      current += character;
      index++;
    } else if (character === '-' && next === '-') {
      while (index < length && source[index] !== '\n') {
        index++;
      }
    } else if (character === '/' && next === '*') {
      // Block comments nest in PostgreSQL.
      let depth = 1;
      index += 2;
      while (index < length && depth > 0) {
        if (source[index] === '\n') {
          line++;
          index++;
        } else if (source[index] === '/' && source[index + 1] === '*') {
          depth++;
          index += 2;
        } else if (source[index] === '*' && source[index + 1] === '/') {
          depth--;
          index += 2;
        } else {
          index++;
        }
      }
      current += ' ';
    } else if (character === "'") {
      markStart();
      const previous = source[index - 1];
      const hasEscapes = index > 0 && (previous === 'E' || previous === 'e');
      let end = index + 1;
      while (end < length) {
        if (hasEscapes && source[end] === '\\' && end + 1 < length) {
          end += 2;
          continue;
        }
        if (source[end] === "'") {
          if (source[end + 1] === "'") {
            end += 2;
            continue;
          }
          break;
        }
        if (source[end] === '\n') {
          line++;
        }
        end++;
      }
      const stop = Math.min(end + 1, length);
      current += source.slice(index, stop);
      index = stop;
    } else if (character === '"') {
      markStart();
      let end = index + 1;
      while (end < length && !(source[end] === '"' && source[end + 1] !== '"')) {
        if (source[end] === '"') {
          end += 2;
          continue;
        }
        end++;
      }
      const stop = Math.min(end + 1, length);
      current += source.slice(index, stop);
      index = stop;
    } else if (character === '$') {
      markStart();
      const tag = readDollarTag(source, index);
      if (tag === undefined) {
        current += character;
        index++;
        continue;
      }
      const closing = source.indexOf(tag, index + tag.length);
      const stop = closing >= 0 ? closing + tag.length : length;
      const body = source.slice(index, stop);
      line += countNewlines(body);
      current += body;
      index = stop;
    } else if (character === ';') {
      flush();
      index++;
    } else {
      if (!isSpace(character)) {
        markStart();
      }
      current += character;
      index++;
    }
  }
  flush();
  return statements;
}

/** Returns the dollar-quote opener (such as `$$` or `$body$`) that starts at `start`, if there is one. */
function readDollarTag(source: string, start: number): string | undefined {
  for (let index = start + 1; index < source.length; index++) {
    const character = source.charAt(index);
    if (character === '$') {
      return source.slice(start, index + 1);
    }
    const isLetter = character === '_' || /^[A-Za-z]$/.test(character);
    const isDigitAfterFirst = index > start + 1 && /^[0-9]$/.test(character);
    if (!isLetter && !isDigitAfterFirst) {
      return undefined;
    }
  }
  return undefined;
}

export function countNewlines(text: string): number {
  let count = 0;
  for (const character of text) {
    if (character === '\n') {
      count++;
    }
  }
  return count;
}

/**
 * Uppercases a statement, collapses whitespace, and blanks string literals, so keyword
 * rules cannot be fooled by text inside a string.
 */
export function normalizeStatement(sql: string): string {
  let output = '';
  let isInString = false;
  for (let index = 0; index < sql.length; index++) {
    const character = sql[index];
    if (character === "'") {
      if (isInString && sql[index + 1] === "'") {
        index++;
        continue;
      }
      if (isInString) {
        output += "''"; // one placeholder per literal, written when it closes
      }
      isInString = !isInString;
      continue;
    }
    if (isInString) {
      continue;
    }
    output += character;
  }
  return output
    .toUpperCase()
    .split(/\s+/)
    .filter((word) => word !== '')
    .join(' ');
}
