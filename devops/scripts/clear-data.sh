#!/bin/bash

kubectl scale statefulset fly-cockroachdb --replicas=0
kubectl delete pvc datadir-fly-cockroachdb-0
kubectl scale statefulset fly-cockroachdb --replicas=1
