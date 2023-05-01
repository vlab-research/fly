file_path = $(APP)/test.yaml
.EXPORT_ALL_VARIABLES:
APP_NAME = $(APP)
IS_CI = $(IS_CI)

.PHONY: test
test: 
	@docker compose -f $(file_path) down --remove-orphans
	@docker compose -f $(file_path) build initdb
	@docker compose -f $(file_path) run initdb
	@docker compose -f $(file_path) build main
	@docker compose -f $(file_path) run main
