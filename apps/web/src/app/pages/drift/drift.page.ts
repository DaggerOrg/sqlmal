import { ChangeDetectionStrategy, Component, DestroyRef, inject, resource, signal } from '@angular/core';
import { NgIcon } from '@ng-icons/core';
import { phosphorCheck, phosphorCopy } from '@ng-icons/phosphor-icons/regular';
import type { DriftMigrationProposal } from '@sqlmal/contracts';
import { SqlmalApiService } from '../../core/sqlmal-api.service';
import { ChipComponent } from '../../shared/chip/chip.component';
import { EmptyStateComponent } from '../../shared/empty-state/empty-state.component';
import { ErrorBoxComponent } from '../../shared/error-box/error-box.component';
import { LoadingSkeletonComponent } from '../../shared/loading-skeleton/loading-skeleton.component';
import { PageHeaderComponent } from '../../shared/page-header/page-header.component';
import { PluralizePipe } from '../../shared/pipes/pluralize.pipe';
import { SchemaChangeListComponent } from '../../shared/schema-change-list/schema-change-list.component';
import { SqlCodeViewComponent } from '../../shared/sql-code-view/sql-code-view.component';

interface GenerationState {
  isGenerating: boolean;
  proposal?: DriftMigrationProposal;
  errorMessage?: string;
}

const COPIED_CONFIRMATION_MS = 1800;

/** Compares the live database with the migrations, and can write a migration that captures the difference. */
@Component({
  selector: 'app-drift-page',
  imports: [
    NgIcon,
    ChipComponent,
    EmptyStateComponent,
    ErrorBoxComponent,
    LoadingSkeletonComponent,
    PageHeaderComponent,
    SchemaChangeListComponent,
    SqlCodeViewComponent,
    PluralizePipe,
  ],
  templateUrl: './drift.page.html',
  styleUrl: './drift.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'page-stack' },
})
export class DriftPage {
  private readonly dataSource = inject(SqlmalApiService).dataSource;
  private copiedTimer: ReturnType<typeof setTimeout> | undefined;

  protected readonly icons = { phosphorCheck, phosphorCopy };
  protected readonly drift = resource({ loader: () => this.dataSource.loadDrift() });
  protected readonly generation = signal<GenerationState>({ isGenerating: false });
  protected readonly wasCopied = signal(false);

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      clearTimeout(this.copiedTimer);
    });
  }

  protected async generateMigration(): Promise<void> {
    this.generation.set({ isGenerating: true });
    try {
      this.generation.set({ isGenerating: false, proposal: await this.dataSource.generateDriftMigration() });
    } catch (error: unknown) {
      this.generation.set({
        isGenerating: false,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  protected async copyToClipboard(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.wasCopied.set(true);
      clearTimeout(this.copiedTimer);
      this.copiedTimer = setTimeout(() => {
        this.wasCopied.set(false);
      }, COPIED_CONFIRMATION_MS);
    } catch {
      /* clipboard can be blocked; the SQL is still on screen */
    }
  }
}
