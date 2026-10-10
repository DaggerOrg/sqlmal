import { useMemo } from "react";
import { GitCommit, GitMerge } from "@phosphor-icons/react";
import Changes from "../components/Changes";
import { Link } from "../components/Link";
import { Chip, Empty, ErrorBox, FindingItem, PageTitle, Skeleton, SqlView, StateChip } from "../components/ui";
import type { Api } from "../lib/api";
import { plural, ver, when } from "../lib/format";
import { useAsync, useRoute } from "../lib/hooks";
import type { Change, MigrationView, Row, Step } from "../lib/types";

const ADD = new Set(["table_added", "column_added", "unique_added", "foreign_key_added", "check_added", "index_added", "enum_added", "enum_value_added"]);
const DEL = new Set(["table_removed", "column_removed", "unique_removed", "foreign_key_removed", "check_removed", "index_removed", "enum_removed"]);
const stat = (cs: Change[]) => ({ add: cs.filter((c) => ADD.has(c.kind)).length, del: cs.filter((c) => DEL.has(c.kind)).length });
const sha = (checksum: string) => checksum.slice(0, 7);
const day = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) : "Not applied yet");

interface Data { rows: Row[]; views: MigrationView[]; steps: Step[] }

export default function Versions({ api }: { api: Api }) {
  const { parts } = useRoute();
  const { data, error, loading, reload } = useAsync<Data>(async () => {
    const [rows, views] = await Promise.all([api.status(), api.migrations()]);
    // Schema changes need a scratch database; without one the log still shows files and SQL.
    const steps = (await api.timeline().catch(() => null))?.steps ?? [];
    return { rows, views, steps };
  }, api.database);

  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (loading || !data) return <Skeleton lines={8} />;
  if (data.rows.length === 0) return <Empty title="No versions yet" hint="Create one with: migrate-studio new add_users" />;

  const arg = parts[1] ?? "";
  if (arg.includes("...")) {
    const [a, b] = arg.split("...").map(Number);
    return <Compare data={data} from={a} to={b} />;
  }
  if (arg) return <Detail data={data} version={Number(arg)} />;
  return <Log data={data} />;
}

function Log({ data }: { data: Data }) {
  const { go } = useRoute();
  const rows = useMemo(() => [...data.rows].sort((a, b) => b.version - a.version), [data.rows]);
  const steps = new Map(data.steps.map((s) => [s.version, s]));
  const views = new Map(data.views.map((v) => [v.version, v]));
  const groups: [string, Row[]][] = [];
  for (const r of rows) {
    const d = day(r.applied_at);
    if (groups.at(-1)?.[0] === d) groups.at(-1)![1].push(r);
    else groups.push([d, [r]]);
  }
  const oldest = rows.at(-1)!.version;
  const newest = rows[0].version;

  return (
    <div className="stack" style={{ gap: "1.25rem" }}>
      <PageTitle title="Versions" sub={`${plural(rows.length, "version")} of your schema, newest first. Open one to see exactly what it changed.`} />
      <section className="panel cmp" style={{ padding: "1rem 1.25rem" }} aria-label="Compare versions">
        <GitMerge size={20} aria-hidden />
        <b>Compare</b>
        <VersionSelect id="from" label="Base" rows={rows} value={oldest} />
        <span aria-hidden>...</span>
        <VersionSelect id="to" label="Compare" rows={rows} value={newest} />
        <button className="btn btn-sm" onClick={() => {
          const f = Number((document.getElementById("from") as HTMLSelectElement).value);
          const t = Number((document.getElementById("to") as HTMLSelectElement).value);
          go(`versions/${Math.min(f, t)}...${Math.max(f, t)}`);
        }}>Compare</button>
      </section>
      {groups.map(([d, list]) => (
        <section key={d} aria-label={d}>
          <div className="vday"><GitCommit size={16} aria-hidden /> Applied on {d}</div>
          <ul className="vlist">
            {list.map((r) => {
              const st = steps.get(r.version);
              const s = st ? stat(st.changes) : null;
              const v = views.get(r.version);
              return (
                <li key={r.version} className="vrow">
                  <div style={{ minWidth: 0 }}>
                    <Link className="t" to={`versions/${r.version}`}>{r.name.replace(/_/g, " ")}</Link>{" "}
                    {r.state !== "applied" && <StateChip state={r.state} />}{" "}
                    {v && v.lint.length > 0 && <Chip tone="warn">{plural(v.lint.length, "lint finding")}</Chip>}
                    <div className="meta">
                      {ver(r.version)}{r.applied_by ? ` · ${r.applied_by}` : ""}{r.applied_at ? ` · ${when(r.applied_at)}` : ""}
                      {s && <> · <span className="stat"><span className="a">+{s.add}</span> <span className="d">−{s.del}</span></span></>}
                    </div>
                  </div>
                  <span className="sha" title="Checksum of the file">{sha(r.checksum)}</span>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

function VersionSelect({ id, label, rows, value }: { id: string; label: string; rows: Row[]; value: number }) {
  return (
    <label className="row" style={{ gap: ".4rem" }}>
      <span className="faint">{label}</span>
      <select id={id} defaultValue={value}>
        {rows.map((r) => <option key={r.version} value={r.version}>{ver(r.version)} {r.name}</option>)}
      </select>
    </label>
  );
}

function Detail({ data, version }: { data: Data; version: number }) {
  const row = data.rows.find((r) => r.version === version);
  const view = data.views.find((v) => v.version === version);
  const step = data.steps.find((s) => s.version === version);
  const sorted = [...data.rows].sort((a, b) => a.version - b.version);
  const i = sorted.findIndex((r) => r.version === version);
  if (!row || !view) return <Empty title="Version not found" hint="It may have been removed." />;
  const s = step ? stat(step.changes) : null;
  const lines = (t: string) => t.replace(/\n$/, "").split("\n").length;

  return (
    <div className="stack" style={{ gap: "1.25rem" }}>
      <p><Link to="versions">← All versions</Link></p>
      <div className="stack panel" style={{ padding: "1.25rem" }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h1 style={{ fontSize: "1.5rem" }}>{row.name.replace(/_/g, " ")}</h1>
          <StateChip state={row.state} />
        </div>
        <div className="row">
          <Chip>{ver(row.version)}</Chip>
          <Chip>checksum {sha(row.checksum)}</Chip>
          {row.applied_by && <Chip>{row.applied_by} applied this {when(row.applied_at)}</Chip>}
          {row.state === "pending" && <Chip tone="warn">not applied yet</Chip>}
          {step?.reversible === true && <Chip tone="ok">verified reversible</Chip>}
          {step?.reversible === false && <Chip tone="bad">not fully reversible</Chip>}
        </div>
        {row.state === "modified" && <div className="err" role="alert">This file was edited after it was applied (applied checksum {sha(row.applied_checksum ?? "")}, file now {sha(row.checksum)}).</div>}
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span>{i > 0 ? <Link to={`versions/${sorted[i - 1].version}`}>← {ver(sorted[i - 1].version)}</Link> : ""}</span>
          {s && <span className="stat">{plural(step!.changes.length, "schema change")}: <span className="a">+{s.add}</span> <span className="d">−{s.del}</span></span>}
          <span>{i < sorted.length - 1 ? <Link to={`versions/${sorted[i + 1].version}`}>{ver(sorted[i + 1].version)} →</Link> : ""}</span>
        </div>
      </div>

      <div className="stack panel" style={{ padding: "1.25rem" }}>
        <h2 style={{ fontSize: "1.1rem" }}>Schema changes</h2>
        {step ? <Changes changes={step.changes} /> : <p className="muted">Needs a scratch database to compute. See the Timeline page.</p>}
      </div>

      <div className="stack panel" style={{ padding: "1.25rem" }}>
        <h2 style={{ fontSize: "1.1rem" }}>Files changed (2)</h2>
        <h3 className="mono" style={{ fontSize: 13.5 }}>{ver(row.version)}_{row.name}.up.sql <span className="stat"><span className="a">+{lines(view.up_sql)}</span></span></h3>
        <SqlView sql={view.up_sql} sign="+" label="up SQL" marks={view.lint.filter((f) => f.file === "up").map((f) => f.line)} />
        {view.has_down && (
          <>
            <h3 className="mono" style={{ fontSize: 13.5 }}>{ver(row.version)}_{row.name}.down.sql <span className="stat"><span className="d">−{lines(view.down_sql)}</span></span></h3>
            <SqlView sql={view.down_sql} sign="-" label="down SQL" marks={view.lint.filter((f) => f.file === "down").map((f) => f.line)} />
          </>
        )}
      </div>

      {view.lint.length > 0 && (
        <div className="stack panel" style={{ padding: "1.25rem" }}>
          <h2 style={{ fontSize: "1.1rem" }}>Review comments ({view.lint.length})</h2>
          <ul className="stack" style={{ margin: 0, padding: 0 }}>{view.lint.map((f, k) => <FindingItem key={k} f={f} showFile />)}</ul>
        </div>
      )}
    </div>
  );
}

function Compare({ data, from, to }: { data: Data; from: number; to: number }) {
  const inRange = data.rows.filter((r) => r.version > from && r.version <= to).sort((a, b) => a.version - b.version);
  const changes = data.steps.filter((x) => x.version > from && x.version <= to).flatMap((x) => x.changes);
  const s = stat(changes);
  return (
    <div className="stack" style={{ gap: "1.25rem" }}>
      <p><Link to="versions">← All versions</Link></p>
      <PageTitle title={`Compare ${ver(from)}...${ver(to)}`} sub={`${plural(inRange.length, "version")} between these two points. Changes are listed in the order they ran.`} />
      <div className="stack panel" style={{ padding: "1.25rem" }}>
        <h2 style={{ fontSize: "1.1rem" }}>Schema changes <span className="stat"><span className="a">+{s.add}</span> <span className="d">−{s.del}</span></span></h2>
        {data.steps.length === 0 ? <p className="muted">Needs a scratch database to compute. See the Timeline page.</p> : <Changes changes={changes} empty="No schema changes in this range." />}
      </div>
      <div className="stack panel" style={{ padding: "1.25rem" }}>
        <h2 style={{ fontSize: "1.1rem" }}>Commits in this range</h2>
        <ul className="vlist">
          {inRange.map((r) => (
            <li key={r.version} className="vrow">
              <div><Link className="t" to={`versions/${r.version}`}>{r.name.replace(/_/g, " ")}</Link><div className="meta">{ver(r.version)}{r.applied_at ? ` · ${when(r.applied_at)}` : ""}</div></div>
              <span className="sha">{sha(r.checksum)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
