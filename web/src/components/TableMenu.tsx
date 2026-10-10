import { ArrowRight, Info, MagnifyingGlass, X } from "@phosphor-icons/react";
import type { Focus, FocusMode } from "../lib/focus";
import { plural } from "../lib/format";
import type { Table } from "../lib/types";

const MODES: { id: FocusMode; label: string; hint: string }[] = [
  { id: "path", label: "Path", hint: "Shows how the picked tables connect, including the tables in between." },
  { id: "near", label: "Neighbours", hint: "Shows the picked tables and every table directly linked to them." },
  { id: "only", label: "Only these", hint: "Shows just the picked tables and the links between them." },
];

interface Props {
  tables: Table[];
  picked: string[];
  focus?: Focus;
  mode: FocusMode;
  q: string;
  onQuery: (q: string) => void;
  onMode: (m: FocusMode) => void;
  onToggle: (name: string) => void;
  onClear: () => void;
  onDetails: (name: string) => void;
  onClose: () => void;
}

/** The second menu: every table with a checkbox, so any set of tables can be lit up together. */
export default function TableMenu({ tables, picked, focus, mode, q, onQuery, onMode, onToggle, onClear, onDetails, onClose }: Props) {
  const needle = q.trim().toLowerCase();
  const shown = tables.filter((t) => !needle || t.name.toLowerCase().includes(needle) || t.columns.some((c) => c.name.toLowerCase().includes(needle)));
  const on = new Set(picked);
  const apart = focus && focus.groups.length > 1 && mode === "path";

  return (
    <aside className="tmenu panel-dark" aria-label="Tables">
      <div className="tmenu-head">
        <h2>Tables <span className="faint">{tables.length}</span></h2>
        <button className="icon-btn" aria-label="Hide the table menu" title="Hide the table menu" onClick={onClose}><X size={20} /></button>
      </div>

      <label className="search tmenu-search">
        <MagnifyingGlass size={18} aria-hidden />
        <input type="search" placeholder="Find a table or column" value={q} onChange={(e) => onQuery(e.target.value)} aria-label="Find a table or column" />
      </label>

      <div className="tmenu-modes" role="radiogroup" aria-label="How to connect the picked tables">
        {MODES.map((m) => (
          <button key={m.id} role="radio" aria-checked={mode === m.id} className="tab" onClick={() => onMode(m.id)}>{m.label}</button>
        ))}
      </div>
      <p className="tmenu-hint">{MODES.find((m) => m.id === mode)!.hint}</p>

      <ul className="tmenu-list">
        {shown.map((t) => (
          <li key={t.name} className={on.has(t.name) ? "on" : ""}>
            <label>
              <input type="checkbox" checked={on.has(t.name)} onChange={() => onToggle(t.name)} />
              <span className="n">{t.name}</span>
              <span className="m">{t.foreign_keys.length > 0 ? `${t.foreign_keys.length} FK` : ""}</span>
            </label>
            <button className="icon-btn sm" aria-label={`Details for ${t.name}`} title="Details" onClick={() => onDetails(t.name)}><Info size={16} /></button>
          </li>
        ))}
        {shown.length === 0 && <li className="tmenu-none">No table matches.</li>}
      </ul>

      <div className="tmenu-foot" aria-live="polite">
        {picked.length === 0 ? (
          <p className="faint">Tick two or more tables to light up how they relate. You can also Shift-click them on the diagram.</p>
        ) : (
          <>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <b>{plural(picked.length, "table")} picked</b>
              <button className="btn btn-sm" onClick={onClear}>Clear</button>
            </div>
            {focus && focus.paths.map((p, i) => (
              <p key={i} className="tmenu-path">
                {p.map((n, k) => (
                  <span key={n + k}>{k > 0 && <ArrowRight size={12} aria-label="to" />}<span className={on.has(n) ? "pk" : ""}>{n}</span></span>
                ))}
              </p>
            ))}
            {apart && (
              <p className="tmenu-note">
                No chain of foreign keys joins {focus.groups.map((g) => g[0]).join(" and ")}. They are lit up separately.
              </p>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
