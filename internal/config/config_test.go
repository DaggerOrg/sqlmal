package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func write(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "sqlmal.json")
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestLoadResolvesRelativeDirectoriesFromTheConfigFile(t *testing.T) {
	p := write(t, `{"databases":[{"name":"shop","dsn_env":"SHOP_URL","migrations":"./migrations"}]}`)
	c, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	if c.Databases[0].Migrations != filepath.Join(filepath.Dir(p), "migrations") {
		t.Fatalf("got %s", c.Databases[0].Migrations)
	}
}

func TestLoadRejectsBadConfigs(t *testing.T) {
	cases := map[string]string{
		"no databases":  `{"databases":[]}`,
		"bad name":      `{"databases":[{"name":"My DB","dsn_env":"X","migrations":"m"}]}`,
		"duplicate":     `{"databases":[{"name":"a","dsn_env":"X","migrations":"m"},{"name":"a","dsn_env":"X","migrations":"m"}]}`,
		"no dsn":        `{"databases":[{"name":"a","migrations":"m"}]}`,
		"no directory":  `{"databases":[{"name":"a","dsn_env":"X"}]}`,
		"unknown field": `{"databases":[{"name":"a","dsn_env":"X","migrations":"m","passwrd":"oops"}]}`,
		"not json":      `databases: []`,
	}
	for name, body := range cases {
		if _, err := Load(write(t, body)); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
}

func TestResolveDSNPrefersTheEnvironment(t *testing.T) {
	d := Database{Name: "a", DSNEnv: "MS_TEST_DSN", DSN: "postgres://fallback/db"}
	t.Setenv("MS_TEST_DSN", "postgres://from-env/db")
	if got, _ := d.ResolveDSN(); got != "postgres://from-env/db" {
		t.Fatalf("got %s", got)
	}
	t.Setenv("MS_TEST_DSN", "")
	if got, _ := d.ResolveDSN(); got != "postgres://fallback/db" {
		t.Fatalf("fallback: %s", got)
	}
	d.DSN = ""
	if _, err := d.ResolveDSN(); err == nil || !strings.Contains(err.Error(), "MS_TEST_DSN") {
		t.Fatalf("an unset variable must be named in the error: %v", err)
	}
}
