interface CacheEntry {
  value: unknown;
  expiresAtMs: number;
}

/**
 * Remembers computed values for a while. Concurrent callers for the same key wait for the
 * first one instead of repeating the work; a failure is not remembered.
 */
export class TtlCache {
  private readonly entriesByKey = new Map<string, CacheEntry>();
  private readonly pendingByKey = new Map<string, Promise<unknown>>();

  get entryCount(): number {
    return this.entriesByKey.size;
  }

  async remember<TValue>(key: string, ttlMs: number, compute: () => Promise<TValue>): Promise<TValue> {
    for (;;) {
      const pending = this.pendingByKey.get(key);
      if (pending === undefined) {
        break;
      }
      await pending.catch(() => undefined);
    }
    const entry = this.entriesByKey.get(key);
    if (entry !== undefined && Date.now() < entry.expiresAtMs) {
      return entry.value as TValue;
    }
    const computation = compute();
    this.pendingByKey.set(key, computation);
    try {
      const value = await computation;
      this.entriesByKey.set(key, { value, expiresAtMs: Date.now() + ttlMs });
      return value;
    } finally {
      this.pendingByKey.delete(key);
    }
  }

  /** Forgets every entry whose key starts with `prefix`. */
  forgetByPrefix(prefix: string): void {
    for (const key of [...this.entriesByKey.keys()]) {
      if (key.startsWith(prefix)) {
        this.entriesByKey.delete(key);
      }
    }
  }
}
