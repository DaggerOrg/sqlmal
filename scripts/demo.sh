#!/usr/bin/env bash
# Builds the example shop database, makes one manual change so Drift has something to show, and opens the UI.
set -euo pipefail
cd "$(dirname "$0")/.."

ADMIN_DSN="${SQLMAL_TEST_ADMIN_DSN:-postgres://studio:studio@127.0.0.1:54329/postgres}"
DEMO_DSN="${ADMIN_DSN%/*}/shop_demo"
SQLMAL=(node apps/server/dist/main.js --config examples/shop/sqlmal.json)

psql "$ADMIN_DSN" -qc "DROP DATABASE IF EXISTS shop_demo" -c "CREATE DATABASE shop_demo"

export SHOP_DATABASE_URL="$DEMO_DSN"
"${SQLMAL[@]}" up
psql "$DEMO_DSN" -q -f examples/shop/seed.sql
# Someone "fixed production by hand". SQLMal notices.
psql "$DEMO_DSN" -qc "ALTER TABLE users ADD COLUMN nickname text; CREATE INDEX idx_orders_status_manual ON orders (status);"

if [[ "${1:-}" == "--export" ]]; then
  # Refresh the snapshot the static demo site shows.
  exec "${SQLMAL[@]}" export --out apps/web/public/demo.json
fi

echo
echo "Open http://127.0.0.1:8484"
exec "${SQLMAL[@]}" serve --addr 127.0.0.1:8484
