.PHONY: build ui test test-go test-web lint demo-db demo clean

BIN := bin/sqlmal

build: ## Build the binary (uses the committed UI)
	go build -o $(BIN) ./cmd/sqlmal

ui: ## Rebuild the web UI and embed it in the Go server
	cd web && npm ci && npm run build
	rm -rf internal/server/ui && cp -r web/dist internal/server/ui
	rm -f internal/server/ui/demo.json

test: test-go test-web ## Run every test

# Integration tests need a Postgres. Set SQLMAL_TEST_ADMIN_DSN, or start one with `make demo-db`.
test-go:
	go vet ./...
	go test -race -timeout 300s ./...

test-web:
	cd web && npm run typecheck && npm test

demo-db: ## Start Postgres for the demo and the tests (port 54329)
	docker compose up -d --wait

demo: demo-db build ## Load the shop example and open the UI
	./scripts/demo.sh

clean:
	rm -rf bin web/dist
