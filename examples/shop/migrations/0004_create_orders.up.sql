CREATE TYPE order_status AS ENUM ('pending', 'paid', 'shipped', 'cancelled');

CREATE TABLE orders (
    id        bigserial PRIMARY KEY,
    user_id   bigint NOT NULL REFERENCES users (id),
    status    order_status NOT NULL DEFAULT 'pending',
    placed_at timestamptz NOT NULL DEFAULT now()
);
