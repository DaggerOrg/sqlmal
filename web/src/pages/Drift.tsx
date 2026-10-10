import { useState } from "react";
import { Check, Copy } from "@phosphor-icons/react";
import Changes from "../components/Changes";
import { Chip, Empty, ErrorBox, PageTitle, Skeleton, SqlView } from "../components/ui";
import type { Api } from "../lib/api";
import { plural } from "../lib/format";
import { useAsync } from "../lib/hooks";
import type { Generated } from "../lib/types";

export default function DriftPage({ api }: { api: Api }) {
  const { data: drift, error, loading, reload } = useAsync(() => api.drift(), api.database);
  const [gen, setGen] = useState<{ data?: Generated; err?: string; busy?: boolean }>({});
  const [copied, setCopied] = useState(false);

  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (loading || !drift) return <Skeleton lines={6} />;

  const make = async () => {
    setGen({ busy: true });
    try {
      setGen({ data: await api.generate() });
    } catch (e) {
      setGen({ err: (e as Error).message });
    }
  };
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard can be blocked; the SQL is still on screen */
    }
  };

  return (
    <div className="stack" style={{ gap: "1.25rem" }}>
      <PageTitle title="Drift" sub="Compares your live database with what the applied migrations should have produced." />

      {drift.skipped ? (
        <Empty title="Drift check skipped" hint={drift.skipped} />
      ) : drift.in_sync ? (
        <section className="panel-dark" style={{ padding: "2rem" }}>
          <Chip tone="ok">In sync</Chip>
          <h2 style={{ fontSize: "1.8rem", margin: ".6rem 0 .3rem" }}>No drift.</h2>
          <p style={{ color: "rgba(255,255,255,.8)" }}>The live database matches the {plural(drift.applied, "applied migration")}. Nobody has changed it by hand.</p>
        </section>
      ) : (
        <>
          <section className="panel stack" style={{ padding: "1.25rem" }} aria-label="Differences">
            <div className="row"><Chip tone="warn">{plural(drift.changes.length, "difference")}</Chip><span className="muted">Changes needed to turn the migrated schema into the live one.</span></div>
            <Changes changes={drift.changes} />
          </section>

          <section className="panel stack" style={{ padding: "1.25rem" }} aria-label="Fix">
            <h2 style={{ fontSize: "1.2rem" }}>Capture it as a migration</h2>
            <p className="muted">Generates SQL that records the manual change, with a matching down. Review it before saving it as a file.</p>
            {!gen.data && <div><button className="btn btn-grad" onClick={make} disabled={gen.busy}>{gen.busy ? "Generating" : "Generate migration"}</button></div>}
            {gen.err && <div className="err" role="alert">{gen.err}</div>}
            {gen.data && (
              <div className="stack">
                {gen.data.up.warnings.length > 0 && <ul className="err" style={{ margin: 0 }}>{gen.data.up.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <h3 style={{ fontSize: "1.05rem" }}>Up</h3>
                  <button className="btn btn-sm" onClick={() => copy(gen.data!.up.sql)}>{copied ? <Check size={18} aria-hidden /> : <Copy size={18} aria-hidden />} {copied ? "Copied" : "Copy"}</button>
                </div>
                <SqlView sql={gen.data.up.sql} label="Generated up SQL" />
                <h3 style={{ fontSize: "1.05rem" }}>Down</h3>
                <SqlView sql={gen.data.down.sql} label="Generated down SQL" />
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
