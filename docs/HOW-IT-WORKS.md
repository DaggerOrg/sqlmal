# How SQLMal works

## Running migrations

1. `migration.Load` reads `NNNN_name.up.sql` and `.down.sql`, normalises the up file (case, whitespace, string literals) and takes a SHA-256. That checksum is what detects edits.
2. `engine` takes a Postgres **advisory lock** for the length of one operation, so two migrators can't interleave. A second one fails fast with a clear message instead of queueing.
3. Each migration runs in **its own transaction** with `SET LOCAL lock_timeout` and `statement_timeout`. If a `ALTER TABLE` can't get its lock quickly it fails, instead of queueing behind a long query and blocking every other query on that table.
4. Files marked `-- migrate:no-transaction` run one statement at a time, because `CREATE INDEX CONCURRENTLY` refuses to run inside a transaction.
5. A bookkeeping row goes in `schema_migrations` (version, checksum) and `migration_history` (every attempt, including failures).
6. **Dry run** is one transaction that applies the migrations and rolls back.
7. When a statement fails, the error points at a **line number**. Postgres gives a character position for syntax and most schema errors. For runtime errors (division by zero, a constraint violation) it doesn't, so the engine replays the file in a rolled-back transaction and finds the statement. It only trusts that result if the same error comes back, and it skips the replay for timeouts, where replaying would just wait again.

### Statuses

| Status | Meaning |
|---|---|
| applied | Recorded, and the file still matches its checksum |
| pending | Not applied yet |
| modified | Applied, but the file has changed since. Blocks `up` unless forced |
| missing | Applied, but the file is gone |
| out of order | A pending migration older than the newest applied one |

## The scratch database

`shadow` creates a database named `ms_shadow_<random>` on the same server, replays the migrations into it, and drops it afterwards. From that it produces:

- **Timeline.** After each migration it reads the schema and diffs it against the previous one. That is what the scrubber shows. Positions are computed once over the union of all steps so tables don't jump around while you scrub.
- **Reversibility.** Independently for each migration: build the schema just before it, apply the up, read the schema, run the down inside a transaction, read the schema again (`introspect.ReadTx`), roll back, and compare it with the schema from before the up. Doing each one independently means a missing down in the middle of the chain can't make a later migration take the blame.
- **Drift.** The scratch database built from the *applied* migrations is the expected schema. The diff against the live database is the drift.

The result is cached for ten minutes, keyed by a fingerprint of the migration files.

## Diff and generate

`diff.Compare` produces typed changes (table, column, primary key, unique, foreign key, check, index, enum). `diff.Generate` turns them into SQL: tables in dependency order, foreign keys last so cycles work, serial columns recognised and rewritten, identifiers quoted when needed. Two round-trip tests guard it: generate from an empty schema to a fixture and rebuild the fixture exactly, and apply the diff of an altered database and check nothing is left.

## Lint rules

| Rule | Flags |
|---|---|
| L001 | `DROP COLUMN` / `DROP TABLE` (data loss). Up files only |
| L002 | Column type change that rewrites the table |
| L003 | `ADD COLUMN ... NOT NULL` without a default |
| L004 | `CREATE INDEX` without `CONCURRENTLY` |
| L005 | `ADD FOREIGN KEY` without `NOT VALID` |
| L006 | `DELETE` / `UPDATE` without `WHERE`, `TRUNCATE` |
| L007 | No down file (skipped for `migrate:irreversible`) |
| L008 | A rename (note: breaks code that still uses the old name) |
| L009 | `CONCURRENTLY` inside a transaction (will fail) |
| L010 | `SET NOT NULL` (full table scan under lock) |

Tables created in the same file are exempt from the lock-risk rules, since nothing can be using them yet.

## The server

`serve` is a plain `net/http` server. JSON under `/api/{db}/...`, and the React build embedded with `go:embed` for everything else. The UI uses hash routing so the same build also works as static files, on GitHub Pages, reading `demo.json` instead of the API.

Security checks (see the README) live in `internal/server`: loopback bind unless a token is set, `Host` allowlist, `Origin` check and a required header on writes, `Content-Security-Policy`, `nosniff`, `no-store` on API responses, and scrubbing of DSNs and passwords from every error.

## The UI

React 19 and Vite, no component library. The entity diagram is plain SVG with its own layout (`web/src/lib/layout.ts`): break cycles, layer by longest path so referenced tables sit to the left, order each layer by the average position of its neighbours, and put unconnected tables in a grid. A property test checks that no two tables overlap on a random 60-table graph.
