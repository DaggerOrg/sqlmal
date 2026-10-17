import { ChangeDetectionStrategy, Component, computed, inject, resource } from '@angular/core';
import { RouterLink } from '@angular/router';
import { NgIcon } from '@ng-icons/core';
import { phosphorDatabaseFill, phosphorGitBranchFill, phosphorWarningFill } from '@ng-icons/phosphor-icons/fill';
import { phosphorArrowRight } from '@ng-icons/phosphor-icons/regular';
import type { LintFinding } from '@sqlmal/contracts';
import { pluralize } from '../../core/format';
import { countMigrationStates } from '../../core/migration-state-counts';
import { SqlmalApiService } from '../../core/sqlmal-api.service';
import { ChipComponent } from '../../shared/chip/chip.component';
import { ErrorBoxComponent } from '../../shared/error-box/error-box.component';
import { LintFindingComponent } from '../../shared/lint-finding/lint-finding.component';
import { LoadingSkeletonComponent } from '../../shared/loading-skeleton/loading-skeleton.component';
import { PluralizePipe } from '../../shared/pipes/pluralize.pipe';
import { TimestampPipe } from '../../shared/pipes/timestamp.pipe';
import { VersionLabelPipe } from '../../shared/pipes/version-label.pipe';

const MAX_LISTED_FINDINGS = 5;

const EXPLORE_LINKS = [
  {
    section: 'schema',
    heading: 'Schema diagram',
    description: 'Every table and foreign key as a map you can pan and zoom.',
  },
  { section: 'timeline', heading: 'Timeline', description: 'Scrub through the schema after each migration.' },
  {
    section: 'migrations',
    heading: 'Migrations',
    description: 'Read the SQL, the lint findings and what each one changes.',
  },
] as const;

/** The landing page: a summary of the database and a list of what needs attention. */
@Component({
  selector: 'app-overview-page',
  imports: [
    RouterLink,
    NgIcon,
    ChipComponent,
    ErrorBoxComponent,
    LintFindingComponent,
    LoadingSkeletonComponent,
    PluralizePipe,
    TimestampPipe,
    VersionLabelPipe,
  ],
  templateUrl: './overview.page.html',
  styleUrl: './overview.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'page-stack' },
})
export class OverviewPage {
  private readonly api = inject(SqlmalApiService);
  private readonly dataSource = this.api.dataSource;

  protected readonly serverInfo = this.dataSource.serverInfo;
  protected readonly databaseName = this.dataSource.databaseName;
  protected readonly exploreLinks = EXPLORE_LINKS;
  protected readonly icons = {
    phosphorArrowRight,
    phosphorDatabaseFill,
    phosphorGitBranchFill,
    phosphorWarningFill,
  };

  protected readonly overviewData = resource({
    loader: async () => {
      const [statuses, migrations, schema] = await Promise.all([
        this.dataSource.loadStatuses(),
        this.dataSource.loadMigrations(),
        this.dataSource.loadSchema(),
      ]);
      // The scratch-database checks can be unavailable (no CREATEDB permission). The rest of the page still works.
      const [timelineResult, driftResult] = await Promise.allSettled([
        this.dataSource.loadTimeline(),
        this.dataSource.loadDrift(),
      ]);
      return { statuses, migrations, schema, timelineResult, driftResult };
    },
  });

  protected readonly summary = computed(() => {
    if (!this.overviewData.hasValue()) return undefined;
    const { statuses, migrations, schema, timelineResult, driftResult } = this.overviewData.value();
    const timeline = timelineResult.status === 'fulfilled' ? timelineResult.value : null;
    const drift = driftResult.status === 'fulfilled' ? driftResult.value : null;
    const rejectedCheck = [timelineResult, driftResult].find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    const stateCounts = countMigrationStates(statuses);
    const flaggedFindings: LintFinding[] = migrations
      .flatMap((migration) => migration.lintFindings)
      .filter((finding) => finding.severity !== 'info');
    const irreversibleSteps = (timeline?.steps ?? []).filter((step) => step.isReversible === false);
    const hasDrift = drift !== null && !drift.isInSync;
    const problemCount =
      stateCounts.modified +
      stateCounts.missing +
      irreversibleSteps.length +
      (hasDrift ? 1 : 0) +
      flaggedFindings.length;
    const lastAppliedStatus = statuses
      .filter((status) => status.state === 'applied' || status.state === 'modified')
      .sort((first, second) => second.version - first.version)[0];
    return {
      migrationCount: statuses.length,
      stateCounts,
      tableCount: schema.tables.length,
      drift,
      hasDrift,
      unavailableReason: rejectedCheck ? describeRejection(rejectedCheck.reason) : undefined,
      irreversibleSteps,
      listedFindings: flaggedFindings.slice(0, MAX_LISTED_FINDINGS),
      problemCount,
      lastAppliedAt: lastAppliedStatus?.appliedAt,
      driftValueLabel: drift ? (drift.isInSync ? 'None' : String(drift.changes.length)) : 'n/a',
      driftCaption:
        drift && !drift.isInSync
          ? pluralize(drift.changes.length, 'drift change').replace(/^\d+ /, '')
          : 'drift',
    };
  });
}

function describeRejection(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
