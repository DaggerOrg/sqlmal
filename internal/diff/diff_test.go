package diff

import (
	"context"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/Stephen-SMH/sqlmal/internal/introspect"
	"github.com/Stephen-SMH/sqlmal/internal/testdb"
)

func col(name, typ string, notNull bool) introspect.Column {
	return introspect.Column{Name: name, Type: typ, NotNull: notNull}
}

func tbl(name string, cols ...introspect.Column) introspect.Table {
	return introspect.Table{Name: name, Columns: cols, PrimaryKey: []string{}, Uniques: []introspect.Unique{}, ForeignKeys: []introspect.ForeignKey{}, Checks: []introspect.Check{}, Indexes: []introspect.Index{}}
}

func kinds(cs []Change) string {
	var k []string
	for _, c := range cs {
		k = append(k, string(c.Kind)+":"+c.Table+"."+c.Object)
	}
	return strings.Join(k, " ")
}

func TestCompareFindsEachKindOfChange(t *testing.T) {
	a := introspect.Schema{Tables: []introspect.Table{
		tbl("users", col("id", "integer", true), col("email", "text", true), col("old", "text", false)),
		tbl("gone", col("id", "integer", true)),
	}, Enums: []introspect.Enum{{Name: "status", Labels: []string{"a", "b"}}}}
	b := introspect.Schema{Tables: []introspect.Table{
		tbl("users", col("id", "bigint", true), col("email", "text", false), col("age", "integer", false)),
		tbl("fresh", col("id", "integer", true)),
	}, Enums: []introspect.Enum{{Name: "status", Labels: []string{"a", "b", "c"}}, {Name: "kind", Labels: []string{"x"}}}}
	got := Compare(a, b)
	want := []string{
		"enum_value_added:.status", "enum_added:.kind",
		"table_added:fresh.", "table_removed:gone.",
		"column_added:users.age", "column_changed:users.email", "column_changed:users.id", "column_removed:users.old",
	}
	for _, w := range want {
		if !strings.Contains(kinds(got), w) {
			t.Errorf("missing %s in %s", w, kinds(got))
		}
	}
	for _, c := range got {
		switch {
		case c.Kind == TableRemoved && !c.Destructive, c.Kind == ColumnRemoved && !c.Destructive:
			t.Errorf("removals are destructive: %+v", c)
		case c.Kind == ColumnChanged && c.Object == "email" && c.Destructive:
			t.Errorf("a nullability change does not lose data: %+v", c)
		case c.Kind == ColumnChanged && c.Object == "id" && !c.Destructive:
			t.Errorf("a type change can lose data: %+v", c)
		}
	}
	if len(Compare(a, a)) != 0 {
		t.Fatal("a schema equals itself")
	}
	if kinds(Compare(a, b)) != kinds(Compare(a, b)) {
		t.Fatal("the order is deterministic")
	}
}

func TestChangedConstraintsAndIndexesAreRemoveThenAdd(t *testing.T) {
	x := tbl("orders", col("id", "integer", true), col("user_id", "integer", true))
	x.ForeignKeys = []introspect.ForeignKey{{Name: "fk", Columns: []string{"user_id"}, RefTable: "users", RefColumns: []string{"id"}, OnDelete: "NO ACTION"}}
	x.Indexes = []introspect.Index{{Name: "idx", Def: "CREATE INDEX idx ON public.orders USING btree (user_id)", Columns: []string{"user_id"}}}
	y := x
	y.ForeignKeys = []introspect.ForeignKey{{Name: "fk", Columns: []string{"user_id"}, RefTable: "users", RefColumns: []string{"id"}, OnDelete: "CASCADE"}}
	y.Indexes = []introspect.Index{{Name: "idx", Def: "CREATE INDEX idx ON public.orders USING btree (user_id, id)", Columns: []string{"user_id", "id"}}}
	got := kinds(Compare(introspect.Schema{Tables: []introspect.Table{x}}, introspect.Schema{Tables: []introspect.Table{y}}))
	for _, w := range []string{"foreign_key_removed:orders.fk", "foreign_key_added:orders.fk", "index_removed:orders.idx", "index_added:orders.idx"} {
		if !strings.Contains(got, w) {
			t.Errorf("missing %s in %s", w, got)
		}
	}
}

func TestIdentQuotesOnlyWhenNeeded(t *testing.T) {
	cases := map[string]string{"users": "users", "user": `"user"`, "Order": `"Order"`, "order": `"order"`, "my table": `"my table"`, `we"ird`: `"we""ird"`, "_ok1": "_ok1", "1abc": `"1abc"`}
	for in, want := range cases {
		if got := Ident(in); got != want {
			t.Errorf("Ident(%q) = %s, want %s", in, got, want)
		}
	}
}

func TestGenerateWritesSerialAndDefersForeignKeys(t *testing.T) {
	users := tbl("users", introspect.Column{Name: "id", Type: "integer", NotNull: true, Default: "nextval('users_id_seq'::regclass)"}, col("email", "text", true))
	users.PrimaryKey, users.PrimaryKeyName = []string{"id"}, "users_pkey"
	posts := tbl("posts", col("id", "integer", true), col("user_id", "integer", true))
	posts.ForeignKeys = []introspect.ForeignKey{{Name: "posts_user_id_fkey", Columns: []string{"user_id"}, RefTable: "users", RefColumns: []string{"id"}, OnDelete: "CASCADE", OnUpdate: "NO ACTION"}}
	s := Generate(introspect.Schema{}, introspect.Schema{Tables: []introspect.Table{posts, users}}) // posts first on purpose
	if !strings.Contains(s.SQL, "id serial,") && !strings.Contains(s.SQL, "id serial\n") && !strings.Contains(s.SQL, "id serial,\n") {
		t.Errorf("a column that owns its sequence is written as serial:\n%s", s.SQL)
	}
	if strings.Contains(s.SQL, "nextval") {
		t.Errorf("no nextval in generated DDL:\n%s", s.SQL)
	}
	create := strings.LastIndex(s.SQL, "CREATE TABLE")
	fk := strings.Index(s.SQL, "ADD CONSTRAINT posts_user_id_fkey")
	if fk < create {
		t.Errorf("foreign keys must come after every CREATE TABLE:\n%s", s.SQL)
	}
	if !strings.Contains(s.SQL, "ON DELETE CASCADE") || strings.Contains(s.SQL, "ON UPDATE NO ACTION") {
		t.Errorf("only non-default actions are written:\n%s", s.SQL)
	}
}

func TestGenerateDropsConstraintsBeforeTablesAndWarnsAboutDataLoss(t *testing.T) {
	users := tbl("users", col("id", "integer", true))
	orders := tbl("orders", col("id", "integer", true), col("user_id", "integer", true))
	orders.ForeignKeys = []introspect.ForeignKey{{Name: "fk", Columns: []string{"user_id"}, RefTable: "users", RefColumns: []string{"id"}}}
	from := introspect.Schema{Tables: []introspect.Table{orders, users}}
	to := introspect.Schema{Tables: []introspect.Table{tbl("orders", col("id", "integer", true))}}
	s := Generate(from, to)
	dropFK := strings.Index(s.SQL, "DROP CONSTRAINT fk")
	dropTbl := strings.Index(s.SQL, "DROP TABLE users")
	if dropFK < 0 || dropTbl < 0 || dropFK > dropTbl {
		t.Errorf("the foreign key must be dropped before the table it points at:\n%s", s.SQL)
	}
	if len(s.Warnings) < 2 {
		t.Errorf("dropping a table and a column warns about data loss: %v", s.Warnings)
	}
	if got := Generate(from, from); got.SQL != "" {
		t.Errorf("identical schemas need no SQL, got %q", got.SQL)
	}
}

// ---- against a real database ----

const fixture = `
CREATE TYPE order_status AS ENUM ('new', 'paid', 'shipped');
CREATE TABLE users (
    id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email    text NOT NULL UNIQUE,
    name     text DEFAULT 'anonymous',
    age      int CHECK (age >= 0),
    created  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE products (
    sku    text PRIMARY KEY,
    price  numeric(10,2) NOT NULL,
    tags   text[] NOT NULL DEFAULT '{}',
    net    numeric GENERATED ALWAYS AS (price / 1.07) STORED
);
CREATE TABLE orders (
    id        serial PRIMARY KEY,
    user_id   bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE RESTRICT,
    status    order_status NOT NULL DEFAULT 'new',
    note      text,
    CONSTRAINT orders_user_status UNIQUE (user_id, status)
);
CREATE INDEX idx_orders_new ON orders (user_id) WHERE status = 'new';
CREATE INDEX idx_orders_lower ON orders (lower(note));
CREATE TABLE order_items (
    order_id int NOT NULL REFERENCES orders(id),
    sku      text NOT NULL REFERENCES products(sku),
    qty      int NOT NULL DEFAULT 1,
    PRIMARY KEY (order_id, sku)
);
CREATE TABLE "user" (id bigserial PRIMARY KEY, "Display Name" text);
`

func read(t *testing.T, dsn string) introspect.Schema {
	t.Helper()
	ctx := context.Background()
	c, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close(ctx)
	s, err := introspect.Read(ctx, c, introspect.Options{})
	if err != nil {
		t.Fatal(err)
	}
	for i := range s.Tables {
		s.Tables[i].RowEstimate, s.Tables[i].SizeBytes = 0, 0
	}
	return s
}

func run(t *testing.T, dsn, sql string) {
	t.Helper()
	ctx := context.Background()
	c, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close(ctx)
	if _, err := c.Exec(ctx, sql); err != nil {
		t.Fatalf("%v\n--- SQL ---\n%s", err, sql)
	}
}

// The strongest check there is: SQL generated from nothing to a complex schema
// must rebuild exactly that schema.
func TestGeneratedSQLRebuildsTheSchemaExactly(t *testing.T) {
	src := testdb.New(t)
	run(t, src, fixture)
	want := read(t, src)

	script := Generate(introspect.Schema{}, want)
	dst := testdb.New(t)
	run(t, dst, script.SQL)
	got := read(t, dst)

	if d := Compare(want, got); len(d) != 0 {
		t.Fatalf("the rebuilt schema differs from the original:\n%v\n--- SQL ---\n%s", d, script.SQL)
	}
}

// Changing a live schema and generating the diff must reproduce the change.
func TestGeneratedDiffTurnsOneSchemaIntoTheOther(t *testing.T) {
	a := testdb.New(t)
	b := testdb.New(t)
	run(t, a, fixture)
	run(t, b, fixture)
	run(t, b, `
		ALTER TABLE users ADD COLUMN nickname text NOT NULL DEFAULT '';
		ALTER TABLE users DROP COLUMN age;
		ALTER TABLE users ALTER COLUMN name SET NOT NULL;
		ALTER TABLE users ALTER COLUMN name SET DEFAULT 'guest';
		ALTER TABLE users ALTER COLUMN email TYPE varchar(255);
		ALTER TABLE products ADD CONSTRAINT price_positive CHECK (price > 0);
		DROP INDEX idx_orders_new;
		CREATE INDEX idx_orders_user ON orders (user_id, status);
		ALTER TABLE orders DROP CONSTRAINT orders_user_status;
		ALTER TABLE orders ADD CONSTRAINT orders_unique_note UNIQUE (note);
		ALTER TABLE order_items DROP CONSTRAINT order_items_order_id_fkey;
		ALTER TABLE order_items ADD CONSTRAINT items_order_fk FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE;
		ALTER TYPE order_status ADD VALUE 'refunded';
		CREATE TABLE audit (id bigserial PRIMARY KEY, order_id int REFERENCES orders(id), at timestamptz NOT NULL DEFAULT now());
		CREATE INDEX idx_audit_order ON audit (order_id);
		DROP TABLE "user";
	`)
	from, to := read(t, a), read(t, b)
	script := Generate(from, to)
	if script.SQL == "" {
		t.Fatal("expected changes")
	}
	// ALTER TYPE ADD VALUE cannot share a transaction with its use, so run it apart from the rest.
	var enumSQL, rest []string
	for _, s := range strings.Split(script.SQL, "\n\n") {
		if strings.Contains(s, "ADD VALUE") {
			enumSQL = append(enumSQL, s)
		} else {
			rest = append(rest, s)
		}
	}
	run(t, a, strings.Join(enumSQL, "\n"))
	run(t, a, strings.Join(rest, "\n\n"))
	if d := Compare(to, read(t, a)); len(d) != 0 {
		t.Fatalf("after applying the generated SQL the schemas still differ:\n%v\n--- SQL ---\n%s", d, script.SQL)
	}
	if len(script.Warnings) == 0 {
		t.Error("dropping a column, a table and changing a type must warn")
	}
}
