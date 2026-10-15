package introspect

import (
	"context"
	"reflect"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/Stephen-SMH/sqlmal/internal/testdb"
)

const fixture = `
CREATE TYPE order_status AS ENUM ('new', 'paid', 'shipped');
COMMENT ON TYPE order_status IS 'ignored';

CREATE TABLE users (
    id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email    text NOT NULL UNIQUE,
    name     text DEFAULT 'anonymous',
    age      int CHECK (age >= 0),
    created  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE users IS 'People who can sign in';
COMMENT ON COLUMN users.email IS 'Login name';

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
    sku      text NOT NULL REFERENCES products(sku) ON DELETE SET NULL (sku),
    qty      int NOT NULL DEFAULT 1,
    PRIMARY KEY (order_id, sku)
);

CREATE TABLE events (id int, at date) PARTITION BY RANGE (at);
CREATE TABLE events_2026 PARTITION OF events FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');

CREATE VIEW active_users AS SELECT * FROM users;
CREATE TABLE schema_migrations (version bigint);
`

func load(t *testing.T) Schema {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, testdb.New(t))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, fixture); err != nil {
		t.Fatalf("the test fixture must load: %v", err) // never skip: a broken fixture would hide real failures
	}
	s, err := Read(ctx, conn, Options{})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestReadsTablesColumnsAndHidesNoise(t *testing.T) {
	s := load(t)
	var names []string
	for _, tb := range s.Tables {
		names = append(names, tb.Name)
	}
	want := []string{"events", "order_items", "orders", "products", "users"}
	if !reflect.DeepEqual(names, want) {
		t.Fatalf("tables %v, want %v (no partition child, view, or bookkeeping table)", names, want)
	}
	users, _ := s.Table("users")
	if users.Comment != "People who can sign in" {
		t.Errorf("table comment: %q", users.Comment)
	}
	byName := map[string]Column{}
	for _, c := range users.Columns {
		byName[c.Name] = c
	}
	if c := byName["id"]; c.Type != "bigint" || c.Identity != "always" || !c.NotNull || c.Default != "" {
		t.Errorf("identity column: %+v", c)
	}
	if c := byName["email"]; c.Comment != "Login name" || !c.NotNull {
		t.Errorf("email: %+v", c)
	}
	if c := byName["name"]; c.Default != "'anonymous'::text" || c.NotNull {
		t.Errorf("default: %+v", c)
	}
	if c := byName["created"]; c.Type != "timestamp with time zone" || c.Default != "now()" {
		t.Errorf("timestamptz: %+v", c)
	}
	products, _ := s.Table("products")
	for _, c := range products.Columns {
		if c.Name == "net" && c.Generated == "" {
			t.Errorf("a generated column must report its expression: %+v", c)
		}
		if c.Name == "price" && c.Type != "numeric(10,2)" {
			t.Errorf("numeric type: %q", c.Type)
		}
		if c.Name == "tags" && c.Type != "text[]" {
			t.Errorf("array type: %q", c.Type)
		}
	}
	events, _ := s.Table("events")
	if !events.Partitioned {
		t.Error("the partitioned parent should be flagged")
	}
}

func TestReadsConstraintsAndIndexes(t *testing.T) {
	s := load(t)
	users, _ := s.Table("users")
	if !reflect.DeepEqual(users.PrimaryKey, []string{"id"}) {
		t.Errorf("pk: %v", users.PrimaryKey)
	}
	if len(users.Uniques) != 1 || !reflect.DeepEqual(users.Uniques[0].Columns, []string{"email"}) {
		t.Errorf("unique: %+v", users.Uniques)
	}
	if len(users.Checks) != 1 || users.Checks[0].Expr != "((age >= 0))" {
		t.Errorf("check: %+v", users.Checks)
	}
	orders, _ := s.Table("orders")
	if len(orders.ForeignKeys) != 1 {
		t.Fatalf("fk: %+v", orders.ForeignKeys)
	}
	fk := orders.ForeignKeys[0]
	if fk.RefTable != "users" || !reflect.DeepEqual(fk.Columns, []string{"user_id"}) || !reflect.DeepEqual(fk.RefColumns, []string{"id"}) || fk.OnDelete != "CASCADE" || fk.OnUpdate != "RESTRICT" {
		t.Errorf("fk details: %+v", fk)
	}
	if len(orders.Uniques) != 1 || !reflect.DeepEqual(orders.Uniques[0].Columns, []string{"user_id", "status"}) {
		t.Errorf("composite unique keeps column order: %+v", orders.Uniques)
	}
	items, _ := s.Table("order_items")
	if !reflect.DeepEqual(items.PrimaryKey, []string{"order_id", "sku"}) {
		t.Errorf("composite pk: %v", items.PrimaryKey)
	}
	idx := map[string]Index{}
	for _, i := range orders.Indexes {
		idx[i.Name] = i
	}
	if i := idx["orders_pkey"]; !i.Primary || !i.Unique || i.Method != "btree" {
		t.Errorf("pk index: %+v", i)
	}
	if i := idx["idx_orders_new"]; i.Def == "" || !reflect.DeepEqual(i.Columns, []string{"user_id"}) || i.Unique {
		t.Errorf("partial index: %+v", i)
	}
	if i := idx["idx_orders_lower"]; !reflect.DeepEqual(i.Columns, []string{"(expr)"}) {
		t.Errorf("expression index: %+v", i)
	}
}

func TestReadsEnumsInDeclaredOrder(t *testing.T) {
	s := load(t)
	if len(s.Enums) != 1 || s.Enums[0].Name != "order_status" || !reflect.DeepEqual(s.Enums[0].Labels, []string{"new", "paid", "shipped"}) {
		t.Fatalf("enums: %+v", s.Enums)
	}
}

func TestIncludeToolKeepsTheBookkeepingTables(t *testing.T) {
	ctx := context.Background()
	conn, _ := pgx.Connect(ctx, testdb.New(t))
	defer conn.Close(ctx)
	conn.Exec(ctx, "CREATE TABLE schema_migrations (version bigint); CREATE TABLE a (id int)")
	hidden, _ := Read(ctx, conn, Options{})
	shown, _ := Read(ctx, conn, Options{IncludeTool: true})
	if len(hidden.Tables) != 1 || len(shown.Tables) != 2 {
		t.Fatalf("hidden=%d shown=%d", len(hidden.Tables), len(shown.Tables))
	}
}

func TestReadIsDeterministic(t *testing.T) {
	ctx := context.Background()
	conn, _ := pgx.Connect(ctx, testdb.New(t))
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, fixture); err != nil {
		t.Fatal(err)
	}
	a, _ := Read(ctx, conn, Options{})
	b, _ := Read(ctx, conn, Options{})
	a2, b2 := a, b
	for i := range a2.Tables {
		a2.Tables[i].RowEstimate, a2.Tables[i].SizeBytes = 0, 0
	}
	for i := range b2.Tables {
		b2.Tables[i].RowEstimate, b2.Tables[i].SizeBytes = 0, 0
	}
	if !reflect.DeepEqual(a2, b2) {
		t.Fatal("two reads of the same database must be identical")
	}
}
