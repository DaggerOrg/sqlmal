import { deriveAdminDsn } from './database-dsn';

describe('deriveAdminDsn', () => {
  it('points at the maintenance database and keeps the query', () => {
    expect(deriveAdminDsn('postgres://u:p@db.example:5432/shop?sslmode=require')).toBe(
      'postgres://u:p@db.example:5432/postgres?sslmode=require',
    );
  });

  it('says so when a key=value DSN cannot be rewritten', () => {
    expect(() => deriveAdminDsn('host=localhost dbname=shop')).toThrow(/postgres:\/\/user:pass@host/);
  });
});
