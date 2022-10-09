DB_VERSION=v20.1.4
PORT=5432
DATABASE=chatroach

docker stop vlab-cockroach && docker rm vlab-cockroach

docker run --name vlab-cockroach -d -p $PORT:26257 cockroachdb/cockroach:$DB_VERSION start-single-node --insecure

cat ./sql/* | docker run -i --net=host --rm cockroachdb/cockroach:$DB_VERSION sql --insecure --host localhost --port $PORT --database chatroach

echo "set sql_safe_updates = false;" | docker run -i --net=host --rm cockroachdb/cockroach:$DB_VERSION sql --insecure --host localhost --port $PORT --database chatroach


