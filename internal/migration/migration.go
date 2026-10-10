// Package migration loads versioned SQL migration files from a directory.
//
// Files are named VERSION_name.up.sql and VERSION_name.down.sql. VERSION is a
// number (0001, or a timestamp like 20261010120000); migrations run in
// ascending version order. A file may start with the comment
//
//	-- migrate:no-transaction
//
// for statements that cannot run inside a transaction, such as
// CREATE INDEX CONCURRENTLY.
package migration

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

type Migration struct {
	Version  int64  `json:"version"`
	Name     string `json:"name"`
	UpSQL    string `json:"up_sql"`
	DownSQL  string `json:"down_sql"`
	UpPath   string `json:"up_path"`
	DownPath string `json:"down_path,omitempty"`
	// Checksum is the SHA-256 of the normalised up file. Editing an applied
	// migration changes it, which the engine reports as drift.
	Checksum string `json:"checksum"`
	// NoTx means the up file asks to run outside a transaction.
	NoTx     bool `json:"no_tx"`
	DownNoTx bool `json:"down_no_tx"`
	HasDown  bool `json:"has_down"`
	// OneWay means the down file says, with -- migrate:irreversible, that this
	// change cannot or should not be undone. Lint and verify treat it as a decision, not a mistake.
	OneWay bool `json:"one_way"`
}

type Set []Migration

var fileRe = regexp.MustCompile(`^(\d{1,14})_([A-Za-z0-9][A-Za-z0-9_]*)\.(up|down)\.sql$`)

const (
	noTxDirective         = "migrate:no-transaction"
	irreversibleDirective = "migrate:irreversible"
)

// Load reads and validates every migration in dir.
func Load(dir string) (Set, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("read migrations directory: %w", err)
	}
	byVersion := map[int64]*Migration{}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".sql") {
			continue
		}
		m := fileRe.FindStringSubmatch(e.Name())
		if m == nil {
			return nil, fmt.Errorf("%s: file name must look like 0001_create_users.up.sql", e.Name())
		}
		version, _ := strconv.ParseInt(m[1], 10, 64)
		name, dir2 := m[2], m[3]
		raw, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			return nil, err
		}
		text := normalizeNewlines(string(raw))
		mig := byVersion[version]
		if mig == nil {
			mig = &Migration{Version: version, Name: name}
			byVersion[version] = mig
		} else if mig.Name != name {
			return nil, fmt.Errorf("version %d has two different names: %q and %q", version, mig.Name, name)
		}
		path := filepath.Join(dir, e.Name())
		if dir2 == "up" {
			if mig.UpPath != "" {
				return nil, fmt.Errorf("version %d has two up files", version)
			}
			mig.UpSQL, mig.UpPath, mig.NoTx = text, path, hasNoTx(text)
			mig.Checksum = checksum(text)
		} else {
			mig.DownSQL, mig.DownPath, mig.DownNoTx, mig.HasDown = text, path, hasNoTx(text), strings.TrimSpace(stripComments(text)) != ""
			mig.OneWay = !mig.HasDown && strings.Contains(text, irreversibleDirective)
		}
	}
	out := make(Set, 0, len(byVersion))
	for _, m := range byVersion {
		if m.UpPath == "" {
			return nil, fmt.Errorf("version %d (%s) has a down file but no up file", m.Version, m.Name)
		}
		if strings.TrimSpace(stripComments(m.UpSQL)) == "" {
			return nil, fmt.Errorf("%s is empty", filepath.Base(m.UpPath))
		}
		out = append(out, *m)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Version < out[j].Version })
	return out, nil
}

func normalizeNewlines(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	return strings.ReplaceAll(s, "\r", "\n")
}

// checksum ignores line-ending style and trailing blank lines, so a Windows
// checkout does not look like an edited migration.
func checksum(text string) string {
	sum := sha256.Sum256([]byte(strings.TrimRight(text, " \t\n") + "\n"))
	return hex.EncodeToString(sum[:])
}

func hasNoTx(text string) bool {
	for _, line := range strings.Split(text, "\n") {
		l := strings.TrimSpace(line)
		if l == "" {
			continue
		}
		if !strings.HasPrefix(l, "--") {
			return false // directives are only honoured in the leading comment block
		}
		if strings.Contains(l, noTxDirective) {
			return true
		}
	}
	return false
}

func stripComments(text string) string {
	var b strings.Builder
	for _, line := range strings.Split(text, "\n") {
		if i := strings.Index(line, "--"); i >= 0 {
			line = line[:i]
		}
		b.WriteString(line)
		b.WriteByte('\n')
	}
	return b.String()
}

func (s Set) ByVersion(v int64) (Migration, bool) {
	for _, m := range s {
		if m.Version == v {
			return m, true
		}
	}
	return Migration{}, false
}

// NextVersion picks the version for a new migration. Sequential directories
// (all versions below 100000) get max+1; anything else gets a UTC timestamp.
func NextVersion(s Set, now time.Time) int64 {
	var max int64
	sequential := true
	for _, m := range s {
		if m.Version > max {
			max = m.Version
		}
		if m.Version >= 100000 {
			sequential = false
		}
	}
	if len(s) > 0 && sequential {
		return max + 1
	}
	if len(s) == 0 {
		return 1
	}
	v, _ := strconv.ParseInt(now.UTC().Format("20060102150405"), 10, 64)
	return v
}

var nameRe = regexp.MustCompile(`^[a-z][a-z0-9_]{0,60}$`)

// Create writes an empty up/down pair for a new migration and returns the paths.
func Create(dir, name string, now time.Time) (up, down string, err error) {
	name = strings.ToLower(strings.ReplaceAll(strings.TrimSpace(name), " ", "_"))
	if !nameRe.MatchString(name) {
		return "", "", errors.New("name must be lower case letters, digits and underscores, starting with a letter")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", "", err
	}
	set, err := Load(dir)
	if err != nil {
		return "", "", err
	}
	v := NextVersion(set, now)
	width := 4
	if v >= 100000 {
		width = 14
	}
	base := fmt.Sprintf("%0*d_%s", width, v, name)
	up, down = filepath.Join(dir, base+".up.sql"), filepath.Join(dir, base+".down.sql")
	if err := os.WriteFile(up, []byte("-- Write the change here.\n"), 0o644); err != nil {
		return "", "", err
	}
	if err := os.WriteFile(down, []byte("-- Write how to undo it here.\n"), 0o644); err != nil {
		return "", "", err
	}
	return up, down, nil
}
