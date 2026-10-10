import { useMemo, useState } from "react";
import { ArrowCounterClockwise, Eye, Play } from "@phosphor-icons/react";
import Changes from "../components/Changes";
import { Chip, Empty, ErrorBox, FindingItem, PageTitle, Skeleton, SqlView, StateChip } from "../components/ui";
import type { Api, RunResponse } from "../lib/api";
import { plural, ver, when } from "../lib/format";
import { useAsync, useRoute } from "../lib/hooks";
import type { Row } from "../lib/types";

export default function Migrations({ api }: { api: Api }) {
  const { parts, go } = useRoute();
  const [tab, setTab] = useState<"up" | "down">("up");
  const [run, setRun] = useState<{ busy: boolean; res?: RunResponse; err?: string }>({ busy: false });
  const { data, error, loading, reload } = useAsync(
    async () => {
      const [status, migrations] = await Promise.all([api.status(), api.migrations()]);
      // The timeline needs a scratch database; without one the page still shows files, SQL and lint.
      const timeline = await api.timeline().catch(() => null);
      return [status, migrations, timeline] as const;
    },
    api.database,
  );

  const rows = useMemo(() => data?.[0] ?? [], [data]);
  const newestFirst = useMemo(() => [...rows].sort((a, b) => b.version - a.version), [rows]);

  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (loading || !data) return <Skeleton lines={8} />;
  if (rows.length === 0) return <Empty title="No migrations yet" hint="Create one with: migrate-studio new add_users" />;

  const sel = parts[1] ? Number(parts[1]) : newestFirst[0].version;
  const row = rows.find((r) => r.version === sel);
  const view = data[1].find((m) => m.version === sel);
  const step = data[2]?.steps.find((s) => s.version === sel);
  const writable = !api.info.read_only;

  const act = async (direction: "up" | "down", dry: boolean) => {
    if (!row) return;
    setRun({ busy: true });
    try {
      // Up stops after this version. Down rolls back this one and everything applied after it.
      const req =
        direction === "up"
          ? { direction, target: row.version, dry_run: dry }
          : { direction, steps: rows.filter((r) => r.version >= row.version && r.state !== "pending").length, dry_run: dry };
      const res = await api.run(req);
      setRun({ busy: false, res });
      if (!dry) reload();
    } catch (e) {
      setRun({ busy: false, err: (e as Error).message });
    }
  };

  return (
    <div className="stack" style={{ gap: "1.25rem" }}>
      <PageTitle title="Migrations" sub={`${plural(rows.length, "migration")}. Pick one to read its SQL and see what it changes.`} />
      <div className="split">
        <nav aria-label="Migrations" className="panel-dark" style={{ padding: ".6rem" }}>
          <ul className="mlist">
            {newestFirst.map((r) => (
              <li key={r.version}>
                <button className="mrow" aria-current={r.version === sel} onClick={() => { setRun({ busy: false }); go(`migrations/${r.version}`); }}>
                  <span className={`dot ${r.state}`} aria-hidden />
                  <span style={{ minWidth: 0 }}>
                    <span className="n" style={{ display: "block" }}>{r.name.replace(/_/g, " ")}</span>
                    <span className="v">{ver(r.version)} · {r.state}</span>
                  </span>
                  <span className="flags">
                    {r.no_tx && <Chip>no tx</Chip>}
                    {!r.has_down && <Chip tone="warn">no down</Chip>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </nav>

        {row && view ? (
          <section className="stack" aria-label={`Migration ${ver(row.version)}`}>
            <div className="stack panel" style={{ padding: "1.25rem" }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <h2 style={{ fontSize: "1.35rem" }}>{ver(row.version)} · {row.name.replace(/_/g, " ")}</h2>
                <StateChip state={row.state} />
              </div>
              <Facts row={row} oneWay={view.one_way} reversible={step?.reversible} />
              {row.state === "modified" && (
                <div className="err" role="alert">The file was edited after it was applied, so the database ran a different version than the one on disk.</div>
              )}

              {writable ? (
                <div className="row" role="group" aria-label="Actions">
                  {row.state === "pending" && (
                    <>
                      <button className="btn btn-sm" disabled={run.busy} onClick={() => act("up", true)}><Eye size={18} aria-hidden /> Dry run</button>
                      <button className="btn btn-sm btn-grad" disabled={run.busy} onClick={() => act("up", false)}><Play size={18} weight="fill" aria-hidden /> Apply up to here</button>
                    </>
                  )}
                  {row.state === "applied" && (
                    <>
                      <button className="btn btn-sm" disabled={run.busy} onClick={() => act("down", true)}><Eye size={18} aria-hidden /> Dry run rollback</button>
                      <button className="btn btn-sm btn-danger" disabled={run.busy || !view.has_down} onClick={() => act("down", false)}><ArrowCounterClockwise size={18} aria-hidden /> Roll back to before this</button>
                    </>
                  )}
                </div>
              ) : (
                <p className="faint" style={{ fontSize: 13.5 }}>
                  {api.info.static ? "This is a saved snapshot, so it is read only." : "Read only. Start the server with --allow-write to run migrations from here."}
                </p>
              )}
              <div aria-live="polite">
                {run.err && <div className="err" role="alert">{run.err}</div>}
                {run.res && <RunResult res={run.res} />}
              </div>
            </div>

            <div className="stack panel" style={{ padding: "1.25rem" }}>
              <div className="tabs" role="tablist" aria-label="Direction">
                {(["up", "down"] as const).map((d) => (
                  <button key={d} role="tab" className="tab" aria-selected={tab === d} onClick={() => setTab(d)}>{d === "up" ? "Up" : "Down"}</button>
                ))}
              </div>
              {tab === "down" && !view.has_down ? (
                <p className="muted">{view.one_way ? "This migration is one-way on purpose, so it has no down file." : "There is no down file for this migration."}</p>
              ) : (
                <SqlView sql={tab === "up" ? view.up_sql : view.down_sql} marks={view.lint.filter((f) => f.file === tab).map((f) => f.line)} label={`${tab} SQL`} />
              )}
            </div>

            {view.lint.length > 0 && (
              <div className="stack panel" style={{ padding: "1.25rem" }}>
                <h3 style={{ fontSize: "1.1rem" }}>Lint ({view.lint.length})</h3>
                <ul className="stack" style={{ margin: 0, padding: 0 }}>{view.lint.map((f, i) => <FindingItem key={i} f={f} showFile />)}</ul>
              </div>
            )}

            <div className="stack panel" style={{ padding: "1.25rem" }}>
              <h3 style={{ fontSize: "1.1rem" }}>What it changes</h3>
              {step ? <Changes changes={step.changes} /> : <p className="muted">Not available for this migration.</p>}
              {step?.error && <div className="err" role="alert">Failed on a clean database: {step.error}</div>}
              {step?.reversible === false && <p className="muted"><b>The down does not fully undo the up.</b> {step.reverse_note ? step.reverse_note[0].toUpperCase() + step.reverse_note.slice(1) : ""}</p>}
              {step?.reverse_diff && step.reverse_diff.length > 0 && <Changes changes={step.reverse_diff} />}
            </div>
          </section>
        ) : (
          <Empty title="Migration not found" hint="It may have been removed." />
        )}
      </div>
    </div>
  );
}

function Facts({ row, oneWay, reversible }: { row: Row; oneWay?: boolean; reversible?: boolean | null }) {
  return (
    <div className="row">
      {row.applied_at && <Chip>Applied {when(row.applied_at)}</Chip>}
      {row.duration_ms != null && row.state !== "pending" && <Chip>{row.duration_ms} ms</Chip>}
      {row.applied_by && <Chip>by {row.applied_by}</Chip>}
      {row.no_tx && <Chip tone="info">runs outside a transaction</Chip>}
      {oneWay && <Chip tone="info">one-way by design</Chip>}
      {reversible === true && <Chip tone="ok">verified reversible</Chip>}
      {reversible === false && <Chip tone="bad">not fully reversible</Chip>}
      {row.out_of_order && <Chip tone="warn">applied out of order</Chip>}
    </div>
  );
}

function RunResult({ res }: { res: RunResponse }) {
  const failed = res.error || res.results?.some((r) => r.error);
  return (
    <div className={failed ? "err" : "ok-box"} role={failed ? "alert" : "status"}>
      {res.message && <p>{res.message}</p>}
      <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
        {(res.results ?? []).map((r) => (
          <li key={`${r.version}${r.direction}`}>
            {ver(r.version)} {r.name} ({r.direction}{r.dry_run ? ", dry run" : ""}):{" "}
            {r.error ? `failed${r.line ? ` on line ${r.line}` : ""}: ${r.error}` : r.skipped ? `skipped (${r.skipped})` : `ok in ${r.duration_ms} ms`}
          </li>
        ))}
      </ul>
    </div>
  );
}
