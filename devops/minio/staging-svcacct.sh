#!/usr/bin/env bash

set -euo pipefail

# Provision the staging exporter's MinIO access: creates the `staging` bucket and
# a service account scoped to it, then writes the credentials into the gitignored
# exporter/.env-staging.
#
# Runs `mc` inside the cluster so the MinIO root credentials are read from the
# `minio-auth` Secret by the pod itself and never touch your shell or the repo.
#
# Idempotent: re-running replaces the service account with a fresh key pair.
#
# Usage: bash staging-svcacct.sh
#
# After this, apply and restart:
#   bash ../secrets.sh vstag exporter ../../exporter/.env-staging
#   kubectl rollout restart deployment/gbv-exporter -n vstag

BUCKET="staging"
ENV_FILE="$(dirname "$0")/../../exporter/.env-staging"
POD="mc-provision-staging"

if [[ ! -w "$ENV_FILE" ]]; then
    echo "ERROR: cannot write $ENV_FILE" >&2
    exit 1
fi

# Generate the credentials locally so they can be written to the env file.
# openssl rand is used rather than `tr -dc < /dev/urandom | head`, which raises
# SIGPIPE and trips `set -o pipefail`.
ACCESS_KEY="staging-exporter"
SECRET_KEY="$(openssl rand -hex 20)"

# Policy: the staging exporter may only touch the `staging` bucket.
POLICY=$(cat <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetBucketLocation", "s3:ListBucket", "s3:GetLifecycleConfiguration", "s3:PutLifecycleConfiguration"],
      "Resource": ["arn:aws:s3:::staging"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"],
      "Resource": ["arn:aws:s3:::staging/*"]
    }
  ]
}
JSON
)

SCRIPT=$(cat <<EOF
set -e
mc alias set m http://minio:9000 "\$MINIO_ROOT_USER" "\$MINIO_ROOT_PASSWORD" >/dev/null 2>&1
mc mb --ignore-existing m/$BUCKET
cat > /tmp/policy.json <<'POLICYEOF'
$POLICY
POLICYEOF
mc admin user svcacct rm m "$ACCESS_KEY" >/dev/null 2>&1 || true
mc admin user svcacct add m "\$MINIO_ROOT_USER" \
    --access-key "$ACCESS_KEY" \
    --secret-key "$SECRET_KEY" \
    --policy /tmp/policy.json >/dev/null
echo "PROVISIONED"
EOF
)

OVERRIDES=$(ACCESS_KEY="$ACCESS_KEY" SCRIPT="$SCRIPT" python3 - <<'PY'
import json, os
print(json.dumps({"spec": {"restartPolicy": "Never", "containers": [{
    "name": "mc",
    "image": "minio/mc:latest",
    "command": ["sh", "-c", os.environ["SCRIPT"]],
    "env": [
        {"name": "MINIO_ROOT_USER", "valueFrom": {"secretKeyRef": {"name": "minio-auth", "key": "root-user"}}},
        {"name": "MINIO_ROOT_PASSWORD", "valueFrom": {"secretKeyRef": {"name": "minio-auth", "key": "root-password"}}},
    ],
}]}}))
PY
)

kubectl delete pod "$POD" -n minio --ignore-not-found >/dev/null 2>&1
kubectl run "$POD" -n minio --restart=Never --image=minio/mc:latest \
    --overrides="$OVERRIDES" >/dev/null

for _ in $(seq 45); do
    phase=$(kubectl get pod "$POD" -n minio -o jsonpath='{.status.phase}' 2>/dev/null || true)
    [[ "$phase" == "Succeeded" || "$phase" == "Failed" ]] && break
    sleep 2
done

OUT=$(kubectl logs "$POD" -n minio 2>&1 || true)
kubectl delete pod "$POD" -n minio --ignore-not-found >/dev/null 2>&1

if ! grep -q PROVISIONED <<<"$OUT"; then
    echo "ERROR: provisioning failed:" >&2
    echo "$OUT" >&2
    exit 1
fi
echo "$OUT" | grep -v PROVISIONED || true

# Write the credentials into the gitignored env file.
python3 - "$ENV_FILE" "$ACCESS_KEY" "$SECRET_KEY" <<'PY'
import re, sys
path, ak, sk = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(path).read()
for key, val in (("S3_ACCESS_KEY", ak), ("S3_SECRET_KEY", sk)):
    pattern = re.compile(rf"^{key}=.*$", re.M)
    text = pattern.sub(f"{key}={val}", text) if pattern.search(text) else text + f"\n{key}={val}\n"
open(path, "w").write(text)
PY

echo "Created bucket '$BUCKET' and service account '$ACCESS_KEY' (scoped to $BUCKET)."
echo "Credentials written to exporter/.env-staging. Next:"
echo "  bash devops/secrets.sh vstag exporter exporter/.env-staging"
echo "  kubectl rollout restart deployment/gbv-exporter -n vstag"
