-- migrate:no-transaction
-- The first index is built the safe way: CONCURRENTLY does not block writes.
CREATE INDEX CONCURRENTLY idx_orders_user_id ON orders (user_id);

-- The second is not: this is the kind of thing `migrate-studio lint` warns about.
CREATE INDEX idx_products_category_id ON products (category_id);
