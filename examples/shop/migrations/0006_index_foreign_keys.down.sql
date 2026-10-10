-- migrate:no-transaction
DROP INDEX CONCURRENTLY idx_orders_user_id;
DROP INDEX idx_products_category_id;
