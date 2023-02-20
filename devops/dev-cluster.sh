#!/bin/sh

######################
# setup cluster
######################

./dev/kind-with-registry.sh
kubectl config use-context kind-kind

######################
# env file for dev
######################
# NOTE: this contains actual secrets
kubectl create secret generic gbv-bot-envs --from-env-file=dev/.env

######################
# install
######################

# use upgrade as it allows script to be idempotent
helm upgrade --install gbv vlab -f values/test.yaml

######################
# create database
######################

sleep 20
kubectl wait --for=condition=Ready pod/gbv-cockroachdb-0 --timeout 20m
sleep 20

cat ./sql/* > tmp.sql
cat tmp.sql | kubectl run -i --rm cockroach-client --image=cockroachdb/cockroach:v20.1.4 --restart=Never --command -- ./cockroach sql --insecure --host gbv-cockroachdb-public
rm -f tmp.sql

######################
# wait for everything
######################

kubectl wait --for=condition=Ready pod/gbv-kafka-0 --timeout 5m
kubectl wait --for=condition=available \
        deployment/gbv-replybot \
        deployment/gbv-botserver \
        deployment/gbv-linksniffer \
        deployment/gbv-scribble-messages \
        deployment/gbv-scribble-responses \
        deployment/gbv-scribble-states \
        --timeout 5m
