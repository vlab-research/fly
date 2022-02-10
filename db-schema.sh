FILE_PATH="system/db-schema.yaml"

function cleanup {
	docker-compose -f ${FILE_PATH} down --remove-orphans
}

trap cleanup EXIT
cleanup

docker-compose -f ${FILE_PATH} build main
docker-compose -f ${FILE_PATH} run main
