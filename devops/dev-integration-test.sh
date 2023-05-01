kubectl apply -f testing/facebot.yaml
kubectl wait --for=condition=available deployment/gbv-facebot --timeout 5m

envsubst < testing/testrunner.yaml | kubectl apply -f -
