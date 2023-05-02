#!/bin/bash
# This is just a file to run each sql migration individual in order to pick up 
# which migration failed
set -e

FILES="sql/*.sql"
for f in $FILES
do
  echo "Processing $f file..."
  # take action on each file. $f store current file name
  cat "$f" | kubectl run -i   \
    --rm cockroach-client   \
    --image=cockroachdb/cockroach:v21.1.9 \
    --restart=Never \
    --command -- ./cockroach sql --insecure --host fly-cockroachdb-public
done
