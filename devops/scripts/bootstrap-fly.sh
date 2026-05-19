#!/bin/sh
set -e
######################
# add third party charts
######################
helm repo add cockroachdb https://charts.cockroachdb.com/ --force-update
helm repo add dandydev https://dandydeveloper.github.io/charts --force-update
helm repo update cockroachdb dandydev

######################
# install infrastructure in parallel
######################
echo "Installing infrastructure components in parallel..."

# Start all installations in parallel (without --wait)
helm upgrade --install db cockroachdb/cockroachdb \
  --values values/integrations/cdb.yaml \
  --timeout 10m &
DB_PID=$!

# Deploy Kafka using simple K8s manifests (Bitnami images unavailable as of Aug 2025)
kubectl apply -f dev/kafka-dev.yaml &
KAFKA_PID=$!

# Deploy Redis via dandydeveloper/redis-ha with official redis:7-alpine and haproxy:3.0-alpine.
# kind clusters have intermittent DNS issues pulling from registry-1.docker.io, so pre-load
# images if this is a fresh kind cluster.
for img in redis:7-alpine haproxy:3.0-alpine; do
  if ! docker image inspect "$img" > /dev/null 2>&1; then
    docker pull "$img"
  fi
  kind load docker-image "$img" 2>/dev/null || true
done
helm upgrade --install redis dandydev/redis-ha \
  --values values/integrations/redis-ha-dev.yaml \
  --timeout 5m &
REDIS_PID=$!

# TODO: Minio is disabled — bitnami image requires a paid subscription and the
# exporter (the only consumer) is disabled in dev. Re-enable once we have
# integration tests that need it and have switched to the official MinIO Operator.

# Wait for all to complete
echo "Waiting for database installation..."
wait $DB_PID
echo "Waiting for kafka installation..."
wait $KAFKA_PID
echo "Waiting for redis installation..."
wait $REDIS_PID

# Apply the cockroachdb hack after DB is ready
kubectl apply -f dev/cockroachdb.hack.yaml

# Wait for Kafka StatefulSet to be ready
echo "Waiting for Kafka to be ready..."
kubectl rollout status statefulset/kafka -n default --timeout=5m

# Provision Kafka topics
echo "Provisioning Kafka topics..."
kubectl delete job kafka-topic-provisioning -n default 2>/dev/null || true
kubectl apply -f dev/kafka-topics.yaml
kubectl wait --for=condition=complete --timeout=300s job/kafka-topic-provisioning -n default

######################
# create database
######################
# Glob is *.sql to skip the migrations/prod/ subdir, which holds prod-only
# migrations (e.g. backup schedule) that require external resources unavailable
# in dev (GCS bucket, GKE Workload Identity).
kubectl wait --for=condition=ready pod/db-cockroachdb-0 --timeout=5m

# Check if migrations have already been applied by looking for the messages table
INITIALIZED=$(kubectl exec db-cockroachdb-0 -- ./cockroach sql --insecure --database chatroach --execute="SELECT count(*) FROM information_schema.tables WHERE table_name = 'messages';" --format=tsv 2>/dev/null | tail -1)
if [ "${INITIALIZED}" != "1" ]; then
  echo "Running migrations..."
  cat migrations/*.sql | kubectl exec -i db-cockroachdb-0 -- ./cockroach sql --insecure
else
  echo "Database already initialized, skipping migrations"
fi

######################
# install fly
######################
helm upgrade --install \
  fly vlab \
  -f values/integrations/fly.yaml \
  --timeout 10m0s \
  --wait

