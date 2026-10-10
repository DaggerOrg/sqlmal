// Places tables on a canvas so that foreign keys read left to right.
//
// Layering: a table sits one layer to the right of the tables it references,
// so "orders" is right of "users". Cycles are broken before layering, and
// tables with no relationships go in a tidy grid underneath.

export interface NodeSpec {
  name: string;
  /** Number of column rows that will be drawn. */
  rows: number;
  /** Names of tables this one references (foreign keys). */
  refs: string[];
}

export interface Box { x: number; y: number; w: number; h: number }

export const NODE_W = 264;
export const HEADER_H = 40;
export const ROW_H = 22;
export const FOOT_H = 24;
export const MAX_ROWS = 10;
const GAP_X = 120;
const GAP_Y = 44;

/** Height of a table card for a given number of columns. */
export function nodeHeight(columns: number): number {
  const shown = Math.min(columns, MAX_ROWS);
  return HEADER_H + shown * ROW_H + (columns > MAX_ROWS ? FOOT_H : 8) + 4;
}

export function layout(nodes: NodeSpec[]): Record<string, Box> {
  const byName = new Map(nodes.map((n) => [n.name, n]));
  const names = [...byName.keys()].sort();

  // Edges to real, different tables only.
  const out = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const n of names) {
    out.set(n, []);
    incoming.set(n, []);
  }
  for (const n of names) {
    for (const r of new Set(byName.get(n)!.refs)) {
      if (r !== n && byName.has(r)) {
        out.get(n)!.push(r);
        incoming.get(r)!.push(n);
      }
    }
  }

  // Break cycles: drop any edge that closes a loop in a depth-first walk.
  const state = new Map<string, 0 | 1 | 2>();
  const dag = new Map<string, string[]>(names.map((n) => [n, []]));
  const visit = (n: string) => {
    state.set(n, 1);
    for (const r of out.get(n)!.slice().sort()) {
      if (state.get(r) === 1) continue; // back edge: ignored for layering
      dag.get(n)!.push(r);
      if (!state.has(r)) visit(r);
    }
    state.set(n, 2);
  };
  for (const n of names) if (!state.has(n)) visit(n);

  // Longest-path layering: layer = 1 + max layer of referenced tables.
  const layer = new Map<string, number>();
  const depth = (n: string): number => {
    if (layer.has(n)) return layer.get(n)!;
    const l = dag.get(n)!.length === 0 ? 0 : 1 + Math.max(...dag.get(n)!.map(depth));
    layer.set(n, l);
    return l;
  };
  names.forEach(depth);

  const connected = names.filter((n) => out.get(n)!.length > 0 || incoming.get(n)!.length > 0);
  const loose = names.filter((n) => !connected.includes(n));

  const layers: string[][] = [];
  for (const n of connected) (layers[layer.get(n)!] ??= []).push(n);
  for (let i = 0; i < layers.length; i++) layers[i] ??= [];

  // Reduce crossings: order each layer by the average position of its neighbours.
  const index = new Map<string, number>();
  const reindex = () => layers.forEach((col) => col.forEach((n, i) => index.set(n, i)));
  reindex();
  const bary = (n: string, towards: Map<string, string[]>): number => {
    const ns = towards.get(n)!.filter((m) => index.has(m));
    return ns.length ? ns.reduce((s, m) => s + index.get(m)!, 0) / ns.length : index.get(n)!;
  };
  for (let pass = 0; pass < 6; pass++) {
    for (let l = 1; l < layers.length; l++) {
      layers[l].sort((a, b) => bary(a, out) - bary(b, out) || a.localeCompare(b));
      reindex();
    }
    for (let l = layers.length - 2; l >= 0; l--) {
      layers[l].sort((a, b) => bary(a, incoming) - bary(b, incoming) || a.localeCompare(b));
      reindex();
    }
  }

  const heightOf = (n: string) => nodeHeight(byName.get(n)!.rows);
  const colHeight = (col: string[]) => col.reduce((s, n) => s + heightOf(n), 0) + Math.max(col.length - 1, 0) * GAP_Y;
  const tallest = Math.max(0, ...layers.map(colHeight));

  const boxes: Record<string, Box> = {};
  layers.forEach((col, l) => {
    let y = (tallest - colHeight(col)) / 2;
    for (const n of col) {
      boxes[n] = { x: l * (NODE_W + GAP_X), y, w: NODE_W, h: heightOf(n) };
      y += heightOf(n) + GAP_Y;
    }
  });

  // Tables with no relationships: a grid below everything else.
  if (loose.length) {
    const perRow = Math.max(1, Math.min(4, Math.max(layers.length, 3)));
    const top = connected.length ? tallest + GAP_Y * 2 : 0;
    let x = 0;
    let y = top;
    let rowH = 0;
    loose.forEach((n, i) => {
      if (i > 0 && i % perRow === 0) {
        x = 0;
        y += rowH + GAP_Y;
        rowH = 0;
      }
      boxes[n] = { x, y, w: NODE_W, h: heightOf(n) };
      rowH = Math.max(rowH, heightOf(n));
      x += NODE_W + GAP_X / 2;
    });
  }
  return boxes;
}

export function bounds(boxes: Record<string, Box>): Box {
  const bs = Object.values(boxes);
  if (!bs.length) return { x: 0, y: 0, w: 1, h: 1 };
  const x1 = Math.min(...bs.map((b) => b.x));
  const y1 = Math.min(...bs.map((b) => b.y));
  const x2 = Math.max(...bs.map((b) => b.x + b.w));
  const y2 = Math.max(...bs.map((b) => b.y + b.h));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** Where a foreign key leaves the referencing table and arrives at the referenced one. */
export function edgePath(from: Box, fromRow: number, to: Box, toRow: number): string {
  const y1 = from.y + HEADER_H + fromRow * ROW_H + ROW_H / 2;
  const y2 = to.y + HEADER_H + toRow * ROW_H + ROW_H / 2;
  if (from === to || (from.x === to.x && from.y === to.y)) {
    // Self reference: a loop out of the right edge.
    const x = from.x + from.w;
    return `M ${x} ${y1} C ${x + 70} ${y1 - 10}, ${x + 70} ${y2 + 30}, ${x} ${y2 + 14}`;
  }
  const toIsLeft = to.x + to.w <= from.x;
  const toIsRight = to.x >= from.x + from.w;
  let x1: number;
  let x2: number;
  if (toIsLeft) {
    x1 = from.x;
    x2 = to.x + to.w;
  } else if (toIsRight) {
    x1 = from.x + from.w;
    x2 = to.x;
  } else {
    // Same column: go out the right side of both and meet in a bracket.
    x1 = from.x + from.w;
    x2 = to.x + to.w;
    const bow = 60;
    return `M ${x1} ${y1} C ${x1 + bow} ${y1}, ${x2 + bow} ${y2}, ${x2} ${y2}`;
  }
  const dx = Math.max(50, Math.abs(x2 - x1) * 0.45) * (x2 > x1 ? 1 : -1);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}
