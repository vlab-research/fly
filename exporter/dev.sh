# App
kubectl delete -f kube-dev
docker build -t localhost:5000/exporter:registry .
docker push localhost:5000/exporter:registry
kubectl apply -f kube-dev
