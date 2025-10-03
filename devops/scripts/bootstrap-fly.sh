#!/bin/sh
set -e
######################
# add third party charts
######################
helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo add cockroachdb https://charts.cockroachdb.com/
helm repo update

######################
# install infrastructure in parallel
######################
echo "Installing infrastructure components in parallel..."

# Start all installations in parallel (without --wait)
helm upgrade --install db cockroachdb/cockroachdb \
  --values values/integrations/cdb.yaml \
  --timeout 10m &
DB_PID=$!

helm upgrade --install kafka bitnami/kafka \
  --values values/integrations/kafka.yaml \
  --version 22.1.6 \
  --timeout 10m0s &
KAFKA_PID=$!

helm upgrade --install minio oci://registry-1.docker.io/bitnamicharts/minio \
  --values values/integrations/minio.yaml \
  --timeout 10m0s &
MINIO_PID=$!

# Wait for all to complete
echo "Waiting for database installation..."
wait $DB_PID
echo "Waiting for kafka installation..."
wait $KAFKA_PID
echo "Waiting for minio installation..."
wait $MINIO_PID

# Apply the cockroachdb hack after DB is ready
kubectl apply -f dev/cockroachdb.hack.yaml

######################
# create database
######################
# Migrations should be idempotent
cat migrations/* | kubectl run -i \
  --rm cockroach-client \
  --image=cockroachdb/cockroach:v21.2.17 \
  --restart=Never \
  --command -- ./cockroach sql --insecure --host db-cockroachdb-public

######################
# install fly
######################
helm upgrade --install \
  fly vlab \
  -f values/integrations/fly.yaml \
  --timeout 10m0s \
  --wait

