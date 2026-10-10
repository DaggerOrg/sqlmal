import { useMemo, useState } from "react";
import { MagnifyingGlass, X } from "@phosphor-icons/react";
import Diagram from "../components/Diagram";
import TableDetail from "../components/TableDetail";
import { Empty, ErrorBox, PageTitle, Skeleton } from "../components/ui";
import type { Api } from "../lib/api";
import { useAsync, useRoute } from "../lib/hooks";
import { boxesFor } from "../lib/schema";
import { plural } from "../lib/format";

export default function SchemaPage({ api }: { api: Api }) {
  const { parts, go } = useRoute();
  const { data: schema, error, loading, reload } = useAsync(() => api.schema(), api.database);
  const [q, setQ] = useState("");
  const selected = parts[1] ?? null;

  const boxes = useMemo(() => (schema ? boxesFor(schema.tables) : {}), [schema]);
  const dim = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!schema || !needle) return undefined;
    return new Set(schema.tables.filter((t) => !t.name.toLowerCase().includes(needle) && !t.columns.some((c) => c.name.toLowerCase().includes(needle))).map((t) => t.name));
  }, [schema, q]);

  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (loading || !schema) return <Skeleton lines={8} />;
  if (schema.tables.length === 0) return <Empty title="The schema is empty" hint="Apply a migration and its tables will appear here." />;

  const table = schema.tables.find((t) => t.name === selected);
  const fks = schema.tables.reduce((n, t) => n + t.foreign_keys.length, 0);

  return (
    <div className="stack" style={{ gap: "1.25rem" }}>
      <PageTitle title="Schema" sub={`${plural(schema.tables.length, "table")}, ${plural(fks, "foreign key")}, ${plural(schema.enums.length, "enum")}.`}>
        <label className="search">
          <MagnifyingGlass size={18} aria-hidden />
          <input type="search" placeholder="Find a table or column" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a table or column" />
        </label>
      </PageTitle>
      <div className={table ? "schema-grid with-side" : "schema-grid"}>
        <Diagram
          tables={schema.tables}
          boxes={boxes}
          selected={selected}
          onSelect={(n) => go(n ? `schema/${n}` : "schema")}
          label={`Entity diagram with ${schema.tables.length} tables`}
          fitKey={api.database}
          dim={dim}
        />
        {table && (
          <aside className="panel side" style={{ padding: "1.25rem" }} aria-label={`Details for ${table.name}`}>
            <button className="icon-btn" style={{ justifySelf: "end" }} aria-label="Close details" onClick={() => go("schema")}><X size={20} /></button>
            <TableDetail table={table} all={schema.tables} />
          </aside>
        )}
      </div>
      {schema.enums.length > 0 && (
        <section className="panel stack" style={{ padding: "1.25rem" }} aria-label="Enums">
          <h2 style={{ fontSize: "1.1rem" }}>Enums</h2>
          {schema.enums.map((e) => (
            <p key={e.name}><b className="mono">{e.name}</b> <span className="muted mono" style={{ fontSize: 13 }}>{e.labels.join(" | ")}</span></p>
          ))}
        </section>
      )}
    </div>
  );
}
