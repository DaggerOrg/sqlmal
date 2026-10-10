import { useState } from "react";
import { FloppyDisk, MagicWand } from "@phosphor-icons/react";
import SqlEditor from "../components/SqlEditor";
import { Link } from "../components/Link";
import { PageTitle } from "../components/ui";
import type { Api } from "../lib/api";
import { useRoute } from "../lib/hooks";

const UP = "-- Write the change here. It runs in one transaction.\n";
const DOWN = "-- Write the SQL that undoes the change above.\n";

export default function NewVersion({ api }: { api: Api }) {
  const { go } = useRoute();
  const [name, setName] = useState("");
  const [up, setUp] = useState(UP);
  const [down, setDown] = useState(DOWN);
  const [tab, setTab] = useState<"up" | "down">("up");
  const [msg, setMsg] = useState<{ kind: "err" | "info"; text: string }>();
  const [busy, setBusy] = useState(false);

  const valid = /^[a-z][a-z0-9_]*$/.test(name);
  const writable = !api.info.read_only;

  const fromDrift = async () => {
    setBusy(true);
    setMsg(undefined);
    try {
      const g = await api.generate();
      setUp(g.up.sql || UP);
      setDown(g.down.sql || DOWN);
      if (!name) setName("capture_manual_changes");
      const warn = [...g.up.warnings, ...g.down.warnings];
      setMsg({ kind: "info", text: warn.length ? `Filled from the live database. Check before saving: ${warn.join(" ")}` : "Filled from the changes found in the live database. Read it before saving." });
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setMsg(undefined);
    try {
      await api.createMigration(name, up, down);
      // The new file is pending, so its page shows lint results and the Apply button.
      go("migrations");
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
      setBusy(false);
    }
  };

  return (
    <div className="stack" style={{ gap: "1.25rem" }}>
      <p><Link to="versions">← All versions</Link></p>
      <PageTitle title="New version" sub="Write the SQL for a schema change. Saving creates the up and down files. Nothing runs until you apply it." />
      {!writable && (
        <div className="err" role="alert">
          {api.info.static ? "This is a saved snapshot, so it is read only." : "Read only. Start the server with --allow-write to save migrations from here."}
        </div>
      )}
      <div className="stack panel" style={{ padding: "1.25rem" }}>
        <label className="stack" style={{ gap: ".3rem" }}>
          <b>Name</b>
          <input value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[\s-]+/g, "_"))} placeholder="add_orders_status" autoComplete="off" spellCheck={false} className="mono" style={{ minHeight: 44, borderRadius: ".8rem", border: "1px solid var(--rule)", padding: "0 .8rem", background: "var(--paper)", color: "inherit" }} />
          {name && !valid && <span className="faint">Use lower case letters, digits and underscores, starting with a letter.</span>}
        </label>
        <div className="tabs" role="tablist" aria-label="File">
          {(["up", "down"] as const).map((d) => (
            <button key={d} role="tab" className="tab" aria-selected={tab === d} onClick={() => setTab(d)}>{d === "up" ? "Up" : "Down"}</button>
          ))}
        </div>
        <SqlEditor value={tab === "up" ? up : down} onChange={tab === "up" ? setUp : setDown} label={`${tab} SQL`} />
        <div aria-live="polite">{msg && <div className={msg.kind === "err" ? "err" : "ok-box"} role={msg.kind === "err" ? "alert" : "status"}>{msg.text}</div>}</div>
        <div className="row">
          <button className="btn btn-sm" disabled={busy} onClick={fromDrift}><MagicWand size={18} aria-hidden /> Fill from live database changes</button>
          <button className="btn btn-sm btn-grad" disabled={busy || !valid || !writable} onClick={save}><FloppyDisk size={18} weight="fill" aria-hidden /> Save version</button>
        </div>
      </div>
    </div>
  );
}
