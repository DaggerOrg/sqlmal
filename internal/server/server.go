// Package server serves the JSON API and the embedded web UI.
//
// This process can reach databases, so it is careful by default: it binds to
// localhost, refuses to run on another address without a token, rejects
// requests whose Host or Origin is not its own (DNS rebinding and cross-site
// forms), and is read-only unless started with --allow-write.
package server

import (
	"context"
	"crypto/subtle"
	"embed"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/Stephen-SMH/sqlmal/internal/app"
	"github.com/Stephen-SMH/sqlmal/internal/engine"
	"github.com/Stephen-SMH/sqlmal/internal/migration"
)

//go:embed all:ui
var uiFiles embed.FS

type Options struct {
	// Addr is the listen address; it decides which Host headers are accepted.
	Addr string
	// AllowWrite lets the API run migrations and write files.
	AllowWrite bool
	// Token, when set, must be sent as a Bearer token on every API call.
	Token   string
	Version string
}

type Server struct {
	app  *app.App
	opts Options
	mux  *http.ServeMux
}

// ValidateBind refuses to expose the API beyond this machine without a token.
func ValidateBind(addr, token string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return err
	}
	if token == "" && !isLoopback(host) {
		return errors.New("refusing to listen on a non-local address without --token: anyone who can reach it could read your database schema" +
			" (and run migrations with --allow-write)")
	}
	return nil
}

func isLoopback(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	return ip != nil && ip.IsLoopback()
}

func New(a *app.App, o Options) *Server {
	s := &Server{app: a, opts: o, mux: http.NewServeMux()}
	s.routes()
	return s
}

func (s *Server) Handler() http.Handler {
	return s.secure(s.mux)
}

func (s *Server) routes() {
	m := s.mux
	m.HandleFunc("GET /api/info", s.api(s.info))
	m.HandleFunc("GET /api/{db}/migrations", s.api(s.migrations))
	m.HandleFunc("GET /api/{db}/status", s.api(s.status))
	m.HandleFunc("GET /api/{db}/schema", s.api(s.schema))
	m.HandleFunc("GET /api/{db}/timeline", s.api(s.timeline))
	m.HandleFunc("GET /api/{db}/drift", s.api(s.drift))
	m.HandleFunc("GET /api/{db}/history", s.api(s.history))
	m.HandleFunc("GET /api/{db}/bundle", s.api(s.bundle))
	m.HandleFunc("POST /api/{db}/generate", s.api(s.generate))
	m.HandleFunc("POST /api/{db}/run", s.write(s.run))
	m.HandleFunc("POST /api/{db}/migrations", s.write(s.create))
	m.HandleFunc("/", s.static)
}

// ---- security ----

var secretRe = regexp.MustCompile(`(?i)(password|passwd|pwd)=\S+|://[^:@/\s]+:[^@/\s]+@`)

func scrub(msg string) string {
	return secretRe.ReplaceAllString(msg, "://***@")
}

func (s *Server) allowedHost(host string) bool {
	h, _, err := net.SplitHostPort(host)
	if err != nil {
		h = host
	}
	h = strings.Trim(h, "[]")
	if isLoopback(h) {
		return true
	}
	lh, _, err := net.SplitHostPort(s.opts.Addr)
	return err == nil && strings.EqualFold(h, strings.Trim(lh, "[]"))
}

func (s *Server) secure(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'")
		if !s.allowedHost(r.Host) {
			// A page on another site that tricks the browser into resolving its own name
			// to 127.0.0.1 would arrive with that name as Host.
			http.Error(w, "unexpected Host header", http.StatusForbidden)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/") {
			h.Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}

type apiError struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func fail(w http.ResponseWriter, status int, code, msg string) {
	var e apiError
	e.Error.Code, e.Error.Message = code, scrub(msg)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(e)
}

func ok(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(v)
}

type handler func(w http.ResponseWriter, r *http.Request, db string)

// api wraps a read handler: token check, then a per-request timeout.
func (s *Server) api(h handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.authorized(r) {
			w.Header().Set("WWW-Authenticate", "Bearer")
			fail(w, http.StatusUnauthorized, "unauthorized", "A token is required.")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
		defer cancel()
		h(w, r.WithContext(ctx), r.PathValue("db"))
	}
}

// write wraps a handler that changes things: it also needs --allow-write, a
// same-origin request, and the custom header a forged form cannot send.
func (s *Server) write(h handler) http.HandlerFunc {
	return s.api(func(w http.ResponseWriter, r *http.Request, db string) {
		if !s.opts.AllowWrite {
			fail(w, http.StatusForbidden, "read_only", "This server is read-only. Start it with --allow-write to run migrations from the UI.")
			return
		}
		if o := r.Header.Get("Origin"); o != "" {
			u, err := url.Parse(o)
			if err != nil || !strings.EqualFold(u.Host, r.Host) {
				fail(w, http.StatusForbidden, "bad_origin", "Cross-site requests are not allowed.")
				return
			}
		}
		if r.Header.Get("X-SQLMal") != "1" {
			fail(w, http.StatusForbidden, "missing_header", "Missing X-SQLMal header.")
			return
		}
		h(w, r, db)
	})
}

func (s *Server) authorized(r *http.Request) bool {
	if s.opts.Token == "" {
		return true
	}
	tok, found := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	return found && subtle.ConstantTimeCompare([]byte(tok), []byte(s.opts.Token)) == 1
}

func decode(w http.ResponseWriter, r *http.Request, dst any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	// An empty body means "all defaults".
	if err := dec.Decode(dst); err != nil && !errors.Is(err, io.EOF) {
		fail(w, http.StatusBadRequest, "bad_request", "The request body is not valid: "+err.Error())
		return false
	}
	return true
}

func (s *Server) problem(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, app.ErrUnknownDB):
		fail(w, http.StatusNotFound, "unknown_database", err.Error())
	case errors.Is(err, engine.ErrLocked):
		fail(w, http.StatusConflict, "locked", err.Error())
	case errors.Is(err, engine.ErrDrifted), errors.Is(err, engine.ErrOutOfSeq), errors.Is(err, engine.ErrNoDown), errors.Is(err, engine.ErrNothing):
		fail(w, http.StatusConflict, "not_allowed", err.Error())
	case errors.Is(err, context.DeadlineExceeded):
		fail(w, http.StatusGatewayTimeout, "timeout", "That took too long.")
	default:
		fail(w, http.StatusBadGateway, "failed", err.Error())
	}
}

// ---- handlers ----

type dbInfo struct {
	Name string `json:"name"`
}

func (s *Server) info(w http.ResponseWriter, _ *http.Request, _ string) {
	var dbs []dbInfo
	for _, n := range s.app.Names() {
		dbs = append(dbs, dbInfo{Name: n})
	}
	ok(w, map[string]any{"version": s.opts.Version, "read_only": !s.opts.AllowWrite, "databases": dbs, "static": false})
}

func (s *Server) migrations(w http.ResponseWriter, _ *http.Request, db string) {
	v, err := s.app.Migrations(db)
	reply(s, w, v, err)
}

func (s *Server) status(w http.ResponseWriter, r *http.Request, db string) {
	v, err := s.app.Status(r.Context(), db)
	reply(s, w, v, err)
}

func (s *Server) schema(w http.ResponseWriter, r *http.Request, db string) {
	v, err := s.app.Schema(r.Context(), db)
	reply(s, w, v, err)
}

func (s *Server) timeline(w http.ResponseWriter, r *http.Request, db string) {
	v, err := s.app.Timeline(r.Context(), db)
	reply(s, w, v, err)
}

func (s *Server) drift(w http.ResponseWriter, r *http.Request, db string) {
	v, err := s.app.Drift(r.Context(), db)
	reply(s, w, v, err)
}

func (s *Server) history(w http.ResponseWriter, r *http.Request, db string) {
	n, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	v, err := s.app.History(r.Context(), db, n)
	reply(s, w, v, err)
}

func (s *Server) bundle(w http.ResponseWriter, r *http.Request, db string) {
	v, err := s.app.Bundle(r.Context(), db)
	reply(s, w, v, err)
}

// generate only reads and computes, so it works in read-only mode.
func (s *Server) generate(w http.ResponseWriter, r *http.Request, db string) {
	v, err := s.app.Generate(r.Context(), db)
	reply(s, w, v, err)
}

func reply[T any](s *Server, w http.ResponseWriter, v T, err error) {
	if err != nil {
		s.problem(w, err)
		return
	}
	ok(w, v)
}

type runRequest struct {
	Direction string `json:"direction"` // up, down
	Steps     int    `json:"steps"`
	Target    int64  `json:"target"`
	DryRun    bool   `json:"dry_run"`
	Force     bool   `json:"force"`
}

func (s *Server) run(w http.ResponseWriter, r *http.Request, db string) {
	var req runRequest
	if !decode(w, r, &req) {
		return
	}
	if req.Direction != "up" && req.Direction != "down" {
		fail(w, http.StatusBadRequest, "bad_request", "direction must be up or down")
		return
	}
	if req.Steps < 0 || req.Steps > 1000 || req.Target < 0 {
		fail(w, http.StatusBadRequest, "bad_request", "steps or target out of range")
		return
	}
	res, err := s.app.Run(r.Context(), db, req.Direction, engine.Options{Steps: req.Steps, Target: req.Target, DryRun: req.DryRun, Force: req.Force})
	out := map[string]any{"results": res}
	if err != nil {
		if errors.Is(err, engine.ErrNothing) {
			out["message"] = "Nothing to do."
			ok(w, out)
			return
		}
		if len(res) > 0 { // a migration ran and failed: return what happened, not just an error
			out["error"] = scrub(err.Error())
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.WriteHeader(http.StatusUnprocessableEntity)
			_ = json.NewEncoder(w).Encode(out)
			return
		}
		s.problem(w, err)
		return
	}
	ok(w, out)
}

type createRequest struct {
	Name string `json:"name"`
	Up   string `json:"up_sql"`
	Down string `json:"down_sql"`
}

func (s *Server) create(w http.ResponseWriter, r *http.Request, db string) {
	var req createRequest
	if !decode(w, r, &req) {
		return
	}
	path, err := s.app.Create(db, req.Name, req.Up, req.Down)
	if err != nil {
		if strings.Contains(err.Error(), "name must be") {
			fail(w, http.StatusBadRequest, "bad_request", err.Error())
			return
		}
		s.problem(w, err)
		return
	}
	set, _ := migration.Load(dirOf(s.app, db))
	ok(w, map[string]any{"file": baseName(path), "migrations": len(set)})
}

func dirOf(a *app.App, db string) string {
	d, _ := a.Dir(db)
	return d
}

func baseName(p string) string {
	if i := strings.LastIndexAny(p, `/\`); i >= 0 {
		return p[i+1:]
	}
	return p
}

// ---- static UI ----

func (s *Server) static(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") {
		fail(w, http.StatusNotFound, "not_found", "No such endpoint.")
		return
	}
	sub, err := fs.Sub(uiFiles, "ui")
	if err != nil {
		http.Error(w, "UI missing", http.StatusInternalServerError)
		return
	}
	name := strings.TrimPrefix(r.URL.Path, "/")
	if name == "" {
		name = "index.html"
	}
	if _, err := fs.Stat(sub, name); err != nil {
		// Client-side routes fall back to the app shell; a missing file does not.
		if strings.Contains(name, ".") {
			http.NotFound(w, r)
			return
		}
		name = "index.html"
	}
	if name == "index.html" {
		w.Header().Set("Cache-Control", "no-cache")
	} else if strings.HasPrefix(name, "assets/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable") // content-hashed file names
	}
	http.ServeFileFS(w, r, sub, name)
}
