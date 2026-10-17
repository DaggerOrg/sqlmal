import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  type ElementRef,
  afterNextRender,
  afterRenderEffect,
  computed,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { NgIcon } from '@ng-icons/core';
import {
  phosphorArrowsOut,
  phosphorMagnifyingGlassMinus,
  phosphorMagnifyingGlassPlus,
} from '@ng-icons/phosphor-icons/regular';
import type { Table } from '@sqlmal/contracts';
import { formatCompactCount } from '../../core/format';
import {
  HEADER_HEIGHT,
  MAX_VISIBLE_COLUMNS,
  NODE_WIDTH,
  ROW_HEIGHT,
  buildEdgePath,
  measureBounds,
  type DiagramBox,
} from './schema-layout';

/** How a table changed in the step being shown. */
export type TableMark = 'added' | 'changed';
/** How a column changed in the step being shown. */
export type ColumnMark = 'added' | 'changed';

interface DiagramViewport {
  offsetX: number;
  offsetY: number;
  scale: number;
}

interface PanGesture {
  startClientX: number;
  startClientY: number;
  startOffsetX: number;
  startOffsetY: number;
  hasMoved: boolean;
}

const MIN_FIT_SCALE = 0.2;
const MAX_FIT_SCALE = 1.1;
const MIN_SCALE = 0.15;
const MAX_SCALE = 2.5;
const FIT_PADDING = 48;
const KEYBOARD_ZOOM_FACTOR = 1.2;
const BUTTON_ZOOM_IN_FACTOR = 1.25;
const BUTTON_ZOOM_OUT_FACTOR = 0.8;
const WHEEL_ZOOM_SENSITIVITY = 0.0015;
/** Pointer travel, in pixels, before a press counts as a drag rather than a click. */
const DRAG_THRESHOLD = 3;
const MAX_TABLE_NAME_LENGTH = 24;
const MAX_COLUMN_NAME_LENGTH = 17;

let nextDiagramNumber = 0;

const clamp = (value: number, lowest: number, highest: number): number =>
  Math.min(highest, Math.max(lowest, value));

const truncate = (text: string, maxLength: number): string =>
  text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;

/** PostgreSQL's long type names, shortened to fit on a card. */
function shortenTypeName(typeName: string): string {
  return typeName
    .replace('timestamp with time zone', 'timestamptz')
    .replace('timestamp without time zone', 'timestamp')
    .replace('character varying', 'varchar')
    .replace('character', 'char')
    .replace('double precision', 'float8')
    .replace('integer', 'int');
}

/** An entity-relationship diagram you can pan, zoom and select tables in. */
@Component({
  selector: 'app-schema-diagram',
  imports: [NgIcon],
  templateUrl: './schema-diagram.component.html',
  styleUrl: './schema-diagram.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SchemaDiagramComponent {
  readonly tables = input.required<readonly Table[]>();
  /** Tables that were removed in this step: drawn dashed where they used to be. */
  readonly removedTables = input<readonly Table[]>([]);
  readonly boxesByTableName = input.required<Record<string, DiagramBox>>();
  readonly selectedTableName = input<string | null>(null);
  readonly tableMarks = input<Partial<Record<string, TableMark>>>({});
  /** Table name to column name to mark: the columns to colour. */
  readonly columnMarks = input<Partial<Record<string, Partial<Record<string, ColumnMark>>>>>({});
  readonly label = input.required<string>();
  /** The view is fitted to the content when this changes. */
  readonly fitKey = input<string>();
  readonly dimmedTableNames = input<ReadonlySet<string>>();
  /** A table was clicked (its name), or the selection was cleared (`null`). */
  readonly selectionChange = output<string | null>();

  protected readonly arrowMarkerId = `er-arrow-${nextDiagramNumber++}`;
  protected readonly icons = { phosphorArrowsOut, phosphorMagnifyingGlassMinus, phosphorMagnifyingGlassPlus };
  protected readonly constants = { HEADER_HEIGHT, MAX_VISIBLE_COLUMNS, NODE_WIDTH, ROW_HEIGHT };

  private readonly canvas = viewChild.required<ElementRef<SVGSVGElement>>('canvas');
  private readonly viewport = signal<DiagramViewport>({ offsetX: 40, offsetY: 40, scale: 1 });
  private readonly hoveredTableName = signal<string | null>(null);
  private panGesture: PanGesture | null = null;

  protected readonly viewTransform = computed(() => {
    const { offsetX, offsetY, scale } = this.viewport();
    return `translate(${offsetX} ${offsetY}) scale(${scale})`;
  });

  private readonly drawnTables = computed(() => [...this.tables(), ...this.removedTables()]);

  /** The table whose relationships are emphasised: the selected one, or else the hovered one. */
  private readonly activeTableName = computed(() => this.selectedTableName() ?? this.hoveredTableName());

  protected readonly edges = computed(() => {
    const boxesByTableName = this.boxesByTableName();
    const tablesByName = new Map(this.drawnTables().map((table) => [table.name, table]));
    const activeTableName = this.activeTableName();
    const edges = [];
    for (const table of this.drawnTables()) {
      const fromBox = boxesByTableName[table.name];
      if (!fromBox) continue;
      for (const foreignKey of table.foreignKeys) {
        const referencedTable = tablesByName.get(foreignKey.referencedTable);
        const toBox = boxesByTableName[foreignKey.referencedTable];
        if (!referencedTable || !toBox) continue;
        const fromRowIndex = clamp(
          table.columns.findIndex((column) => column.name === foreignKey.columns[0]),
          0,
          MAX_VISIBLE_COLUMNS,
        );
        const toRowIndex = clamp(
          referencedTable.columns.findIndex((column) => column.name === foreignKey.referencedColumns[0]),
          0,
          MAX_VISIBLE_COLUMNS,
        );
        const isActive =
          activeTableName !== null &&
          (table.name === activeTableName || foreignKey.referencedTable === activeTableName);
        edges.push({
          key: `${table.name}.${foreignKey.name}`,
          path: buildEdgePath(fromBox, fromRowIndex, toBox, toRowIndex),
          isActive,
          isFaded: activeTableName !== null && !isActive,
        });
      }
    }
    return edges;
  });

  protected readonly cards = computed(() => {
    const boxesByTableName = this.boxesByTableName();
    const removedTables = this.removedTables();
    const tableMarks = this.tableMarks();
    const columnMarks = this.columnMarks();
    return this.drawnTables().flatMap((table) => {
      const box = boxesByTableName[table.name];
      if (!box) return [];
      const primaryKeyColumnNames = new Set(table.primaryKey);
      const foreignKeyColumnNames = new Set(table.foreignKeys.flatMap((foreignKey) => foreignKey.columns));
      const visibleColumns = table.columns.slice(0, MAX_VISIBLE_COLUMNS);
      const hiddenColumnCount = table.columns.length - visibleColumns.length;
      const marksForTable = columnMarks[table.name];
      return [
        {
          name: table.name,
          box,
          transform: `translate(${box.x} ${box.y})`,
          isRemoved: removedTables.includes(table),
          mark: removedTables.includes(table) ? undefined : tableMarks[table.name],
          ariaLabel: `${table.name} table, ${table.columns.length} columns`,
          displayName: truncate(table.name, MAX_TABLE_NAME_LENGTH),
          rowCountLabel: table.estimatedRowCount > 0 ? `${formatCompactCount(table.estimatedRowCount)} rows` : '',
          columns: visibleColumns.map((column, columnIndex) => {
            const isPrimaryKey = primaryKeyColumnNames.has(column.name);
            return {
              name: column.name,
              displayName: truncate(column.name, MAX_COLUMN_NAME_LENGTH),
              shortTypeName: shortenTypeName(column.type),
              textY: HEADER_HEIGHT + columnIndex * ROW_HEIGHT + 16,
              mark: marksForTable?.[column.name],
              isPrimaryKey,
              isForeignKey: foreignKeyColumnNames.has(column.name),
              foreignKeyTagX: NODE_WIDTH - (isPrimaryKey ? 108 : 84),
            };
          }),
          hiddenColumnsLabel:
            hiddenColumnCount > 0
              ? `and ${hiddenColumnCount} more ${hiddenColumnCount === 1 ? 'column' : 'columns'}`
              : '',
        },
      ];
    });
  });

  protected readonly headerPath = `M0 ${HEADER_HEIGHT} V16 A16 16 0 0 1 16 0 H${NODE_WIDTH - 16} A16 16 0 0 1 ${NODE_WIDTH} 16 V${HEADER_HEIGHT} Z`;

  constructor() {
    // Fit when the diagram first appears or when the caller says the content changed.
    afterRenderEffect(() => {
      this.fitKey();
      untracked(() => {
        this.fitToScreen();
      });
    });

    // A non-passive listener, so the page does not scroll while the wheel zooms the diagram.
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      const canvasElement = this.canvas().nativeElement;
      const handleWheel = (event: WheelEvent): void => {
        event.preventDefault();
        const canvasRect = canvasElement.getBoundingClientRect();
        this.zoomAt(
          Math.exp(-event.deltaY * WHEEL_ZOOM_SENSITIVITY),
          event.clientX - canvasRect.left,
          event.clientY - canvasRect.top,
        );
      };
      canvasElement.addEventListener('wheel', handleWheel, { passive: false });
      destroyRef.onDestroy(() => {
        canvasElement.removeEventListener('wheel', handleWheel);
      });
    });
  }

  protected isDimmed(tableName: string): boolean {
    return this.dimmedTableNames()?.has(tableName) ?? false;
  }

  protected zoomIn(): void {
    this.zoomAt(BUTTON_ZOOM_IN_FACTOR);
  }

  protected zoomOut(): void {
    this.zoomAt(BUTTON_ZOOM_OUT_FACTOR);
  }

  protected fitToScreen(): void {
    const canvasElement = this.canvas().nativeElement;
    const boxesByTableName = this.boxesByTableName();
    const visibleBoxes = Object.fromEntries(
      this.drawnTables().flatMap((table) => {
        const box = boxesByTableName[table.name];
        return box ? [[table.name, box] as const] : [];
      }),
    );
    if (Object.keys(visibleBoxes).length === 0) return;
    const bounds = measureBounds(visibleBoxes);
    const canvasWidth = canvasElement.clientWidth || 800;
    const canvasHeight = canvasElement.clientHeight || 500;
    const scale = clamp(
      Math.min((canvasWidth - FIT_PADDING * 2) / bounds.width, (canvasHeight - FIT_PADDING * 2) / bounds.height),
      MIN_FIT_SCALE,
      MAX_FIT_SCALE,
    );
    this.viewport.set({
      scale,
      offsetX: (canvasWidth - bounds.width * scale) / 2 - bounds.x * scale,
      offsetY: (canvasHeight - bounds.height * scale) / 2 - bounds.y * scale,
    });
  }

  protected handleCanvasKeydown(event: KeyboardEvent): void {
    if (event.key === '+' || event.key === '=') this.zoomAt(KEYBOARD_ZOOM_FACTOR);
    else if (event.key === '-') this.zoomAt(1 / KEYBOARD_ZOOM_FACTOR);
    else if (event.key === '0') this.fitToScreen();
    else if (event.key === 'Escape') this.selectionChange.emit(null);
  }

  protected startPan(event: PointerEvent): void {
    if (event.target instanceof Element && event.target.closest('.er-card')) return;
    this.canvas().nativeElement.setPointerCapture(event.pointerId);
    const { offsetX, offsetY } = this.viewport();
    this.panGesture = {
      startClientX: event.clientX,
      startClientY: event.clientY,
      startOffsetX: offsetX,
      startOffsetY: offsetY,
      hasMoved: false,
    };
  }

  protected continuePan(event: PointerEvent): void {
    const panGesture = this.panGesture;
    if (!panGesture) return;
    const travel =
      Math.abs(event.clientX - panGesture.startClientX) + Math.abs(event.clientY - panGesture.startClientY);
    if (travel > DRAG_THRESHOLD) panGesture.hasMoved = true;
    this.viewport.update((viewport) => ({
      ...viewport,
      offsetX: panGesture.startOffsetX + event.clientX - panGesture.startClientX,
      offsetY: panGesture.startOffsetY + event.clientY - panGesture.startClientY,
    }));
  }

  protected endPan(): void {
    // A click on empty canvas clears the selection.
    if (this.panGesture && !this.panGesture.hasMoved) this.selectionChange.emit(null);
    this.panGesture = null;
  }

  protected toggleTableSelection(tableName: string, event: Event): void {
    event.stopPropagation();
    event.preventDefault();
    this.selectionChange.emit(this.selectedTableName() === tableName ? null : tableName);
  }

  protected setHoveredTable(tableName: string | null): void {
    this.hoveredTableName.set(tableName);
  }

  private zoomAt(factor: number, focusX?: number, focusY?: number): void {
    const canvasElement = this.canvas().nativeElement;
    const pivotX = focusX ?? canvasElement.clientWidth / 2;
    const pivotY = focusY ?? canvasElement.clientHeight / 2;
    this.viewport.update((viewport) => {
      const scale = clamp(viewport.scale * factor, MIN_SCALE, MAX_SCALE);
      const scaleRatio = scale / viewport.scale;
      return {
        scale,
        offsetX: pivotX - (pivotX - viewport.offsetX) * scaleRatio,
        offsetY: pivotY - (pivotY - viewport.offsetY) * scaleRatio,
      };
    });
  }
}
