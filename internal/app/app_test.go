package app

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/Stephen-SMH/migrate-studio/internal/config"
	"github.com/Stephen-SMH/migrate-studio/internal/engine"
	"github.com/Stephen-SMH/migrate-studio/internal/testdb"
)

func setup(t *testing.T) (*App, string, string) {
	t.Helper()
	dsn := testdb.New(t)
	dir := t.TempDir()
	put := func(n, b string) { os.WriteFile(filepath.Join(dir, n), []byte(b), 0o644) }
	put("0001_users.up.sql", "CREATE TABLE users (id serial PRIMARY KEY, email text NOT NULL);")
	put("0001_users.down.sql", "DROP TABLE users;")
	put("0002_cleanup.up.sql", "ALTER TABLE users ADD COLUMN age int;\nDROP TABLE IF EXISTS nothing;")
	put("0002_cleanup.down.sql", "ALTER TABLE users DROP COLUMN age;")
	a, err := New(config.Single(dsn, dir))
	if err != nil {
		t.Fatal(err)
	}
	return a, dsn, dir
}

func TestMigrationsAreListedWithLintAndWithoutPaths(t *testing.T) {
	a, _, dir := setup(t)
	ms, err := a.Migrations("default")
	if err != nil || len(ms) != 2 {
		t.Fatalf("%+v %v", ms, err)
	}
	found := false
	for _, f := range ms[1].Lint {
		found = found || f.Rule == "L001"
	}
	if ms[0].Lint == nil || !found {
		t.Fatalf("lint: %+v / %+v", ms[0].Lint, ms[1].Lint)
	}
	b, _ := a.Bundle(context.Background(), "default")
	if raw := marshal(t, b); strings.Contains(raw, dir) {
		t.Fatal("the JSON must not leak the server's file paths")
	}
}

func TestUnknownDatabaseIsAnError(t *testing.T) {
	a, _, _ := setup(t)
	if _, err := a.Status(context.Background(), "nope"); err == nil || !strings.Contains(err.Error(), "unknown database") {
		t.Fatalf("got %v", err)
	}
}

func TestRunStatusAndTimelineCaching(t *testing.T) {
	a, _, dir := setup(t)
	ctx := context.Background()
	if _, err := a.Run(ctx, "default", "up", engine.Options{}); err != nil {
		t.Fatal(err)
	}
	rows, _ := a.Status(ctx, "default")
	if len(rows) != 2 || rows[1].State != engine.Applied {
		t.Fatalf("%+v", rows)
	}
	tl1, err := a.Timeline(ctx, "default")
	if err != nil || len(tl1.Steps) != 2 || !tl1.AllReversible {
		t.Fatalf("%+v %v", tl1, err)
	}
	// Same files, so the second call must come from the cache (the scratch database is not rebuilt).
	a.mu.Lock()
	n := len(a.cache)
	a.mu.Unlock()
	if _, err := a.Timeline(ctx, "default"); err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	n2 := len(a.cache)
	a.mu.Unlock()
	if n != 1 || n2 != 1 {
		t.Fatalf("one cache entry expected, got %d then %d", n, n2)
	}
	// Editing a file changes the fingerprint, so the timeline is recomputed.
	os.WriteFile(filepath.Join(dir, "0002_cleanup.down.sql"), []byte("-- nothing\n"), 0o644)
	tl3, err := a.Timeline(ctx, "default")
	if err != nil || tl3.AllReversible {
		t.Fatalf("a changed down must be re-checked: %+v %v", tl3.AllReversible, err)
	}
}

// The whole point of generate: a change made by hand becomes a migration, and
// once that migration exists the database and the files agree again.
func TestGenerateTurnsHandMadeChangesIntoAMigration(t *testing.T) {
	a, dsn, dir := setup(t)
	ctx := context.Background()
	if _, err := a.Run(ctx, "default", "up", engine.Options{}); err != nil {
		t.Fatal(err)
	}
	c, _ := pgx.Connect(ctx, dsn)
	if _, err := c.Exec(ctx, "ALTER TABLE users ADD COLUMN hotfix text; CREATE INDEX idx_hotfix ON users (hotfix);"); err != nil {
		t.Fatal(err)
	}
	c.Close(ctx)

	rep, _ := a.Drift(ctx, "default")
	if rep.InSync {
		t.Fatal("expected drift")
	}
	g, err := a.Generate(ctx, "default")
	if err != nil || !strings.Contains(g.Up.SQL, "ADD COLUMN hotfix text") || !strings.Contains(g.Down.SQL, "DROP COLUMN hotfix") {
		t.Fatalf("%+v %v", g, err)
	}
	path, err := a.Create("default", "adopt_hotfix", g.Up.SQL, g.Down.SQL)
	if err != nil || !strings.HasSuffix(path, "0003_adopt_hotfix.up.sql") {
		t.Fatalf("%s %v", path, err)
	}
	// The live database already has the change, so record the new migration as applied...
	if err := a.Baseline(ctx, "default", 3); err != nil {
		t.Fatal(err)
	}
	rep, err = a.Drift(ctx, "default")
	if err != nil || !rep.InSync {
		t.Fatalf("after adopting the change the database and the files agree: %+v %v", rep, err)
	}
	// ...and the same migration builds the same schema from scratch.
	tl, err := a.Timeline(ctx, "default")
	if err != nil || tl.Failed != 0 || !tl.AllReversible {
		t.Fatalf("the adopted migration must replay cleanly and be reversible: %+v %v", tl, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "0003_adopt_hotfix.down.sql")); err != nil {
		t.Fatal(err)
	}
}

func marshal(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
