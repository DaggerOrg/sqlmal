import { ChangeDetectionStrategy, Component, inject, resource } from '@angular/core';
import { NgIcon } from '@ng-icons/core';
import { phosphorCheckCircleFill, phosphorXCircleFill } from '@ng-icons/phosphor-icons/fill';
import { SqlmalApiService } from '../../core/sqlmal-api.service';
import { EmptyStateComponent } from '../../shared/empty-state/empty-state.component';
import { ErrorBoxComponent } from '../../shared/error-box/error-box.component';
import { LoadingSkeletonComponent } from '../../shared/loading-skeleton/loading-skeleton.component';
import { PageHeaderComponent } from '../../shared/page-header/page-header.component';
import { TimestampPipe } from '../../shared/pipes/timestamp.pipe';
import { VersionLabelPipe } from '../../shared/pipes/version-label.pipe';

/** Every migration run, including failures and rollbacks. */
@Component({
  selector: 'app-history-page',
  imports: [
    NgIcon,
    EmptyStateComponent,
    ErrorBoxComponent,
    LoadingSkeletonComponent,
    PageHeaderComponent,
    TimestampPipe,
    VersionLabelPipe,
  ],
  templateUrl: './history.page.html',
  styleUrl: './history.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'page-stack' },
})
export class HistoryPage {
  private readonly dataSource = inject(SqlmalApiService).dataSource;

  protected readonly icons = { phosphorCheckCircleFill, phosphorXCircleFill };
  protected readonly history = resource({ loader: () => this.dataSource.loadHistory() });
}
