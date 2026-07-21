# FIRST SET UP KUBECTL TO POINT TO CLUSTER:

# SSD
# kubectl create -f ssd-storage.yaml

# Namespaces
kubectl create namespace cert-manager
kubectl create namespace routing
kubectl create namespace monitoring

# # Install nginx-ingress
helm install -n routing nginx-ingress stable/nginx-ingress --set rbac.create=true

## Install cert-manager
helm repo add jetstack https://charts.jetstack.io
helm repo update

helm install \
     cert-manager jetstack/cert-manager \
     --namespace cert-manager \
     --create-namespace \
     --version v1.3.0 \
     --set installCRDs=true

# wait for it to be ready
sleep 20

# Create cluster-issuer
kubectl create -f cm-issuer.yaml

# Create Prometheus Operator
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

helm install --namespace monitoring prometheus prometheus-community/kube-prometheus-stack -f prometheus/values.yaml

# Create zookeeper operator and kafka operator
helm install zookeeper-operator banzaicloud-stable/zookeeper-operator

# Kafka operator: Adobe's maintained fork of Banzaicloud Koperator (the original
# repo was archived in March 2025). CRD group is still kafka.banzaicloud.io,
# so existing KafkaCluster / KafkaTopic / KafkaUser / CruiseControlOperation
# resources apply unchanged.
KOPERATOR_VERSION=0.28.0-adobe-20250923

for crd in cruisecontroloperations kafkaclusters kafkatopics kafkausers; do
    kubectl apply -f "https://raw.githubusercontent.com/adobe/koperator/${KOPERATOR_VERSION}/config/base/crds/kafka.banzaicloud.io_${crd}.yaml"
done

# Project Contour CRDs — Adobe Koperator watches HTTPProxy.projectcontour.io
# even when Contour is unused, and crash-loops if the CRDs are absent
# (adobe/koperator#229). Only httpproxies is strictly required; the others
# are inert.
kubectl apply --server-side --force-conflicts \
    -f https://raw.githubusercontent.com/projectcontour/contour/release-1.28/examples/contour/01-crds.yaml

helm install kafka-operator oci://ghcr.io/adobe/helm-charts/kafka-operator \
    --version "${KOPERATOR_VERSION}" \
    --namespace default \
    --values ./kafka-operator/prod/values.yaml

# wait for kafka-operator to be ready and make kafka/zk cluster
sleep 20
kubectl apply -f ./kafka-operator/prod

# wait for cluster and install exporter 
# TODO: bring this up to date with the latest chart version which
# now lives in the kafka_exporter repo: 
# https://github.com/danielqsj/kafka_exporter
sleep 30
helm install kafka-exporter kafka-exporter -f ./kafka-operator/exporter-values.yaml

# kminion — maintained Kafka consumer-group/topic exporter. Backs the
# consumer-lag alerts (offset-sum + member/state metrics kafka-exporter lacks).
helm install kminion kminion --namespace default

# sql_exporter — exports CockroachDB study health metrics (error/blocked/stuck/
# expired states by form) into Prometheus for alerting on survey degradation.
helm install sql-exporter sql-exporter --namespace monitoring

# Kafka consumer-group health alerts — a single PrometheusRule for the shared
# cluster (both prod + staging). See documentation/kafka-consumer-lag-alerting.md
helm install kafka-consumer-health kafka-consumer-health --namespace monitoring

# Hand-authored cluster/app alerts (Kafka broker health, replybot crash loop).
# Replaces the retired koperator default kafka-alerts. See documentation/alerting.md
helm install vlab-alerts alerts --namespace monitoring

# Grafana dashboards provisioned as code via ConfigMaps. The Grafana sidecar watches
# for ConfigMaps labeled grafana_dashboard=1 and loads them automatically.
helm install grafana-dashboards grafana-dashboards --namespace monitoring
