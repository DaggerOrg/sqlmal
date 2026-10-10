#!/usr/bin/env bash
# Builds the example shop database, makes one manual change so Drift has something to show, and opens the UI.
set -euo pipefail
cd "$(dirname "$0")/.."

ADMIN="${MS_ADMIN_DSN:-postgres://studio:studio@127.0.0.1:${MS_DB_PORT:-54329}/postgres}"
DEMO="${ADMIN%/*}/shop_demo"
BIN="${BIN:-bin/migrate-studio}"

psql "$ADMIN" -qc "DROP DATABASE IF EXISTS shop_demo" -c "CREATE DATABASE shop_demo"

export SHOP_DATABASE_URL="$DEMO"
cfg=(--config examples/shop/migrate-studio.json)
"$BIN" "${cfg[@]}" up
psql "$DEMO" -q -f examples/shop/seed.sql
# Someone "fixed production by hand". Migrate Studio notices.
psql "$DEMO" -qc "ALTER TABLE users ADD COLUMN nickname text; CREATE INDEX idx_orders_status_manual ON orders (status);"

echo
echo "Open http://127.0.0.1:8484"
exec "$BIN" "${cfg[@]}" serve --addr 127.0.0.1:8484
