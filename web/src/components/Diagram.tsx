import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowsOut, MagnifyingGlassMinus, MagnifyingGlassPlus } from "@phosphor-icons/react";
import { bounds, edgePath, HEADER_H, MAX_ROWS, NODE_W, ROW_H, type Box } from "../lib/layout";
import { count } from "../lib/format";
import { pairKey } from "../lib/focus";
import type { Table } from "../lib/types";

export type Mark = "added" | "changed";

interface Props {
  tables: Table[];
  /** Tables that were removed in this step: drawn dashed where they used to be. */
  ghosts?: Table[];
  boxes: Record<string, Box>;
  selected?: string | null;
  onSelect?: (name: string | null) => void;
  marks?: Record<string, Mark>;
  /** table -> column -> "new" | "mod": columns to colour. */
  colMarks?: Record<string, Record<string, "new" | "mod">>;
  label: string;
  /** Refit the view when this changes. */
  fitKey?: string;
  dim?: Set<string>;
  /** Tables picked for a closer look. Picked ones glow, related ones glow softly, the rest fade. */
  focus?: { picked: Set<string>; related: Set<string>; edges: Set<string>; hideOthers: boolean };
  /** Shift or Ctrl/Cmd click on a table. */
  onPick?: (name: string) => void;
  /** Zoom to these tables whenever zoomKey changes. */
  zoomTo?: string[];
  zoomKey?: string;
}

interface View { x: number; y: number; k: number }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export default function Diagram({ tables, ghosts = [], boxes, selected, onSelect, marks = {}, colMarks = {}, label, fitKey, dim, focus, onPick, zoomTo, zoomKey }: Props) {
  const svg = useRef<SVGSVGElement>(null);
  const [view, setView] = useState<View>({ x: 40, y: 40, k: 1 });
  const [hover, setHover] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);

  const drawn = useMemo(() => [...tables, ...ghosts], [tables, ghosts]);
  const byName = useMemo(() => new Map(drawn.map((t) => [t.name, t])), [drawn]);

  // The camera glides on programmatic moves, and follows the pointer immediately while dragging or scrolling.
  const [smooth, setSmooth] = useState(false);

  const fit = useCallback((only?: string[]) => {
    const el = svg.current;
    const names = (only && only.length > 0 ? only : drawn.map((t) => t.name)).filter((n) => boxes[n]);
    if (!el || names.length === 0) return;
    const b = bounds(Object.fromEntries(names.map((n) => [n, boxes[n]])));
    const w = el.clientWidth || 800;
    const h = el.clientHeight || 500;
    const pad = 48;
    const k = clamp(Math.min((w - pad * 2) / b.w, (h - pad * 2) / b.h), 0.2, only && only.length > 0 ? 1.25 : 1.1);
    setView({ k, x: (w - b.w * k) / 2 - b.x * k, y: (h - b.h * k) / 2 - b.y * k });
  }, [drawn, boxes]);

  // Fit when the diagram first appears or when the caller says the content changed.
  useEffect(() => {
    setSmooth(false);
    fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);

  // Picking tables, or changing how they are connected, glides the camera to them.
  const firstZoom = useRef(true);
  useEffect(() => {
    if (firstZoom.current) { firstZoom.current = false; return; }
    if (zoomKey === undefined) return;
    setSmooth(true);
    fit(zoomTo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomKey]);

  const zoomAt = useCallback((factor: number, cx?: number, cy?: number) => {
    const el = svg.current;
    if (!el) return;
    setSmooth(false);
    const px = cx ?? el.clientWidth / 2;
    const py = cy ?? el.clientHeight / 2;
    setView((v) => {
      const k = clamp(v.k * factor, 0.15, 2.5);
      const f = k / v.k;
      return { k, x: px - (px - v.x) * f, y: py - (py - v.y) * f };
    });
  }, []);

  // A non-passive listener, so the page does not scroll while the wheel zooms the diagram.
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const on = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener("wheel", on, { passive: false });
    return () => el.removeEventListener("wheel", on);
  }, [zoomAt]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "+" || e.key === "=") zoomAt(1.2);
    else if (e.key === "-") zoomAt(1 / 1.2);
    else if (e.key === "0") { setSmooth(true); fit(); }
    else if (e.key === "Escape") onSelect?.(null);
  };

  const active = selected ?? hover;
  const edges = useMemo(() => {
    const out: { key: string; d: string; from: string; to: string }[] = [];
    for (const t of drawn) {
      const a = boxes[t.name];
      if (!a) continue;
      for (const fk of t.foreign_keys) {
        const target = byName.get(fk.ref_table);
        const b = boxes[fk.ref_table];
        if (!target || !b) continue;
        const fromRow = Math.min(Math.max(t.columns.findIndex((c) => c.name === fk.columns[0]), 0), MAX_ROWS);
        const toRow = Math.min(Math.max(target.columns.findIndex((c) => c.name === fk.ref_columns[0]), 0), MAX_ROWS);
        out.push({ key: `${t.name}.${fk.name}`, d: edgePath(a, fromRow, b, toRow), from: t.name, to: fk.ref_table });
      }
    }
    return out;
  }, [drawn, boxes, byName]);

  return (
    <div className="canvas-wrap panel-dark" style={{ padding: 0 }}>
      <div className="canvas-tools">
        <button className="icon-btn" aria-label="Zoom in" title="Zoom in (+)" onClick={() => zoomAt(1.25)}><MagnifyingGlassPlus size={20} /></button>
        <button className="icon-btn" aria-label="Zoom out" title="Zoom out (-)" onClick={() => zoomAt(0.8)}><MagnifyingGlassMinus size={20} /></button>
        <button className="icon-btn" aria-label="Fit to screen" title="Fit to screen (0)" onClick={() => { setSmooth(true); fit(focus && focus.picked.size > 0 ? zoomTo : undefined); }}><ArrowsOut size={20} /></button>
      </div>
      <svg
        ref={svg}
        className="canvas"
        role="group"
        aria-label={label}
        onKeyDown={onKey}
        onPointerDown={(e) => {
          if ((e.target as Element).closest(".er-card")) return;
          (e.currentTarget as Element).setPointerCapture(e.pointerId);
          setSmooth(false);
          drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3) d.moved = true;
          setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }));
        }}
        onPointerUp={() => {
          if (drag.current && !drag.current.moved) onSelect?.(null); // a click on empty canvas clears the selection
          drag.current = null;
        }}
      >
        <defs>
          <marker id="er-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
            <path d="M 0 1 L 9 5 L 0 9 z" fill="currentColor" />
          </marker>
        </defs>
        <g className={smooth ? "cam smooth" : "cam"} style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
          <g style={{ color: "rgba(190,200,255,.55)" }}>
            {edges.map((e) => {
              if (focus) {
                const lit = focus.edges.has(pairKey(e.from, e.to));
                if (!lit && focus.hideOthers) return null;
                return <path key={e.key} d={e.d} className={`er-edge ${lit ? "flow" : "faded"}`} markerEnd="url(#er-arrow)" />;
              }
              const on = active && (e.from === active || e.to === active);
              return <path key={e.key} d={e.d} className={`er-edge ${on ? "on" : active ? "faded" : ""}`} markerEnd="url(#er-arrow)" />;
            })}
          </g>
          {drawn.map((t) => {
            const b = boxes[t.name];
            if (!b) return null;
            const ghost = ghosts.includes(t);
            const mark = marks[t.name];
            const f = focus ? (focus.picked.has(t.name) ? "picked" : focus.related.has(t.name) ? "related" : focus.hideOthers ? "hide" : "dim") : "";
            const cls = ["er-card", ghost ? "ghost" : mark ?? "", selected === t.name ? "sel" : "", dim?.has(t.name) ? "dim" : "", f].join(" ");
            return (
              <Card
                key={t.name}
                t={t}
                b={b}
                cls={cls}
                cols={colMarks[t.name]}
                onSelect={(multi) => (multi && onPick ? onPick(t.name) : onSelect?.(selected === t.name ? null : t.name))}
                onHover={(on) => setHover(on ? t.name : null)}
              />
            );
          })}
        </g>
      </svg>
      <p className="canvas-hint">Drag to pan, scroll to zoom, click a table for details{onPick ? ", Shift-click to pick several" : ""}</p>
    </div>
  );
}

function Card({ t, b, cls, cols, onSelect, onHover }: { t: Table; b: Box; cls: string; cols?: Record<string, "new" | "mod">; onSelect: (multi: boolean) => void; onHover: (on: boolean) => void }) {
  const shown = t.columns.slice(0, MAX_ROWS);
  const fkCols = new Set(t.foreign_keys.flatMap((f) => f.columns));
  const pk = new Set(t.primary_key);
  const more = t.columns.length - shown.length;
  return (
    <g
      className={cls}
      transform={`translate(${b.x} ${b.y})`}
      role="button"
      tabIndex={0}
      aria-label={`${t.name} table, ${t.columns.length} columns`}
      aria-pressed={cls.includes(" sel")}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(e.shiftKey || e.ctrlKey || e.metaKey);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(e.shiftKey);
        }
      }}
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
      onFocus={() => onHover(true)}
      onBlur={() => onHover(false)}
      style={{ cursor: "pointer" }}
    >
      <rect className="bg" width={b.w} height={b.h} rx={16} />
      <path className="head" d={`M0 ${HEADER_H} V16 A16 16 0 0 1 16 0 H${NODE_W - 16} A16 16 0 0 1 ${NODE_W} 16 V${HEADER_H} Z`} fill="rgba(255,255,255,.08)" />
      <text className="tname" x={14} y={26}>{t.name.length > 24 ? t.name.slice(0, 23) + "…" : t.name}</text>
      <text className="rowc" x={NODE_W - 14} y={25} textAnchor="end">{t.row_estimate > 0 ? `${count(t.row_estimate)} rows` : ""}</text>
      {shown.map((c, i) => {
        const y = HEADER_H + i * ROW_H + 16;
        const mark = cols?.[c.name];
        return (
          <g key={c.name}>
            <text x={14} y={y} className={mark === "new" ? "col-new" : mark === "mod" ? "col-mod" : ""}>{c.name.length > 17 ? c.name.slice(0, 16) + "…" : c.name}{c.not_null && !pk.has(c.name) ? "" : ""}</text>
            <text x={NODE_W - 14} y={y} textAnchor="end" className="ctype">{shortType(c.type)}</text>
            {pk.has(c.name) && <text x={NODE_W - 84} y={y} className="tag-pk" textAnchor="end">PK</text>}
            {fkCols.has(c.name) && <text x={NODE_W - (pk.has(c.name) ? 108 : 84)} y={y} className="tag-fk" textAnchor="end">FK</text>}
          </g>
        );
      })}
      {more > 0 && <text className="more" x={14} y={HEADER_H + MAX_ROWS * ROW_H + 18}>and {more} more {more === 1 ? "column" : "columns"}</text>}
    </g>
  );
}

function shortType(t: string): string {
  return t
    .replace("timestamp with time zone", "timestamptz")
    .replace("timestamp without time zone", "timestamp")
    .replace("character varying", "varchar")
    .replace("character", "char")
    .replace("double precision", "float8")
    .replace("integer", "int");
}
