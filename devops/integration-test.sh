#!/bin/sh

kind delete cluster --name test 
kind create cluster --name test --wait 5m
kubectl config use-context kind-test

######################
# env file for testing
######################

kubectl create secret generic gbv-bot-envs --from-env-file=./testing/.test-env

######################
# Install cockroachdb
######################
helm repo add cockroachdb https://charts.cockroachdb.com
helm repo update
helm install gbv-cockroachdb cockroachdb/cockroachdb --version 4.1.6
sleep 20
kubectl wait --for=condition=Ready pod/gbv-cockroachdb-0 --timeout 20m

cat ./sql/* > tmp.sql
cat tmp.sql | kubectl run -i --rm cockroach-client --image=cockroachdb/cockroach:v20.1.4 --restart=Never --command -- ./cockroach sql --insecure --host gbv-cockroachdb-public
rm -f tmp.sql

######################
# install
######################

# helm install gbv vlab -f values/test.yaml --timeout 30m
# kubectl apply -f testing/facebot.yaml

# ######################
# # create database
# ######################

# sleep 20
# kubectl wait --for=condition=Ready pod/gbv-cockroachdb-0 --timeout 30m
# sleep 20


# cat ./sql/* > tmp.sql
# cat tmp.sql | kubectl run -i --rm cockroach-client --image=cockroachdb/cockroach:v20.1.4 --restart=Never --command -- ./cockroach sql --insecure --host gbv-cockroachdb-public
# rm -f tmp.sql


# ######################
# # wait for everything
# ######################

# kubectl wait --for=condition=Ready pod/gbv-kafka-0 --timeout 20m
# kubectl wait --for=condition=available \
#         deployment/gbv-replybot \
#         deployment/gbv-botserver \
#         deployment/gbv-linksniffer \
#         deployment/gbv-scribble-messages \
#         deployment/gbv-scribble-responses \
#         deployment/gbv-scribble-states \
#         --timeout 20m

# ######################
# # run test
# ######################

# sleep 120

# kubectl apply -f testing/testrunner.yaml

# kubectl wait --for=condition=complete job/gbv-testrunner --timeout 10m
# kubectl logs -l app=gbv-testrunner

# ######################
# # test success
# ######################

# SUCCESS=$(kubectl get job gbv-testrunner -o jsonpath='{.status.succeeded}')
# if [ -z "$SUCCESS" ]; then exit 1; fi
# echo "Test Succesful!"
