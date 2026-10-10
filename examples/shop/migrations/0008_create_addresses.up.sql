CREATE TABLE addresses (
    id          bigserial PRIMARY KEY,
    user_id     bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    line1       text NOT NULL,
    city        text NOT NULL,
    postal_code text NOT NULL,
    is_default  boolean NOT NULL DEFAULT false
);

-- A user can have many addresses but only one default.
CREATE UNIQUE INDEX one_default_address_per_user ON addresses (user_id) WHERE is_default;
