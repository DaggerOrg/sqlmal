import { ChangeDetectionStrategy, Component, computed, inject, input, resource, signal } from '@angular/core';
import { Router } from '@angular/router';
import { NgIcon } from '@ng-icons/core';
import { phosphorPlayFill } from '@ng-icons/phosphor-icons/fill';
import { phosphorArrowCounterClockwise, phosphorEye } from '@ng-icons/phosphor-icons/regular';
import type {
  MigrationDirection,
  MigrationRunResult,
  RunMigrationsRequest,
  RunMigrationsResponse,
} from '@sqlmal/contracts';
import { formatVersion } from '../../core/format';
import { SqlmalApiService } from '../../core/sqlmal-api.service';
import { ChipComponent } from '../../shared/chip/chip.component';
import { EmptyStateComponent } from '../../shared/empty-state/empty-state.component';
import { ErrorBoxComponent } from '../../shared/error-box/error-box.component';
import { LintFindingComponent } from '../../shared/lint-finding/lint-finding.component';
import { LoadingSkeletonComponent } from '../../shared/loading-skeleton/loading-skeleton.component';
import { MigrationStateChipComponent } from '../../shared/migration-state-chip/migration-state-chip.component';
import { PageHeaderComponent } from '../../shared/page-header/page-header.component';
import { CapitalizeFirstLetterPipe } from '../../shared/pipes/capitalize-first-letter.pipe';
import { MigrationNamePipe } from '../../shared/pipes/migration-name.pipe';
import { PluralizePipe } from '../../shared/pipes/pluralize.pipe';
import { TimestampPipe } from '../../shared/pipes/timestamp.pipe';
import { VersionLabelPipe } from '../../shared/pipes/version-label.pipe';
import { SchemaChangeListComponent } from '../../shared/schema-change-list/schema-change-list.component';
import { SqlCodeViewComponent } from '../../shared/sql-code-view/sql-code-view.component';

interface RunState {
  isRunning: boolean;
  response?: RunMigrationsResponse;
  errorMessage?: string;
}

const MIGRATION_DIRECTIONS: readonly MigrationDirection[] = ['up', 'down'];

/** Every migration, newest first, with its SQL, lint findings, what it changes, and run buttons. */
@Component({
  selector: 'app-migrations-page',
  imports: [
    NgIcon,
    ChipComponent,
    EmptyStateComponent,
    ErrorBoxComponent,
    LintFindingComponent,
    LoadingSkeletonComponent,
    MigrationStateChipComponent,
    PageHeaderComponent,
    SchemaChangeListComponent,
    SqlCodeViewComponent,
    CapitalizeFirstLetterPipe,
    MigrationNamePipe,
    PluralizePipe,
    TimestampPipe,
    VersionLabelPipe,
  ],
  templateUrl: './migrations.page.html',
  styleUrl: './migrations.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'page-stack' },
})
export class MigrationsPage {
  private readonly dataSource = inject(SqlmalApiService).dataSource;
  private readonly router = inject(Router);

  /** From the route `migrations/:version`. */
  readonly version = input<string>();

  protected readonly serverInfo = this.dataSource.serverInfo;
  protected readonly canWrite = !this.serverInfo.isReadOnly;
  protected readonly migrationDirections = MIGRATION_DIRECTIONS;
  protected readonly icons = { phosphorArrowCounterClockwise, phosphorEye, phosphorPlayFill };

  protected readonly selectedDirection = signal<MigrationDirection>('up');
  protected readonly runState = signal<RunState>({ isRunning: false });

  protected readonly migrationData = resource({
    loader: async () => {
      const [statuses, migrations] = await Promise.all([
        this.dataSource.loadStatuses(),
        this.dataSource.loadMigrations(),
      ]);
      // The timeline needs a scratch database; without one the page still shows files, SQL and lint.
      const timeline = await this.dataSource.loadTimeline().catch(() => null);
      return { statuses, migrations, timeline };
    },
  });

  protected readonly statusesNewestFirst = computed(() =>
    this.migrationData.hasValue()
      ? [...this.migrationData.value().statuses].sort((first, second) => second.version - first.version)
      : [],
  );

  protected readonly selectedVersion = computed(() => {
    const routeVersion = this.version();
    return routeVersion ? Number(routeVersion) : this.statusesNewestFirst()[0]?.version;
  });

  protected readonly selected = computed(() => {
    if (!this.migrationData.hasValue()) return undefined;
    const { statuses, migrations, timeline } = this.migrationData.value();
    const version = this.selectedVersion();
    const status = statuses.find((candidate) => candidate.version === version);
    const migration = migrations.find((candidate) => candidate.version === version);
    if (!status || !migration) return undefined;
    const step = timeline?.steps.find((candidate) => candidate.version === version);
    return { status, migration, step };
  });

  protected readonly visibleSql = computed(() => {
    const selected = this.selected();
    if (!selected) return undefined;
    const direction = this.selectedDirection();
    const { migration } = selected;
    return {
      sql: direction === 'up' ? migration.upSql : migration.downSql,
      lintLineNumbers: migration.lintFindings
        .filter((finding) => finding.file === direction)
        .map((finding) => finding.line),
      label: `${direction} SQL`,
    };
  });

  protected readonly hasRunFailed = computed(() => {
    const response = this.runState().response;
    return Boolean(response?.errorMessage) || (response?.results.some((result) => result.errorMessage) ?? false);
  });

  protected selectMigration(version: number): void {
    this.runState.set({ isRunning: false });
    void this.router.navigate(['/migrations', version]);
  }

  protected describeVersion(version: number): string {
    return `Migration ${formatVersion(version)}`;
  }

  protected describeRunResult(result: MigrationRunResult): string {
    const heading = `${formatVersion(result.version)} ${result.name} (${result.direction}${result.isDryRun ? ', dry run' : ''}): `;
    if (result.errorMessage) {
      return `${heading}failed${result.errorLine ? ` on line ${result.errorLine}` : ''}: ${result.errorMessage}`;
    }
    if (result.skippedReason) return `${heading}skipped (${result.skippedReason})`;
    return `${heading}ok in ${result.durationMs} ms`;
  }

  protected async runMigrations(direction: MigrationDirection, isDryRun: boolean): Promise<void> {
    const selected = this.selected();
    if (!selected || !this.migrationData.hasValue()) return;
    const { status } = selected;
    this.runState.set({ isRunning: true });
    // Up stops after this version. Down rolls back this one and everything applied after it.
    const request: RunMigrationsRequest =
      direction === 'up'
        ? { direction, targetVersion: status.version, isDryRun }
        : {
            direction,
            steps: this.migrationData
              .value()
              .statuses.filter(
                (candidate) => candidate.version >= status.version && candidate.state !== 'pending',
              ).length,
            isDryRun,
          };
    try {
      const response = await this.dataSource.runMigrations(request);
      this.runState.set({ isRunning: false, response });
      if (!isDryRun) this.migrationData.reload();
    } catch (error: unknown) {
      this.runState.set({ isRunning: false, errorMessage: error instanceof Error ? error.message : String(error) });
    }
  }
}
