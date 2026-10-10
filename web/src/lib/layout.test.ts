import { describe, expect, it } from "vitest";
import { bounds, layout, nodeHeight, NODE_W, type Box, type NodeSpec } from "./layout";

const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const shop: NodeSpec[] = [
  { name: "users", rows: 5, refs: [] },
  { name: "categories", rows: 3, refs: ["categories"] }, // self reference
  { name: "products", rows: 7, refs: ["categories"] },
  { name: "orders", rows: 4, refs: ["users"] },
  { name: "order_items", rows: 4, refs: ["orders", "products"] },
  { name: "payments", rows: 5, refs: ["orders"] },
  { name: "audit_log", rows: 6, refs: [] }, // no relationships
];

describe("layout", () => {
  it("puts referenced tables to the left of the tables that reference them", () => {
    const b = layout(shop);
    expect(b.users.x).toBeLessThan(b.orders.x);
    expect(b.orders.x).toBeLessThan(b.order_items.x);
    expect(b.products.x).toBeLessThan(b.order_items.x);
    expect(b.orders.x).toBeLessThan(b.payments.x);
    expect(b.categories.x).toBeLessThan(b.products.x);
  });

  it("never lets two tables overlap", () => {
    const b = Object.entries(layout(shop));
    for (let i = 0; i < b.length; i++)
      for (let j = i + 1; j < b.length; j++) expect(overlaps(b[i][1], b[j][1]), `${b[i][0]} overlaps ${b[j][0]}`).toBe(false);
  });

  it("keeps unrelated tables out of the relationship columns", () => {
    const b = layout(shop);
    const related = ["users", "orders", "order_items", "products", "categories", "payments"].map((n) => b[n]);
    const lowest = Math.max(...related.map((r) => r.y + r.h));
    expect(b.audit_log.y).toBeGreaterThanOrEqual(lowest);
  });

  it("survives cycles and self references without hanging", () => {
    const cyc: NodeSpec[] = [
      { name: "a", rows: 2, refs: ["b"] },
      { name: "b", rows: 2, refs: ["c"] },
      { name: "c", rows: 2, refs: ["a", "c"] },
    ];
    const b = layout(cyc);
    expect(Object.keys(b)).toHaveLength(3);
    const xs = new Set(Object.values(b).map((x) => x.x));
    expect(xs.size).toBeGreaterThan(1);
  });

  it("ignores references to tables that are not drawn", () => {
    const b = layout([{ name: "a", rows: 2, refs: ["ghost"] }]);
    expect(b.a).toBeDefined();
  });

  it("is deterministic", () => {
    expect(layout(shop)).toEqual(layout([...shop].reverse()));
  });

  it("handles an empty schema and a single table", () => {
    expect(layout([])).toEqual({});
    expect(bounds({})).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(layout([{ name: "t", rows: 1, refs: [] }]).t).toMatchObject({ x: 0, y: 0, w: NODE_W });
  });

  it("scales to a large random schema with no overlaps", () => {
    // A small seeded generator so the test is repeatable.
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    const nodes: NodeSpec[] = Array.from({ length: 60 }, (_, i) => ({
      name: `t${i}`,
      rows: 1 + Math.floor(rnd() * 14),
      refs: Array.from({ length: Math.floor(rnd() * 3) }, () => `t${Math.floor(rnd() * 60)}`),
    }));
    const b = Object.values(layout(nodes));
    expect(b).toHaveLength(60);
    for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) expect(overlaps(b[i], b[j])).toBe(false);
  });

  it("caps tall tables and reserves room for the 'more columns' footer", () => {
    expect(nodeHeight(50)).toBe(nodeHeight(11));
    expect(nodeHeight(11)).toBeGreaterThan(nodeHeight(10));
  });
});
