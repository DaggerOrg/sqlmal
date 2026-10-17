import { DatabaseError } from 'pg';

import { describeDatabaseError } from './database-error-description';

function buildDatabaseError(message: string, position?: string, detail?: string): DatabaseError {
  const error = new DatabaseError(message, 0, 'error');
  error.position = position;
  error.detail = detail;
  return error;
}

describe('describeDatabaseError', () => {
  it('turns the character position into a line and appends the detail', () => {
    const sql = 'SELECT 1;\nSELECT nope;';
    expect(describeDatabaseError(sql, buildDatabaseError('column "nope" does not exist', '18', 'more'))).toEqual({
      message: 'column "nope" does not exist (more)',
      line: 2,
    });
  });

  it('gives line 0 without a position and passes other errors through', () => {
    expect(describeDatabaseError('SELECT 1/0', buildDatabaseError('division by zero')).line).toBe(0);
    expect(describeDatabaseError('x', new Error('boom'))).toEqual({ message: 'boom', line: 0 });
  });
});
