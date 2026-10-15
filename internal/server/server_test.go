package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Stephen-SMH/sqlmal/internal/app"
	"github.com/Stephen-SMH/sqlmal/internal/config"
	"github.com/Stephen-SMH/sqlmal/internal/testdb"
)

func newServer(t *testing.T, o Options) (*httptest.Server, string) {
	t.Helper()
	dsn := testdb.New(t)
	dir := t.TempDir()
	put := func(n, b string) { os.WriteFile(filepath.Join(dir, n), []byte(b), 0o644) }
	put("0001_users.up.sql", "CREATE TABLE users (id serial PRIMARY KEY, email text NOT NULL);")
	put("0001_users.down.sql", "DROP TABLE users;")
	put("0002_orders.up.sql", "CREATE TABLE orders (id serial PRIMARY KEY, user_id int REFERENCES users(id));")
	put("0002_orders.down.sql", "DROP TABLE orders;")
	a, _ := app.New(config.Single(dsn, dir))
	srv := httptest.NewServer(nil)
	srv.Config.Handler = New(a, o).Handler()
	t.Cleanup(srv.Close)
	return srv, dsn
}

func do(t *testing.T, method, url string, body any, hdr map[string]string) (*http.Response, map[string]any) {
	t.Helper()
	var rd *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	} else {
		rd = bytes.NewReader(nil)
	}
	req, _ := http.NewRequestWithContext(context.Background(), method, url, rd)
	for k, v := range hdr {
		if k == "Host" {
			req.Host = v
			continue
		}
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(res.Body).Decode(&out)
	return res, out
}

var writeHdr = map[string]string{"X-SQLMal": "1"}

func TestReadOnlyServerShowsEverythingAndChangesNothing(t *testing.T) {
	srv, _ := newServer(t, Options{Addr: "127.0.0.1:8484", Version: "test"})
	res, info := do(t, "GET", srv.URL+"/api/info", nil, nil)
	if res.StatusCode != 200 || info["read_only"] != true {
		t.Fatalf("info: %d %v", res.StatusCode, info)
	}
	for _, p := range []string{"migrations", "status", "schema", "timeline", "drift", "history"} {
		resp, err := http.Get(srv.URL + "/api/default/" + p)
		if err != nil || resp.StatusCode != 200 {
			t.Errorf("%s: %v %v", p, resp, err)
		}
		resp.Body.Close()
	}
	res, body := do(t, "POST", srv.URL+"/api/default/run", map[string]any{"direction": "up"}, writeHdr)
	if res.StatusCode != 403 || body["error"].(map[string]any)["code"] != "read_only" {
		t.Fatalf("a read-only server must refuse to run migrations: %d %v", res.StatusCode, body)
	}
	res, _ = do(t, "POST", srv.URL+"/api/default/migrations", map[string]any{"name": "x"}, writeHdr)
	if res.StatusCode != 403 {
		t.Fatalf("or write files: %d", res.StatusCode)
	}
}

func TestWriteModeRunsMigrationsAndReportsFailures(t *testing.T) {
	srv, _ := newServer(t, Options{Addr: "127.0.0.1:8484", AllowWrite: true})
	res, body := do(t, "POST", srv.URL+"/api/default/run", map[string]any{"direction": "up", "dry_run": true}, writeHdr)
	if res.StatusCode != 200 || len(body["results"].([]any)) != 2 {
		t.Fatalf("dry run: %d %v", res.StatusCode, body)
	}
	_, st := do(t, "GET", srv.URL+"/api/default/status", nil, nil)
	_ = st
	resp, _ := http.Get(srv.URL + "/api/default/status")
	var rows []map[string]any
	json.NewDecoder(resp.Body).Decode(&rows)
	resp.Body.Close()
	if rows[0]["state"] != "pending" {
		t.Fatalf("a dry run changes nothing: %v", rows)
	}
	res, body = do(t, "POST", srv.URL+"/api/default/run", map[string]any{"direction": "up"}, writeHdr)
	if res.StatusCode != 200 || len(body["results"].([]any)) != 2 {
		t.Fatalf("up: %d %v", res.StatusCode, body)
	}
	res, body = do(t, "POST", srv.URL+"/api/default/run", map[string]any{"direction": "up"}, writeHdr)
	if res.StatusCode != 200 || body["message"] != "Nothing to do." {
		t.Fatalf("nothing left: %d %v", res.StatusCode, body)
	}
	res, body = do(t, "POST", srv.URL+"/api/default/run", map[string]any{"direction": "down", "steps": 1}, writeHdr)
	if res.StatusCode != 200 {
		t.Fatalf("down: %d %v", res.StatusCode, body)
	}
	res, _ = do(t, "POST", srv.URL+"/api/default/run", map[string]any{"direction": "sideways"}, writeHdr)
	if res.StatusCode != 400 {
		t.Fatalf("bad direction: %d", res.StatusCode)
	}
	res, _ = do(t, "POST", srv.URL+"/api/default/run", map[string]any{"direction": "up", "bogus": 1}, writeHdr)
	if res.StatusCode != 400 {
		t.Fatalf("unknown field: %d", res.StatusCode)
	}
	res, _ = do(t, "POST", srv.URL+"/api/nope/run", map[string]any{"direction": "up"}, writeHdr)
	if res.StatusCode != 404 {
		t.Fatalf("unknown database: %d", res.StatusCode)
	}
}

func TestWritesNeedASameSiteRequestWithTheCustomHeader(t *testing.T) {
	srv, _ := newServer(t, Options{Addr: "127.0.0.1:8484", AllowWrite: true})
	body := map[string]any{"direction": "up", "dry_run": true}
	if res, _ := do(t, "POST", srv.URL+"/api/default/run", body, nil); res.StatusCode != 403 {
		t.Errorf("a plain form post has no custom header: %d", res.StatusCode)
	}
	evil := map[string]string{"X-SQLMal": "1", "Origin": "https://evil.example"}
	if res, _ := do(t, "POST", srv.URL+"/api/default/run", body, evil); res.StatusCode != 403 {
		t.Errorf("a request from another site is refused: %d", res.StatusCode)
	}
	same := map[string]string{"X-SQLMal": "1", "Origin": srv.URL}
	if res, _ := do(t, "POST", srv.URL+"/api/default/run", body, same); res.StatusCode != 200 {
		t.Errorf("the UI's own requests work: %d", res.StatusCode)
	}
}

func TestHostHeaderMustBeLocal(t *testing.T) {
	srv, _ := newServer(t, Options{Addr: "127.0.0.1:8484"})
	for host, want := range map[string]int{"localhost:8484": 200, "127.0.0.1:8484": 200, "[::1]:8484": 200, "attacker.example:8484": 403, "evil.test": 403} {
		res, _ := do(t, "GET", srv.URL+"/api/info", nil, map[string]string{"Host": host})
		if res.StatusCode != want {
			t.Errorf("Host %s: got %d want %d", host, res.StatusCode, want)
		}
	}
}

func TestTokenIsRequiredWhenSet(t *testing.T) {
	srv, _ := newServer(t, Options{Addr: "127.0.0.1:8484", Token: "s3cret-token"})
	if res, _ := do(t, "GET", srv.URL+"/api/info", nil, nil); res.StatusCode != 401 {
		t.Errorf("no token: %d", res.StatusCode)
	}
	if res, _ := do(t, "GET", srv.URL+"/api/info", nil, map[string]string{"Authorization": "Bearer wrong"}); res.StatusCode != 401 {
		t.Errorf("wrong token: %d", res.StatusCode)
	}
	if res, _ := do(t, "GET", srv.URL+"/api/info", nil, map[string]string{"Authorization": "Bearer s3cret-token"}); res.StatusCode != 200 {
		t.Errorf("right token: %d", res.StatusCode)
	}
	// The UI itself is public: it holds no data, and cannot call the API without the token.
	if res, _ := do(t, "GET", srv.URL+"/", nil, nil); res.StatusCode != 200 {
		t.Errorf("app shell: %d", res.StatusCode)
	}
}

func TestValidateBind(t *testing.T) {
	for addr, token := range map[string]string{"127.0.0.1:8484": "", "localhost:8484": "", "[::1]:8484": "", "0.0.0.0:8484": "tok", "192.168.1.5:8484": "tok"} {
		if err := ValidateBind(addr, token); err != nil {
			t.Errorf("%s with token %q should be allowed: %v", addr, token, err)
		}
	}
	for _, addr := range []string{"0.0.0.0:8484", ":8484", "192.168.1.5:8484", "example.com:80"} {
		if err := ValidateBind(addr, ""); err == nil {
			t.Errorf("%s without a token must be refused", addr)
		}
	}
}

func TestSecurityHeadersAndStaticRouting(t *testing.T) {
	srv, _ := newServer(t, Options{Addr: "127.0.0.1:8484"})
	res, _ := do(t, "GET", srv.URL+"/", nil, nil)
	for h, want := range map[string]string{"X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer"} {
		if res.Header.Get(h) != want {
			t.Errorf("%s = %q", h, res.Header.Get(h))
		}
	}
	if !strings.Contains(res.Header.Get("Content-Security-Policy"), "default-src 'self'") {
		t.Error("CSP missing")
	}
	if res, _ := do(t, "GET", srv.URL+"/schema", nil, nil); res.StatusCode != 200 {
		t.Errorf("a client-side route serves the app shell: %d", res.StatusCode)
	}
	if res, _ := do(t, "GET", srv.URL+"/missing.js", nil, nil); res.StatusCode != 404 {
		t.Errorf("a missing file is a 404: %d", res.StatusCode)
	}
	if res, _ := do(t, "GET", srv.URL+"/api/nothing/here/at/all", nil, nil); res.StatusCode != 404 {
		t.Errorf("unknown api: %d", res.StatusCode)
	}
	if res, _ := do(t, "GET", srv.URL+"/api/info", nil, nil); res.Header.Get("Cache-Control") != "no-store" {
		t.Error("api responses must not be cached")
	}
}

func TestErrorsDoNotLeakCredentials(t *testing.T) {
	got := scrub("failed to connect to postgres://admin:hunter2@db.internal:5432/shop and password=hunter2 was wrong")
	if strings.Contains(got, "hunter2") {
		t.Fatalf("scrub leaked a secret: %s", got)
	}
}
