CREATE TABLE order_items (
    order_id         bigint NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
    product_id       bigint NOT NULL REFERENCES products (id),
    quantity         integer NOT NULL CHECK (quantity > 0),
    unit_price_cents integer NOT NULL,
    PRIMARY KEY (order_id, product_id)
);
