import { describe, expect, it } from "vitest";
import { bytes, count, plural, ver } from "./format";

describe("format", () => {
  it("formats sizes", () => {
    expect(bytes(512)).toBe("512 B");
    expect(bytes(2048)).toBe("2.0 KB");
    expect(bytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(bytes(300 * 1024 * 1024)).toBe("300 MB");
  });
  it("formats counts", () => {
    expect(count(999)).toBe("999");
    expect(count(1500)).toBe("1.5k");
    expect(count(25000)).toBe("25k");
    expect(count(2_400_000)).toBe("2.4M");
  });
  it("pads sequential versions but not timestamps", () => {
    expect(ver(7)).toBe("0007");
    expect(ver(20261010120000)).toBe("20261010120000");
  });
  it("pluralises", () => {
    expect(plural(1, "table")).toBe("1 table");
    expect(plural(3, "table")).toBe("3 tables");
  });
});
