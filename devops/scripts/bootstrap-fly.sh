#!/bin/sh
set -e
######################
# add third party charts
######################
helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo add cockroachdb https://charts.cockroachdb.com/
helm repo update

######################
# install db
######################
helm upgrade --install db cockroachdb/cockroachdb \
  --values values/integrations/cdb.yaml \
  --timeout 10m \
  --wait

kubectl apply -f dev/cockroachdb.hack.yaml

######################
# create database
######################
# Migrations should be idempotent
cat migrations/init.sql | kubectl run -i \
  --rm cockroach-client \
  --image=cockroachdb/cockroach:v2.1.4 \
  --restart=Never \
  --command -- ./cockroach sql --insecure --host db-cockroachdb-public


######################
# install kafka
######################
helm upgrade --install kafka bitnami/kafka \
  --values values/integrations/kafka.yaml \
  --timeout 10m0s \
  --wait


######################
# install minio
######################
helm upgrade --install minio oci://registry-1.docker.io/bitnamicharts/minio \
  --values values/integrations/minio.yaml \
  --timeout 10m0s \
  --wait

######################
# install fly
######################
helm upgrade --install \
  fly vlab \
  -f values/integrations/fly.yaml \
  --timeout 10m0s \
  --wait

