-- Fills the demo database with enough rows that table sizes look real.
INSERT INTO categories (name, parent_id) VALUES ('Electronics', NULL), ('Books', NULL), ('Home', NULL);
INSERT INTO categories (name, parent_id) VALUES ('Phones', 1), ('Laptops', 1), ('Novels', 2), ('Kitchen', 3);

INSERT INTO users (email, first_name, last_name, phone, country)
SELECT 'user' || g || '@example.com', 'First' || g, 'Last' || g, '+66' || (800000000 + g), (ARRAY['TH','MM','SG','JP'])[1 + g % 4]
FROM generate_series(1, 5000) g;

INSERT INTO products (sku, name, price_cents, category_id, stock)
SELECT 'SKU-' || lpad(g::text, 5, '0'), 'Product ' || g, 500 + (g * 37) % 90000, 4 + g % 4, g % 200
FROM generate_series(1, 1200) g;

INSERT INTO orders (user_id, status, placed_at)
SELECT 1 + g % 5000, (ARRAY['pending','paid','shipped','cancelled'])[1 + g % 4]::order_status, now() - (g || ' minutes')::interval
FROM generate_series(1, 20000) g;

INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents)
SELECT g, 1 + (g * 7) % 1200, 1 + g % 3, 1000 + g % 5000 FROM generate_series(1, 20000) g;

INSERT INTO payments (order_id, amount_cents, method)
SELECT g, 1000 + g % 8000, (ARRAY['card','promptpay','cash'])[1 + g % 3] FROM generate_series(1, 12000) g;

INSERT INTO addresses (user_id, line1, city, postal_code, is_default)
SELECT g, g || ' Example Road', 'Bangkok', '10' || lpad((g % 900)::text, 3, '0'), true FROM generate_series(1, 4000) g;

ANALYZE;
