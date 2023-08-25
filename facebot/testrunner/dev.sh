kubectl delete -f ../kube/job.yaml
docker build -t localhost:5000/testrunner:registry .
docker push localhost:5000/testrunner:registry
kubectl apply -f ../kube/job.yaml

sleep 10
kubectl logs -l app=testrunner --follow
