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

######################
# create database
######################
cat ./sql/* > tmp.sql

# Note we skip this if it fails as 
# currently migrations are not idempotent
cat tmp.sql | kubectl run -i \
  --rm cockroach-client \
  --image=cockroachdb/cockroach:v2.1.4 \
  --restart=Never \
  --command -- ./cockroach sql --insecure --host db-cockroachdb-public || true
rm -f tmp.sql

######################
# install kafka
######################
helm upgrade --install kafka bitnami/kafka \
  --values values/integrations/kafka.yaml \
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

