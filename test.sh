export APP_NAME=${1}
export ARG=${2}

if [ "${APP_NAME}" = "" ]
then
	echo "ERROR: enter an application name"
	exit 1
fi
FILE_PATH="${APP_NAME}/test.yaml"

function cleanup {
	docker-compose -f ${FILE_PATH} down --remove-orphans
}

trap cleanup EXIT
cleanup

docker-compose -f ${FILE_PATH} build initdb
docker-compose -f ${FILE_PATH} run initdb

docker-compose -f ${FILE_PATH} build main
docker-compose -f ${FILE_PATH} run main
