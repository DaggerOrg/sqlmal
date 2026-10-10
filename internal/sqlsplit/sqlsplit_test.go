package sqlsplit

import (
	"reflect"
	"testing"
)

func texts(in string) []string {
	var out []string
	for _, s := range Split(in) {
		out = append(out, s.SQL)
	}
	return out
}

func TestSplitBasics(t *testing.T) {
	got := texts("CREATE TABLE a (id int);\n\nCREATE TABLE b (id int);")
	want := []string{"CREATE TABLE a (id int)", "CREATE TABLE b (id int)"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q", got)
	}
}

func TestSemicolonsInsideQuotesAndCommentsDoNotSplit(t *testing.T) {
	cases := map[string][]string{
		"string":        {"INSERT INTO t VALUES ('a;b');SELECT 1"},
		"escaped quote": {"INSERT INTO t VALUES ('it''s; fine');SELECT 1"},
		"E string":      {`INSERT INTO t VALUES (E'a\';b');SELECT 1`},
		"identifier":    {`SELECT "weird;name" FROM t;SELECT 1`},
		"line comment":  {"SELECT 1 -- ; not a split\n;SELECT 2"},
		"block comment": {"SELECT 1 /* ; /* nested ; */ ; */ ;SELECT 2"},
		"dollar quote":  {"CREATE FUNCTION f() RETURNS void AS $$ BEGIN PERFORM 1; END; $$ LANGUAGE plpgsql;SELECT 2"},
		"tagged dollar": {"DO $body$ BEGIN PERFORM 1; END $body$;SELECT 2"},
	}
	for name, c := range cases {
		if n := len(Split(c[0])); n != 2 {
			t.Errorf("%s: want 2 statements, got %d: %q", name, n, texts(c[0]))
		}
	}
}

func TestLineNumbersPointAtTheStatementStart(t *testing.T) {
	got := Split("-- header\n\nCREATE TABLE a (\n  id int\n);\n\nDROP TABLE a;")
	if len(got) != 2 || got[0].Line != 3 || got[1].Line != 7 {
		t.Fatalf("lines: %+v", got)
	}
	// A dollar-quoted body spans lines and must not shift later statements.
	got = Split("SELECT $$a\nb\nc$$;\nSELECT 2;")
	if got[1].Line != 4 {
		t.Fatalf("after a multi-line dollar quote: %+v", got)
	}
}

func TestNormalizeBlanksStringsAndCollapsesWhitespace(t *testing.T) {
	got := Normalize("insert  into t\n values ('DROP TABLE x', 'it''s')")
	if got != "INSERT INTO T VALUES ('', '')" {
		t.Fatalf("got %q", got)
	}
}

func TestUnterminatedInputDoesNotHang(t *testing.T) {
	for _, in := range []string{"SELECT 'oops", `SELECT "oops`, "SELECT $$oops", "SELECT /* oops", "$"} {
		_ = Split(in) // must simply return
	}
}
