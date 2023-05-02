DB_VERSION=v21.1.9
PORT=5432
DATABASE=chatroach

dev: create-kind-cluster setup-dev-secret setup-kind-registry bootstrap-fly

start-testrunner:
	@kubectl apply -f testing/facebot.yaml
	@kubectl wait --for=condition=available deployment/facebot --timeout 5m
	@kubectl delete job testrunner || true
	@envsubst < testing/testrunner.yaml | kubectl apply -f -

.PHONY: check-test-status
check-test-status:
	$(eval SUCCESS=$(shell kubectl get job testrunner -o jsonpath='{.status.succeeded}'))
	@if [ "$(SUCCESS)" != "1" ]; then\
			exit 1; \
		fi
	@echo "Test Succesful"

.PHONY: integration-tests
integration-tests:	create-integration-secret bootstrap-fly start-testrunner
	@kubectl wait --for=condition=complete job/testrunner --timeout 10m
	@kubectl logs -l app=testrunner --tail -1
	$(MAKE) check-test-status

create-kind-cluster:
	@kind create cluster --config dev/kind-cluster.yaml

create-integration-secret:
	@kubectl create secret generic bot-envs --from-env-file=./testing/.test-env || true

create-dev-secret:
	@kubectl create secret generic bot-envs --from-env-file=./dev/.env || true

bootstrap-fly:
	@bash ./scripts/bootstrap-fly.sh

setup-kind-registry:
	@bash ./dev/kind-with-registry.sh

test-db:
	@docker stop vlab-cockroach && docker rm vlab-cockroach
	@docker run --name vlab-cockroach -d \
		-p $(PORT):26257 \
		cockroachdb/cockroach:$(DB_VERSION) start-single-node --insecure
	@cat ./sql/* | docker run -i \
		--net=host \
		--rm cockroachdb/cockroach:$(DB_VERSION) \
		sql --insecure --host localhost --port $(PORT) --database chatroach
	@echo "set sql_safe_updates = false;" | docker run -i \
		--net=host \
		--rm cockroachdb/cockroach:$(DB_VERSION) \
		sql --insecure --host localhost --port $(PORT) --database chatroach
