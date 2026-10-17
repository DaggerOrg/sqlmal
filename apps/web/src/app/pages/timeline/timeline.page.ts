import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  resource,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import { NgIcon } from '@ng-icons/core';
import { phosphorPauseFill, phosphorPlayFill } from '@ng-icons/phosphor-icons/fill';
import { phosphorSkipBack, phosphorSkipForward } from '@ng-icons/phosphor-icons/regular';
import type { Table } from '@sqlmal/contracts';
import { formatVersion, humanizeMigrationName, pluralize } from '../../core/format';
import { SqlmalApiService } from '../../core/sqlmal-api.service';
import { ChipComponent } from '../../shared/chip/chip.component';
import { EmptyStateComponent } from '../../shared/empty-state/empty-state.component';
import { ErrorBoxComponent } from '../../shared/error-box/error-box.component';
import { LoadingSkeletonComponent } from '../../shared/loading-skeleton/loading-skeleton.component';
import { PageHeaderComponent } from '../../shared/page-header/page-header.component';
import { CapitalizeFirstLetterPipe } from '../../shared/pipes/capitalize-first-letter.pipe';
import { PluralizePipe } from '../../shared/pipes/pluralize.pipe';
import { SchemaChangeListComponent } from '../../shared/schema-change-list/schema-change-list.component';
import {
  SchemaDiagramComponent,
  type ColumnMark,
  type TableMark,
} from '../../shared/schema-diagram/schema-diagram.component';
import { layoutSchemaTables, mergeTablesAcrossSchemas } from '../../shared/schema-diagram/schema-tables';

const PLAYBACK_STEP_INTERVAL_MS = 1300;

/** Replays the migrations one by one and shows the schema after each. */
@Component({
  selector: 'app-timeline-page',
  imports: [
    NgIcon,
    ChipComponent,
    EmptyStateComponent,
    ErrorBoxComponent,
    LoadingSkeletonComponent,
    PageHeaderComponent,
    SchemaChangeListComponent,
    SchemaDiagramComponent,
    CapitalizeFirstLetterPipe,
    PluralizePipe,
  ],
  templateUrl: './timeline.page.html',
  styleUrl: './timeline.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'page-stack' },
})
export class TimelinePage {
  private readonly dataSource = inject(SqlmalApiService).dataSource;
  private readonly router = inject(Router);

  /** From the route `timeline/:version`; `0` is the empty database. */
  readonly version = input<string>();

  protected readonly databaseName = this.dataSource.databaseName;
  protected readonly icons = { phosphorPauseFill, phosphorPlayFill, phosphorSkipBack, phosphorSkipForward };
  protected readonly isPlaying = signal(false);
  /** Set when Play is pressed on the last step: the route has not moved back to the start yet. */
  private isRestarting = false;

  protected readonly timeline = resource({ loader: () => this.dataSource.loadTimeline() });

  protected readonly steps = computed(() => (this.timeline.hasValue() ? this.timeline.value().steps : []));

  /** Position 0 is the empty database; position n is the schema after the nth migration. */
  protected readonly position = computed(() => {
    const steps = this.steps();
    const routeVersion = this.version();
    const positionFromRoute = routeVersion
      ? steps.findIndex((step) => step.version === Number(routeVersion)) + 1
      : steps.length;
    return Math.max(0, Math.min(steps.length, positionFromRoute));
  });

  protected readonly currentStep = computed(() => {
    const position = this.position();
    return position === 0 ? undefined : this.steps()[position - 1];
  });

  protected readonly boxesByTableName = computed(() =>
    layoutSchemaTables(mergeTablesAcrossSchemas(this.steps().map((step) => step.schema))),
  );

  protected readonly currentTables = computed<readonly Table[]>(() => this.currentStep()?.schema.tables ?? []);

  /** Tables that the current step removed, drawn dashed where they used to be. */
  protected readonly removedTables = computed(() => {
    const position = this.position();
    const previousTables = position <= 1 ? [] : (this.steps()[position - 2]?.schema.tables ?? []);
    const currentTableNames = new Set(this.currentTables().map((table) => table.name));
    return previousTables.filter((table) => !currentTableNames.has(table.name));
  });

  protected readonly changeMarks = computed(() => {
    const tableMarks: Partial<Record<string, TableMark>> = {};
    const columnMarks: Partial<Record<string, Partial<Record<string, ColumnMark>>>> = {};
    for (const change of this.currentStep()?.changes ?? []) {
      const { tableName, objectName, kind } = change;
      if (!tableName) continue;
      if (kind === 'table_added') tableMarks[tableName] = 'added';
      else if (kind !== 'table_removed' && !tableMarks[tableName]) tableMarks[tableName] = 'changed';
      if (objectName && (kind === 'column_added' || kind === 'column_changed')) {
        (columnMarks[tableName] ??= {})[objectName] = kind === 'column_added' ? 'added' : 'changed';
      }
    }
    return { tableMarks, columnMarks };
  });

  protected readonly currentStepTitle = computed(() => {
    const step = this.currentStep();
    return step ? `${formatVersion(step.version)} ${humanizeMigrationName(step.name)}` : 'Empty database';
  });

  protected readonly sliderValueText = computed(() => {
    const step = this.currentStep();
    return step ? `${formatVersion(step.version)} ${step.name}` : 'Empty database';
  });

  protected readonly diagramLabel = computed(() => {
    const step = this.currentStep();
    return `Schema after ${step ? step.name : 'no migrations'}, ${pluralize(this.currentTables().length, 'table')}`;
  });

  protected readonly ticks = computed(() =>
    this.steps().map((step, stepIndex) => ({
      version: step.version,
      isReached: stepIndex < this.position(),
      isFailed: Boolean(step.errorMessage),
      isIrreversible: !step.errorMessage && step.isReversible === false,
    })),
  );

  constructor() {
    effect((onCleanup) => {
      if (!this.isPlaying()) return;
      const position = this.position();
      const stepCount = this.steps().length;
      if (this.isRestarting) {
        if (position >= stepCount) return;
        this.isRestarting = false;
      }
      if (position >= stepCount) {
        this.isPlaying.set(false);
        return;
      }
      const timer = setTimeout(() => {
        this.goToPosition(position + 1);
      }, PLAYBACK_STEP_INTERVAL_MS);
      onCleanup(() => {
        clearTimeout(timer);
      });
    });
  }

  protected stepBack(): void {
    this.isPlaying.set(false);
    this.goToPosition(this.position() - 1);
  }

  protected stepForward(): void {
    this.isPlaying.set(false);
    this.goToPosition(this.position() + 1);
  }

  protected togglePlayback(): void {
    if (!this.isPlaying() && this.position() >= this.steps().length) {
      this.isRestarting = true;
      this.goToPosition(0);
    }
    this.isPlaying.update((isPlaying) => !isPlaying);
  }

  protected scrubTo(event: Event): void {
    if (!(event.target instanceof HTMLInputElement)) return;
    this.isPlaying.set(false);
    this.goToPosition(Number(event.target.value));
  }

  private goToPosition(position: number): void {
    const step = this.steps()[position - 1];
    void this.router.navigate(['/timeline', position === 0 || !step ? 0 : step.version]);
  }
}
