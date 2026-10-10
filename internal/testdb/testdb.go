// Package testdb gives integration tests a throwaway PostgreSQL database.
package testdb

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// AdminDSN is the server used to create throwaway databases.
func AdminDSN() string {
	if v := os.Getenv("MIGRATE_STUDIO_TEST_ADMIN_DSN"); v != "" {
		return v
	}
	return "postgres://studio:studio@127.0.0.1:54329/postgres"
}

// WithDatabase returns dsn pointing at another database on the same server.
func WithDatabase(dsn, name string) string {
	u, err := url.Parse(dsn)
	if err != nil {
		return dsn
	}
	u.Path = "/" + name
	return u.String()
}

// New creates an empty database and returns its DSN. It is dropped when the
// test ends. The test is skipped when no PostgreSQL server is reachable.
func New(t testing.TB) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	admin, err := pgx.Connect(ctx, AdminDSN())
	if err != nil {
		if os.Getenv("CI") != "" {
			t.Fatalf("no PostgreSQL for integration tests (%v); CI must provide one", err) // never skip silently in CI
		}
		t.Skipf("no PostgreSQL for integration tests (%v); run `make demo-db` or set MIGRATE_STUDIO_TEST_ADMIN_DSN", err)
	}
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	name := "ms_test_" + hex.EncodeToString(b)
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		admin.Close(ctx)
		t.Fatal(err)
	}
	t.Cleanup(func() {
		c, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		_, _ = admin.Exec(c, "DROP DATABASE IF EXISTS "+name+" WITH (FORCE)")
		admin.Close(c)
	})
	return WithDatabase(AdminDSN(), name)
}
