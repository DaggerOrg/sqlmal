// Package config reads sqlmal.json.
//
// Connection strings are read from environment variables by default, so a
// password never has to sit in a file that gets committed.
package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
)

type Database struct {
	Name string `json:"name"`
	// DSNEnv names the environment variable holding the connection URL.
	DSNEnv string `json:"dsn_env,omitempty"`
	// DSN is a literal URL. Fine for a local demo; avoid it for real passwords.
	DSN        string `json:"dsn,omitempty"`
	Migrations string `json:"migrations"`
}

type Config struct {
	Databases []Database `json:"databases"`
	// ShadowAdminDSNEnv optionally names a variable with the URL of a server
	// where scratch databases may be created. Defaults to the target's server.
	ShadowAdminDSNEnv string `json:"shadow_admin_dsn_env,omitempty"`
}

var nameRe = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,40}$`)

// Load reads a config file. Relative migration directories are resolved from
// the file's own directory.
func Load(path string) (Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return Config{}, err
	}
	var c Config
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&c); err != nil {
		return Config{}, fmt.Errorf("%s: %w", path, err)
	}
	if len(c.Databases) == 0 {
		return Config{}, errors.New("the config lists no databases")
	}
	seen := map[string]bool{}
	for i, d := range c.Databases {
		if !nameRe.MatchString(d.Name) {
			return Config{}, fmt.Errorf("database %d: name must be lower case letters, digits, - or _", i+1)
		}
		if seen[d.Name] {
			return Config{}, fmt.Errorf("database name %q is used twice", d.Name)
		}
		seen[d.Name] = true
		if d.DSN == "" && d.DSNEnv == "" {
			return Config{}, fmt.Errorf("database %q needs dsn_env (or dsn)", d.Name)
		}
		if d.Migrations == "" {
			return Config{}, fmt.Errorf("database %q needs a migrations directory", d.Name)
		}
		if !filepath.IsAbs(d.Migrations) {
			c.Databases[i].Migrations = filepath.Join(filepath.Dir(path), d.Migrations)
		}
	}
	return c, nil
}

// ResolveDSN returns the connection URL for d.
func (d Database) ResolveDSN() (string, error) {
	if d.DSNEnv != "" {
		if v := os.Getenv(d.DSNEnv); v != "" {
			return v, nil
		}
		if d.DSN == "" {
			return "", fmt.Errorf("environment variable %s is not set (needed for database %q)", d.DSNEnv, d.Name)
		}
	}
	return d.DSN, nil
}

// Single builds a one-database config from flags, for quick use without a file.
func Single(dsn, dir string) Config {
	return Config{Databases: []Database{{Name: "default", DSN: dsn, Migrations: dir}}}
}
