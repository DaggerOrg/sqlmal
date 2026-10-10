import { useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, SkipBack, SkipForward } from "@phosphor-icons/react";
import Changes from "../components/Changes";
import Diagram, { type Mark } from "../components/Diagram";
import { Chip, Empty, ErrorBox, PageTitle, Skeleton } from "../components/ui";
import type { Api } from "../lib/api";
import { plural, ver } from "../lib/format";
import { useAsync, useRoute } from "../lib/hooks";
import { boxesFor, unionTables } from "../lib/schema";
import type { Table } from "../lib/types";

export default function TimelinePage({ api }: { api: Api }) {
  const { parts, go } = useRoute();
  const { data: tl, error, loading, reload } = useAsync(() => api.timeline(), api.database);
  const [playing, setPlaying] = useState(false);
  // Set when Play is pressed on the last step: the hash has not moved back to the start yet.
  const restarting = useRef(false);

  const steps = tl?.steps ?? [];
  // Position 0 is the empty database; position n is the schema after the nth migration.
  const fromRoute = parts[1] ? steps.findIndex((s) => s.version === Number(parts[1])) + 1 : steps.length;
  const pos = Math.max(0, Math.min(steps.length, fromRoute));
  const set = (n: number) => go(n === 0 ? "timeline/0" : `timeline/${steps[n - 1].version}`);

  useEffect(() => {
    if (!playing) return;
    if (restarting.current) {
      if (pos >= steps.length) return;
      restarting.current = false;
    }
    if (pos >= steps.length) { setPlaying(false); return; }
    const t = setTimeout(() => set(pos + 1), 1300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, pos, steps.length]);

  const boxes = useMemo(() => (tl ? boxesFor(unionTables(tl.steps.map((s) => s.schema))) : {}), [tl]);

  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (loading || !tl) return <Skeleton lines={8} />;
  if (steps.length === 0) return <Empty title="No migrations to replay" hint="Add a migration and the timeline will show the schema after each one." />;

  const cur = pos === 0 ? null : steps[pos - 1];
  const prev = pos <= 1 ? [] : steps[pos - 2].schema.tables;
  const tables: Table[] = cur ? cur.schema.tables : [];
  const now = new Set(tables.map((t) => t.name));
  const ghosts = prev.filter((t) => !now.has(t.name));

  const marks: Record<string, Mark> = {};
  const colMarks: Record<string, Record<string, "new" | "mod">> = {};
  for (const c of cur?.changes ?? []) {
    if (!c.table) continue;
    if (c.kind === "table_added") marks[c.table] = "added";
    else if (c.kind !== "table_removed" && !marks[c.table]) marks[c.table] = "changed";
    if (c.object && (c.kind === "column_added" || c.kind === "column_changed")) (colMarks[c.table] ??= {})[c.object] = c.kind === "column_added" ? "new" : "mod";
  }

  return (
    <div className="stack" style={{ gap: "1.25rem" }}>
      <PageTitle title="Timeline" sub="The schema after every migration, built on a scratch database. Your own data is never touched." />

      <section className="panel scrub" style={{ padding: "1.1rem 1.25rem" }} aria-label="Timeline controls">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div className="row">
            <button className="icon-btn" aria-label="Previous migration" disabled={pos === 0} onClick={() => { setPlaying(false); set(pos - 1); }}><SkipBack size={20} /></button>
            <button className="icon-btn" aria-label={playing ? "Pause" : "Play"} onClick={() => { if (!playing && pos >= steps.length) { restarting.current = true; set(0); } setPlaying((p) => !p); }}>
              {playing ? <Pause size={20} weight="fill" /> : <Play size={20} weight="fill" />}
            </button>
            <button className="icon-btn" aria-label="Next migration" disabled={pos === steps.length} onClick={() => { setPlaying(false); set(pos + 1); }}><SkipForward size={20} /></button>
          </div>
          <b className="mono" style={{ fontSize: 14 }}>{cur ? `${ver(cur.version)} ${cur.name.replace(/_/g, " ")}` : "Empty database"}</b>
        </div>
        <input
          type="range"
          min={0}
          max={steps.length}
          value={pos}
          aria-label="Migration"
          aria-valuetext={cur ? `${ver(cur.version)} ${cur.name}` : "Empty database"}
          onChange={(e) => { setPlaying(false); set(Number(e.target.value)); }}
        />
        <div className="ticks" aria-hidden>
          {steps.map((s, i) => (
            <span key={s.version} className={`tick ${i < pos ? "on" : ""} ${s.error ? "bad" : s.reversible === false ? "warn" : ""}`} />
          ))}
        </div>
      </section>

      <div className="schema-grid with-side">
        <Diagram
          tables={tables}
          ghosts={ghosts}
          boxes={boxes}
          marks={marks}
          colMarks={colMarks}
          label={`Schema after ${cur ? cur.name : "no migrations"}, ${plural(tables.length, "table")}`}
          fitKey={api.database}
        />
        <aside className="panel side" style={{ padding: "1.25rem" }} aria-label="This step">
          <h2 style={{ fontSize: "1.1rem" }}>{cur ? "What this step did" : "Start"}</h2>
          {cur ? (
            <>
              <div className="row">
                <Chip>{plural(tables.length, "table")}</Chip>
                <Chip>{cur.apply_ms} ms</Chip>
                {cur.reversible === true && <Chip tone="ok">undo verified</Chip>}
                {cur.reversible === false && <Chip tone="bad">undo incomplete</Chip>}
                {cur.reversible === null && <Chip>undo not checked</Chip>}
              </div>
              <Changes changes={cur.changes} />
              {cur.error && <div className="err" role="alert">Failed: {cur.error}</div>}
              {cur.reversible === false && cur.reverse_note && <p className="muted">{cur.reverse_note[0].toUpperCase() + cur.reverse_note.slice(1)}</p>}
            </>
          ) : (
            <p className="muted">Nothing exists yet. Press play or drag the slider.</p>
          )}
          <div className="legend-light" aria-hidden>
            <span><i style={{ borderColor: "#39c684" }} />new</span>
            <span><i style={{ borderColor: "#f4a825" }} />changed</span>
            <span><i style={{ borderColor: "#ef6a6a", borderStyle: "dashed" }} />removed</span>
          </div>
        </aside>
      </div>
    </div>
  );
}
