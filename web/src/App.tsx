import { useEffect, useState } from "react";
import { ArrowsLeftRight, Clock, Database, GitBranch, GitDiff, House, ListChecks, Moon, Sun, Table } from "@phosphor-icons/react";
import { Link } from "./components/Link";
import { Chip, ErrorBox, Skeleton } from "./components/ui";
import { ApiError, connect, setToken, type Api } from "./lib/api";
import { useRoute, useTheme } from "./lib/hooks";
import Drift from "./pages/Drift";
import History from "./pages/History";
import Migrations from "./pages/Migrations";
import Overview from "./pages/Overview";
import Schema from "./pages/Schema";
import Timeline from "./pages/Timeline";
import Versions from "./pages/Versions";

const NAV = [
  { to: "", label: "Overview", icon: House },
  { to: "migrations", label: "Migrations", icon: ListChecks },
  { to: "versions", label: "Versions", icon: GitBranch },
  { to: "schema", label: "Schema", icon: Table },
  { to: "timeline", label: "Timeline", icon: Clock },
  { to: "drift", label: "Drift", icon: GitDiff },
  { to: "history", label: "History", icon: ArrowsLeftRight },
] as const;

export default function App() {
  const [api, setApi] = useState<Api>();
  const [error, setError] = useState<ApiError | Error>();
  const [attempt, setAttempt] = useState(0);
  const { parts } = useRoute();
  const [theme, toggle] = useTheme();

  useEffect(() => {
    connect().then(setApi).catch(setError);
  }, [attempt]);

  const page = parts[0] ?? "";
  useEffect(() => {
    const label = NAV.find((n) => n.to === page)?.label ?? "Not found";
    document.title = `${label} · Migrate Studio`;
  }, [page]);

  if (error instanceof ApiError && error.code === "unauthorized") {
    return <TokenPrompt onDone={() => { setError(undefined); setAttempt((n) => n + 1); }} />;
  }

  return (
    <div className="shell">
      <a className="skip" href="#main">Skip to content</a>
      <nav className="rail" aria-label="Main">
        <div className="logo" aria-hidden><Database size={26} weight="fill" /></div>
        {NAV.map(({ to, label, icon: Icon }) => (
          <Link key={to} to={to} data-tip={label} aria-label={label} aria-current={page === to ? "page" : undefined}>
            <Icon size={24} weight={page === to ? "fill" : "regular"} />
          </Link>
        ))}
        <div className="grow" />
        <button className="icon-btn" aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} onClick={toggle}>
          {theme === "dark" ? <Sun size={22} /> : <Moon size={22} />}
        </button>
      </nav>
      <div className="main">
        <header className="topbar">
          <b style={{ letterSpacing: "-0.02em" }}>Migrate Studio</b>
          {api && <Chip tone="brand" icon={<Database size={14} weight="fill" aria-hidden />}>{api.database}</Chip>}
          {api && (api.info.static ? <Chip tone="info">Snapshot</Chip> : api.info.read_only ? <Chip>Read only</Chip> : <Chip tone="warn">Writes on</Chip>)}
          <span className="grow" />
          {api && !api.info.static && <span className="faint mono" style={{ fontSize: 12.5 }}>{/^\d/.test(api.info.version) ? `v${api.info.version}` : api.info.version}</span>}
        </header>
        <main id="main" className="page" tabIndex={-1}>
          {error ? <ErrorBox error={error} onRetry={() => { setError(undefined); setAttempt((n) => n + 1); }} /> : !api ? <Skeleton lines={6} /> : <Route page={page} api={api} />}
        </main>
      </div>
    </div>
  );
}

function Route({ page, api }: { page: string; api: Api }) {
  switch (page) {
    case "": return <Overview api={api} />;
    case "migrations": return <Migrations api={api} />;
    case "versions": return <Versions api={api} />;
    case "schema": return <Schema api={api} />;
    case "timeline": return <Timeline api={api} />;
    case "drift": return <Drift api={api} />;
    case "history": return <History api={api} />;
    default:
      return (
        <div className="empty">
          <b>That page does not exist.</b>
          <Link to="" className="btn btn-sm">Back to overview</Link>
        </div>
      );
  }
}

function TokenPrompt({ onDone }: { onDone: () => void }) {
  const [value, setValue] = useState("");
  return (
    <main className="token-wrap">
      <form className="panel-dark token" onSubmit={(e) => { e.preventDefault(); setToken(value.trim()); onDone(); }}>
        <h1 style={{ fontSize: "1.8rem" }}>Enter the access token</h1>
        <p>This server needs the token it was started with. It is kept for this tab only.</p>
        <label className="stack">
          <span>Access token</span>
          <input className="field" type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} required />
        </label>
        <button className="btn btn-grad" type="submit">Continue</button>
      </form>
    </main>
  );
}
