APP_NAME=${1}
cd $APP_NAME
echo $REGISTRY_PASSWORD | docker login ghcr.io -u $REGISTRY_USERNAME --password-stdin
docker build -t $REGISTRY_URL/$APP_NAME .
docker push $REGISTRY_URL/$APP_NAME
