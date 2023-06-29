#!/bin/bash

set -e 

USER=$1
# Swaps user for provided 

echo "delete from users where email = '${USER}'; update users set email = '${USER}' where email = 'test@test.com';" | kubectl run -i \
  --rm cockroach-client \
  --image=cockroachdb/cockroach:v21.2.17 \
  --restart=Never \
  --command -- ./cockroach sql --insecure --host db-cockroachdb-public --database chatroach
