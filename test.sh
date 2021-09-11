export APP_NAME=${1}
if [ "${APP_NAME}" = "" ]
	then
		echo "ERROR: enter an application name"
		exit 1
	else
		FILE_PATH="${APP_NAME}/test.yaml"
fi
docker-compose -f ${FILE_PATH} down --remove-orphans

docker-compose -f ${FILE_PATH} build build_base_image
docker-compose -f ${FILE_PATH} run build_base_image

docker-compose -f ${FILE_PATH} build main
docker-compose -f ${FILE_PATH} run \
	--name ${APP_NAME} \
	main
