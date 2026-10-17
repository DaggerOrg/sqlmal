import { createHash } from 'node:crypto';

import type { Migration } from '../migration-files/migration';

/** Changes whenever any migration file's content changes. */
export function computeMigrationFingerprint(migrations: readonly Migration[]): string {
  const hash = createHash('sha256');
  for (const migration of migrations) {
    hash.update(`${migration.version}|${migration.name}|${migration.upSql}|${migration.downSql}\n`, 'utf8');
  }
  return hash.digest('hex').slice(0, 16);
}
