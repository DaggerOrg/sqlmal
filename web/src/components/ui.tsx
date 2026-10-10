import type { ReactNode } from "react";
import { CheckCircle, Info, Warning, WarningOctagon, XCircle } from "@phosphor-icons/react";
import { highlight, type Token } from "../lib/highlight";
import type { Finding, Row, Severity, State } from "../lib/types";

export function Chip({ tone = "", icon, children }: { tone?: "ok" | "warn" | "bad" | "info" | "brand" | ""; icon?: ReactNode; children: ReactNode }) {
  return (
    <span className={`chip ${tone}`}>
      {icon}
      {children}
    </span>
  );
}

const STATE_LABEL: Record<State, string> = { applied: "Applied", pending: "Pending", modified: "Edited after applying", missing: "File missing" };

export function StateChip({ state }: { state: State }) {
  const tone = state === "applied" ? "ok" : state === "pending" ? "warn" : "bad";
  const icon = state === "applied" ? <CheckCircle size={14} weight="fill" aria-hidden /> : state === "pending" ? <Info size={14} weight="fill" aria-hidden /> : <XCircle size={14} weight="fill" aria-hidden />;
  return <Chip tone={tone} icon={icon}>{STATE_LABEL[state]}</Chip>;
}

export function SeverityIcon({ s }: { s: Severity }) {
  if (s === "error") return <WarningOctagon size={20} weight="fill" color="var(--destructive)" aria-label="error" />;
  if (s === "warning") return <Warning size={20} weight="fill" color="var(--warning)" aria-label="warning" />;
  return <Info size={20} weight="fill" color="var(--accent)" aria-label="note" />;
}

export function FindingItem({ f, showFile }: { f: Finding; showFile?: boolean }) {
  return (
    <li className="finding" style={{ listStyle: "none" }}>
      <SeverityIcon s={f.severity} />
      <div>
        <p>
          <b className="mono" style={{ fontSize: 13 }}>{f.rule}</b> {f.message}{" "}
          <span className="faint mono" style={{ fontSize: 12 }}>{showFile ? `${f.file}.sql, ` : ""}line {f.line}</span>
        </p>
      </div>
      {f.hint && <p className="hint">{f.hint}</p>}
    </li>
  );
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="stack" role="status" aria-label="Loading">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton" style={{ width: `${95 - ((i * 17) % 40)}%` }} />
      ))}
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div className="err" role="alert">
      <p><b>{error.message}</b></p>
      {onRetry && <button className="btn btn-sm" style={{ marginTop: ".6rem" }} onClick={onRetry}>Try again</button>}
    </div>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="empty">
      <b>{title}</b>
      {hint && <p>{hint}</p>}
    </div>
  );
}

export function PageTitle({ title, sub, children }: { title: string; sub?: string; children?: ReactNode }) {
  return (
    <div className="page-title">
      <div>
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {children}
    </div>
  );
}

/** Splits highlighted tokens into lines, so each line can carry a number. */
function toLines(tokens: Token[]): Token[][] {
  const lines: Token[][] = [[]];
  for (const t of tokens) {
    const parts = t.text.split("\n");
    parts.forEach((p, i) => {
      if (i > 0) lines.push([]);
      if (p) lines[lines.length - 1].push({ kind: t.kind, text: p });
    });
  }
  return lines;
}

export function SqlView({ sql, marks = [], label, sign }: { sql: string; marks?: number[]; label: string; sign?: "+" | "-" }) {
  const lines = toLines(highlight(sql.replace(/\n$/, "")));
  const marked = new Set(marks);
  return (
    <pre className={`sql${sign ? ` diff ${sign === "+" ? "add" : "del"}` : ""}`} tabIndex={0} aria-label={label}>
      <code>
        {lines.map((ln, i) => (
          <span key={i} className={`sql-line ${marked.has(i + 1) ? "hl" : ""}`}>
            <span className="ln" aria-hidden>{i + 1}</span>{sign && <span className="sg" aria-hidden>{sign}</span>}
            {ln.map((t, j) => (t.kind === "text" ? t.text : <span key={j} className={t.kind}>{t.text}</span>))}
          </span>
        ))}
      </code>
    </pre>
  );
}

export function summarize(rows: Row[]) {
  const c = { applied: 0, pending: 0, modified: 0, missing: 0 };
  for (const r of rows) c[r.state]++;
  return c;
}
