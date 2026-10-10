// Package engine applies and rolls back migrations on a PostgreSQL database
// and reports what has run.
//
// Safety properties:
//   - One migration runs at a time per database (advisory lock).
//   - Each migration runs in its own transaction, so a failure leaves no
//     half-applied schema (unless it asked for -- migrate:no-transaction).
//   - Applied migrations are checksummed, so editing history is detected.
//   - A lock_timeout stops a migration from queueing behind a long query and
//     blocking the whole application.
package engine

import (
	"context"
	"errors"
	"fmt"
	"hash/fnv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/Stephen-SMH/migrate-studio/internal/migration"
	"github.com/Stephen-SMH/migrate-studio/internal/sqlsplit"
)

var (
	ErrLocked   = errors.New("another migration is already running on this database")
	ErrDrifted  = errors.New("applied migrations no longer match the files")
	ErrNoDown   = errors.New("there is no down migration")
	ErrNothing  = errors.New("nothing to do")
	ErrOutOfSeq = errors.New("a pending migration is older than one already applied")
)

type State string

const (
	Applied  State = "applied"
	Pending  State = "pending"
	Modified State = "modified" // applied, but the file was edited afterwards
	Missing  State = "missing"  // applied, but the file is gone
)

// Row is one migration's status.
type Row struct {
	Version         int64      `json:"version"`
	Name            string     `json:"name"`
	State           State      `json:"state"`
	Checksum        string     `json:"checksum"`
	AppliedChecksum string     `json:"applied_checksum,omitempty"`
	AppliedAt       *time.Time `json:"applied_at,omitempty"`
	DurationMs      int        `json:"duration_ms,omitempty"`
	AppliedBy       string     `json:"applied_by,omitempty"`
	HasDown         bool       `json:"has_down"`
	NoTx            bool       `json:"no_tx"`
	OutOfOrder      bool       `json:"out_of_order,omitempty"`
}

// HistoryEntry is one run of a migration, successful or not.
type HistoryEntry struct {
	ID         int64     `json:"id"`
	Version    int64     `json:"version"`
	Name       string    `json:"name"`
	Direction  string    `json:"direction"`
	Success    bool      `json:"success"`
	Error      string    `json:"error,omitempty"`
	StartedAt  time.Time `json:"started_at"`
	DurationMs int       `json:"duration_ms"`
	AppliedBy  string    `json:"applied_by"`
}

// Result describes one migration run.
type Result struct {
	Version    int64  `json:"version"`
	Name       string `json:"name"`
	Direction  string `json:"direction"`
	DryRun     bool   `json:"dry_run"`
	Skipped    string `json:"skipped,omitempty"`
	Error      string `json:"error,omitempty"`
	Line       int    `json:"line,omitempty"`
	DurationMs int    `json:"duration_ms"`
}

// Options tune a run. The zero value is a safe default.
type Options struct {
	// Steps limits how many migrations run (0 = all for Up, 1 for Down).
	Steps int
	// Target stops after this version (Up) or rolls back to it, keeping it applied (Down).
	Target int64
	DryRun bool
	// Force runs even when applied migrations were edited or are missing.
	Force bool
	// AllowOutOfOrder applies a pending migration older than the newest applied one.
	AllowOutOfOrder bool
	// LockWait is how long to wait for another migrator (default 10s).
	LockWait time.Duration
	// LockTimeout bounds waiting for table locks inside a migration (default 10s).
	LockTimeout time.Duration
	// StatementTimeout bounds each migration (default none).
	StatementTimeout time.Duration
}

func (o Options) lockWait() time.Duration {
	if o.LockWait > 0 {
		return o.LockWait
	}
	return 10 * time.Second
}

func (o Options) lockTimeout() time.Duration {
	if o.LockTimeout > 0 {
		return o.LockTimeout
	}
	return 10 * time.Second
}

// Engine runs migrations over one dedicated connection.
type Engine struct {
	conn *pgx.Conn
	set  migration.Set
	// Lock names the advisory lock. Defaults to the database name.
	locked bool
}

// Open connects to dsn.
func Open(ctx context.Context, dsn string, set migration.Set) (*Engine, error) {
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		return nil, fmt.Errorf("connect: %w", err)
	}
	return &Engine{conn: conn, set: set}, nil
}

func (e *Engine) Close(ctx context.Context) {
	e.unlock(ctx)
	_ = e.conn.Close(ctx)
}

func (e *Engine) lockKey(ctx context.Context) int64 {
	var db string
	_ = e.conn.QueryRow(ctx, `SELECT current_database()`).Scan(&db)
	h := fnv.New64a()
	h.Write([]byte("migrate-studio:" + db))
	return int64(h.Sum64() >> 1)
}

// acquire takes the lock for one operation and returns the function that
// releases it. If the caller already holds the lock the release is a no-op.
func (e *Engine) acquire(ctx context.Context, wait time.Duration) (func(), error) {
	if e.locked {
		return func() {}, nil
	}
	if err := e.lock(ctx, wait); err != nil {
		return nil, err
	}
	return func() { e.unlock(context.WithoutCancel(ctx)) }, nil
}

func (e *Engine) unlock(ctx context.Context) {
	if e.locked {
		_, _ = e.conn.Exec(ctx, `SELECT pg_advisory_unlock($1)`, e.lockKey(ctx))
		e.locked = false
	}
}

func (e *Engine) lock(ctx context.Context, wait time.Duration) error {
	if e.locked {
		return nil
	}
	key := e.lockKey(ctx)
	deadline := time.Now().Add(wait)
	for {
		var got bool
		if err := e.conn.QueryRow(ctx, `SELECT pg_try_advisory_lock($1)`, key).Scan(&got); err != nil {
			return err
		}
		if got {
			e.locked = true
			return nil
		}
		if time.Now().After(deadline) {
			return ErrLocked
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(150 * time.Millisecond):
		}
	}
}

const ddl = `
CREATE TABLE IF NOT EXISTS schema_migrations (
    version     bigint PRIMARY KEY,
    name        text NOT NULL,
    checksum    text NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now(),
    duration_ms integer NOT NULL DEFAULT 0,
    applied_by  text NOT NULL DEFAULT current_user
);
CREATE TABLE IF NOT EXISTS migration_history (
    id          bigserial PRIMARY KEY,
    version     bigint NOT NULL,
    name        text NOT NULL,
    direction   text NOT NULL CHECK (direction IN ('up', 'down')),
    success     boolean NOT NULL,
    error       text NOT NULL DEFAULT '',
    started_at  timestamptz NOT NULL DEFAULT now(),
    duration_ms integer NOT NULL DEFAULT 0,
    applied_by  text NOT NULL DEFAULT current_user,
    checksum    text NOT NULL DEFAULT ''
);`

func (e *Engine) ensureTables(ctx context.Context) error {
	_, err := e.conn.Exec(ctx, ddl)
	return err
}

func (e *Engine) hasTables(ctx context.Context) (bool, error) {
	var ok bool
	err := e.conn.QueryRow(ctx, `SELECT to_regclass('schema_migrations') IS NOT NULL`).Scan(&ok)
	return ok, err
}

type applied struct {
	version    int64
	name       string
	checksum   string
	at         time.Time
	durationMs int
	by         string
}

func (e *Engine) loadApplied(ctx context.Context) (map[int64]applied, error) {
	out := map[int64]applied{}
	has, err := e.hasTables(ctx)
	if err != nil || !has {
		return out, err
	}
	rows, err := e.conn.Query(ctx, `SELECT version, name, checksum, applied_at, duration_ms, applied_by FROM schema_migrations`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var a applied
		if err := rows.Scan(&a.version, &a.name, &a.checksum, &a.at, &a.durationMs, &a.by); err != nil {
			return nil, err
		}
		out[a.version] = a
	}
	return out, rows.Err()
}

// Status lists every migration, from the files and from the database.
func (e *Engine) Status(ctx context.Context) ([]Row, error) {
	ap, err := e.loadApplied(ctx)
	if err != nil {
		return nil, err
	}
	return buildStatus(e.set, ap), nil
}

func buildStatus(set migration.Set, ap map[int64]applied) []Row {
	var maxApplied int64
	for v := range ap {
		maxApplied = max(maxApplied, v)
	}
	seen := map[int64]bool{}
	var rows []Row
	for _, m := range set {
		seen[m.Version] = true
		r := Row{Version: m.Version, Name: m.Name, Checksum: m.Checksum, HasDown: m.HasDown, NoTx: m.NoTx, State: Pending}
		if a, ok := ap[m.Version]; ok {
			t := a.at
			r.AppliedAt, r.DurationMs, r.AppliedBy, r.AppliedChecksum = &t, a.durationMs, a.by, a.checksum
			r.State = Applied
			if a.checksum != m.Checksum {
				r.State = Modified
			}
		} else if m.Version < maxApplied {
			r.OutOfOrder = true
		}
		rows = append(rows, r)
	}
	for v, a := range ap {
		if seen[v] {
			continue
		}
		t := a.at
		rows = append(rows, Row{Version: v, Name: a.name, State: Missing, AppliedChecksum: a.checksum, AppliedAt: &t, DurationMs: a.durationMs, AppliedBy: a.by})
	}
	sortRows(rows)
	return rows
}

func sortRows(rows []Row) {
	for i := 1; i < len(rows); i++ {
		for j := i; j > 0 && rows[j].Version < rows[j-1].Version; j-- {
			rows[j], rows[j-1] = rows[j-1], rows[j]
		}
	}
}

// guard refuses to run on top of a history that no longer matches the files.
func guard(rows []Row, o Options, direction string) error {
	if o.Force {
		return nil
	}
	var bad []string
	for _, r := range rows {
		switch r.State {
		case Modified:
			bad = append(bad, fmt.Sprintf("%04d_%s was edited after it was applied", r.Version, r.Name))
		case Missing:
			bad = append(bad, fmt.Sprintf("%04d_%s was applied but its file is missing", r.Version, r.Name))
		}
	}
	if len(bad) > 0 {
		return fmt.Errorf("%w: %s. Restore the files, or re-run with force if you are sure", ErrDrifted, strings.Join(bad, "; "))
	}
	if direction == "up" && !o.AllowOutOfOrder {
		for _, r := range rows {
			if r.State == Pending && r.OutOfOrder {
				return fmt.Errorf("%w: %04d_%s. Renumber it, or allow out-of-order migrations", ErrOutOfSeq, r.Version, r.Name)
			}
		}
	}
	return nil
}

// Up applies pending migrations in version order.
func (e *Engine) Up(ctx context.Context, o Options) ([]Result, error) {
	release, err := e.acquire(ctx, o.lockWait())
	if err != nil {
		return nil, err
	}
	defer release()
	ap, err := e.loadApplied(ctx)
	if err != nil {
		return nil, err
	}
	rows := buildStatus(e.set, ap)
	if err := guard(rows, o, "up"); err != nil {
		return nil, err
	}
	var todo []migration.Migration
	for _, r := range rows {
		if r.State != Pending {
			continue
		}
		if o.Target > 0 && r.Version > o.Target {
			break
		}
		m, _ := e.set.ByVersion(r.Version)
		todo = append(todo, m)
		if o.Steps > 0 && len(todo) >= o.Steps {
			break
		}
	}
	if len(todo) == 0 {
		return nil, ErrNothing
	}
	if o.DryRun {
		return e.dryRunUp(ctx, todo, o)
	}
	if err := e.ensureTables(ctx); err != nil {
		return nil, err
	}
	var results []Result
	for _, m := range todo {
		r := e.runUp(ctx, m, o)
		results = append(results, r)
		if r.Error != "" {
			return results, errors.New(r.Error)
		}
	}
	return results, nil
}

func (e *Engine) setLocal(ctx context.Context, tx pgx.Tx, o Options) error {
	if _, err := tx.Exec(ctx, fmt.Sprintf("SET LOCAL lock_timeout = '%dms'", o.lockTimeout().Milliseconds())); err != nil {
		return err
	}
	if o.StatementTimeout > 0 {
		_, err := tx.Exec(ctx, fmt.Sprintf("SET LOCAL statement_timeout = '%dms'", o.StatementTimeout.Milliseconds()))
		return err
	}
	return nil
}

func (e *Engine) runUp(ctx context.Context, m migration.Migration, o Options) Result {
	res := Result{Version: m.Version, Name: m.Name, Direction: "up"}
	start := time.Now()
	var runErr error
	if m.NoTx {
		// No transaction: the SQL runs as it is and cannot be rolled back.
		if _, err := e.conn.Exec(ctx, fmt.Sprintf("SET lock_timeout = '%dms'", o.lockTimeout().Milliseconds())); err != nil {
			runErr = err
		} else {
			runErr = e.execEach(ctx, m.UpSQL)
			_, _ = e.conn.Exec(ctx, "RESET lock_timeout")
		}
		res.DurationMs = int(time.Since(start).Milliseconds())
		if runErr == nil {
			runErr = e.record(ctx, m, res.DurationMs)
		}
	} else {
		runErr = e.inTx(ctx, func(tx pgx.Tx) error {
			if err := e.setLocal(ctx, tx, o); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, m.UpSQL); err != nil {
				return err
			}
			res.DurationMs = int(time.Since(start).Milliseconds())
			_, err := tx.Exec(ctx, `
				WITH ins AS (INSERT INTO schema_migrations (version, name, checksum, duration_ms) VALUES ($1,$2,$3,$4))
				INSERT INTO migration_history (version, name, direction, success, duration_ms, checksum) VALUES ($1,$2,'up',true,$4,$3)`,
				m.Version, m.Name, m.Checksum, res.DurationMs)
			return err
		})
	}
	if runErr != nil {
		res.Error, res.Line = describe(m.UpSQL, runErr)
		if res.Line == 0 && !m.NoTx {
			res.Line = e.locate(ctx, m.UpSQL, res.Error)
		}
		if m.NoTx {
			res.Error += " (this migration ran outside a transaction, so it may be partly applied: check the database)"
		}
		res.DurationMs = int(time.Since(start).Milliseconds())
		e.recordFailure(ctx, m, "up", res.Error, res.DurationMs)
	}
	return res
}

// execEach runs a no-transaction file one statement at a time. PostgreSQL wraps
// a multi-statement string in an implicit transaction, which is exactly what
// CREATE INDEX CONCURRENTLY refuses to run inside.
func (e *Engine) execEach(ctx context.Context, sql string) error {
	for _, st := range sqlsplit.Split(sql) {
		if _, err := e.conn.Exec(ctx, st.SQL); err != nil {
			return err
		}
	}
	return nil
}

func (e *Engine) record(ctx context.Context, m migration.Migration, ms int) error {
	return e.inTx(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			WITH ins AS (INSERT INTO schema_migrations (version, name, checksum, duration_ms) VALUES ($1,$2,$3,$4))
			INSERT INTO migration_history (version, name, direction, success, duration_ms, checksum) VALUES ($1,$2,'up',true,$4,$3)`,
			m.Version, m.Name, m.Checksum, ms)
		return err
	})
}

func (e *Engine) recordFailure(ctx context.Context, m migration.Migration, dir, msg string, ms int) {
	// Best effort: the migration already failed, and a history write must not hide that.
	_, _ = e.conn.Exec(ctx, `INSERT INTO migration_history (version, name, direction, success, error, duration_ms, checksum) VALUES ($1,$2,$3,false,$4,$5,$6)`,
		m.Version, m.Name, dir, msg, ms, m.Checksum)
}

func (e *Engine) inTx(ctx context.Context, fn func(pgx.Tx) error) error {
	tx, err := e.conn.Begin(ctx)
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		_ = tx.Rollback(ctx)
		return err
	}
	return tx.Commit(ctx)
}

// dryRunUp applies every selected migration inside one transaction that is
// always rolled back, so later migrations see earlier ones.
func (e *Engine) dryRunUp(ctx context.Context, todo []migration.Migration, o Options) ([]Result, error) {
	var results []Result
	tx, err := e.conn.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := e.setLocal(ctx, tx, o); err != nil {
		return nil, err
	}
	for _, m := range todo {
		r := Result{Version: m.Version, Name: m.Name, Direction: "up", DryRun: true}
		if m.NoTx {
			r.Skipped = "runs outside a transaction, so it cannot be tried safely"
			results = append(results, r)
			continue
		}
		start := time.Now()
		if _, err := tx.Exec(ctx, m.UpSQL); err != nil {
			r.Error, r.Line = describe(m.UpSQL, err)
			r.DurationMs = int(time.Since(start).Milliseconds())
			results = append(results, r)
			return results, errors.New(r.Error)
		}
		r.DurationMs = int(time.Since(start).Milliseconds())
		results = append(results, r)
	}
	return results, nil
}

// Down rolls back applied migrations, newest first. Without Steps or Target it
// rolls back one.
func (e *Engine) Down(ctx context.Context, o Options) ([]Result, error) {
	release, err := e.acquire(ctx, o.lockWait())
	if err != nil {
		return nil, err
	}
	defer release()
	ap, err := e.loadApplied(ctx)
	if err != nil {
		return nil, err
	}
	rows := buildStatus(e.set, ap)
	if err := guard(rows, o, "down"); err != nil {
		return nil, err
	}
	var todo []migration.Migration
	for i := len(rows) - 1; i >= 0; i-- {
		r := rows[i]
		if r.State != Applied && r.State != Modified {
			continue
		}
		if o.Target > 0 && r.Version <= o.Target {
			break
		}
		m, _ := e.set.ByVersion(r.Version)
		if !m.HasDown {
			return nil, fmt.Errorf("%w for %04d_%s: roll back stops here", ErrNoDown, m.Version, m.Name)
		}
		todo = append(todo, m)
		limit := o.Steps
		if limit == 0 && o.Target == 0 {
			limit = 1
		}
		if limit > 0 && len(todo) >= limit {
			break
		}
	}
	if len(todo) == 0 {
		return nil, ErrNothing
	}
	var results []Result
	if o.DryRun {
		tx, err := e.conn.Begin(ctx)
		if err != nil {
			return nil, err
		}
		defer func() { _ = tx.Rollback(ctx) }()
		if err := e.setLocal(ctx, tx, o); err != nil {
			return nil, err
		}
		for _, m := range todo {
			r := Result{Version: m.Version, Name: m.Name, Direction: "down", DryRun: true}
			if m.DownNoTx {
				r.Skipped = "runs outside a transaction, so it cannot be tried safely"
				results = append(results, r)
				continue
			}
			start := time.Now()
			if _, err := tx.Exec(ctx, m.DownSQL); err != nil {
				r.Error, r.Line = describe(m.DownSQL, err)
				results = append(results, r)
				return results, errors.New(r.Error)
			}
			r.DurationMs = int(time.Since(start).Milliseconds())
			results = append(results, r)
		}
		return results, nil
	}
	for _, m := range todo {
		r := Result{Version: m.Version, Name: m.Name, Direction: "down"}
		start := time.Now()
		var runErr error
		finish := func(ctx context.Context, tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `
				WITH del AS (DELETE FROM schema_migrations WHERE version = $1)
				INSERT INTO migration_history (version, name, direction, success, duration_ms, checksum) VALUES ($1,$2,'down',true,$3,$4)`,
				m.Version, m.Name, int(time.Since(start).Milliseconds()), m.Checksum)
			return err
		}
		if m.DownNoTx {
			runErr = e.execEach(ctx, m.DownSQL)
			if runErr == nil {
				runErr = e.inTx(ctx, func(tx pgx.Tx) error { return finish(ctx, tx) })
			}
		} else {
			runErr = e.inTx(ctx, func(tx pgx.Tx) error {
				if err := e.setLocal(ctx, tx, o); err != nil {
					return err
				}
				if _, err := tx.Exec(ctx, m.DownSQL); err != nil {
					return err
				}
				return finish(ctx, tx)
			})
		}
		r.DurationMs = int(time.Since(start).Milliseconds())
		if runErr != nil {
			r.Error, r.Line = describe(m.DownSQL, runErr)
			if r.Line == 0 && !m.DownNoTx {
				r.Line = e.locate(ctx, m.DownSQL, r.Error)
			}
			e.recordFailure(ctx, m, "down", r.Error, r.DurationMs)
			results = append(results, r)
			return results, errors.New(r.Error)
		}
		results = append(results, r)
	}
	return results, nil
}

// Goto moves the database to exactly version target (0 means before everything).
func (e *Engine) Goto(ctx context.Context, target int64, o Options) ([]Result, error) {
	ap, err := e.loadApplied(ctx)
	if err != nil {
		return nil, err
	}
	var current int64
	for v := range ap {
		current = max(current, v)
	}
	if target > 0 {
		if _, ok := e.set.ByVersion(target); !ok {
			return nil, fmt.Errorf("version %d does not exist", target)
		}
	}
	switch {
	case target == current:
		return nil, ErrNothing
	case target > current:
		o.Target = target
		return e.Up(ctx, o)
	default:
		o.Target = target
		if target == 0 {
			o.Steps = len(ap)
		}
		return e.Down(ctx, o)
	}
}

// Baseline records migrations up to version as applied without running them,
// for adopting a database whose schema already exists.
func (e *Engine) Baseline(ctx context.Context, version int64) error {
	release, err := e.acquire(ctx, 10*time.Second)
	if err != nil {
		return err
	}
	defer release()
	if _, ok := e.set.ByVersion(version); !ok {
		return fmt.Errorf("version %d does not exist", version)
	}
	if err := e.ensureTables(ctx); err != nil {
		return err
	}
	return e.inTx(ctx, func(tx pgx.Tx) error {
		for _, m := range e.set {
			if m.Version > version {
				break
			}
			if _, err := tx.Exec(ctx, `INSERT INTO schema_migrations (version, name, checksum) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, m.Version, m.Name, m.Checksum); err != nil {
				return err
			}
		}
		return nil
	})
}

// History returns recent runs, newest first.
func (e *Engine) History(ctx context.Context, limit int) ([]HistoryEntry, error) {
	has, err := e.hasTables(ctx)
	if err != nil || !has {
		return []HistoryEntry{}, err
	}
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := e.conn.Query(ctx, `SELECT id, version, name, direction, success, error, started_at, duration_ms, applied_by FROM migration_history ORDER BY id DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []HistoryEntry{}
	for rows.Next() {
		var h HistoryEntry
		if err := rows.Scan(&h.ID, &h.Version, &h.Name, &h.Direction, &h.Success, &h.Error, &h.StartedAt, &h.DurationMs, &h.AppliedBy); err != nil {
			return nil, err
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

// locate finds which statement of a failed script raised the error. PostgreSQL
// reports a position only for syntax and name errors; for runtime errors (such
// as division by zero) it says nothing. So the script is replayed statement by
// statement in a transaction that is always rolled back. The line is trusted
// only when the replay fails with the very same message.
func (e *Engine) locate(ctx context.Context, sql, wantMsg string) int {
	// Timeouts say nothing about which statement was at fault, and replaying one
	// would just wait on the same lock again.
	if strings.Contains(wantMsg, "timeout") || strings.Contains(wantMsg, "canceling statement") {
		return 0
	}
	tx, err := e.conn.Begin(ctx)
	if err != nil {
		return 0
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// The replay must never hang or hold locks for long.
	if _, err := tx.Exec(ctx, "SET LOCAL lock_timeout = '1s'; SET LOCAL statement_timeout = '5s'"); err != nil {
		return 0
	}
	for _, st := range sqlsplit.Split(sql) {
		if _, err := tx.Exec(ctx, st.SQL); err != nil {
			msg, _ := describe(sql, err)
			if msg == wantMsg {
				return st.Line
			}
			return 0
		}
	}
	return 0
}

// describe turns a database error into a message and, when PostgreSQL gives a
// position, the line of the migration where it happened.
func describe(sql string, err error) (string, int) {
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		line := 0
		if pg.Position > 0 && int(pg.Position) <= len(sql)+1 {
			line = strings.Count(sql[:pg.Position-1], "\n") + 1
		}
		msg := pg.Message
		if pg.Detail != "" {
			msg += " (" + pg.Detail + ")"
		}
		return msg, line
	}
	return err.Error(), 0
}
