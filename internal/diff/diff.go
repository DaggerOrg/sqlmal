// Package diff compares two schemas and writes the SQL that turns one into the other.
package diff

import (
	"fmt"
	"reflect"
	"sort"
	"strings"

	"github.com/Stephen-SMH/sqlmal/internal/introspect"
)

type Kind string

const (
	TableAdded     Kind = "table_added"
	TableRemoved   Kind = "table_removed"
	ColumnAdded    Kind = "column_added"
	ColumnRemoved  Kind = "column_removed"
	ColumnChanged  Kind = "column_changed"
	PKChanged      Kind = "primary_key_changed"
	UniqueAdded    Kind = "unique_added"
	UniqueRemoved  Kind = "unique_removed"
	FKAdded        Kind = "foreign_key_added"
	FKRemoved      Kind = "foreign_key_removed"
	CheckAdded     Kind = "check_added"
	CheckRemoved   Kind = "check_removed"
	IndexAdded     Kind = "index_added"
	IndexRemoved   Kind = "index_removed"
	EnumAdded      Kind = "enum_added"
	EnumRemoved    Kind = "enum_removed"
	EnumValueAdded Kind = "enum_value_added"
)

// Change is one difference between two schemas.
type Change struct {
	Kind   Kind   `json:"kind"`
	Table  string `json:"table,omitempty"`
	Object string `json:"object,omitempty"` // column, index, constraint or type name
	Detail string `json:"detail,omitempty"`
	// Destructive means applying the change can lose data.
	Destructive bool `json:"destructive,omitempty"`
}

func (c Change) String() string {
	target := c.Table
	if c.Object != "" && c.Table != "" {
		target += "." + c.Object
	} else if c.Object != "" {
		target = c.Object
	}
	s := fmt.Sprintf("%s %s", c.Kind, target)
	if c.Detail != "" {
		s += " (" + c.Detail + ")"
	}
	return s
}

// Compare lists what changed going from a to b. The result is sorted so that
// the same two schemas always give the same list.
func Compare(a, b introspect.Schema) []Change {
	var out []Change
	ta, tb := tableMap(a), tableMap(b)

	for _, e := range b.Enums {
		old, ok := enumMap(a)[e.Name]
		if !ok {
			out = append(out, Change{Kind: EnumAdded, Object: e.Name, Detail: strings.Join(e.Labels, ", ")})
			continue
		}
		have := map[string]bool{}
		for _, l := range old.Labels {
			have[l] = true
		}
		for _, l := range e.Labels {
			if !have[l] {
				out = append(out, Change{Kind: EnumValueAdded, Object: e.Name, Detail: l})
			}
		}
	}
	for _, e := range a.Enums {
		if _, ok := enumMap(b)[e.Name]; !ok {
			out = append(out, Change{Kind: EnumRemoved, Object: e.Name, Destructive: true})
		}
	}

	for _, name := range sortedNames(ta, tb) {
		x, inA := ta[name]
		y, inB := tb[name]
		switch {
		case !inA:
			out = append(out, Change{Kind: TableAdded, Table: name, Detail: fmt.Sprintf("%d columns", len(y.Columns))})
		case !inB:
			out = append(out, Change{Kind: TableRemoved, Table: name, Destructive: true})
		default:
			out = append(out, compareTable(x, y)...)
		}
	}
	return out
}

func compareTable(a, b introspect.Table) []Change {
	var out []Change
	n := b.Name
	ca, cb := colMap(a), colMap(b)
	for _, c := range b.Columns {
		old, ok := ca[c.Name]
		if !ok {
			out = append(out, Change{Kind: ColumnAdded, Table: n, Object: c.Name, Detail: colSummary(c)})
			continue
		}
		if d := colDiff(old, c); d != "" {
			out = append(out, Change{Kind: ColumnChanged, Table: n, Object: c.Name, Detail: d,
				Destructive: old.Type != c.Type})
		}
	}
	for _, c := range a.Columns {
		if _, ok := cb[c.Name]; !ok {
			out = append(out, Change{Kind: ColumnRemoved, Table: n, Object: c.Name, Destructive: true})
		}
	}
	if !reflect.DeepEqual(a.PrimaryKey, b.PrimaryKey) {
		out = append(out, Change{Kind: PKChanged, Table: n, Detail: fmt.Sprintf("(%s) to (%s)", strings.Join(a.PrimaryKey, ", "), strings.Join(b.PrimaryKey, ", "))})
	}
	ua, ub := map[string]introspect.Unique{}, map[string]introspect.Unique{}
	for _, u := range a.Uniques {
		ua[u.Name] = u
	}
	for _, u := range b.Uniques {
		ub[u.Name] = u
	}
	for _, name := range keys(ua, ub) {
		x, inA := ua[name]
		y, inB := ub[name]
		switch {
		case !inA:
			out = append(out, Change{Kind: UniqueAdded, Table: n, Object: name, Detail: strings.Join(y.Columns, ", ")})
		case !inB:
			out = append(out, Change{Kind: UniqueRemoved, Table: n, Object: name, Detail: strings.Join(x.Columns, ", ")})
		case !reflect.DeepEqual(x.Columns, y.Columns):
			out = append(out, Change{Kind: UniqueRemoved, Table: n, Object: name}, Change{Kind: UniqueAdded, Table: n, Object: name, Detail: strings.Join(y.Columns, ", ")})
		}
	}
	fa, fb := map[string]introspect.ForeignKey{}, map[string]introspect.ForeignKey{}
	for _, f := range a.ForeignKeys {
		fa[f.Name] = f
	}
	for _, f := range b.ForeignKeys {
		fb[f.Name] = f
	}
	for _, name := range keys(fa, fb) {
		x, inA := fa[name]
		y, inB := fb[name]
		switch {
		case !inA:
			out = append(out, Change{Kind: FKAdded, Table: n, Object: name, Detail: fkSummary(y)})
		case !inB:
			out = append(out, Change{Kind: FKRemoved, Table: n, Object: name, Detail: fkSummary(x)})
		case !reflect.DeepEqual(x, y):
			out = append(out, Change{Kind: FKRemoved, Table: n, Object: name, Detail: fkSummary(x)}, Change{Kind: FKAdded, Table: n, Object: name, Detail: fkSummary(y)})
		}
	}
	cka, ckb := map[string]introspect.Check{}, map[string]introspect.Check{}
	for _, c := range a.Checks {
		cka[c.Name] = c
	}
	for _, c := range b.Checks {
		ckb[c.Name] = c
	}
	for _, name := range keys(cka, ckb) {
		x, inA := cka[name]
		y, inB := ckb[name]
		switch {
		case !inA:
			out = append(out, Change{Kind: CheckAdded, Table: n, Object: name, Detail: y.Expr})
		case !inB:
			out = append(out, Change{Kind: CheckRemoved, Table: n, Object: name, Detail: x.Expr})
		case x.Expr != y.Expr:
			out = append(out, Change{Kind: CheckRemoved, Table: n, Object: name, Detail: x.Expr}, Change{Kind: CheckAdded, Table: n, Object: name, Detail: y.Expr})
		}
	}
	ia, ib := indexMap(a), indexMap(b)
	for _, name := range keys(ia, ib) {
		x, inA := ia[name]
		y, inB := ib[name]
		switch {
		case !inA:
			out = append(out, Change{Kind: IndexAdded, Table: n, Object: name, Detail: strings.Join(y.Columns, ", ")})
		case !inB:
			out = append(out, Change{Kind: IndexRemoved, Table: n, Object: name, Detail: strings.Join(x.Columns, ", ")})
		case x.Def != y.Def:
			out = append(out, Change{Kind: IndexRemoved, Table: n, Object: name, Detail: strings.Join(x.Columns, ", ")}, Change{Kind: IndexAdded, Table: n, Object: name, Detail: strings.Join(y.Columns, ", ")})
		}
	}
	return out
}

// indexMap holds the plain indexes only: primary keys and unique constraints
// have their own entries, and listing their backing index again would double count.
func indexMap(t introspect.Table) map[string]introspect.Index {
	backing := map[string]bool{t.PrimaryKeyName: true}
	for _, u := range t.Uniques {
		backing[u.Name] = true
	}
	m := map[string]introspect.Index{}
	for _, i := range t.Indexes {
		if !i.Primary && !backing[i.Name] {
			m[i.Name] = i
		}
	}
	return m
}

func colDiff(a, b introspect.Column) string {
	var d []string
	if a.Type != b.Type {
		d = append(d, fmt.Sprintf("type %s to %s", a.Type, b.Type))
	}
	if a.NotNull != b.NotNull {
		if b.NotNull {
			d = append(d, "now NOT NULL")
		} else {
			d = append(d, "now nullable")
		}
	}
	if a.Default != b.Default {
		d = append(d, fmt.Sprintf("default %s to %s", orNone(a.Default), orNone(b.Default)))
	}
	if a.Identity != b.Identity {
		d = append(d, fmt.Sprintf("identity %s to %s", orNone(a.Identity), orNone(b.Identity)))
	}
	if a.Generated != b.Generated {
		d = append(d, "generated expression changed")
	}
	return strings.Join(d, "; ")
}

func orNone(s string) string {
	if s == "" {
		return "none"
	}
	return s
}

func colSummary(c introspect.Column) string {
	s := c.Type
	if c.NotNull {
		s += " NOT NULL"
	}
	if c.Default != "" {
		s += " DEFAULT " + c.Default
	}
	return s
}

func fkSummary(f introspect.ForeignKey) string {
	return fmt.Sprintf("(%s) references %s(%s) on delete %s", strings.Join(f.Columns, ", "), f.RefTable, strings.Join(f.RefColumns, ", "), strings.ToLower(f.OnDelete))
}

func tableMap(s introspect.Schema) map[string]introspect.Table {
	m := map[string]introspect.Table{}
	for _, t := range s.Tables {
		m[t.Name] = t
	}
	return m
}

func enumMap(s introspect.Schema) map[string]introspect.Enum {
	m := map[string]introspect.Enum{}
	for _, e := range s.Enums {
		m[e.Name] = e
	}
	return m
}

func colMap(t introspect.Table) map[string]introspect.Column {
	m := map[string]introspect.Column{}
	for _, c := range t.Columns {
		m[c.Name] = c
	}
	return m
}

func sortedNames(a, b map[string]introspect.Table) []string {
	set := map[string]bool{}
	for k := range a {
		set[k] = true
	}
	for k := range b {
		set[k] = true
	}
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func keys[V any](a, b map[string]V) []string {
	set := map[string]bool{}
	for k := range a {
		set[k] = true
	}
	for k := range b {
		set[k] = true
	}
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
