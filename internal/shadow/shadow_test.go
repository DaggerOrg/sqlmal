package shadow

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/Stephen-SMH/migrate-studio/internal/engine"
	"github.com/Stephen-SMH/migrate-studio/internal/migration"
	"github.com/Stephen-SMH/migrate-studio/internal/testdb"
)

type fx struct {
	t   *testing.T
	dir string
}

func (f fx) file(name, body string) {
	f.t.Helper()
	if err := os.WriteFile(filepath.Join(f.dir, name), []byte(body), 0o644); err != nil {
		f.t.Fatal(err)
	}
}

func (f fx) load() migration.Set {
	f.t.Helper()
	s, err := migration.Load(f.dir)
	if err != nil {
		f.t.Fatal(err)
	}
	return s
}

func base(t *testing.T) fx {
	f := fx{t, t.TempDir()}
	f.file("0001_users.up.sql", "CREATE TABLE users (id serial PRIMARY KEY, email text NOT NULL);")
	f.file("0001_users.down.sql", "DROP TABLE users;")
	f.file("0002_orders.up.sql", "CREATE TABLE orders (id serial PRIMARY KEY, user_id int NOT NULL REFERENCES users(id));")
	f.file("0002_orders.down.sql", "DROP TABLE orders;")
	f.file("0003_idx.up.sql", "CREATE INDEX idx_orders_user ON orders (user_id);\nALTER TABLE users ADD COLUMN name text;")
	f.file("0003_idx.down.sql", "ALTER TABLE users DROP COLUMN name;\nDROP INDEX idx_orders_user;")
	return f
}

func admin(t *testing.T) string {
	// testdb.New creates a database; its server is the one we want scratch databases on.
	return testdb.WithDatabase(testdb.AdminDSN(), "postgres")
}

func TestTimelineShowsTheSchemaAfterEachMigration(t *testing.T) {
	f := base(t)
	testdb.New(t) // skips the test when there is no PostgreSQL
	tl, err := BuildTimeline(context.Background(), admin(t), f.load())
	if err != nil {
		t.Fatal(err)
	}
	if len(tl.Steps) != 3 || tl.Failed != 0 {
		t.Fatalf("steps: %+v", tl.Steps)
	}
	if got := tl.Steps[0].Changes; len(got) != 1 || got[0].Kind != "table_added" || got[0].Table != "users" {
		t.Errorf("step 1: %+v", got)
	}
	if len(tl.Steps[0].Schema.Tables) != 1 || len(tl.Steps[1].Schema.Tables) != 2 {
		t.Errorf("each step carries the whole schema at that point")
	}
	kinds := ""
	for _, c := range tl.Steps[2].Changes {
		kinds += string(c.Kind) + " "
	}
	if !strings.Contains(kinds, "index_added") || !strings.Contains(kinds, "column_added") {
		t.Errorf("step 3: %s", kinds)
	}
	if !tl.AllReversible {
		t.Errorf("every down here undoes its up: %+v", tl.Steps)
	}
	for _, s := range tl.Steps {
		if s.Reversible == nil || !*s.Reversible {
			t.Errorf("step %d reversible = %v", s.Version, s.Reversible)
		}
	}
}

func TestTimelineCatchesADownThatDoesNotUndoItsUp(t *testing.T) {
	f := base(t)
	testdb.New(t)
	f.file("0003_idx.down.sql", "ALTER TABLE users DROP COLUMN name;") // forgets to drop the index
	tl, err := BuildTimeline(context.Background(), admin(t), f.load())
	if err != nil {
		t.Fatal(err)
	}
	s := tl.Steps[2]
	if s.Reversible == nil || *s.Reversible || tl.AllReversible {
		t.Fatalf("this down is wrong: %+v", s)
	}
	if len(s.ReverseDiff) != 1 || s.ReverseDiff[0].Kind != "index_added" || s.ReverseDiff[0].Object != "idx_orders_user" {
		t.Fatalf("the leftover index should be named: %+v", s.ReverseDiff)
	}
	// The earlier migrations are still checked and fine.
	if s2 := tl.Steps[1]; s2.Reversible == nil {
		t.Logf("note: step 2 is checked after step 3's rollback left an index behind: %+v", s2.ReverseDiff)
	}
}

func TestTimelineReportsMissingDownsAndFailingUps(t *testing.T) {
	f := base(t)
	testdb.New(t)
	os.Remove(filepath.Join(f.dir, "0002_orders.down.sql"))
	tl, err := BuildTimeline(context.Background(), admin(t), f.load())
	if err != nil {
		t.Fatal(err)
	}
	if tl.Steps[1].Reversible != nil || !strings.Contains(tl.Steps[1].ReverseNote, "no down") || tl.AllReversible {
		t.Fatalf("unknown reversibility must be reported as unknown: %+v", tl.Steps[1])
	}

	g := base(t)
	g.file("0002_orders.up.sql", "CREATE TABLE orders (id serial PRIMARY KEY);\nSELECT 1/0;")
	tl, err = BuildTimeline(context.Background(), admin(t), g.load())
	if err != nil {
		t.Fatal(err)
	}
	if tl.Failed != 2 || len(tl.Steps) != 2 || !strings.Contains(tl.Steps[1].Error, "division by zero") || !strings.Contains(tl.Steps[1].Error, "line 2") {
		t.Fatalf("a failing up stops the timeline and says where: %+v", tl.Steps)
	}
	if len(tl.Steps[1].Schema.Tables) != 1 {
		t.Error("the failed step shows the schema as it was before")
	}
}

func TestTimelineLeavesNoScratchDatabaseBehind(t *testing.T) {
	f := base(t)
	testdb.New(t)
	ctx := context.Background()
	if _, err := BuildTimeline(ctx, admin(t), f.load()); err != nil {
		t.Fatal(err)
	}
	c, err := pgx.Connect(ctx, admin(t))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close(ctx)
	var n int
	if err := c.QueryRow(ctx, `SELECT count(*) FROM pg_database WHERE datname LIKE 'ms_shadow_%'`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("scratch databases left behind: %d %v", n, err)
	}
}

func TestDriftDetectsHandMadeChanges(t *testing.T) {
	f := base(t)
	live := testdb.New(t)
	set := f.load()
	ctx := context.Background()
	e, _ := engine.Open(ctx, live, set)
	if _, err := e.Up(ctx, engine.Options{}); err != nil {
		t.Fatal(err)
	}
	e.Close(ctx)

	rep, err := Drift(ctx, live, admin(t), set)
	if err != nil || !rep.InSync || rep.Applied != 3 {
		t.Fatalf("a database that only ran the migrations is in sync: %+v %v", rep, err)
	}

	c, _ := pgx.Connect(ctx, live)
	if _, err := c.Exec(ctx, `ALTER TABLE users ADD COLUMN hotfix int; CREATE INDEX idx_hand_made ON orders (id); DROP INDEX idx_orders_user;`); err != nil {
		t.Fatal(err)
	}
	c.Close(ctx)
	rep, err = Drift(ctx, live, admin(t), set)
	if err != nil || rep.InSync {
		t.Fatalf("drift must be found: %+v %v", rep, err)
	}
	got := ""
	for _, ch := range rep.Changes {
		got += ch.String() + "; "
	}
	for _, w := range []string{"column_added users.hotfix", "index_added orders.idx_hand_made", "index_removed orders.idx_orders_user"} {
		if !strings.Contains(got, w) {
			t.Errorf("missing %q in %s", w, got)
		}
	}
}

func TestDriftOnlyExpectsTheMigrationsThatWereApplied(t *testing.T) {
	f := base(t)
	live := testdb.New(t)
	set := f.load()
	ctx := context.Background()
	e, _ := engine.Open(ctx, live, set)
	if _, err := e.Up(ctx, engine.Options{Steps: 2}); err != nil {
		t.Fatal(err)
	}
	e.Close(ctx)
	rep, err := Drift(ctx, live, admin(t), set)
	if err != nil || !rep.InSync || rep.Applied != 2 {
		t.Fatalf("two of three applied is still in sync: %+v %v", rep, err)
	}
}

func TestDriftExplainsWhenItCannotCompare(t *testing.T) {
	f := base(t)
	live := testdb.New(t)
	set := f.load()
	ctx := context.Background()
	e, _ := engine.Open(ctx, live, set)
	e.Up(ctx, engine.Options{})
	e.Close(ctx)
	os.Remove(filepath.Join(f.dir, "0002_orders.up.sql"))
	os.Remove(filepath.Join(f.dir, "0002_orders.down.sql"))
	rep, err := Drift(ctx, live, admin(t), f.load())
	if err != nil || rep.Skipped == "" || !strings.Contains(rep.Skipped, "0002_orders") {
		t.Fatalf("expected an explanation: %+v %v", rep, err)
	}
}

func TestAdminDSN(t *testing.T) {
	got, err := AdminDSN("postgres://u:p@db.example:5432/shop?sslmode=require")
	if err != nil || got != "postgres://u:p@db.example:5432/postgres?sslmode=require" {
		t.Fatalf("got %q %v", got, err)
	}
	if _, err := AdminDSN("host=localhost dbname=shop"); err == nil {
		t.Fatal("a key=value DSN cannot be rewritten and must say so")
	}
}
