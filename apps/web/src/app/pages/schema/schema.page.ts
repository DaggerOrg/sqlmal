import { ChangeDetectionStrategy, Component, computed, inject, input, resource, signal } from '@angular/core';
import { Router } from '@angular/router';
import { NgIcon } from '@ng-icons/core';
import { phosphorMagnifyingGlass, phosphorX } from '@ng-icons/phosphor-icons/regular';
import { pluralize } from '../../core/format';
import { SqlmalApiService } from '../../core/sqlmal-api.service';
import { EmptyStateComponent } from '../../shared/empty-state/empty-state.component';
import { ErrorBoxComponent } from '../../shared/error-box/error-box.component';
import { LoadingSkeletonComponent } from '../../shared/loading-skeleton/loading-skeleton.component';
import { PageHeaderComponent } from '../../shared/page-header/page-header.component';
import { SchemaDiagramComponent } from '../../shared/schema-diagram/schema-diagram.component';
import { layoutSchemaTables } from '../../shared/schema-diagram/schema-tables';
import { TableDetailComponent } from '../../shared/table-detail/table-detail.component';

/** The live schema as a diagram, with a search box and a details panel for the selected table. */
@Component({
  selector: 'app-schema-page',
  imports: [
    NgIcon,
    EmptyStateComponent,
    ErrorBoxComponent,
    LoadingSkeletonComponent,
    PageHeaderComponent,
    SchemaDiagramComponent,
    TableDetailComponent,
  ],
  templateUrl: './schema.page.html',
  styleUrl: './schema.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'page-stack' },
})
export class SchemaPage {
  private readonly dataSource = inject(SqlmalApiService).dataSource;
  private readonly router = inject(Router);

  /** From the route `schema/:tableName`. */
  readonly tableName = input<string>();

  protected readonly databaseName = this.dataSource.databaseName;
  protected readonly icons = { phosphorMagnifyingGlass, phosphorX };
  protected readonly searchText = signal('');

  protected readonly schema = resource({ loader: () => this.dataSource.loadSchema() });

  protected readonly tables = computed(() => (this.schema.hasValue() ? this.schema.value().tables : []));
  protected readonly enums = computed(() => (this.schema.hasValue() ? this.schema.value().enums : []));
  protected readonly boxesByTableName = computed(() => layoutSchemaTables(this.tables()));
  protected readonly selectedTableName = computed(() => this.tableName() ?? null);
  protected readonly selectedTable = computed(() =>
    this.tables().find((table) => table.name === this.selectedTableName()),
  );

  /** Tables that match neither by name nor by a column name are dimmed. */
  protected readonly dimmedTableNames = computed(() => {
    const searchTerm = this.searchText().trim().toLowerCase();
    if (!searchTerm) return undefined;
    return new Set(
      this.tables()
        .filter(
          (table) =>
            !table.name.toLowerCase().includes(searchTerm) &&
            !table.columns.some((column) => column.name.toLowerCase().includes(searchTerm)),
        )
        .map((table) => table.name),
    );
  });

  protected readonly description = computed(() => {
    const foreignKeyCount = this.tables().reduce((sum, table) => sum + table.foreignKeys.length, 0);
    return `${pluralize(this.tables().length, 'table')}, ${pluralize(foreignKeyCount, 'foreign key')}, ${pluralize(this.enums().length, 'enum')}.`;
  });

  protected readonly diagramLabel = computed(() => `Entity diagram with ${this.tables().length} tables`);

  protected updateSearchText(event: Event): void {
    if (event.target instanceof HTMLInputElement) this.searchText.set(event.target.value);
  }

  protected selectTable(tableName: string | null): void {
    void this.router.navigate(tableName ? ['/schema', tableName] : ['/schema']);
  }
}
