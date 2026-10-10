CREATE TABLE payments (
    id           bigserial PRIMARY KEY,
    order_id     bigint NOT NULL REFERENCES orders (id),
    amount_cents integer NOT NULL CHECK (amount_cents > 0),
    method       text NOT NULL,
    paid_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_payments_order_id ON payments (order_id);
