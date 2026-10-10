import { bytes, count } from "../lib/format";
import type { Table } from "../lib/types";
import { Chip } from "./ui";

/** Everything about one table: columns, keys, indexes, and who points at it. */
export default function TableDetail({ table, all }: { table: Table; all: Table[] }) {
  const pk = new Set(table.primary_key);
  const referencedBy = all.flatMap((t) => t.foreign_keys.filter((f) => f.ref_table === table.name).map((f) => ({ from: t.name, fk: f })));
  const plainIndexes = table.indexes.filter((i) => !i.primary);
  return (
    <div className="stack">
      <div>
        <h2 className="mono" style={{ fontSize: "1.3rem" }}>{table.name}</h2>
        <div className="row" style={{ marginTop: ".4rem" }}>
          <Chip>{count(table.row_estimate)} rows (estimate)</Chip>
          <Chip>{bytes(table.size_bytes)} on disk</Chip>
          {table.partitioned && <Chip tone="info">partitioned</Chip>}
        </div>
        {table.comment && <p className="muted" style={{ marginTop: ".6rem" }}>{table.comment}</p>}
      </div>

      <section aria-label="Columns">
        <h3 className="mono-label" style={{ marginBottom: ".4rem" }}>Columns</h3>
        <div className="tablewrap" role="region" aria-label="Column list" tabIndex={0}>
          <table className="coltable">
            <thead><tr><th scope="col">Name</th><th scope="col">Type</th><th scope="col">Notes</th></tr></thead>
            <tbody>
              {table.columns.map((c) => (
                <tr key={c.name}>
                  <td>{c.name}</td>
                  <td className="mono">{c.type}</td>
                  <td>
                    <span className="row" style={{ gap: ".3rem" }}>
                      {pk.has(c.name) && <Chip tone="warn">primary key</Chip>}
                      {c.not_null && !pk.has(c.name) && <Chip>not null</Chip>}
                      {c.identity && <Chip tone="info">identity</Chip>}
                      {c.generated && <Chip tone="info">generated</Chip>}
                      {c.default && <span className="faint mono dflt" style={{ fontSize: 12 }}>default {c.default}</span>}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {table.foreign_keys.length > 0 && (
        <section aria-label="References">
          <h3 className="mono-label" style={{ marginBottom: ".4rem" }}>References</h3>
          <ul className="stack" style={{ margin: 0, padding: 0, listStyle: "none" }}>
            {table.foreign_keys.map((f) => (
              <li key={f.name}><span className="mono">{f.columns.join(", ")}</span> → <b className="mono">{f.ref_table}</b>(<span className="mono">{f.ref_columns.join(", ")}</span>) <span className="faint">on delete {f.on_delete.toLowerCase()}</span></li>
            ))}
          </ul>
        </section>
      )}

      {referencedBy.length > 0 && (
        <section aria-label="Referenced by">
          <h3 className="mono-label" style={{ marginBottom: ".4rem" }}>Referenced by</h3>
          <ul className="stack" style={{ margin: 0, padding: 0, listStyle: "none" }}>
            {referencedBy.map((r) => (
              <li key={r.from + r.fk.name}><b className="mono">{r.from}</b>.<span className="mono">{r.fk.columns.join(", ")}</span></li>
            ))}
          </ul>
        </section>
      )}

      {(table.uniques.length > 0 || table.checks.length > 0) && (
        <section aria-label="Constraints">
          <h3 className="mono-label" style={{ marginBottom: ".4rem" }}>Constraints</h3>
          <ul className="stack" style={{ margin: 0, padding: 0, listStyle: "none" }}>
            {table.uniques.map((u) => <li key={u.name}>unique <span className="mono">({u.columns.join(", ")})</span></li>)}
            {table.checks.map((c) => <li key={c.name}>check <span className="mono">{c.expr}</span></li>)}
          </ul>
        </section>
      )}

      {plainIndexes.length > 0 && (
        <section aria-label="Indexes">
          <h3 className="mono-label" style={{ marginBottom: ".4rem" }}>Indexes</h3>
          <ul className="stack" style={{ margin: 0, padding: 0, listStyle: "none" }}>
            {plainIndexes.map((i) => (
              <li key={i.name}>
                <b className="mono">{i.name}</b> <Chip>{i.method}</Chip>{i.unique && <Chip tone="info">unique</Chip>}
                <div className="faint mono" style={{ fontSize: 12, overflowWrap: "anywhere" }}>{i.def.replace(" ON public.", " ON ")}</div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
