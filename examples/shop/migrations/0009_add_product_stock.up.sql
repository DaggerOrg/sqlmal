ALTER TABLE products ADD COLUMN stock integer NOT NULL DEFAULT 0;
ALTER TABLE products ADD CONSTRAINT products_stock_nonnegative CHECK (stock >= 0);
