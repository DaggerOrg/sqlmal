// Package app is the layer the CLI and the web server share: it knows the
// configured databases and offers each operation as one call.
package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"sort"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Stephen-SMH/migrate-studio/internal/config"
	"github.com/Stephen-SMH/migrate-studio/internal/diff"
	"github.com/Stephen-SMH/migrate-studio/internal/engine"
	"github.com/Stephen-SMH/migrate-studio/internal/introspect"
	"github.com/Stephen-SMH/migrate-studio/internal/lint"
	"github.com/Stephen-SMH/migrate-studio/internal/migration"
	"github.com/Stephen-SMH/migrate-studio/internal/shadow"
)

var ErrUnknownDB = errors.New("unknown database")

type App struct {
	dbs         map[string]config.Database
	order       []string
	shadowAdmin string

	mu    sync.Mutex
	cache map[string]cached
	locks map[string]*sync.Mutex
}

type cached struct {
	value   any
	expires time.Time
}

// New builds an App from a config.
func New(c config.Config) (*App, error) {
	a := &App{dbs: map[string]config.Database{}, cache: map[string]cached{}, locks: map[string]*sync.Mutex{}}
	for _, d := range c.Databases {
		a.dbs[d.Name] = d
		a.order = append(a.order, d.Name)
	}
	if c.ShadowAdminDSNEnv != "" {
		a.shadowAdmin = os.Getenv(c.ShadowAdminDSNEnv)
	}
	return a, nil
}

func (a *App) Names() []string { return append([]string(nil), a.order...) }

func (a *App) database(name string) (config.Database, string, error) {
	d, ok := a.dbs[name]
	if !ok {
		return d, "", fmt.Errorf("%w %q", ErrUnknownDB, name)
	}
	dsn, err := d.ResolveDSN()
	return d, dsn, err
}

func (a *App) adminDSN(target string) (string, error) {
	if a.shadowAdmin != "" {
		return a.shadowAdmin, nil
	}
	return shadow.AdminDSN(target)
}

// Dir returns a database's migrations directory.
func (a *App) Dir(name string) (string, error) {
	d, ok := a.dbs[name]
	if !ok {
		return "", fmt.Errorf("%w %q", ErrUnknownDB, name)
	}
	return d.Migrations, nil
}

// MigrationView is a migration as the UI shows it. File paths are left out.
type MigrationView struct {
	Version  int64          `json:"version"`
	Name     string         `json:"name"`
	UpSQL    string         `json:"up_sql"`
	DownSQL  string         `json:"down_sql"`
	Checksum string         `json:"checksum"`
	NoTx     bool           `json:"no_tx"`
	HasDown  bool           `json:"has_down"`
	Lint     []lint.Finding `json:"lint"`
}

func (a *App) load(name string) (migration.Set, error) {
	d, ok := a.dbs[name]
	if !ok {
		return nil, fmt.Errorf("%w %q", ErrUnknownDB, name)
	}
	return migration.Load(d.Migrations)
}

// Migrations lists the migration files with their lint findings.
func (a *App) Migrations(name string) ([]MigrationView, error) {
	set, err := a.load(name)
	if err != nil {
		return nil, err
	}
	out := make([]MigrationView, 0, len(set))
	for _, m := range set {
		f := lint.Migration(m)
		if f == nil {
			f = []lint.Finding{}
		}
		out = append(out, MigrationView{Version: m.Version, Name: m.Name, UpSQL: m.UpSQL, DownSQL: m.DownSQL, Checksum: m.Checksum, NoTx: m.NoTx, HasDown: m.HasDown, Lint: f})
	}
	return out, nil
}

func (a *App) open(ctx context.Context, name string) (*engine.Engine, error) {
	set, err := a.load(name)
	if err != nil {
		return nil, err
	}
	_, dsn, err := a.database(name)
	if err != nil {
		return nil, err
	}
	return engine.Open(ctx, dsn, set)
}

func (a *App) Status(ctx context.Context, name string) ([]engine.Row, error) {
	e, err := a.open(ctx, name)
	if err != nil {
		return nil, err
	}
	defer e.Close(ctx)
	return e.Status(ctx)
}

func (a *App) History(ctx context.Context, name string, limit int) ([]engine.HistoryEntry, error) {
	e, err := a.open(ctx, name)
	if err != nil {
		return nil, err
	}
	defer e.Close(ctx)
	return e.History(ctx, limit)
}

// Schema reads the live schema.
func (a *App) Schema(ctx context.Context, name string) (introspect.Schema, error) {
	_, dsn, err := a.database(name)
	if err != nil {
		return introspect.Schema{}, err
	}
	c, err := pgx.Connect(ctx, dsn)
	if err != nil {
		return introspect.Schema{}, fmt.Errorf("connect: %w", err)
	}
	defer c.Close(ctx)
	return introspect.Read(ctx, c, introspect.Options{})
}

// remember runs fn once per key until ttl passes. Concurrent callers for the
// same key wait for the first one instead of repeating the work.
func (a *App) remember(key string, ttl time.Duration, fn func() (any, error)) (any, error) {
	a.mu.Lock()
	lk := a.locks[key]
	if lk == nil {
		lk = &sync.Mutex{}
		a.locks[key] = lk
	}
	a.mu.Unlock()
	lk.Lock()
	defer lk.Unlock()
	a.mu.Lock()
	if c, ok := a.cache[key]; ok && time.Now().Before(c.expires) {
		a.mu.Unlock()
		return c.value, nil
	}
	a.mu.Unlock()
	v, err := fn()
	if err != nil {
		return nil, err
	}
	a.mu.Lock()
	a.cache[key] = cached{value: v, expires: time.Now().Add(ttl)}
	a.mu.Unlock()
	return v, nil
}

func (a *App) forget(name string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	for k := range a.cache {
		if len(k) > len(name) && k[:len(name)+1] == name+":" {
			delete(a.cache, k)
		}
	}
}

// fingerprint changes whenever any migration file's content changes.
func fingerprint(set migration.Set) string {
	h := sha256.New()
	for _, m := range set {
		fmt.Fprintf(h, "%d|%s|%s|%s\n", m.Version, m.Name, m.UpSQL, m.DownSQL)
	}
	return hex.EncodeToString(h.Sum(nil))[:16]
}

// Timeline replays the migrations in a scratch database. The result is cached
// until a migration file changes.
func (a *App) Timeline(ctx context.Context, name string) (shadow.Timeline, error) {
	set, err := a.load(name)
	if err != nil {
		return shadow.Timeline{}, err
	}
	_, dsn, err := a.database(name)
	if err != nil {
		return shadow.Timeline{}, err
	}
	admin, err := a.adminDSN(dsn)
	if err != nil {
		return shadow.Timeline{}, err
	}
	v, err := a.remember(name+":timeline:"+fingerprint(set), 10*time.Minute, func() (any, error) {
		return shadow.BuildTimeline(context.WithoutCancel(ctx), admin, set)
	})
	if err != nil {
		return shadow.Timeline{}, err
	}
	return v.(shadow.Timeline), nil
}

// Drift compares the live database with what its applied migrations produce.
func (a *App) Drift(ctx context.Context, name string) (shadow.DriftReport, error) {
	set, err := a.load(name)
	if err != nil {
		return shadow.DriftReport{}, err
	}
	_, dsn, err := a.database(name)
	if err != nil {
		return shadow.DriftReport{}, err
	}
	admin, err := a.adminDSN(dsn)
	if err != nil {
		return shadow.DriftReport{}, err
	}
	return shadow.Drift(ctx, dsn, admin, set)
}

// Run applies or rolls back migrations. direction is "up" or "down".
func (a *App) Run(ctx context.Context, name, direction string, o engine.Options) ([]engine.Result, error) {
	e, err := a.open(ctx, name)
	if err != nil {
		return nil, err
	}
	defer e.Close(ctx)
	defer a.forget(name)
	switch direction {
	case "up":
		return e.Up(ctx, o)
	case "down":
		return e.Down(ctx, o)
	}
	return nil, fmt.Errorf("direction must be up or down, not %q", direction)
}

func (a *App) Goto(ctx context.Context, name string, target int64, o engine.Options) ([]engine.Result, error) {
	e, err := a.open(ctx, name)
	if err != nil {
		return nil, err
	}
	defer e.Close(ctx)
	defer a.forget(name)
	return e.Goto(ctx, target, o)
}

func (a *App) Baseline(ctx context.Context, name string, version int64) error {
	e, err := a.open(ctx, name)
	if err != nil {
		return err
	}
	defer e.Close(ctx)
	defer a.forget(name)
	return e.Baseline(ctx, version)
}

// Generated is a proposed migration that would make the migrations match the live database.
type Generated struct {
	Up      diff.Script   `json:"up"`
	Down    diff.Script   `json:"down"`
	Changes []diff.Change `json:"changes"`
}

// Generate proposes a migration from the drift: up turns the expected schema
// into the live one, down goes back.
func (a *App) Generate(ctx context.Context, name string) (Generated, error) {
	rep, err := a.Drift(ctx, name)
	if err != nil {
		return Generated{}, err
	}
	if rep.Skipped != "" {
		return Generated{}, errors.New(rep.Skipped)
	}
	return Generated{
		Up:      diff.Generate(rep.Expected, rep.Live),
		Down:    diff.Generate(rep.Live, rep.Expected),
		Changes: rep.Changes,
	}, nil
}

// Create writes a new migration pair with the given SQL and returns its file names.
func (a *App) Create(name, label, up, down string) (string, error) {
	dir, err := a.Dir(name)
	if err != nil {
		return "", err
	}
	upPath, downPath, err := migration.Create(dir, label, time.Now())
	if err != nil {
		return "", err
	}
	if up != "" {
		if err := os.WriteFile(upPath, []byte(up), 0o644); err != nil {
			return "", err
		}
	}
	if down != "" {
		if err := os.WriteFile(downPath, []byte(down), 0o644); err != nil {
			return "", err
		}
	}
	a.forget(name)
	return upPath, nil
}

// Bundle is everything the web UI shows for one database, in one object.
// `export` writes it to a file so the UI can run without a server.
type Bundle struct {
	GeneratedAt time.Time          `json:"generated_at"`
	Database    string             `json:"database"`
	Migrations  []MigrationView    `json:"migrations"`
	Status      []engine.Row       `json:"status"`
	Schema      introspect.Schema  `json:"schema"`
	Timeline    shadow.Timeline    `json:"timeline"`
	Drift       shadow.DriftReport `json:"drift"`
	// Generated is the migration that would catch the files up with the live database, if they differ.
	Generated *Generated            `json:"generated"`
	History   []engine.HistoryEntry `json:"history"`
}

func (a *App) Bundle(ctx context.Context, name string) (Bundle, error) {
	b := Bundle{GeneratedAt: time.Now().UTC(), Database: name}
	var err error
	if b.Migrations, err = a.Migrations(name); err != nil {
		return b, err
	}
	if b.Status, err = a.Status(ctx, name); err != nil {
		return b, err
	}
	if b.Schema, err = a.Schema(ctx, name); err != nil {
		return b, err
	}
	if b.Timeline, err = a.Timeline(ctx, name); err != nil {
		return b, err
	}
	if b.Drift, err = a.Drift(ctx, name); err != nil {
		return b, err
	}
	if !b.Drift.InSync && b.Drift.Skipped == "" {
		g := Generated{Up: diff.Generate(b.Drift.Expected, b.Drift.Live), Down: diff.Generate(b.Drift.Live, b.Drift.Expected), Changes: b.Drift.Changes}
		b.Generated = &g
	}
	if b.History, err = a.History(ctx, name, 200); err != nil {
		return b, err
	}
	sort.SliceStable(b.History, func(i, j int) bool { return b.History[i].ID > b.History[j].ID })
	return b, nil
}
