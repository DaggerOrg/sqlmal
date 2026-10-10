CREATE TABLE categories (
    id        serial PRIMARY KEY,
    name      text NOT NULL UNIQUE,
    parent_id integer REFERENCES categories (id) ON DELETE SET NULL
);
