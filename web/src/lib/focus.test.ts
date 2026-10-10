import { describe, expect, it } from "vitest";
import { computeFocus, pairKey } from "./focus";
import type { Table } from "./types";

const t = (name: string, ...refs: string[]): Table => ({
  name, columns: [], primary_key: [], uniques: [], checks: [], indexes: [], row_estimate: 0, size_bytes: 0,
  foreign_keys: refs.map((r) => ({ name: `${name}_${r}`, columns: [], ref_table: r, ref_columns: [], on_delete: "", on_update: "" })),
});
// a - b - c   and   d - e - f
const tables = [t("a"), t("b", "a"), t("c", "b"), t("d"), t("e", "d"), t("f", "e")];

describe("computeFocus", () => {
  it("finds the path through the table in the middle", () => {
    const f = computeFocus(tables, ["a", "c"], "path");
    expect([...f.related]).toEqual(["b"]);
    expect(f.edges).toEqual(new Set([pairKey("a", "b"), pairKey("b", "c")]));
    expect(f.paths).toEqual([["a", "b", "c"]]);
    expect(f.groups).toHaveLength(1);
  });
  it("keeps picks from separate groups apart", () => {
    const f = computeFocus(tables, ["c", "e"], "path");
    expect(f.edges.size).toBe(0);
    expect(f.groups).toEqual([["c"], ["e"]]);
  });
  it("shows direct neighbours", () => {
    const f = computeFocus(tables, ["b"], "near");
    expect([...f.related].sort()).toEqual(["a", "c"]);
  });
  it("only links picked tables with each other", () => {
    const f = computeFocus(tables, ["a", "b", "d"], "only");
    expect(f.edges).toEqual(new Set([pairKey("a", "b")]));
    expect(f.related.size).toBe(0);
  });
  it("ignores unknown names", () => {
    expect(computeFocus(tables, ["nope"], "path").picked.size).toBe(0);
  });
});
