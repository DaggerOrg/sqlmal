import { DatabaseError } from 'pg';

import { countNewlines } from '../sql/sql-splitter';

export interface DatabaseErrorDescription {
  message: string;
  /** 1-based line in the script, or 0 when PostgreSQL gave no position. */
  line: number;
}

/**
 * Turns a database error into a message and, when PostgreSQL gives a position (a 1-based
 * character offset), the line of the migration where it happened.
 */
export function describeDatabaseError(sql: string, error: unknown): DatabaseErrorDescription {
  if (error instanceof DatabaseError) {
    let line = 0;
    const position = Number(error.position ?? 0);
    const characters = Array.from(sql);
    if (position > 0 && position <= characters.length + 1) {
      line = countNewlines(characters.slice(0, position - 1).join('')) + 1;
    }
    let message = error.message;
    if (error.detail !== undefined && error.detail !== '') {
      message += ` (${error.detail})`;
    }
    return { message, line };
  }
  return { message: error instanceof Error ? error.message : String(error), line: 0 };
}
