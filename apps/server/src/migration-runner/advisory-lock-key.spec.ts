import { computeAdvisoryLockKey, computeFnv1a64 } from './advisory-lock-key';

describe('computeAdvisoryLockKey', () => {
  it('uses FNV-1a 64 like the Go hash/fnv package', () => {
    expect(computeFnv1a64('').toString(16)).toBe('cbf29ce484222325');
    expect(computeFnv1a64('a').toString(16)).toBe('af63dc4c8601ec8c');
  });

  it('fits a signed bigint and depends on the database name', () => {
    const key = BigInt(computeAdvisoryLockKey('shop'));
    expect(key >= 0n && key <= 0x7fffffffffffffffn).toBe(true);
    expect(computeAdvisoryLockKey('shop')).not.toBe(computeAdvisoryLockKey('blog'));
  });
});
