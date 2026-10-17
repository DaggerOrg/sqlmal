// Places tables on a canvas so that foreign keys read left to right.
//
// Layering: a table sits one layer to the right of the tables it references,
// so "orders" is right of "users". Cycles are broken before layering, and
// tables with no relationships go in a tidy grid underneath.

export interface TableNodeSpec {
  name: string;
  /** Number of column rows that will be drawn. */
  columnCount: number;
  /** Names of tables this one references (foreign keys). */
  referencedTableNames: string[];
}

export interface DiagramBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const NODE_WIDTH = 264;
export const HEADER_HEIGHT = 40;
export const ROW_HEIGHT = 22;
export const FOOTER_HEIGHT = 24;
export const MAX_VISIBLE_COLUMNS = 10;
const HORIZONTAL_GAP = 120;
const VERTICAL_GAP = 44;
const CROSSING_REDUCTION_PASSES = 6;

/** Height of a table card for a given number of columns. */
export function calculateNodeHeight(columnCount: number): number {
  const visibleColumnCount = Math.min(columnCount, MAX_VISIBLE_COLUMNS);
  return (
    HEADER_HEIGHT +
    visibleColumnCount * ROW_HEIGHT +
    (columnCount > MAX_VISIBLE_COLUMNS ? FOOTER_HEIGHT : 8) +
    4
  );
}

type VisitState = 'visiting' | 'visited';

/** Returns a box for every table, keyed by table name. */
export function layoutTables(nodes: readonly TableNodeSpec[]): Record<string, DiagramBox> {
  const nodesByName = new Map(nodes.map((node) => [node.name, node]));
  const names = [...nodesByName.keys()].sort();
  const listFor = (listsByName: Map<string, string[]>, name: string): string[] => listsByName.get(name) ?? [];

  // Edges to real, different tables only.
  const referencedByName = new Map<string, string[]>();
  const referencingByName = new Map<string, string[]>();
  for (const name of names) {
    referencedByName.set(name, []);
    referencingByName.set(name, []);
  }
  for (const name of names) {
    for (const referencedName of new Set(nodesByName.get(name)?.referencedTableNames ?? [])) {
      if (referencedName !== name && nodesByName.has(referencedName)) {
        listFor(referencedByName, name).push(referencedName);
        listFor(referencingByName, referencedName).push(name);
      }
    }
  }

  // Break cycles: drop any edge that closes a loop in a depth-first walk.
  const visitStates = new Map<string, VisitState>();
  const acyclicReferencesByName = new Map<string, string[]>(names.map((name) => [name, []]));
  const visit = (name: string): void => {
    visitStates.set(name, 'visiting');
    for (const referencedName of listFor(referencedByName, name).slice().sort()) {
      if (visitStates.get(referencedName) === 'visiting') continue; // back edge: ignored for layering
      listFor(acyclicReferencesByName, name).push(referencedName);
      if (!visitStates.has(referencedName)) visit(referencedName);
    }
    visitStates.set(name, 'visited');
  };
  for (const name of names) if (!visitStates.has(name)) visit(name);

  // Longest-path layering: layer = 1 + max layer of referenced tables.
  const layerIndexByName = new Map<string, number>();
  const findLayerIndex = (name: string): number => {
    const knownLayerIndex = layerIndexByName.get(name);
    if (knownLayerIndex !== undefined) return knownLayerIndex;
    const references = listFor(acyclicReferencesByName, name);
    const layerIndex = references.length === 0 ? 0 : 1 + Math.max(...references.map(findLayerIndex));
    layerIndexByName.set(name, layerIndex);
    return layerIndex;
  };
  names.forEach(findLayerIndex);

  const connectedNames = names.filter(
    (name) => listFor(referencedByName, name).length > 0 || listFor(referencingByName, name).length > 0,
  );
  const looseNames = names.filter((name) => !connectedNames.includes(name));

  const layers: string[][] = [];
  for (const name of connectedNames) (layers[layerIndexByName.get(name) ?? 0] ??= []).push(name);
  for (let layerIndex = 0; layerIndex < layers.length; layerIndex++) layers[layerIndex] ??= [];

  // Reduce crossings: order each layer by the average position of its neighbours.
  const positionByName = new Map<string, number>();
  const recordPositions = (): void => {
    layers.forEach((layer) => {
      layer.forEach((name, position) => positionByName.set(name, position));
    });
  };
  recordPositions();
  const averageNeighbourPosition = (name: string, neighboursByName: Map<string, string[]>): number => {
    const neighbours = listFor(neighboursByName, name).filter((neighbour) => positionByName.has(neighbour));
    return neighbours.length
      ? neighbours.reduce((sum, neighbour) => sum + (positionByName.get(neighbour) ?? 0), 0) / neighbours.length
      : (positionByName.get(name) ?? 0);
  };
  const sortLayer = (layer: string[] | undefined, neighboursByName: Map<string, string[]>): void => {
    layer?.sort(
      (first, second) =>
        averageNeighbourPosition(first, neighboursByName) - averageNeighbourPosition(second, neighboursByName) ||
        first.localeCompare(second),
    );
    recordPositions();
  };
  for (let pass = 0; pass < CROSSING_REDUCTION_PASSES; pass++) {
    for (let layerIndex = 1; layerIndex < layers.length; layerIndex++) sortLayer(layers[layerIndex], referencedByName);
    for (let layerIndex = layers.length - 2; layerIndex >= 0; layerIndex--) {
      sortLayer(layers[layerIndex], referencingByName);
    }
  }

  const heightOf = (name: string): number => calculateNodeHeight(nodesByName.get(name)?.columnCount ?? 0);
  const layerHeight = (layer: string[]): number =>
    layer.reduce((sum, name) => sum + heightOf(name), 0) + Math.max(layer.length - 1, 0) * VERTICAL_GAP;
  const tallestLayerHeight = Math.max(0, ...layers.map(layerHeight));

  const boxesByName: Record<string, DiagramBox> = {};
  layers.forEach((layer, layerIndex) => {
    let y = (tallestLayerHeight - layerHeight(layer)) / 2;
    for (const name of layer) {
      boxesByName[name] = {
        x: layerIndex * (NODE_WIDTH + HORIZONTAL_GAP),
        y,
        width: NODE_WIDTH,
        height: heightOf(name),
      };
      y += heightOf(name) + VERTICAL_GAP;
    }
  });

  // Tables with no relationships: a grid below everything else.
  if (looseNames.length) {
    const tablesPerRow = Math.max(1, Math.min(4, Math.max(layers.length, 3)));
    const top = connectedNames.length ? tallestLayerHeight + VERTICAL_GAP * 2 : 0;
    let x = 0;
    let y = top;
    let rowHeight = 0;
    looseNames.forEach((name, looseIndex) => {
      if (looseIndex > 0 && looseIndex % tablesPerRow === 0) {
        x = 0;
        y += rowHeight + VERTICAL_GAP;
        rowHeight = 0;
      }
      boxesByName[name] = { x, y, width: NODE_WIDTH, height: heightOf(name) };
      rowHeight = Math.max(rowHeight, heightOf(name));
      x += NODE_WIDTH + HORIZONTAL_GAP / 2;
    });
  }
  return boxesByName;
}

/** The smallest box around all the given boxes. */
export function measureBounds(boxesByName: Record<string, DiagramBox>): DiagramBox {
  const boxes = Object.values(boxesByName);
  if (!boxes.length) return { x: 0, y: 0, width: 1, height: 1 };
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Where a foreign key leaves the referencing table and arrives at the referenced one. */
export function buildEdgePath(
  fromBox: DiagramBox,
  fromRowIndex: number,
  toBox: DiagramBox,
  toRowIndex: number,
): string {
  const fromY = fromBox.y + HEADER_HEIGHT + fromRowIndex * ROW_HEIGHT + ROW_HEIGHT / 2;
  const toY = toBox.y + HEADER_HEIGHT + toRowIndex * ROW_HEIGHT + ROW_HEIGHT / 2;
  if (fromBox === toBox || (fromBox.x === toBox.x && fromBox.y === toBox.y)) {
    // Self reference: a loop out of the right edge.
    const x = fromBox.x + fromBox.width;
    return `M ${x} ${fromY} C ${x + 70} ${fromY - 10}, ${x + 70} ${toY + 30}, ${x} ${toY + 14}`;
  }
  const isTargetLeft = toBox.x + toBox.width <= fromBox.x;
  const isTargetRight = toBox.x >= fromBox.x + fromBox.width;
  let fromX: number;
  let toX: number;
  if (isTargetLeft) {
    fromX = fromBox.x;
    toX = toBox.x + toBox.width;
  } else if (isTargetRight) {
    fromX = fromBox.x + fromBox.width;
    toX = toBox.x;
  } else {
    // Same column: go out the right side of both and meet in a bracket.
    fromX = fromBox.x + fromBox.width;
    toX = toBox.x + toBox.width;
    const bow = 60;
    return `M ${fromX} ${fromY} C ${fromX + bow} ${fromY}, ${toX + bow} ${toY}, ${toX} ${toY}`;
  }
  const controlOffset = Math.max(50, Math.abs(toX - fromX) * 0.45) * (toX > fromX ? 1 : -1);
  return `M ${fromX} ${fromY} C ${fromX + controlOffset} ${fromY}, ${toX - controlOffset} ${toY}, ${toX} ${toY}`;
}
