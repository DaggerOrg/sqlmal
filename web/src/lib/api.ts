import type { Bundle, Change, DriftReport, Generated, HistoryEntry, Info, MigrationView, Result, Row, Schema, Timeline } from "./types";

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface RunRequest {
  direction: "up" | "down";
  steps?: number;
  target?: number;
  dry_run?: boolean;
}

export interface RunResponse {
  results: Result[];
  message?: string;
  error?: string;
}

/** One interface for both modes: a live server, or a saved snapshot (the demo). */
export interface Api {
  info: Info;
  database: string;
  migrations(): Promise<MigrationView[]>;
  status(): Promise<Row[]>;
  schema(): Promise<Schema>;
  timeline(): Promise<Timeline>;
  drift(): Promise<DriftReport>;
  history(): Promise<HistoryEntry[]>;
  generate(): Promise<Generated>;
  run(req: RunRequest): Promise<RunResponse>;
  createMigration(name: string, up: string, down: string): Promise<{ file: string }>;
}

const TOKEN_KEY = "ms-token";
export const getToken = () => {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
};
export const setToken = (t: string) => {
  try {
    sessionStorage.setItem(TOKEN_KEY, t);
  } catch {
    /* private mode: the token just will not be remembered */
  }
};

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const tok = getToken();
  if (tok) headers.Authorization = `Bearer ${tok}`;
  if (init?.method === "POST") {
    headers["Content-Type"] = "application/json";
    headers["X-SQLMal"] = "1";
  }
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers });
  } catch {
    throw new ApiError(0, "network", "Cannot reach the server.");
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok && res.status !== 422) {
    const e = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, e?.code ?? "error", e?.message ?? `Request failed (${res.status}).`);
  }
  return body as T;
}

function memo<T>(fn: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | undefined;
  return () => (p ??= fn().catch((e) => {
    p = undefined; // do not cache a failure
    throw e;
  }));
}

function live(info: Info, database: string): Api {
  const base = `api/${encodeURIComponent(database)}`;
  return {
    info,
    database,
    migrations: () => call(`${base}/migrations`),
    status: () => call(`${base}/status`),
    schema: () => call(`${base}/schema`),
    timeline: memo(() => call<Timeline>(`${base}/timeline`)),
    drift: () => call(`${base}/drift`),
    history: () => call(`${base}/history?limit=200`),
    generate: () => call(`${base}/generate`, { method: "POST", body: "{}" }),
    run: (req) => call(`${base}/run`, { method: "POST", body: JSON.stringify(req) }),
    createMigration: (name, up, down) => call(`${base}/migrations`, { method: "POST", body: JSON.stringify({ name, up_sql: up, down_sql: down }) }),
  };
}

function snapshot(b: Bundle): Api {
  const readOnly = () => Promise.reject(new ApiError(403, "read_only", "This is a saved snapshot. Run SQLMal against your own database to use this."));
  return {
    info: { version: "snapshot", read_only: true, static: true, databases: [{ name: b.database }] },
    database: b.database,
    migrations: () => Promise.resolve(b.migrations),
    status: () => Promise.resolve(b.status),
    schema: () => Promise.resolve(b.schema),
    timeline: () => Promise.resolve(b.timeline),
    drift: () => Promise.resolve(b.drift),
    history: () => Promise.resolve(b.history),
    generate: () => (b.generated ? Promise.resolve(b.generated) : Promise.reject(new ApiError(404, "no_drift", "There is no drift, so nothing to generate."))),
    run: readOnly,
    createMigration: readOnly,
  };
}

/** Talks to a live server if there is one; otherwise loads demo.json. */
export async function connect(): Promise<Api> {
  try {
    const info = await call<Info>("api/info");
    return live(info, info.databases[0]?.name ?? "default");
  } catch (e) {
    if (e instanceof ApiError && e.code === "unauthorized") throw e;
  }
  const res = await fetch("demo.json").catch(() => null);
  if (!res || !res.ok) throw new ApiError(0, "no_backend", "No SQLMal server was found, and there is no demo snapshot.");
  return snapshot((await res.json()) as Bundle);
}

export type { Change };
