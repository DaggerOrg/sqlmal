package engine

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Stephen-SMH/migrate-studio/internal/migration"
	"github.com/Stephen-SMH/migrate-studio/internal/testdb"
)

type fixture struct {
	t   *testing.T
	ctx context.Context
	dsn string
	dir string
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	return &fixture{t: t, ctx: context.Background(), dsn: testdb.New(t), dir: t.TempDir()}
}

func (f *fixture) file(name, body string) {
	f.t.Helper()
	if err := os.WriteFile(filepath.Join(f.dir, name), []byte(body), 0o644); err != nil {
		f.t.Fatal(err)
	}
}

// base writes three migrations: users, orders (references users), an index.
func (f *fixture) base() {
	f.file("0001_users.up.sql", "CREATE TABLE users (id serial PRIMARY KEY, email text NOT NULL);")
	f.file("0001_users.down.sql", "DROP TABLE users;")
	f.file("0002_orders.up.sql", "CREATE TABLE orders (id serial PRIMARY KEY, user_id int NOT NULL REFERENCES users(id));")
	f.file("0002_orders.down.sql", "DROP TABLE orders;")
	f.file("0003_idx.up.sql", "CREATE INDEX idx_orders_user ON orders (user_id);")
	f.file("0003_idx.down.sql", "DROP INDEX idx_orders_user;")
}

func (f *fixture) open() *Engine {
	f.t.Helper()
	set, err := migration.Load(f.dir)
	if err != nil {
		f.t.Fatal(err)
	}
	e, err := Open(f.ctx, f.dsn, set)
	if err != nil {
		f.t.Fatal(err)
	}
	f.t.Cleanup(func() { e.Close(context.Background()) })
	return e
}

func (f *fixture) query(sql string, args ...any) int {
	f.t.Helper()
	c, err := pgx.Connect(f.ctx, f.dsn)
	if err != nil {
		f.t.Fatal(err)
	}
	defer c.Close(f.ctx)
	var n int
	if err := c.QueryRow(f.ctx, sql, args...).Scan(&n); err != nil {
		f.t.Fatal(err)
	}
	return n
}

func (f *fixture) tableExists(name string) bool {
	return f.query(`SELECT count(*) FROM information_schema.tables WHERE table_name = $1`, name) == 1
}

func states(rows []Row) string {
	var s []string
	for _, r := range rows {
		s = append(s, string(r.State))
	}
	return strings.Join(s, ",")
}

func TestUpAppliesEverythingInOrderAndRecordsIt(t *testing.T) {
	f := newFixture(t)
	f.base()
	e := f.open()
	res, err := e.Up(f.ctx, Options{})
	if err != nil || len(res) != 3 {
		t.Fatalf("up: %+v %v", res, err)
	}
	for _, tbl := range []string{"users", "orders"} {
		if !f.tableExists(tbl) {
			t.Errorf("%s was not created", tbl)
		}
	}
	rows, _ := e.Status(f.ctx)
	if states(rows) != "applied,applied,applied" {
		t.Fatalf("status: %s", states(rows))
	}
	hist, _ := e.History(f.ctx, 10)
	if len(hist) != 3 || hist[0].Version != 3 || hist[2].Version != 1 || !hist[0].Success || hist[0].Direction != "up" {
		t.Fatalf("history: %+v", hist)
	}
	if _, err := e.Up(f.ctx, Options{}); !errors.Is(err, ErrNothing) {
		t.Fatalf("a second up has nothing to do, got %v", err)
	}
}

func TestAFailingMigrationLeavesNoTraceAndStopsTheRun(t *testing.T) {
	f := newFixture(t)
	f.base()
	f.file("0002_orders.up.sql", "CREATE TABLE orders (id serial PRIMARY KEY);\n\nCREATE TABLE half_done (id int);\nSELECT 1/0;")
	e := f.open()
	res, err := e.Up(f.ctx, Options{})
	if err == nil || len(res) != 2 {
		t.Fatalf("expected the second migration to fail: %+v %v", res, err)
	}
	last := res[1]
	if !strings.Contains(last.Error, "division by zero") || last.Line != 4 {
		t.Fatalf("the error should say what and where: %+v", last)
	}
	if f.tableExists("orders") || f.tableExists("half_done") {
		t.Fatal("a failed migration must roll back completely")
	}
	if !f.tableExists("users") {
		t.Fatal("the migration before it stays applied")
	}
	rows, _ := e.Status(f.ctx)
	if states(rows) != "applied,pending,pending" {
		t.Fatalf("status: %s", states(rows))
	}
	hist, _ := e.History(f.ctx, 10)
	if len(hist) != 2 || hist[0].Success || hist[0].Version != 2 || !strings.Contains(hist[0].Error, "division by zero") {
		t.Fatalf("the failure is recorded: %+v", hist)
	}
}

func TestDownTargetAndGoto(t *testing.T) {
	f := newFixture(t)
	f.base()
	e := f.open()
	if _, err := e.Up(f.ctx, Options{}); err != nil {
		t.Fatal(err)
	}
	if res, err := e.Down(f.ctx, Options{}); err != nil || len(res) != 1 || res[0].Version != 3 {
		t.Fatalf("down defaults to one step: %+v %v", res, err)
	}
	if res, err := e.Goto(f.ctx, 1, Options{}); err != nil || len(res) != 1 || res[0].Version != 2 || f.tableExists("orders") {
		t.Fatalf("goto 1: %+v %v", res, err)
	}
	if res, err := e.Goto(f.ctx, 3, Options{}); err != nil || len(res) != 2 || !f.tableExists("orders") {
		t.Fatalf("goto 3: %+v %v", res, err)
	}
	if _, err := e.Goto(f.ctx, 3, Options{}); !errors.Is(err, ErrNothing) {
		t.Fatalf("goto the current version: %v", err)
	}
	if _, err := e.Goto(f.ctx, 99, Options{}); err == nil {
		t.Fatal("goto a version that does not exist must fail")
	}
	if res, err := e.Goto(f.ctx, 0, Options{}); err != nil || len(res) != 3 || f.tableExists("users") {
		t.Fatalf("goto 0 rolls everything back: %+v %v", res, err)
	}
	if res, err := e.Up(f.ctx, Options{Steps: 1}); err != nil || len(res) != 1 {
		t.Fatalf("steps: %+v %v", res, err)
	}
}

func TestEditingAnAppliedMigrationIsDetectedAndBlocks(t *testing.T) {
	f := newFixture(t)
	f.base()
	e := f.open()
	if _, err := e.Up(f.ctx, Options{Steps: 2}); err != nil {
		t.Fatal(err)
	}
	f.file("0001_users.up.sql", "CREATE TABLE users (id serial PRIMARY KEY, email text NOT NULL, extra int);")
	e2 := f.open()
	rows, _ := e2.Status(f.ctx)
	if states(rows) != "modified,applied,pending" {
		t.Fatalf("status: %s", states(rows))
	}
	if rows[0].Checksum == rows[0].AppliedChecksum {
		t.Fatal("the two checksums should differ")
	}
	if _, err := e2.Up(f.ctx, Options{}); !errors.Is(err, ErrDrifted) || !strings.Contains(err.Error(), "0001_users was edited") {
		t.Fatalf("up must refuse: %v", err)
	}
	if _, err := e2.Down(f.ctx, Options{}); !errors.Is(err, ErrDrifted) {
		t.Fatalf("down must refuse: %v", err)
	}
	if _, err := e2.Up(f.ctx, Options{Force: true}); err != nil {
		t.Fatalf("force overrides: %v", err)
	}
}

func TestAMissingFileIsReported(t *testing.T) {
	f := newFixture(t)
	f.base()
	e := f.open()
	if _, err := e.Up(f.ctx, Options{}); err != nil {
		t.Fatal(err)
	}
	os.Remove(filepath.Join(f.dir, "0002_orders.up.sql"))
	os.Remove(filepath.Join(f.dir, "0002_orders.down.sql"))
	e2 := f.open()
	rows, _ := e2.Status(f.ctx)
	if states(rows) != "applied,missing,applied" || rows[1].Name != "orders" {
		t.Fatalf("status: %s %+v", states(rows), rows)
	}
	if _, err := e2.Up(f.ctx, Options{}); !errors.Is(err, ErrDrifted) {
		t.Fatalf("a missing file blocks: %v", err)
	}
}

func TestOutOfOrderMigrationsAreRefusedUnlessAllowed(t *testing.T) {
	f := newFixture(t)
	f.file("0001_a.up.sql", "CREATE TABLE a (id int);")
	f.file("0003_c.up.sql", "CREATE TABLE c (id int);")
	e := f.open()
	if _, err := e.Up(f.ctx, Options{}); err != nil {
		t.Fatal(err)
	}
	f.file("0002_b.up.sql", "CREATE TABLE b (id int);") // a teammate's branch merged late
	e2 := f.open()
	rows, _ := e2.Status(f.ctx)
	if !rows[1].OutOfOrder || rows[1].State != Pending {
		t.Fatalf("0002 should be flagged out of order: %+v", rows)
	}
	if _, err := e2.Up(f.ctx, Options{}); !errors.Is(err, ErrOutOfSeq) {
		t.Fatalf("expected refusal: %v", err)
	}
	if res, err := e2.Up(f.ctx, Options{AllowOutOfOrder: true}); err != nil || len(res) != 1 || !f.tableExists("b") {
		t.Fatalf("allowed: %+v %v", res, err)
	}
}

func TestOnlyOneMigratorRunsAtATime(t *testing.T) {
	f := newFixture(t)
	f.base()
	a := f.open()
	if err := a.lock(f.ctx, time.Second); err != nil {
		t.Fatal(err)
	}
	b := f.open()
	start := time.Now()
	if _, err := b.Up(f.ctx, Options{LockWait: 400 * time.Millisecond}); !errors.Is(err, ErrLocked) {
		t.Fatalf("expected ErrLocked, got %v", err)
	}
	if time.Since(start) > 3*time.Second {
		t.Fatal("waiting for the lock must be bounded")
	}
	if f.tableExists("users") {
		t.Fatal("nothing may run without the lock")
	}
	a.Close(f.ctx) // releases the lock
	b2 := f.open()
	if _, err := b2.Up(f.ctx, Options{}); err != nil {
		t.Fatalf("after release: %v", err)
	}
}

func TestConcurrentRunsNeverApplyTheSameMigrationTwice(t *testing.T) {
	f := newFixture(t)
	f.base()
	var wg sync.WaitGroup
	var mu sync.Mutex
	applied := 0
	for i := 0; i < 4; i++ {
		e := f.open()
		wg.Add(1)
		go func() {
			defer wg.Done()
			res, err := e.Up(f.ctx, Options{LockWait: 10 * time.Second})
			if err != nil && !errors.Is(err, ErrNothing) {
				t.Errorf("unexpected: %v", err)
			}
			mu.Lock()
			applied += len(res)
			mu.Unlock()
		}()
	}
	wg.Wait()
	if applied != 3 || f.query(`SELECT count(*) FROM schema_migrations`) != 3 {
		t.Fatalf("each migration must be applied exactly once, applied=%d", applied)
	}
}

func TestNoTransactionMigrationsRunConcurrentIndexes(t *testing.T) {
	f := newFixture(t)
	f.base()
	f.file("0003_idx.up.sql", "-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY idx_orders_user ON orders (user_id);\nCREATE INDEX CONCURRENTLY idx_orders_id ON orders (id, user_id);")
	e := f.open()
	if res, err := e.Up(f.ctx, Options{}); err != nil || len(res) != 3 {
		t.Fatalf("no-tx up: %+v %v", res, err)
	}
	if f.query(`SELECT count(*) FROM pg_indexes WHERE indexname IN ('idx_orders_user','idx_orders_id')`) != 2 {
		t.Fatal("both concurrent indexes should exist")
	}
	// Forgetting the directive is an error PostgreSQL reports, and it rolls back cleanly.
	f2 := newFixture(t)
	f2.base()
	f2.file("0003_idx.up.sql", "CREATE INDEX CONCURRENTLY idx_orders_user ON orders (user_id);")
	e2 := f2.open()
	if _, err := e2.Up(f2.ctx, Options{}); err == nil || !strings.Contains(err.Error(), "CONCURRENTLY") {
		t.Fatalf("without the directive it must fail: %v", err)
	}
}

func TestDryRunChangesNothing(t *testing.T) {
	f := newFixture(t)
	f.base()
	e := f.open()
	res, err := e.Up(f.ctx, Options{DryRun: true})
	if err != nil || len(res) != 3 || !res[0].DryRun {
		t.Fatalf("dry run: %+v %v", res, err)
	}
	if f.tableExists("users") || f.tableExists("schema_migrations") || f.tableExists("migration_history") {
		t.Fatal("a dry run must leave no tables and no tracking rows behind")
	}
	// A broken migration is caught by the dry run, with its line.
	f.file("0003_idx.up.sql", "CREATE INDEX idx ON orders (no_such_column);")
	e2 := f.open()
	res, err = e2.Up(f.ctx, Options{DryRun: true})
	if err == nil || res[len(res)-1].Version != 3 || !strings.Contains(res[len(res)-1].Error, "no_such_column") {
		t.Fatalf("dry run should find the error: %+v %v", res, err)
	}
	// Dry-running a rollback also changes nothing.
	f.file("0003_idx.up.sql", "CREATE INDEX idx_orders_user ON orders (user_id);")
	e3 := f.open()
	if _, err := e3.Up(f.ctx, Options{}); err != nil {
		t.Fatal(err)
	}
	if _, err := e3.Down(f.ctx, Options{DryRun: true, Steps: 3}); err != nil {
		t.Fatal(err)
	}
	if !f.tableExists("users") || f.query(`SELECT count(*) FROM schema_migrations`) != 3 {
		t.Fatal("a dry-run rollback must not roll anything back")
	}
}

func TestLockTimeoutStopsAMigrationFromBlockingTheApp(t *testing.T) {
	f := newFixture(t)
	f.file("0001_users.up.sql", "CREATE TABLE users (id int);")
	f.file("0002_alter.up.sql", "ALTER TABLE users ADD COLUMN name text;")
	e := f.open()
	if _, err := e.Up(f.ctx, Options{Steps: 1}); err != nil {
		t.Fatal(err)
	}
	// Another session holds a lock on the table, like a long-running query.
	holder, err := pgx.Connect(f.ctx, f.dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Close(f.ctx)
	tx, _ := holder.Begin(f.ctx)
	if _, err := tx.Exec(f.ctx, `LOCK TABLE users IN ACCESS EXCLUSIVE MODE`); err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(f.ctx)

	start := time.Now()
	_, err = e.Up(f.ctx, Options{LockTimeout: 300 * time.Millisecond})
	if err == nil || !strings.Contains(err.Error(), "lock timeout") {
		t.Fatalf("expected a lock timeout, got %v", err)
	}
	if time.Since(start) > 5*time.Second {
		t.Fatal("the migration must give up quickly instead of waiting forever")
	}
}

func TestStatementTimeout(t *testing.T) {
	f := newFixture(t)
	f.file("0001_slow.up.sql", "SELECT pg_sleep(5);")
	e := f.open()
	start := time.Now()
	_, err := e.Up(f.ctx, Options{StatementTimeout: 300 * time.Millisecond})
	if err == nil || !strings.Contains(err.Error(), "statement timeout") || time.Since(start) > 3*time.Second {
		t.Fatalf("expected a statement timeout: %v after %v", err, time.Since(start))
	}
}

func TestBaselineAdoptsAnExistingDatabase(t *testing.T) {
	f := newFixture(t)
	f.base()
	c, _ := pgx.Connect(f.ctx, f.dsn)
	if _, err := c.Exec(f.ctx, "CREATE TABLE users (id serial PRIMARY KEY, email text NOT NULL); CREATE TABLE orders (id serial PRIMARY KEY, user_id int NOT NULL REFERENCES users(id));"); err != nil {
		t.Fatal(err)
	}
	c.Close(f.ctx)
	e := f.open()
	if err := e.Baseline(f.ctx, 2); err != nil {
		t.Fatal(err)
	}
	rows, _ := e.Status(f.ctx)
	if states(rows) != "applied,applied,pending" {
		t.Fatalf("status: %s", states(rows))
	}
	if res, err := e.Up(f.ctx, Options{}); err != nil || len(res) != 1 || res[0].Version != 3 {
		t.Fatalf("only the newer migration runs: %+v %v", res, err)
	}
}

func TestDownNeedsADownFile(t *testing.T) {
	f := newFixture(t)
	f.file("0001_a.up.sql", "CREATE TABLE a (id int);")
	e := f.open()
	if _, err := e.Up(f.ctx, Options{}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.Down(f.ctx, Options{}); !errors.Is(err, ErrNoDown) {
		t.Fatalf("expected ErrNoDown: %v", err)
	}
	if !f.tableExists("a") {
		t.Fatal("nothing may be touched when a rollback cannot complete")
	}
}
