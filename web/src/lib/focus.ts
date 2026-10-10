import type { Table } from "./types";

/** How the picked tables are connected on the diagram. */
export type FocusMode = "path" | "near" | "only";

export interface Focus {
  picked: Set<string>;
  /** Tables to show besides the picked ones: intermediates on a path, or direct neighbours. */
  related: Set<string>;
  /** Relationships to light up, as pairKey(a, b). */
  edges: Set<string>;
  /** Each path found between two picked tables, in order. */
  paths: string[][];
  /** Picked tables that have no relationship chain to the first pick of another group. */
  groups: string[][];
}

export const pairKey = (a: string, b: string) => (a < b ? `${a}\t${b}` : `${b}\t${a}`);

/** Relationships as an undirected graph. A foreign key in either direction connects two tables. */
export function graphOf(tables: Table[]): Map<string, Set<string>> {
  const g = new Map<string, Set<string>>(tables.map((t) => [t.name, new Set()]));
  for (const t of tables) {
    for (const f of t.foreign_keys) {
      if (f.ref_table === t.name || !g.has(f.ref_table)) continue;
      g.get(t.name)!.add(f.ref_table);
      g.get(f.ref_table)!.add(t.name);
    }
  }
  return g;
}

function shortestPath(g: Map<string, Set<string>>, from: string, to: string): string[] | null {
  const prev = new Map<string, string | null>([[from, null]]);
  const queue = [from];
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i];
    if (cur === to) {
      const path: string[] = [];
      for (let n: string | null = to; n !== null; n = prev.get(n) ?? null) path.unshift(n);
      return path;
    }
    for (const next of [...(g.get(cur) ?? [])].sort()) {
      if (!prev.has(next)) {
        prev.set(next, cur);
        queue.push(next);
      }
    }
  }
  return null;
}

export function computeFocus(tables: Table[], pickedNames: string[], mode: FocusMode): Focus {
  const g = graphOf(tables);
  const picked = new Set(pickedNames.filter((n) => g.has(n)));
  const list = [...picked];
  const related = new Set<string>();
  const edges = new Set<string>();
  const paths: string[][] = [];

  // Picks that can reach each other form a group. Picks in different groups have no relationship chain.
  const groups: string[][] = [];
  for (const n of list) {
    const home = groups.find((grp) => shortestPath(g, grp[0], n));
    if (home) home.push(n);
    else groups.push([n]);
  }

  if (mode === "path") {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const p = shortestPath(g, list[i], list[j]);
        if (!p) continue;
        paths.push(p);
        p.forEach((n, k) => {
          if (!picked.has(n)) related.add(n);
          if (k > 0) edges.add(pairKey(p[k - 1], n));
        });
      }
    }
  } else {
    for (const n of list) {
      for (const m of g.get(n) ?? []) {
        if (mode === "near") {
          if (!picked.has(m)) related.add(m);
          edges.add(pairKey(n, m));
        } else if (picked.has(m)) {
          edges.add(pairKey(n, m));
        }
      }
    }
  }
  return { picked, related, edges, paths, groups };
}
