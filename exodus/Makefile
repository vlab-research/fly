.PHONY: test test-unit test-integration test-db

# Run unit tests only (no database required)
test-unit:
	go test -count=1 ./...

# Run all tests including integration tests against a real database.
# Requires the test database to be running: `make test-db` in devops/
# -p 1 runs packages sequentially to prevent races on the shared database.
test:
	go test -count=1 -p 1 ./...

# Run integration tests only
test-integration:
	go test -count=1 -p 1 -run TestIntegration ./...

# Start the test database (CockroachDB on port 5433 with all migrations applied)
test-db:
	$(MAKE) -C ../devops test-db
