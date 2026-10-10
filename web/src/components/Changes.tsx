import type { Change } from "../lib/types";

const MARK: Record<string, "add" | "del" | "mod"> = {
  table_added: "add", column_added: "add", unique_added: "add", foreign_key_added: "add", check_added: "add", index_added: "add", enum_added: "add", enum_value_added: "add",
  table_removed: "del", column_removed: "del", unique_removed: "del", foreign_key_removed: "del", check_removed: "del", index_removed: "del", enum_removed: "del",
  column_changed: "mod", primary_key_changed: "mod",
};
const SIGN = { add: "+", del: "−", mod: "~" } as const;
const WORD: Record<string, string> = {
  table_added: "Table added", table_removed: "Table removed",
  column_added: "Column added", column_removed: "Column removed", column_changed: "Column changed",
  primary_key_changed: "Primary key changed",
  unique_added: "Unique constraint added", unique_removed: "Unique constraint removed",
  foreign_key_added: "Foreign key added", foreign_key_removed: "Foreign key removed",
  check_added: "Check added", check_removed: "Check removed",
  index_added: "Index added", index_removed: "Index removed",
  enum_added: "Enum added", enum_removed: "Enum removed", enum_value_added: "Enum value added",
};

export function describe(c: Change): string {
  const where = [c.table, c.object].filter(Boolean).join(".");
  return `${WORD[c.kind] ?? c.kind}${where ? `: ${where}` : ""}`;
}

export default function Changes({ changes, empty = "No schema changes." }: { changes: Change[]; empty?: string }) {
  if (changes.length === 0) return <p className="muted">{empty}</p>;
  return (
    <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
      {changes.map((c, i) => {
        const m = MARK[c.kind] ?? "mod";
        return (
          <li key={i} className="change">
            <span className={`k ${m}`} aria-hidden>{SIGN[m]}</span>
            <span>
              {describe(c)}
              {c.destructive && <b style={{ color: "var(--destructive-soft-ink)", marginLeft: ".5rem", fontSize: 12.5 }}>destroys data</b>}
              {c.detail && <span className="faint mono" style={{ display: "block", fontSize: 12.5, overflowWrap: "anywhere" }}>{c.detail}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
