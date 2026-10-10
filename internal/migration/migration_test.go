package migration

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func write(t *testing.T, dir, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestLoadSortsAndPairsUpAndDown(t *testing.T) {
	d := t.TempDir()
	write(t, d, "0010_add_index.up.sql", "CREATE INDEX i ON t(a);")
	write(t, d, "0002_create_t.up.sql", "CREATE TABLE t (a int);")
	write(t, d, "0002_create_t.down.sql", "DROP TABLE t;")
	write(t, d, "0010_add_index.down.sql", "-- nothing to do yet\n")
	write(t, d, "README.md", "ignored")
	set, err := Load(d)
	if err != nil {
		t.Fatal(err)
	}
	if len(set) != 2 || set[0].Version != 2 || set[1].Version != 10 {
		t.Fatalf("order: %+v", set)
	}
	if !set[0].HasDown || set[1].HasDown {
		t.Fatalf("a down file with only comments is not a real down: %+v", set)
	}
}

func TestLoadRejectsBrokenDirectories(t *testing.T) {
	cases := map[string]func(d string){
		"bad name":        func(d string) { write(t, d, "create_users.sql", "SELECT 1;") },
		"down only":       func(d string) { write(t, d, "0001_a.down.sql", "SELECT 1;") },
		"name mismatch":   func(d string) { write(t, d, "0001_a.up.sql", "SELECT 1;"); write(t, d, "0001_b.down.sql", "SELECT 1;") },
		"empty up":        func(d string) { write(t, d, "0001_a.up.sql", "-- todo\n") },
		"two up files":    func(d string) { write(t, d, "0001_a.up.sql", "SELECT 1;"); write(t, d, "00001_a.up.sql", "SELECT 1;") },
		"missing dir":     func(d string) { os.RemoveAll(d) },
		"upper extension": func(d string) { write(t, d, "0001_a.UP.sql", "SELECT 1;") },
	}
	for name, setup := range cases {
		d := t.TempDir()
		setup(d)
		if _, err := Load(d); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
}

func TestChecksumIgnoresLineEndingsAndTrailingBlankLines(t *testing.T) {
	a := checksum("CREATE TABLE t (a int);\n")
	b := checksum(normalizeNewlines("CREATE TABLE t (a int);\r\n\r\n\r\n"))
	if a != b {
		t.Fatal("a Windows checkout must not look like an edited migration")
	}
	if a == checksum("CREATE TABLE t (b int);\n") {
		t.Fatal("a real edit must change the checksum")
	}
}

func TestNoTransactionDirectiveOnlyCountsInTheLeadingComments(t *testing.T) {
	if !hasNoTx("-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY i ON t(a);") {
		t.Fatal("directive missed")
	}
	if !hasNoTx("\n-- note\n-- migrate:no-transaction\nSELECT 1;") {
		t.Fatal("directive after other comments missed")
	}
	if hasNoTx("SELECT 1;\n-- migrate:no-transaction\n") {
		t.Fatal("a directive after code must be ignored")
	}
}

func TestNextVersionAndCreate(t *testing.T) {
	now := time.Date(2026, 10, 10, 12, 0, 0, 0, time.UTC)
	d := filepath.Join(t.TempDir(), "migrations")
	up, down, err := Create(d, "Create Users", now)
	if err != nil || !strings.HasSuffix(up, "0001_create_users.up.sql") || !strings.HasSuffix(down, "0001_create_users.down.sql") {
		t.Fatalf("first: %s %s %v", up, down, err)
	}
	write(t, d, "0001_create_users.up.sql", "CREATE TABLE users (id int);")
	up, _, err = Create(d, "add_email", now)
	if err != nil || !strings.HasSuffix(up, "0002_add_email.up.sql") {
		t.Fatalf("second: %s %v", up, err)
	}
	// A timestamped directory keeps getting timestamps.
	d2 := t.TempDir()
	write(t, d2, "20260101000000_a.up.sql", "SELECT 1;")
	up, _, _ = Create(d2, "b", now)
	if !strings.Contains(up, "20261010120000_b.up.sql") {
		t.Fatalf("timestamp: %s", up)
	}
	if _, _, err := Create(d, "Bad-Name!", now); err == nil {
		t.Fatal("an unsafe name was accepted")
	}
}

func TestIrreversibleDirectiveMarksAMigrationOneWay(t *testing.T) {
	d := t.TempDir()
	write(t, d, "0001_a.up.sql", "ALTER TYPE s ADD VALUE 'x';")
	write(t, d, "0001_a.down.sql", "-- migrate:irreversible\n-- cannot remove an enum value\n")
	write(t, d, "0002_b.up.sql", "SELECT 1;")
	write(t, d, "0002_b.down.sql", "-- todo\n")
	set, err := Load(d)
	if err != nil {
		t.Fatal(err)
	}
	if !set[0].OneWay || set[0].HasDown {
		t.Fatalf("0001 is one-way by design: %+v", set[0])
	}
	if set[1].OneWay {
		t.Fatalf("an empty down is not a decision: %+v", set[1])
	}
}
