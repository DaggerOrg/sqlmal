// Package shadow replays migrations in a throwaway database. Because it never
// touches the real database, it can show the schema after every migration,
// check that each down migration really undoes its up, and work out what the
// live database should look like for drift detection.
package shadow

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Stephen-SMH/migrate-studio/internal/diff"
	"github.com/Stephen-SMH/migrate-studio/internal/engine"
	"github.com/Stephen-SMH/migrate-studio/internal/introspect"
	"github.com/Stephen-SMH/migrate-studio/internal/migration"
)

// Scratch is a temporary database. Always Close it.
type Scratch struct {
	DSN   string
	name  string
	admin *pgx.Conn
}

// AdminDSN returns a DSN for the maintenance database on the same server as
// target, which is where scratch databases are created.
func AdminDSN(target string) (string, error) {
	u, err := url.Parse(target)
	if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") {
		return "", errors.New("the database URL must look like postgres://user:pass@host:5432/dbname")
	}
	u.Path = "/postgres"
	return u.String(), nil
}

func databaseDSN(admin, name string) string {
	u, _ := url.Parse(admin)
	u.Path = "/" + name
	return u.String()
}

// NewScratch creates an empty database on the server behind adminDSN.
func NewScratch(ctx context.Context, adminDSN string) (*Scratch, error) {
	admin, err := pgx.Connect(ctx, adminDSN)
	if err != nil {
		return nil, fmt.Errorf("connect to create a scratch database: %w", err)
	}
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	name := "ms_shadow_" + hex.EncodeToString(b)
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		_ = admin.Close(ctx)
		return nil, fmt.Errorf("create scratch database (this needs the CREATEDB privilege): %w", err)
	}
	return &Scratch{DSN: databaseDSN(adminDSN, name), name: name, admin: admin}, nil
}

func (s *Scratch) Close(ctx context.Context) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 20*time.Second)
	defer cancel()
	_, _ = s.admin.Exec(ctx, "DROP DATABASE IF EXISTS "+s.name+" WITH (FORCE)")
	_ = s.admin.Close(ctx)
}

// Step is the schema after one migration.
type Step struct {
	Version int64             `json:"version"`
	Name    string            `json:"name"`
	Schema  introspect.Schema `json:"schema"`
	Changes []diff.Change     `json:"changes"`
	ApplyMs int               `json:"apply_ms"`
	Error   string            `json:"error,omitempty"`
	// Reversible is nil when it was not checked (no down file, or an earlier problem).
	Reversible  *bool         `json:"reversible"`
	ReverseDiff []diff.Change `json:"reverse_diff,omitempty"`
	ReverseNote string        `json:"reverse_note,omitempty"`
}

type Timeline struct {
	Steps         []Step            `json:"steps"`
	Final         introspect.Schema `json:"final"`
	AllReversible bool              `json:"all_reversible"`
	// Failed is the version whose up migration failed, or 0.
	Failed int64 `json:"failed,omitempty"`
}

func readSchema(ctx context.Context, dsn string) (introspect.Schema, error) {
	c, err := pgx.Connect(ctx, dsn)
	if err != nil {
		return introspect.Schema{}, err
	}
	defer c.Close(ctx)
	return introspect.Read(ctx, c, introspect.Options{})
}

// BuildTimeline applies every migration in order to a scratch database,
// recording the schema after each, then rolls them all back one by one to
// check that every down returns the schema to how it was before its up.
func BuildTimeline(ctx context.Context, adminDSN string, set migration.Set) (Timeline, error) {
	sc, err := NewScratch(ctx, adminDSN)
	if err != nil {
		return Timeline{}, err
	}
	defer sc.Close(ctx)
	eng, err := engine.Open(ctx, sc.DSN, set)
	if err != nil {
		return Timeline{}, err
	}
	defer eng.Close(ctx)

	probe, err := pgx.Connect(ctx, sc.DSN)
	if err != nil {
		return Timeline{}, err
	}
	defer probe.Close(ctx)

	prev := introspect.Schema{Tables: []introspect.Table{}, Enums: []introspect.Enum{}}
	tl := Timeline{Steps: []Step{}}
	all := true
	for _, m := range set {
		start := time.Now()
		res, upErr := eng.Up(ctx, engine.Options{Steps: 1, LockWait: 5 * time.Second})
		st := Step{Version: m.Version, Name: m.Name, ApplyMs: int(time.Since(start).Milliseconds()), Changes: []diff.Change{}}
		if upErr != nil {
			msg := upErr.Error()
			if len(res) > 0 && res[len(res)-1].Error != "" {
				msg = res[len(res)-1].Error
				if l := res[len(res)-1].Line; l > 0 {
					msg = fmt.Sprintf("%s (line %d)", msg, l)
				}
			}
			st.Error, st.Schema = msg, prev
			tl.Steps = append(tl.Steps, st)
			tl.Failed = m.Version
			all = false
			break
		}
		cur, err := readSchema(ctx, sc.DSN)
		if err != nil {
			return tl, err
		}
		st.Schema, st.Changes = cur, diff.Compare(prev, cur)

		// Each migration is checked on its own: run its down inside a transaction that
		// is always rolled back, and compare with the schema from just before it.
		switch {
		case m.OneWay:
			st.ReverseNote = "one-way by design (marked irreversible)"
		case !m.HasDown:
			st.ReverseNote, all = "there is no down migration", false
		case m.DownNoTx:
			st.ReverseNote, all = "the down runs outside a transaction, so it cannot be tried safely", false
		default:
			ok, d, note, err := tryDown(ctx, probe, m.DownSQL, prev)
			if err != nil {
				return tl, err
			}
			st.Reversible, st.ReverseDiff, st.ReverseNote = &ok, d, note
			if !ok {
				all = false
			}
		}
		tl.Steps = append(tl.Steps, st)
		prev = cur
	}
	tl.Final = prev
	tl.AllReversible = all && len(tl.Steps) > 0
	return tl, nil
}

// tryDown runs a down migration in a transaction it then rolls back, and says
// whether the schema ended up as it was before the migration's up.
func tryDown(ctx context.Context, conn *pgx.Conn, downSQL string, before introspect.Schema) (ok bool, left []diff.Change, note string, err error) {
	tx, err := conn.Begin(ctx)
	if err != nil {
		return false, nil, "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, derr := tx.Exec(ctx, downSQL); derr != nil {
		return false, nil, "the down migration failed: " + derr.Error(), nil
	}
	after, err := introspect.ReadTx(ctx, tx, introspect.Options{})
	if err != nil {
		return false, nil, "", err
	}
	d := diff.Compare(before, after)
	if len(d) == 0 {
		return true, nil, "", nil
	}
	return false, d, "after rolling back, the schema is not the same as before this migration", nil
}

// DriftReport compares the live database with what its applied migrations should have produced.
type DriftReport struct {
	// Applied is how many migrations the live database has recorded.
	Applied int `json:"applied"`
	// Skipped explains why no comparison was possible.
	Skipped  string            `json:"skipped,omitempty"`
	InSync   bool              `json:"in_sync"`
	Changes  []diff.Change     `json:"changes"`
	Expected introspect.Schema `json:"expected"`
	Live     introspect.Schema `json:"live"`
}

// Drift builds the schema the applied migrations should give, in a scratch
// database, and compares it with the live one. A change listed means the live
// database has it and the migrations do not (someone changed it by hand), or
// the other way round.
func Drift(ctx context.Context, liveDSN, adminDSN string, set migration.Set) (DriftReport, error) {
	live, err := engine.Open(ctx, liveDSN, set)
	if err != nil {
		return DriftReport{}, err
	}
	rows, err := live.Status(ctx)
	live.Close(ctx)
	if err != nil {
		return DriftReport{}, err
	}
	var applied migration.Set
	for _, r := range rows {
		switch r.State {
		case engine.Missing:
			return DriftReport{Skipped: fmt.Sprintf("migration %04d_%s was applied but its file is missing, so the expected schema cannot be rebuilt", r.Version, r.Name), Changes: []diff.Change{}}, nil
		case engine.Applied, engine.Modified:
			m, _ := set.ByVersion(r.Version)
			applied = append(applied, m)
		}
	}
	liveSchema, err := readSchema(ctx, liveDSN)
	if err != nil {
		return DriftReport{}, err
	}
	rep := DriftReport{Applied: len(applied), Live: liveSchema, Changes: []diff.Change{}}
	sc, err := NewScratch(ctx, adminDSN)
	if err != nil {
		return rep, err
	}
	defer sc.Close(ctx)
	eng, err := engine.Open(ctx, sc.DSN, applied)
	if err != nil {
		return rep, err
	}
	defer eng.Close(ctx)
	if len(applied) > 0 {
		if _, err := eng.Up(ctx, engine.Options{LockWait: 5 * time.Second}); err != nil {
			return rep, fmt.Errorf("rebuild the expected schema: %w", err)
		}
	}
	if rep.Expected, err = readSchema(ctx, sc.DSN); err != nil {
		return rep, err
	}
	rep.Changes = diff.Compare(rep.Expected, rep.Live)
	if rep.Changes == nil {
		rep.Changes = []diff.Change{}
	}
	rep.InSync = len(rep.Changes) == 0
	return rep, nil
}
