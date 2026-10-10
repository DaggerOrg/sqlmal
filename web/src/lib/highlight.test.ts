import { describe, expect, it } from "vitest";
import { highlight } from "./highlight";

const kinds = (sql: string) => highlight(sql).filter((t) => t.kind !== "text").map((t) => `${t.kind}:${t.text}`);

describe("highlight", () => {
  it("marks keywords, strings, numbers and comments", () => {
    expect(kinds("CREATE TABLE t (id int DEFAULT 5, n text DEFAULT 'it''s'); -- done")).toEqual([
      "kw:CREATE", "kw:TABLE", "kw:int", "kw:DEFAULT", "num:5", "kw:text", "kw:DEFAULT", "str:'it''s'", "com:-- done",
    ]);
  });

  it("does not highlight keywords inside strings, comments or quoted identifiers", () => {
    expect(kinds("INSERT INTO t VALUES ('DROP TABLE x')")).toEqual(["kw:INSERT", "kw:INTO", "kw:VALUES", "str:'DROP TABLE x'"]);
    expect(kinds("/* DROP TABLE x */ SELECT 1")).toEqual(["com:/* DROP TABLE x */", "kw:SELECT", "num:1"]);
    expect(kinds('SELECT "select" FROM t')).toEqual(["kw:SELECT", 'ident:"select"', "kw:FROM"]);
  });

  it("round-trips: the tokens always concatenate back to the input", () => {
    const sql = "-- header\nCREATE TABLE \"We\"\"ird\" (a int);\nDO $$ BEGIN PERFORM 1; END $$;\nSELECT 'unterminated";
    expect(highlight(sql).map((t) => t.text).join("")).toBe(sql);
  });

  it("is case-insensitive for keywords but keeps the original text", () => {
    expect(kinds("select 1 from T")).toEqual(["kw:select", "num:1", "kw:from"]);
  });

  it("copes with unterminated input", () => {
    for (const s of ["'oops", '"oops', "/* oops", "$$oops", "$"]) expect(highlight(s).map((t) => t.text).join("")).toBe(s);
  });
});
