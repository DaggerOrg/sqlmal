import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { Table } from '@sqlmal/contracts';
import { ChipComponent } from '../chip/chip.component';
import { ByteSizePipe } from '../pipes/byte-size.pipe';
import { CompactCountPipe } from '../pipes/compact-count.pipe';

/** Everything about one table: columns, keys, indexes, and who points at it. */
@Component({
  selector: 'app-table-detail',
  imports: [ChipComponent, ByteSizePipe, CompactCountPipe],
  templateUrl: './table-detail.component.html',
  styleUrl: './table-detail.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TableDetailComponent {
  readonly table = input.required<Table>();
  /** Every table in the schema, to find the foreign keys that point at this one. */
  readonly allTables = input.required<readonly Table[]>();

  protected readonly primaryKeyColumnNames = computed(() => new Set(this.table().primaryKey));
  protected readonly referencingForeignKeys = computed(() => {
    const tableName = this.table().name;
    return this.allTables().flatMap((referencingTable) =>
      referencingTable.foreignKeys
        .filter((foreignKey) => foreignKey.referencedTable === tableName)
        .map((foreignKey) => ({ referencingTableName: referencingTable.name, foreignKey })),
    );
  });
  protected readonly secondaryIndexes = computed(() => this.table().indexes.filter((index) => !index.isPrimary));

  protected describeIndexDefinition(definition: string): string {
    return definition.replace(' ON public.', ' ON ');
  }
}
