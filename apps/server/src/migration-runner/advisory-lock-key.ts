const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const UINT64_MASK = 0xffffffffffffffffn;

/** FNV-1a, 64 bit, over the UTF-8 bytes of `text`. */
export function computeFnv1a64(text: string): bigint {
  let hash = FNV_OFFSET_BASIS;
  for (const byte of Buffer.from(text, 'utf8')) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & UINT64_MASK;
  }
  return hash;
}

/**
 * The advisory lock key for a database: FNV-1a 64 of `sqlmal:<database>`, shifted right by
 * one so it fits a signed bigint. Returned as a decimal string for the driver.
 */
export function computeAdvisoryLockKey(databaseName: string): string {
  return BigInt.asIntN(64, computeFnv1a64(`sqlmal:${databaseName}`) >> 1n).toString();
}
