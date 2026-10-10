CREATE TABLE products (
    id          bigserial PRIMARY KEY,
    sku         text NOT NULL UNIQUE,
    name        text NOT NULL,
    price_cents integer NOT NULL CHECK (price_cents >= 0),
    category_id integer REFERENCES categories (id),
    created_at  timestamptz NOT NULL DEFAULT now()
);
