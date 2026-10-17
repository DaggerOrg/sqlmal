import { describe, expect, it } from 'vitest';
import {
  NODE_WIDTH,
  calculateNodeHeight,
  layoutTables,
  measureBounds,
  type DiagramBox,
  type TableNodeSpec,
} from './schema-layout';

const doBoxesOverlap = (first: DiagramBox, second: DiagramBox): boolean =>
  first.x < second.x + second.width &&
  second.x < first.x + first.width &&
  first.y < second.y + second.height &&
  second.y < first.y + first.height;

const node = (name: string, columnCount: number, referencedTableNames: string[] = []): TableNodeSpec => ({
  name,
  columnCount,
  referencedTableNames,
});

const SHOP_TABLES: TableNodeSpec[] = [
  node('users', 5),
  node('categories', 3, ['categories']), // self reference
  node('products', 7, ['categories']),
  node('orders', 4, ['users']),
  node('order_items', 4, ['orders', 'products']),
  node('payments', 5, ['orders']),
  node('audit_log', 6), // no relationships
];

describe('layoutTables', () => {
  it('puts referenced tables to the left of the tables that reference them', () => {
    const boxes = layoutTables(SHOP_TABLES);
    expect(boxes['users']!.x).toBeLessThan(boxes['orders']!.x);
    expect(boxes['orders']!.x).toBeLessThan(boxes['order_items']!.x);
    expect(boxes['products']!.x).toBeLessThan(boxes['order_items']!.x);
    expect(boxes['orders']!.x).toBeLessThan(boxes['payments']!.x);
    expect(boxes['categories']!.x).toBeLessThan(boxes['products']!.x);
  });

  it('never lets two tables overlap', () => {
    const entries = Object.entries(layoutTables(SHOP_TABLES));
    for (let first = 0; first < entries.length; first++) {
      for (let second = first + 1; second < entries.length; second++) {
        const [firstName, firstBox] = entries[first]!;
        const [secondName, secondBox] = entries[second]!;
        expect(doBoxesOverlap(firstBox, secondBox), `${firstName} overlaps ${secondName}`).toBe(false);
      }
    }
  });

  it('keeps unrelated tables out of the relationship columns', () => {
    const boxes = layoutTables(SHOP_TABLES);
    const relatedBoxes = ['users', 'orders', 'order_items', 'products', 'categories', 'payments'].map(
      (name) => boxes[name]!,
    );
    const lowestBottom = Math.max(...relatedBoxes.map((box) => box.y + box.height));
    expect(boxes['audit_log']!.y).toBeGreaterThanOrEqual(lowestBottom);
  });

  it('survives cycles and self references without hanging', () => {
    const boxes = layoutTables([node('a', 2, ['b']), node('b', 2, ['c']), node('c', 2, ['a', 'c'])]);
    expect(Object.keys(boxes)).toHaveLength(3);
    expect(new Set(Object.values(boxes).map((box) => box.x)).size).toBeGreaterThan(1);
  });

  it('ignores references to tables that are not drawn', () => {
    expect(layoutTables([node('a', 2, ['ghost'])])['a']).toBeDefined();
  });

  it('is deterministic', () => {
    expect(layoutTables(SHOP_TABLES)).toEqual(layoutTables([...SHOP_TABLES].reverse()));
  });

  it('handles an empty schema and a single table', () => {
    expect(layoutTables([])).toEqual({});
    expect(measureBounds({})).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(layoutTables([node('t', 1)])['t']).toMatchObject({ x: 0, y: 0, width: NODE_WIDTH });
  });

  it('scales to a large random schema with no overlaps', () => {
    // A small seeded generator so the test is repeatable.
    let seed = 7;
    const nextRandom = (): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const nodes = Array.from({ length: 60 }, (_, tableIndex) =>
      node(
        `t${tableIndex}`,
        1 + Math.floor(nextRandom() * 14),
        Array.from({ length: Math.floor(nextRandom() * 3) }, () => `t${Math.floor(nextRandom() * 60)}`),
      ),
    );
    const boxes = Object.values(layoutTables(nodes));
    expect(boxes).toHaveLength(60);
    for (let first = 0; first < boxes.length; first++) {
      for (let second = first + 1; second < boxes.length; second++) {
        expect(doBoxesOverlap(boxes[first]!, boxes[second]!)).toBe(false);
      }
    }
  });

  it("caps tall tables and reserves room for the 'more columns' footer", () => {
    expect(calculateNodeHeight(50)).toBe(calculateNodeHeight(11));
    expect(calculateNodeHeight(11)).toBeGreaterThan(calculateNodeHeight(10));
  });
});
