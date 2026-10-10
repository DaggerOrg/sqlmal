// Command migrate-studio manages SQL migrations for PostgreSQL and shows them
// as a diagram you can explore.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"github.com/Stephen-SMH/migrate-studio/internal/app"
	"github.com/Stephen-SMH/migrate-studio/internal/config"
	"github.com/Stephen-SMH/migrate-studio/internal/engine"
	"github.com/Stephen-SMH/migrate-studio/internal/lint"
	"github.com/Stephen-SMH/migrate-studio/internal/migration"
	"github.com/Stephen-SMH/migrate-studio/internal/server"
)

var version = "dev"

const usage = `migrate-studio: SQL migrations for PostgreSQL, with a map of your schema.

Usage: migrate-studio [global flags] <command> [flags]

Commands:
  init [dir]          create a migrations directory and a config file
  new <name>          create an empty up/down migration pair
  status              show which migrations are applied, pending or edited
  up                  apply pending migrations   (--steps N, --to V, --dry-run)
  down                roll back the latest one   (--steps N, --to V, --dry-run)
  goto <version>      move to exactly this version (0 = before everything)
  baseline <version>  mark migrations up to this one as applied without running them
  lint                check migrations for risky statements  (--strict)
  verify              replay everything in a scratch database and check each down undoes its up
  drift               compare the live database with what the migrations should have produced
  generate <name>     write a migration from the drift, so the files catch up with the database
  export              write everything the web UI shows to one JSON file  (--out)
  serve               open the web UI  (--addr, --allow-write, --token)
  version

Global flags (before the command):
  --config FILE   migrate-studio.json (default: ./migrate-studio.json if present)
  --db NAME       which database from the config (default: the first)
  --dsn URL       connect directly (default: $DATABASE_URL)
  --dir DIR       migrations directory (default: ./migrations)
`

type global struct {
	cfgPath, db, dsn, dir string
}

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, out, errw io.Writer) int {
	var g global
	fs := flag.NewFlagSet("migrate-studio", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	fs.StringVar(&g.cfgPath, "config", "", "")
	fs.StringVar(&g.db, "db", "", "")
	fs.StringVar(&g.dsn, "dsn", "", "")
	fs.StringVar(&g.dir, "dir", "", "")
	if err := fs.Parse(args); err != nil {
		fmt.Fprintf(errw, "%v\n\n%s", err, usage)
		return 2
	}
	rest := fs.Args()
	if len(rest) == 0 || rest[0] == "help" || rest[0] == "-h" || rest[0] == "--help" {
		fmt.Fprint(out, usage)
		return 0
	}
	cmd, rest := rest[0], rest[1:]
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	switch cmd {
	case "version":
		fmt.Fprintln(out, "migrate-studio", version)
		return 0
	case "init":
		return finish(errw, cmdInit(out, g, rest))
	case "new":
		return finish(errw, cmdNew(out, g, rest))
	case "lint":
		return cmdLint(out, errw, g, rest)
	}

	a, name, err := open(g)
	if err != nil {
		return finish(errw, err)
	}
	switch cmd {
	case "status":
		return finish(errw, cmdStatus(ctx, out, a, name))
	case "up", "down":
		return cmdRun(ctx, out, errw, a, name, cmd, rest)
	case "goto":
		return finish(errw, cmdGoto(ctx, out, a, name, rest))
	case "baseline":
		return finish(errw, cmdBaseline(ctx, out, a, name, rest))
	case "verify":
		return cmdVerify(ctx, out, a, name)
	case "drift":
		return cmdDrift(ctx, out, a, name)
	case "generate":
		return finish(errw, cmdGenerate(ctx, out, a, name, rest))
	case "export":
		return finish(errw, cmdExport(ctx, out, a, name, rest))
	case "serve":
		return finish(errw, cmdServe(ctx, out, a, rest))
	}
	fmt.Fprintf(errw, "unknown command %q\n\n%s", cmd, usage)
	return 2
}

func finish(errw io.Writer, err error) int {
	if err == nil {
		return 0
	}
	var u usageError
	if errors.As(err, &u) {
		fmt.Fprintln(errw, "error:", err)
		return 2
	}
	fmt.Fprintln(errw, "error:", err)
	return 1
}

type usageError string

func (e usageError) Error() string { return string(e) }

// open builds the App from flags or the config file and picks the database.
func open(g global) (*app.App, string, error) {
	var cfg config.Config
	path := g.cfgPath
	if path == "" {
		if _, err := os.Stat("migrate-studio.json"); err == nil && g.dsn == "" {
			path = "migrate-studio.json"
		}
	}
	if path != "" {
		c, err := config.Load(path)
		if err != nil {
			return nil, "", err
		}
		cfg = c
	} else {
		dsn := g.dsn
		if dsn == "" {
			dsn = os.Getenv("DATABASE_URL")
		}
		if dsn == "" {
			return nil, "", usageError("no database: set DATABASE_URL, pass --dsn, or create migrate-studio.json (run: migrate-studio init)")
		}
		dir := g.dir
		if dir == "" {
			dir = "migrations"
		}
		cfg = config.Single(dsn, dir)
	}
	a, err := app.New(cfg)
	if err != nil {
		return nil, "", err
	}
	name := g.db
	if name == "" {
		name = cfg.Databases[0].Name
	}
	return a, name, nil
}

// ---- output helpers ----

func color(code, s string) string {
	if os.Getenv("NO_COLOR") != "" {
		return s
	}
	if fi, err := os.Stdout.Stat(); err != nil || fi.Mode()&os.ModeCharDevice == 0 {
		return s
	}
	return "\x1b[" + code + "m" + s + "\x1b[0m"
}

func stateLabel(s engine.State) string {
	switch s {
	case engine.Applied:
		return color("32", "applied")
	case engine.Pending:
		return color("33", "pending")
	case engine.Modified:
		return color("31", "EDITED ")
	default:
		return color("31", "MISSING")
	}
}

// ---- commands ----

func cmdInit(out io.Writer, g global, args []string) error {
	dir := "migrations"
	if len(args) > 0 {
		dir = args[0]
	}
	if g.dir != "" {
		dir = g.dir
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	if _, err := os.Stat("migrate-studio.json"); err == nil {
		fmt.Fprintln(out, "migrate-studio.json already exists, leaving it alone")
	} else {
		cfg := map[string]any{"databases": []map[string]string{{"name": "main", "dsn_env": "DATABASE_URL", "migrations": "./" + filepath.ToSlash(dir)}}}
		b, _ := json.MarshalIndent(cfg, "", "  ")
		if err := os.WriteFile("migrate-studio.json", append(b, '\n'), 0o644); err != nil {
			return err
		}
		fmt.Fprintln(out, "wrote migrate-studio.json (the connection URL is read from $DATABASE_URL)")
	}
	fmt.Fprintf(out, "created %s/\n\nNext:\n  migrate-studio new create_users\n  export DATABASE_URL=postgres://user:pass@localhost:5432/mydb\n  migrate-studio up\n  migrate-studio serve\n", dir)
	return nil
}

func cmdNew(out io.Writer, g global, args []string) error {
	if len(args) != 1 {
		return usageError("usage: migrate-studio new <name>")
	}
	dir := g.dir
	if dir == "" {
		dir = "migrations"
	}
	up, down, err := migration.Create(dir, args[0], time.Now())
	if err != nil {
		return err
	}
	fmt.Fprintf(out, "created\n  %s\n  %s\n", up, down)
	return nil
}

func cmdLint(out, errw io.Writer, g global, args []string) int {
	fs := flag.NewFlagSet("lint", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	strict := fs.Bool("strict", false, "")
	if err := fs.Parse(args); err != nil {
		fmt.Fprintln(errw, "error:", err)
		return 2
	}
	dir := g.dir
	if dir == "" {
		dir = "migrations"
		if g.cfgPath != "" || fileExists("migrate-studio.json") {
			if a, name, err := open(g); err == nil {
				if d, err := a.Dir(name); err == nil {
					dir = d
				}
			}
		}
	}
	set, err := migration.Load(dir)
	if err != nil {
		return finish(errw, err)
	}
	var errs, warns int
	for _, m := range set {
		for _, f := range lint.Migration(m) {
			fmt.Fprintf(out, "%04d_%s.%s.sql:%d  %s %s  %s\n", m.Version, m.Name, f.File, f.Line, f.Rule, f.Severity, f.Message)
			if f.Hint != "" {
				fmt.Fprintf(out, "      %s\n", f.Hint)
			}
		}
		e, w, _ := lint.Counts(lint.Migration(m))
		errs, warns = errs+e, warns+w
	}
	fmt.Fprintf(out, "\n%d migrations checked: %d errors, %d warnings\n", len(set), errs, warns)
	if errs > 0 || (*strict && warns > 0) {
		return 1
	}
	return 0
}

func fileExists(p string) bool { _, err := os.Stat(p); return err == nil }

func cmdStatus(ctx context.Context, out io.Writer, a *app.App, name string) error {
	rows, err := a.Status(ctx, name)
	if err != nil {
		return err
	}
	fmt.Fprintf(out, "%-9s %-8s  %-34s %s\n", "STATE", "VERSION", "NAME", "APPLIED")
	for _, r := range rows {
		when := ""
		if r.AppliedAt != nil {
			when = r.AppliedAt.Local().Format("2006-01-02 15:04") + fmt.Sprintf("  %dms", r.DurationMs)
		}
		note := ""
		if r.OutOfOrder {
			note = color("33", "  (older than an applied migration)")
		}
		if !r.HasDown && r.State != engine.Missing {
			note += color("2", "  (no down)")
		}
		fmt.Fprintf(out, "%-9s %04d     %-34s %s%s\n", stateLabel(r.State), r.Version, r.Name, when, note)
	}
	return nil
}

func cmdRun(ctx context.Context, out, errw io.Writer, a *app.App, name, dir string, args []string) int {
	fs := flag.NewFlagSet(dir, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	steps := fs.Int("steps", 0, "")
	to := fs.Int64("to", 0, "")
	dry := fs.Bool("dry-run", false, "")
	force := fs.Bool("force", false, "")
	ooo := fs.Bool("allow-out-of-order", false, "")
	lockWait := fs.Duration("lock-wait", 0, "")
	lockTimeout := fs.Duration("lock-timeout", 0, "")
	stmtTimeout := fs.Duration("statement-timeout", 0, "")
	if err := fs.Parse(args); err != nil {
		fmt.Fprintln(errw, "error:", err)
		return 2
	}
	res, err := a.Run(ctx, name, dir, engine.Options{Steps: *steps, Target: *to, DryRun: *dry, Force: *force, AllowOutOfOrder: *ooo,
		LockWait: *lockWait, LockTimeout: *lockTimeout, StatementTimeout: *stmtTimeout})
	printResults(out, res, *dry)
	if errors.Is(err, engine.ErrNothing) {
		fmt.Fprintln(out, "nothing to do")
		return 0
	}
	return finish(errw, err)
}

func printResults(out io.Writer, res []engine.Result, dry bool) {
	for _, r := range res {
		verb := "applied"
		if r.Direction == "down" {
			verb = "rolled back"
		}
		if r.DryRun {
			verb = "would " + map[string]string{"up": "apply", "down": "roll back"}[r.Direction]
		}
		switch {
		case r.Error != "":
			where := ""
			if r.Line > 0 {
				where = fmt.Sprintf(" at line %d", r.Line)
			}
			fmt.Fprintf(out, "%s %04d_%s%s: %s\n", color("31", "FAILED"), r.Version, r.Name, where, r.Error)
		case r.Skipped != "":
			fmt.Fprintf(out, "%s %04d_%s: %s\n", color("33", "skipped"), r.Version, r.Name, r.Skipped)
		default:
			fmt.Fprintf(out, "%s %04d_%s (%dms)\n", color("32", verb), r.Version, r.Name, r.DurationMs)
		}
	}
	if dry && len(res) > 0 {
		fmt.Fprintln(out, "dry run: nothing was changed")
	}
}

func cmdGoto(ctx context.Context, out io.Writer, a *app.App, name string, args []string) error {
	if len(args) != 1 {
		return usageError("usage: migrate-studio goto <version>")
	}
	v, err := strconv.ParseInt(args[0], 10, 64)
	if err != nil {
		return usageError("version must be a number")
	}
	res, err := a.Goto(ctx, name, v, engine.Options{})
	printResults(out, res, false)
	if errors.Is(err, engine.ErrNothing) {
		fmt.Fprintln(out, "already there")
		return nil
	}
	return err
}

func cmdBaseline(ctx context.Context, out io.Writer, a *app.App, name string, args []string) error {
	if len(args) != 1 {
		return usageError("usage: migrate-studio baseline <version>")
	}
	v, err := strconv.ParseInt(args[0], 10, 64)
	if err != nil {
		return usageError("version must be a number")
	}
	if err := a.Baseline(ctx, name, v); err != nil {
		return err
	}
	fmt.Fprintf(out, "recorded every migration up to %04d as applied, without running them\n", v)
	return nil
}

func cmdVerify(ctx context.Context, out io.Writer, a *app.App, name string) int {
	tl, err := a.Timeline(ctx, name)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		return 1
	}
	bad := tl.Failed != 0
	for _, s := range tl.Steps {
		mark := color("32", "reversible")
		switch {
		case s.Error != "":
			mark, bad = color("31", "FAILED: "+s.Error), true
		case s.Reversible == nil:
			mark, bad = color("33", "unchecked: "+s.ReverseNote), true
		case !*s.Reversible:
			mark, bad = color("31", "NOT reversible: "+s.ReverseNote), true
		}
		fmt.Fprintf(out, "%04d_%-30s %2d changes   %s\n", s.Version, s.Name, len(s.Changes), mark)
		for _, d := range s.ReverseDiff {
			fmt.Fprintf(out, "        left behind after the down: %s\n", d)
		}
	}
	if bad {
		fmt.Fprintln(out, "\nverify found problems")
		return 1
	}
	fmt.Fprintf(out, "\nall %d migrations apply cleanly and every down undoes its up\n", len(tl.Steps))
	return 0
}

func cmdDrift(ctx context.Context, out io.Writer, a *app.App, name string) int {
	rep, err := a.Drift(ctx, name)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		return 1
	}
	if rep.Skipped != "" {
		fmt.Fprintln(out, rep.Skipped)
		return 1
	}
	if rep.InSync {
		fmt.Fprintf(out, "in sync: the live database matches the %d applied migrations\n", rep.Applied)
		return 0
	}
	fmt.Fprintf(out, "the live database differs from what %d applied migrations should produce:\n", rep.Applied)
	for _, c := range rep.Changes {
		fmt.Fprintf(out, "  + %s\n", c)
	}
	fmt.Fprintln(out, "\nrun: migrate-studio generate <name>   to write a migration that catches the files up")
	return 1
}

func cmdGenerate(ctx context.Context, out io.Writer, a *app.App, name string, args []string) error {
	if len(args) != 1 {
		return usageError("usage: migrate-studio generate <name>")
	}
	g, err := a.Generate(ctx, name)
	if err != nil {
		return err
	}
	if g.Up.SQL == "" {
		fmt.Fprintln(out, "no drift: nothing to generate")
		return nil
	}
	path, err := a.Create(name, args[0], g.Up.SQL, g.Down.SQL)
	if err != nil {
		return err
	}
	fmt.Fprintf(out, "wrote %s\n", path)
	for _, w := range g.Up.Warnings {
		fmt.Fprintf(out, "  review: %s\n", w)
	}
	fmt.Fprintln(out, "\nThe live database already has these changes. Record the new migration as applied with:\n  migrate-studio baseline <version>")
	return nil
}

func cmdExport(ctx context.Context, out io.Writer, a *app.App, name string, args []string) error {
	fs := flag.NewFlagSet("export", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	to := fs.String("out", "migrate-studio-export.json", "")
	if err := fs.Parse(args); err != nil {
		return usageError(err.Error())
	}
	b, err := a.Bundle(ctx, name)
	if err != nil {
		return err
	}
	raw, err := json.MarshalIndent(b, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(*to, raw, 0o644); err != nil {
		return err
	}
	fmt.Fprintf(out, "wrote %s (%d migrations, %d tables)\n", *to, len(b.Migrations), len(b.Schema.Tables))
	return nil
}

func cmdServe(ctx context.Context, out io.Writer, a *app.App, args []string) error {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	addr := fs.String("addr", "127.0.0.1:8484", "")
	write := fs.Bool("allow-write", false, "")
	token := fs.String("token", os.Getenv("MIGRATE_STUDIO_TOKEN"), "")
	if err := fs.Parse(args); err != nil {
		return usageError(err.Error())
	}
	if err := server.ValidateBind(*addr, *token); err != nil {
		return err
	}
	srv := &http.Server{
		Addr:              *addr,
		Handler:           server.New(a, server.Options{Addr: *addr, AllowWrite: *write, Token: *token, Version: version}).Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      3 * time.Minute,
		IdleTimeout:       2 * time.Minute,
	}
	go func() {
		<-ctx.Done()
		c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(c)
	}()
	mode := "read-only"
	if *write {
		mode = "WRITE ENABLED: the UI can run migrations"
	}
	fmt.Fprintf(out, "Migrate Studio %s on http://%s  (%s)\n", version, *addr, mode)
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
