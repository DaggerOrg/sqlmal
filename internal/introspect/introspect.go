// Package introspect reads a PostgreSQL schema from the system catalogs into
// a plain, sorted, comparable model. It only reads, inside a read-only
// transaction.
package introspect

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
)

type Column struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	NotNull  bool   `json:"not_null"`
	Default  string `json:"default,omitempty"`
	Identity string `json:"identity,omitempty"` // "always" or "by default"
	// Generated is the expression of a stored generated column.
	Generated string `json:"generated,omitempty"`
	Comment   string `json:"comment,omitempty"`
}

type ForeignKey struct {
	Name       string   `json:"name"`
	Columns    []string `json:"columns"`
	RefTable   string   `json:"ref_table"`
	RefColumns []string `json:"ref_columns"`
	OnDelete   string   `json:"on_delete"`
	OnUpdate   string   `json:"on_update"`
}

type Unique struct {
	Name    string   `json:"name"`
	Columns []string `json:"columns"`
}

type Check struct {
	Name string `json:"name"`
	Expr string `json:"expr"`
}

type Index struct {
	Name    string   `json:"name"`
	Def     string   `json:"def"`
	Unique  bool     `json:"unique"`
	Primary bool     `json:"primary"`
	Method  string   `json:"method"`
	Columns []string `json:"columns"` // "(expr)" for expression columns
}

type Table struct {
	Name           string       `json:"name"`
	Partitioned    bool         `json:"partitioned,omitempty"`
	Columns        []Column     `json:"columns"`
	PrimaryKey     []string     `json:"primary_key"`
	PrimaryKeyName string       `json:"primary_key_name,omitempty"`
	Uniques        []Unique     `json:"uniques"`
	ForeignKeys    []ForeignKey `json:"foreign_keys"`
	Checks         []Check      `json:"checks"`
	Indexes        []Index      `json:"indexes"`
	RowEstimate    int64        `json:"row_estimate"`
	SizeBytes      int64        `json:"size_bytes"`
	Comment        string       `json:"comment,omitempty"`
}

type Enum struct {
	Name   string   `json:"name"`
	Labels []string `json:"labels"`
}

type Schema struct {
	Tables []Table `json:"tables"`
	Enums  []Enum  `json:"enums"`
}

// Table returns the table with the given name.
func (s Schema) Table(name string) (Table, bool) {
	for _, t := range s.Tables {
		if t.Name == name {
			return t, true
		}
	}
	return Table{}, false
}

// Options narrow what is read.
type Options struct {
	// Schemas to read. Defaults to ["public"].
	Schemas []string
	// IncludeTool keeps SQLMal's own bookkeeping tables in the result.
	IncludeTool bool
}

var toolTables = map[string]bool{"schema_migrations": true, "migration_history": true}

// Read loads the schema.
func Read(ctx context.Context, conn *pgx.Conn, o Options) (Schema, error) {
	if len(o.Schemas) == 0 {
		o.Schemas = []string{"public"}
	}
	tx, err := conn.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return Schema{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	return ReadTx(ctx, tx, o)
}

// ReadTx reads inside a transaction the caller already has, so it can see
// schema changes that have not been committed.
func ReadTx(ctx context.Context, tx pgx.Tx, o Options) (Schema, error) {
	if len(o.Schemas) == 0 {
		o.Schemas = []string{"public"}
	}
	var err error
	var out Schema
	byOID := map[uint32]int{}
	rows, err := tx.Query(ctx, `
		SELECT c.oid, c.relname, c.relkind = 'p', GREATEST(c.reltuples, 0)::bigint,
		       pg_total_relation_size(c.oid), COALESCE(obj_description(c.oid, 'pg_class'), '')
		FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = ANY($1) AND c.relkind IN ('r','p') AND NOT c.relispartition
		ORDER BY c.relname`, o.Schemas)
	if err != nil {
		return Schema{}, err
	}
	for rows.Next() {
		var oid uint32
		var t Table
		if err := rows.Scan(&oid, &t.Name, &t.Partitioned, &t.RowEstimate, &t.SizeBytes, &t.Comment); err != nil {
			rows.Close()
			return Schema{}, err
		}
		if !o.IncludeTool && toolTables[t.Name] {
			continue
		}
		t.Columns, t.PrimaryKey, t.Uniques, t.ForeignKeys, t.Checks, t.Indexes = []Column{}, []string{}, []Unique{}, []ForeignKey{}, []Check{}, []Index{}
		byOID[oid] = len(out.Tables)
		out.Tables = append(out.Tables, t)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return Schema{}, err
	}

	if err := readColumns(ctx, tx, byOID, &out); err != nil {
		return Schema{}, err
	}
	if err := readConstraints(ctx, tx, byOID, &out); err != nil {
		return Schema{}, err
	}
	if err := readIndexes(ctx, tx, byOID, &out); err != nil {
		return Schema{}, err
	}
	if out.Enums, err = readEnums(ctx, tx, o.Schemas); err != nil {
		return Schema{}, err
	}
	return out, nil
}

func readColumns(ctx context.Context, tx pgx.Tx, byOID map[uint32]int, s *Schema) error {
	rows, err := tx.Query(ctx, `
		SELECT a.attrelid, a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull,
		       COALESCE(pg_get_expr(d.adbin, d.adrelid), ''), a.attidentity::text, a.attgenerated::text,
		       COALESCE(col_description(a.attrelid, a.attnum), '')
		FROM pg_attribute a
		LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
		WHERE a.attrelid = ANY($1) AND a.attnum > 0 AND NOT a.attisdropped
		ORDER BY a.attrelid, a.attnum`, oids(byOID))
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var oid uint32
		var c Column
		var def, ident, gen string
		if err := rows.Scan(&oid, &c.Name, &c.Type, &c.NotNull, &def, &ident, &gen, &c.Comment); err != nil {
			return err
		}
		switch ident {
		case "a":
			c.Identity = "always"
		case "d":
			c.Identity = "by default"
		}
		if gen == "s" {
			c.Generated, c.Default = def, ""
		} else if c.Identity == "" {
			c.Default = def
		}
		t := &s.Tables[byOID[oid]]
		t.Columns = append(t.Columns, c)
	}
	return rows.Err()
}

var actions = map[string]string{"a": "NO ACTION", "r": "RESTRICT", "c": "CASCADE", "n": "SET NULL", "d": "SET DEFAULT"}

func readConstraints(ctx context.Context, tx pgx.Tx, byOID map[uint32]int, s *Schema) error {
	rows, err := tx.Query(ctx, `
		SELECT c.conrelid, c.conname, c.contype::text,
		       ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY k(n, o)
		             JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n ORDER BY k.o),
		       COALESCE(rt.relname, ''),
		       ARRAY(SELECT a.attname FROM unnest(c.confkey) WITH ORDINALITY k(n, o)
		             JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.n ORDER BY k.o),
		       c.confdeltype::text, c.confupdtype::text,
		       CASE WHEN c.contype = 'c' THEN pg_get_constraintdef(c.oid) ELSE '' END
		FROM pg_constraint c LEFT JOIN pg_class rt ON rt.oid = c.confrelid
		WHERE c.conrelid = ANY($1) AND c.contype IN ('p','u','f','c')
		ORDER BY c.conrelid, c.conname`, oids(byOID))
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var oid uint32
		var name, typ, ref, del, upd, def string
		var cols, refCols []string
		if err := rows.Scan(&oid, &name, &typ, &cols, &ref, &refCols, &del, &upd, &def); err != nil {
			return err
		}
		t := &s.Tables[byOID[oid]]
		switch typ {
		case "p":
			t.PrimaryKey, t.PrimaryKeyName = cols, name
		case "u":
			t.Uniques = append(t.Uniques, Unique{Name: name, Columns: cols})
		case "f":
			t.ForeignKeys = append(t.ForeignKeys, ForeignKey{Name: name, Columns: cols, RefTable: ref, RefColumns: refCols, OnDelete: actions[del], OnUpdate: actions[upd]})
		case "c":
			t.Checks = append(t.Checks, Check{Name: name, Expr: strings.TrimPrefix(def, "CHECK ")})
		}
	}
	return rows.Err()
}

func readIndexes(ctx context.Context, tx pgx.Tx, byOID map[uint32]int, s *Schema) error {
	rows, err := tx.Query(ctx, `
		SELECT i.indrelid, ic.relname, pg_get_indexdef(i.indexrelid), i.indisunique, i.indisprimary, am.amname,
		       ARRAY(SELECT CASE WHEN k.n = 0 THEN '(expr)' ELSE a.attname END
		             FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(n, o)
		             LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.n
		             WHERE k.o <= i.indnkeyatts ORDER BY k.o)
		FROM pg_index i
		JOIN pg_class ic ON ic.oid = i.indexrelid
		JOIN pg_am am ON am.oid = ic.relam
		WHERE i.indrelid = ANY($1)
		ORDER BY i.indrelid, ic.relname`, oids(byOID))
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var oid uint32
		var x Index
		if err := rows.Scan(&oid, &x.Name, &x.Def, &x.Unique, &x.Primary, &x.Method, &x.Columns); err != nil {
			return err
		}
		t := &s.Tables[byOID[oid]]
		t.Indexes = append(t.Indexes, x)
	}
	return rows.Err()
}

func readEnums(ctx context.Context, tx pgx.Tx, schemas []string) ([]Enum, error) {
	rows, err := tx.Query(ctx, `
		SELECT t.typname, e.enumlabel FROM pg_type t
		JOIN pg_namespace n ON n.oid = t.typnamespace
		JOIN pg_enum e ON e.enumtypid = t.oid
		WHERE n.nspname = ANY($1) ORDER BY t.typname, e.enumsortorder`, schemas)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Enum{}
	for rows.Next() {
		var name, label string
		if err := rows.Scan(&name, &label); err != nil {
			return nil, err
		}
		if len(out) == 0 || out[len(out)-1].Name != name {
			out = append(out, Enum{Name: name})
		}
		out[len(out)-1].Labels = append(out[len(out)-1].Labels, label)
	}
	return out, rows.Err()
}

func oids(m map[uint32]int) []uint32 {
	out := make([]uint32, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// Describe is a one-line summary, for logs and tests.
func (s Schema) Describe() string {
	cols := 0
	for _, t := range s.Tables {
		cols += len(t.Columns)
	}
	return fmt.Sprintf("%d tables, %d columns, %d enums", len(s.Tables), cols, len(s.Enums))
}
