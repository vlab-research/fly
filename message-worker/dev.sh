#!/bin/sh
set -e

kubectl delete deployment message-worker --ignore-not-found=true
docker build -t localhost:5000/message-worker:dev .
docker push localhost:5000/message-worker:dev
kubectl apply -f kube-dev/
