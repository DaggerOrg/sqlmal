# SQLMal

Run PostgreSQL migrations from the command line, and **see** what they do: a live map of your schema, a timeline that replays the database after every migration, and a drift check that catches changes someone made by hand.

One Go binary. The web UI is built in. No agent, no account, nothing leaves your machine.

**[Live demo](https://stephen-smh.github.io/sqlmal/)** (a saved snapshot of the example shop database, read only)

![Schema diagram with the orders table selected](docs/img/schema.png)

## What it does

| | |
|---|---|
| **Migrate** | Plain `NNNN_name.up.sql` / `.down.sql` files. Apply, roll back, jump to a version, dry-run any of it. Each migration runs in its own transaction, with lock and statement timeouts, behind an advisory lock so two people can't migrate at once. |
| **Catch edits** | Every applied file is checksummed. Edit one after the fact and it shows as *modified* and blocks the next run until you say otherwise. |
| **Lint** | Ten rules for statements that hurt in production: `DROP COLUMN`, a type rewrite, `NOT NULL` without a default, an index without `CONCURRENTLY`, a foreign key without `NOT VALID`, `DELETE` with no `WHERE`, and so on. Each finding points at a line and says what to do instead. |
| **Prove reversibility** | `verify` replays every migration on a scratch database, runs each `down` inside a rolled-back transaction, and compares the schema with the one before the `up`. It finds the down that forgets to drop the enum. |
| **Visualise** | An entity diagram you can pan, zoom and search, laid out so foreign keys read left to right. A timeline you can scrub or play, with new, changed and removed tables highlighted. |
| **Detect drift** | Builds the schema the applied migrations *should* produce and diffs it against the live database. |
| **Capture drift** | `generate` writes the up and down SQL that would bring the files back in line with the database. |

| Timeline | Drift |
|---|---|
| ![Timeline](docs/img/timeline.png) | ![Drift](docs/img/drift.png) |

The UI follows your system theme and has a light mode:

![Migrations page in light mode](docs/img/migrations-light.png)

## Try it in two minutes

You need Go 1.27+, Docker, and `psql`.

```bash
git clone https://github.com/Stephen-SMH/sqlmal && cd sqlmal
make demo        # starts Postgres, builds the shop example, opens http://127.0.0.1:8484
```

The example has 14 migrations with a few deliberate flaws for the tools to find, and one manual change made behind the migrations' back.

## Use it on your own database

```bash
go install github.com/Stephen-SMH/sqlmal/cmd/sqlmal@latest

export DATABASE_URL=postgres://user:pass@localhost:5432/mydb
sqlmal init            # creates ./migrations and sqlmal.json
sqlmal new create_users
sqlmal up --dry-run    # run everything in one transaction, then roll it back
sqlmal up
sqlmal serve           # http://127.0.0.1:8484
```

| Command | What it does |
|---|---|
| `status` | Which migrations are applied, pending, edited or missing |
| `up [--steps N] [--to V] [--dry-run]` | Apply pending migrations |
| `down [--steps N] [--to V] [--dry-run]` | Roll back (one by default) |
| `goto <version>` | Move to exactly this version (`0` is before everything) |
| `baseline <version>` | Mark migrations up to this one as applied without running them, for adopting an existing database |
| `lint [--strict]` | Check files for risky statements. `--strict` also fails on warnings |
| `verify` | Replay on a scratch database and check every `down` undoes its `up` |
| `drift` | Compare the live database with the migrations |
| `generate <name>` | Write a migration from the drift |
| `export --out file.json` | Save everything the UI shows, to host a read-only snapshot |
| `serve [--addr] [--allow-write] [--token]` | Open the web UI |

`lint` (on errors, or on any warning with `--strict`), `verify` and `drift` exit non-zero when they find a problem, so they work as CI gates.

### Migration files

```
migrations/
  0001_create_users.up.sql
  0001_create_users.down.sql
  0006_index_foreign_keys.up.sql      -- migrate:no-transaction
  0012_order_status_refunded.up.sql   -- migrate:irreversible  (no down file, on purpose)
```

Two directives go in a comment in the file:

- `-- migrate:no-transaction` for statements Postgres won't run in a transaction, like `CREATE INDEX CONCURRENTLY`. Those files run one statement at a time.
- `-- migrate:irreversible` for a migration that is one-way by design (adding an enum value, say). It silences the "no down file" warning and says so in the UI.

### Several databases

`sqlmal.json`:

```json
{
  "databases": [
    { "name": "shop", "dsn_env": "SHOP_DATABASE_URL", "migrations": "./migrations" }
  ]
}
```

Connection strings are read from environment variables, so the config file is safe to commit.

## Safety

SQLMal can change a database, so the server is locked down by default:

- **Read only** until you pass `--allow-write`.
- Listens on **loopback only**. Binding to any other address is refused unless you set `--token`.
- With a token, every request needs `Authorization: Bearer ...` (compared in constant time).
- Writes also need a custom `X-SQLMal` header, and the `Origin` and `Host` headers are checked, to stop other websites and DNS-rebinding tricks from driving it.
- Passwords and connection strings are scrubbed from error messages and responses.
- The timeline, the reversibility check and the drift check run on a **scratch database** that is created and dropped for you. Your data is not read or modified. Drift reads catalog metadata only. This needs permission to `CREATE DATABASE`, or a separate `shadow_admin_dsn_env` in the config. Without that permission the timeline, `verify` and `drift` explain why they can't run, and the migrations, SQL, lint and schema views keep working.

## What it covers, and what it doesn't

- **PostgreSQL only** for now. Tested against 17.
- The schema model covers tables, columns (types, defaults, identity, generated), primary keys, unique constraints, foreign keys, checks, indexes and enums. **Views, functions, triggers, sequences, extensions and permissions are not compared**, so a drift in those won't show up.
- `generate` writes SQL in dependency order and is tested by rebuilding a schema from nothing and by applying a diff to an altered database. It warns when a change can't be expressed safely, and you should still read what it writes.
- Row estimates and table sizes come from Postgres statistics, so they are approximate.

## Development

```bash
make demo-db     # Postgres on 127.0.0.1:54329 (user and password: studio)
make test        # go vet + go test -race, then web typecheck + vitest
make ui          # rebuild the web UI and embed it in the Go binary
make build       # bin/sqlmal
```

The Go integration tests create a throwaway database each, so they need a reachable Postgres (set `SQLMAL_TEST_ADMIN_DSN` to use your own). Without one they skip locally, and fail in CI.

The built UI in `internal/server/ui` is committed so `go install` works without Node. Run `make ui` after changing anything in `web/`.

How it works is in [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md).

## Layout

```
cmd/sqlmal   the CLI
internal/
  migration          file loading, checksums, directives
  sqlsplit           splits SQL into statements (quotes, $$ bodies, comments)
  engine             applies and rolls back, locking, history, drift guard
  lint               the L001 to L010 rules
  introspect         reads a schema from the catalog
  diff               compares two schemas, writes SQL for the difference
  shadow             scratch databases: timeline, reversibility, drift
  app                the service layer both the CLI and the server use
  server             JSON API, security checks, embedded UI
web/                 React + Vite + TypeScript UI
examples/shop        a 14-migration demo project
```

## License

MIT
