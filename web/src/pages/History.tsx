import { CheckCircle, XCircle } from "@phosphor-icons/react";
import { Empty, ErrorBox, PageTitle, Skeleton } from "../components/ui";
import type { Api } from "../lib/api";
import { ver, when } from "../lib/format";
import { useAsync } from "../lib/hooks";

export default function HistoryPage({ api }: { api: Api }) {
  const { data, error, loading, reload } = useAsync(() => api.history(), api.database);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (loading || !data) return <Skeleton lines={6} />;
  return (
    <div className="stack" style={{ gap: "1.25rem" }}>
      <PageTitle title="History" sub="Every run, including failures and rollbacks, newest first." />
      {data.length === 0 ? (
        <Empty title="Nothing has run yet" hint="Applied and rolled back migrations are listed here." />
      ) : (
        <div className="panel tablewrap" style={{ padding: ".5rem 1rem" }} role="region" aria-label="Migration runs" tabIndex={0}>
          <table className="coltable history">
            <thead><tr><th scope="col">Result</th><th scope="col">Migration</th><th scope="col">Direction</th><th scope="col">When</th><th scope="col">Took</th><th scope="col">By</th></tr></thead>
            <tbody>
              {data.map((h) => (
                <tr key={h.id}>
                  <td>
                    {h.success
                      ? <span className="row" style={{ gap: ".35rem" }}><CheckCircle size={18} weight="fill" color="var(--success)" aria-hidden /> ok</span>
                      : <span className="row" style={{ gap: ".35rem" }}><XCircle size={18} weight="fill" color="var(--destructive)" aria-hidden /> failed</span>}
                  </td>
                  <td>{ver(h.version)} {h.name}{h.error && <div className="faint" style={{ fontFamily: "var(--font-sans)", overflowWrap: "anywhere" }}>{h.error}</div>}</td>
                  <td>{h.direction}</td>
                  <td>{when(h.started_at)}</td>
                  <td>{h.duration_ms} ms</td>
                  <td>{h.applied_by}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
