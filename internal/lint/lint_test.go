package lint

import (
	"testing"

	"github.com/Stephen-SMH/migrate-studio/internal/migration"
)

func up(sql string) migration.Migration {
	return migration.Migration{Version: 1, Name: "t", UpSQL: sql, HasDown: true, DownSQL: "SELECT 1;"}
}

func rules(f []Finding) map[string]int {
	m := map[string]int{}
	for _, x := range f {
		m[x.Rule]++
	}
	return m
}

func TestRulesFireOnTheRiskyPatterns(t *testing.T) {
	cases := []struct{ name, sql, rule string }{
		{"drop table", "DROP TABLE orders;", "L001"},
		{"drop column", "ALTER TABLE users DROP COLUMN legacy;", "L001"},
		{"type change", "ALTER TABLE users ALTER COLUMN age TYPE bigint;", "L002"},
		{"type change long form", "alter table users alter column age set data type bigint;", "L002"},
		{"not null no default", "ALTER TABLE users ADD COLUMN email text NOT NULL;", "L003"},
		{"set not null", "ALTER TABLE users ALTER COLUMN email SET NOT NULL;", "L010"},
		{"index without concurrently", "CREATE INDEX idx_u ON users (email);", "L004"},
		{"unique index", "CREATE UNIQUE INDEX idx_u ON users (email);", "L004"},
		{"fk without not valid", "ALTER TABLE orders ADD CONSTRAINT fk FOREIGN KEY (user_id) REFERENCES users(id);", "L005"},
		{"truncate", "TRUNCATE users;", "L006"},
		{"delete all", "DELETE FROM users;", "L006"},
		{"update all", "UPDATE users SET active = false;", "L006"},
		{"rename column", "ALTER TABLE users RENAME COLUMN a TO b;", "L008"},
		{"concurrently in a transaction", "CREATE INDEX CONCURRENTLY idx ON users (email);", "L009"},
	}
	for _, c := range cases {
		if rules(Migration(up(c.sql)))[c.rule] == 0 {
			t.Errorf("%s: rule %s did not fire for %q", c.name, c.rule, c.sql)
		}
	}
}

func TestSafePatternsStaySilent(t *testing.T) {
	safe := []string{
		"CREATE TABLE users (id serial PRIMARY KEY, email text NOT NULL);",
		"ALTER TABLE users ADD COLUMN age int;",
		"ALTER TABLE users ADD COLUMN active boolean NOT NULL DEFAULT true;",
		"ALTER TABLE users ADD COLUMN id2 serial NOT NULL;",
		"CREATE INDEX CONCURRENTLY idx ON users (email);", // fires L009 only without the directive, checked below
		"ALTER TABLE orders ADD CONSTRAINT fk FOREIGN KEY (user_id) REFERENCES users(id) NOT VALID;",
		"DELETE FROM users WHERE id = 1;",
		"UPDATE users SET active = false WHERE id = 1;",
		"INSERT INTO log (msg) VALUES ('DROP TABLE users; TRUNCATE x;');", // keywords inside a string
		"-- DROP TABLE users;\nSELECT 1;",                                 // keywords inside a comment
		"/* TRUNCATE users */ SELECT 1;",
	}
	for _, sql := range safe[:4] {
		if r := rules(Migration(up(sql))); len(r) != 0 {
			t.Errorf("%q should be clean, got %v", sql, r)
		}
	}
	for _, sql := range safe[5:] {
		if r := rules(Migration(up(sql))); len(r) != 0 {
			t.Errorf("%q should be clean, got %v", sql, r)
		}
	}
	m := up(safe[4])
	m.NoTx = true
	if r := rules(Migration(m)); len(r) != 0 {
		t.Errorf("CONCURRENTLY with the no-transaction directive is correct, got %v", r)
	}
}

func TestStatementsOnATableCreatedInTheSameFileAreNotRisky(t *testing.T) {
	sql := `CREATE TABLE orders (id serial PRIMARY KEY, user_id int);
CREATE INDEX idx_orders_user ON orders (user_id);
ALTER TABLE orders ADD COLUMN note text NOT NULL;
ALTER TABLE orders ADD CONSTRAINT fk FOREIGN KEY (user_id) REFERENCES users(id);`
	if r := rules(Migration(up(sql))); len(r) != 0 {
		t.Fatalf("a table that does not have rows yet cannot lock or fail: %v", r)
	}
}

func TestMissingDownAndOrdering(t *testing.T) {
	m := migration.Migration{Version: 1, Name: "t", UpSQL: "DROP TABLE a;\nTRUNCATE b;"}
	f := Migration(m)
	if rules(f)["L007"] != 1 {
		t.Fatalf("missing down not reported: %+v", f)
	}
	if f[0].File != "up" || f[0].Line > f[1].Line {
		t.Fatalf("findings are ordered by file then line: %+v", f)
	}
	e, w, _ := Counts(f)
	if e != 0 || w != 3 {
		t.Fatalf("counts: %d errors, %d warnings", e, w)
	}
}

func TestLineNumbersAreReported(t *testing.T) {
	f := Migration(up("-- header\n\nSELECT 1;\nDROP TABLE x;"))
	if len(f) == 0 || f[0].Line != 4 {
		t.Fatalf("expected line 4: %+v", f)
	}
}

func TestDropsInADownFileAreExpectedAndOneWayIsADecision(t *testing.T) {
	m := migration.Migration{Version: 1, Name: "t", UpSQL: "CREATE TABLE a (id int);", DownSQL: "DROP TABLE a;", HasDown: true}
	if r := rules(Migration(m)); len(r) != 0 {
		t.Fatalf("a down that drops what its up created is normal: %v", r)
	}
	oneWay := migration.Migration{Version: 1, Name: "t", UpSQL: "ALTER TYPE s ADD VALUE 'x';", DownSQL: "-- migrate:irreversible\n", OneWay: true}
	if r := rules(Migration(oneWay)); len(r) != 0 {
		t.Fatalf("a deliberate one-way migration must not be flagged: %v", r)
	}
	forgotten := migration.Migration{Version: 1, Name: "t", UpSQL: "ALTER TYPE s ADD VALUE 'x';"}
	if rules(Migration(forgotten))["L007"] != 1 {
		t.Fatal("a missing down that was not marked is still reported")
	}
}
