import { TtlCache } from './ttl-cache';

describe('TtlCache', () => {
  it('computes once for concurrent callers of the same key', async () => {
    const cache = new TtlCache();
    let computeCount = 0;
    const compute = async (): Promise<number> => {
      computeCount++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return 42;
    };
    const values = await Promise.all([cache.remember('a:x', 1000, compute), cache.remember('a:x', 1000, compute)]);
    expect(values).toEqual([42, 42]);
    expect(computeCount).toBe(1);
    expect(cache.entryCount).toBe(1);
  });

  it('does not remember failures, and forgets by prefix', async () => {
    const cache = new TtlCache();
    await expect(cache.remember('a:x', 1000, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(cache.entryCount).toBe(0);
    await cache.remember('a:x', 1000, () => Promise.resolve(1));
    await cache.remember('ab:x', 1000, () => Promise.resolve(2));
    cache.forgetByPrefix('a:');
    expect(cache.entryCount).toBe(1);
  });

  it('recomputes after the time to live', async () => {
    const cache = new TtlCache();
    await cache.remember('k', -1, () => Promise.resolve(1));
    expect(await cache.remember('k', 1000, () => Promise.resolve(2))).toBe(2);
  });
});
