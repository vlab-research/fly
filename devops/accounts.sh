NAMESPACE=$1
ENV_FILE=${2:-../replybot/.env}

kubectl -n $NAMESPACE create secret generic gbv-bot-envs --from-env-file=$ENV_FILE --dry-run=client -o yaml | kubectl apply -f -
