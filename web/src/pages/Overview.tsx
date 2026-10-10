import { Link } from "../components/Link";
import { ArrowRight, Database, GitBranch, Warning } from "@phosphor-icons/react";
import type { Api } from "../lib/api";
import { useAsync } from "../lib/hooks";
import { plural, ver, when } from "../lib/format";
import { Chip, ErrorBox, FindingItem, Skeleton, summarize } from "../components/ui";

export default function Overview({ api }: { api: Api }) {
  const { data, error, loading, reload } = useAsync(
    async () => {
      const [status, migrations, schema] = await Promise.all([api.status(), api.migrations(), api.schema()]);
      // The scratch-database checks can be unavailable (no CREATEDB permission). The rest of the page still works.
      const [timeline, drift] = await Promise.allSettled([api.timeline(), api.drift()]);
      return { status, migrations, schema, timeline, drift };
    },
    api.database,
  );
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (loading || !data) return <Skeleton lines={6} />;
  const { status, migrations, schema } = data;
  const timeline = data.timeline.status === "fulfilled" ? data.timeline.value : null;
  const drift = data.drift.status === "fulfilled" ? data.drift.value : null;
  const unavailable = [data.timeline, data.drift].find((r): r is PromiseRejectedResult => r.status === "rejected");
  const c = summarize(status);
  const findings = migrations.flatMap((m) => m.lint.map((f) => ({ ...f, version: m.version, name: m.name })));
  const irreversible = (timeline?.steps ?? []).filter((s) => s.reversible === false);
  const problems = c.modified + c.missing + irreversible.length + (drift && !drift.in_sync ? 1 : 0) + findings.filter((f) => f.severity !== "info").length;
  const last = status.filter((r) => r.state === "applied" || r.state === "modified").sort((a, b) => b.version - a.version)[0];

  return (
    <div className="stack" style={{ gap: "1.5rem" }}>
      <section className="panel-dark hero" aria-label="Summary">
        <div className="chips">
          <Chip tone="brand" icon={<Database size={14} weight="fill" aria-hidden />}>{api.database}</Chip>
          {api.info.static ? <Chip tone="info">Saved snapshot</Chip> : api.info.read_only ? <Chip tone="info">Read only</Chip> : <Chip tone="warn">Writes enabled</Chip>}
        </div>
        <h1>{problems === 0 ? "Everything lines up." : `${plural(problems, "thing")} to look at.`}</h1>
        <p>
          {plural(status.length, "migration")}, {c.applied} applied and {c.pending} waiting. {schema.tables.length} tables in the live schema.
          {last?.applied_at && <> Last change {when(last.applied_at)}.</>}
        </p>
        <div className="kpis">
          <div className="kpi glass-in"><b>{c.applied}</b><span>applied</span></div>
          <div className="kpi glass-in"><b>{c.pending}</b><span>pending</span></div>
          <div className="kpi glass-in"><b>{schema.tables.length}</b><span>tables</span></div>
          <div className="kpi glass-in"><b>{!drift ? "n/a" : drift.in_sync ? "None" : drift.changes.length}</b><span>{!drift || drift.in_sync ? "drift" : plural(drift.changes.length, "drift change").replace(/^\d+ /, "")}</span></div>
        </div>
      </section>

      <div className="grid-2">
        <section className="stack" aria-labelledby="attn">
          <h2 id="attn" style={{ fontSize: "1.2rem" }}>Needs attention</h2>
          {problems === 0 && !unavailable && <p className="muted">Nothing is flagged. Migrations are intact, reversible and match the live database.</p>}
          {unavailable && (
            <p className="muted" role="note">
              Timeline, reversibility and drift checks are unavailable: {(unavailable.reason as Error).message}
            </p>
          )}
          <ul className="attention" style={{ margin: 0, padding: 0 }}>
            {c.modified > 0 && (
              <li><Warning size={20} weight="fill" color="var(--destructive)" aria-hidden /><span>{plural(c.modified, "migration")} edited after being applied. <Link to="migrations">Review them</Link></span></li>
            )}
            {c.missing > 0 && (
              <li><Warning size={20} weight="fill" color="var(--destructive)" aria-hidden /><span>{plural(c.missing, "applied migration")} no longer have a file. <Link to="migrations">Review them</Link></span></li>
            )}
            {drift && !drift.in_sync && (
              <li><GitBranch size={20} weight="fill" color="var(--warning)" aria-hidden /><span>The live database differs from the migrations by {plural(drift.changes.length, "change")}. <Link to="drift">See the drift</Link></span></li>
            )}
            {irreversible.map((s) => (
              <li key={s.version}><Warning size={20} weight="fill" color="var(--warning)" aria-hidden /><span>Migration {ver(s.version)} {s.name} does not fully undo itself. <Link to={`timeline/${s.version}`}>Open on the timeline</Link></span></li>
            ))}
          </ul>
          {findings.filter((f) => f.severity !== "info").length > 0 && (
            <ul className="stack" style={{ margin: 0, padding: 0 }}>
              {findings.filter((f) => f.severity !== "info").slice(0, 5).map((f, i) => (
                <FindingItem key={i} f={{ ...f, file: f.file }} showFile />
              ))}
            </ul>
          )}
        </section>

        <section className="stack" aria-labelledby="go">
          <h2 id="go" style={{ fontSize: "1.2rem" }}>Explore</h2>
          {[
            ["schema", "Schema diagram", "Every table and foreign key as a map you can pan and zoom."],
            ["timeline", "Timeline", "Scrub through the schema after each migration."],
            ["migrations", "Migrations", "Read the SQL, the lint findings and what each one changes."],
          ].map(([to, title, text]) => (
            <Link key={to} to={to} className="explore">
              <span><b>{title}</b><span className="muted" style={{ display: "block" }}>{text}</span></span>
              <ArrowRight size={20} aria-hidden />
            </Link>
          ))}
        </section>
      </div>
    </div>
  );
}
