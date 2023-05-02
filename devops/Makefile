DB_VERSION=v21.1.9
PORT=5432
DATABASE=chatroach
KAFKA_CLIENT_VERSION=7.4.0
KAFKA_TOPIC=vlab-exports
KAFKA_HOST=kafka.local
DASHBOARD_HOST=dashboard.fly.local
COCKROACHDB_HOST=cockroachdb.fly.local
MINIO_HOST=minio.fly.local
HOST_FILE=/etc/hosts

dev: create-kind-cluster certs certs-secret create-dev-secret setup-kind-registry setup-ingress-controller bootstrap-fly

clean: delete-kind-cluster

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
	@kubectl wait --for=condition=complete job/testrunner --timeout 20m || true
	@kubectl logs -l app=testrunner --tail -1
	$(MAKE) check-test-status

create-kind-cluster:
	@kind create cluster --config dev/kind-cluster.yaml || true

delete-kind-cluster:
	@kind delete cluster || true

create-integration-secret:
	@kubectl create secret generic bot-envs --from-env-file=./testing/.test-env || true

setup-dev-secret:
	@kubectl create secret generic bot-envs --from-env-file=./dev/.env || true

bootstrap-fly:
	@bash ./scripts/bootstrap-fly.sh

setup-kind-registry:
	@bash ./dev/kind-with-registry.sh || true

setup-ingress-controller:
	@kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml
	@kubectl wait --namespace ingress-nginx \
  	--for=condition=ready pod \
  	--selector=app.kubernetes.io/component=controller \
  	--timeout=90s

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

kafka-producer:
	@echo "Starting Kafka Client Pod"
	@echo "NOTE:                                             "
	@echo "once started you will just have an flashing cursor"
	@echo "each time you hit enter a message will be sent to "
	@echo "kafka on the topic - $(KAFKA_TOPIC)               "
	@echo "=================================================="
	@docker run -i \
		--rm \
		--network=host \
		confluentinc/cp-kafka:$(KAFKA_CLIENT_VERSION) \
		kafka-console-producer \
		--broker-list $(KAFKA_HOST):30092 --topic $(KAFKA_TOPIC)

.PHONY: cockroach-client
cockroach-client:
	@kubectl run -it \
  	--rm cockroach-client \
  	--image=cockroachdb/cockroach:v2.1.4 \
  	--restart=Never \
  	--command -- ./cockroach sql --insecure --host gbv-cockroachdb-public

# This is used to align your local DNS resolver to be synced with the dev
# NOTE: Needs to be run with Sudo
setup-local-networking: clean-local-networking
	@echo "WARN: adding new DNS entries to $(HOST_FILE), this needs sudo permission"
	@echo "127.0.0.1  $(KAFKA_HOST)" >> $(HOST_FILE)
	@echo "127.0.0.1  $(MINIO_HOST)" >> $(HOST_FILE)
	@echo "127.0.0.1  $(DASHBOARD_HOST)" >> $(HOST_FILE)
	@echo "127.0.0.1  $(COCKROACHDB_HOST)" >> $(HOST_FILE)
	@echo "Updated $(HOST_FILE) successfully"

clean-local-networking:
	@echo "WARN: cleaning up previous hosts, this needs sudo permission"
	@sed -ie "/[[:space:]]$(KAFKA_HOST)/d" $(HOST_FILE)
	@sed -ie "/[[:space:]]$(MINIO_HOST)/d" $(HOST_FILE)
	@sed -ie "/[[:space:]]$(DASHBOARD_HOST)/d" $(HOST_FILE)
	@sed -ie "/[[:space:]]$(COCKROACHDB_HOST)/d" $(HOST_FILE)
	@echo "Updated $(HOST_FILE) successfully"

certs:
	@echo "Generating certificates for *.local domains"
	@mkdir -p tmp/certs/
	@mkcert -key-file tmp/certs/key.pem -cert-file tmp/certs/cert.pem *.fly.local

certs-secret:
	@kubectl delete secret local-certs || true
	@kubectl create secret tls local-certs \
		--cert=tmp/certs/cert.pem \
		--key=tmp/certs/key.pem
