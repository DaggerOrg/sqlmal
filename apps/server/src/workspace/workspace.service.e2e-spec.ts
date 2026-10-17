import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createSingleDatabaseConfig } from '../project-config/project-config-loader';
import { MigrationDirectory } from '../testing/migration-directory';
import { describeWithDatabase, itWithDatabase, type TestDatabase } from '../testing/test-database';
import { WorkspaceService } from './workspace.service';

interface Workspace {
  service: WorkspaceService;
  database: TestDatabase;
  directory: MigrationDirectory;
}

describeWithDatabase('WorkspaceService', (context) => {
  async function createWorkspace(): Promise<Workspace> {
    const database = await context.createDatabase();
    const directory = new MigrationDirectory()
      .writeFile('0001_users.up.sql', 'CREATE TABLE users (id serial PRIMARY KEY, email text NOT NULL);')
      .writeFile('0001_users.down.sql', 'DROP TABLE users;')
      .writeFile('0002_cleanup.up.sql', 'ALTER TABLE users ADD COLUMN age int;\nDROP TABLE IF EXISTS nothing;')
      .writeFile('0002_cleanup.down.sql', 'ALTER TABLE users DROP COLUMN age;');
    return {
      service: new WorkspaceService(createSingleDatabaseConfig(database.dsn, directory.path)),
      database,
      directory,
    };
  }

  itWithDatabase(context, 'lists migrations with lint findings and never leaks file paths', async () => {
    const { service, directory } = await createWorkspace();
    const migrations = service.listMigrations('default');
    expect(migrations).toHaveLength(2);
    expect(migrations[0]!.lintFindings).toEqual([]);
    expect(migrations[1]!.lintFindings.map((finding) => finding.ruleId)).toContain('L001');
    const snapshot = await service.buildSnapshot('default');
    expect(JSON.stringify(snapshot)).not.toContain(directory.path);
  });

  itWithDatabase(context, 'rejects an unknown database', async () => {
    const { service } = await createWorkspace();
    await expect(service.readStatuses('nope')).rejects.toThrow('unknown database');
  });

  itWithDatabase(context, 'runs migrations and caches the timeline until a file changes', async () => {
    const { service, directory } = await createWorkspace();
    await service.runMigrations('default', 'up', {});
    const statuses = await service.readStatuses('default');
    expect(statuses.map((status) => status.state)).toEqual(['applied', 'applied']);
    const first = await service.buildTimeline('default');
    expect(first.steps).toHaveLength(2);
    expect(first.isFullyReversible).toBe(true);
    expect(service.cachedResultCount).toBe(1);
    await service.buildTimeline('default');
    expect(service.cachedResultCount).toBe(1);
    writeFileSync(join(directory.path, '0002_cleanup.down.sql'), '-- nothing\n');
    const changed = await service.buildTimeline('default');
    expect(changed.isFullyReversible).toBe(false);
  });

  // A change made by hand becomes a migration, and once that migration exists the database
  // and the files agree again.
  itWithDatabase(context, 'turns hand-made changes into a migration', async () => {
    const { service, database, directory } = await createWorkspace();
    await service.runMigrations('default', 'up', {});
    await database.query('ALTER TABLE users ADD COLUMN hotfix text; CREATE INDEX idx_hotfix ON users (hotfix);');
    expect((await service.detectDrift('default')).isInSync).toBe(false);
    const proposal = await service.proposeDriftMigration('default');
    expect(proposal.up.sql).toContain('ADD COLUMN hotfix text');
    expect(proposal.down.sql).toContain('DROP COLUMN hotfix');
    const upPath = service.createMigration('default', 'adopt_hotfix', proposal.up.sql, proposal.down.sql);
    expect(upPath.endsWith('0003_adopt_hotfix.up.sql')).toBe(true);
    await service.recordBaseline('default', 3);
    expect((await service.detectDrift('default')).isInSync).toBe(true);
    const timeline = await service.buildTimeline('default');
    expect(timeline.failedVersion).toBeUndefined();
    expect(timeline.isFullyReversible).toBe(true);
    expect(existsSync(join(directory.path, '0003_adopt_hotfix.down.sql'))).toBe(true);
  });
});
