#!/usr/bin/env bash

set -euo pipefail

# Provision the media bucket and its two SCOPED MinIO service accounts, from the
# policy files checked into the repo. Nothing here is created by hand and no
# policy is typed at a prompt -- the JSON in devops/minio-media-policy.json and
# devops/minio-media-readonly-policy.json is the source of truth, and this script
# is only the thing that applies it.
#
#   planning/media-abstraction.md §4.3
#
# Three accounts, not one, because the consumers want different halves:
#
#   <bucket>-writer  dashboard-server  Get/Put/Delete on <bucket>/*  (minio-media-policy.json)
#   <bucket>-reader  media-proxy       Get           on <bucket>/*   (minio-media-readonly-policy.json)
#   <bucket>-backup  mc mirror CronJob Get + List    on <bucket>     (minio-media-backup-policy.json)
#                                      -- production only
#
# None can reach the exports bucket (`fly` / `staging`), which holds respondent
# data, and NONE IS THE ROOT CREDENTIAL.
#
# The reader deliberately has NO s3:ListBucket: asset URLs are unguessable
# capability URLs (§4.6), and a list permission on the public read path would
# undo exactly the property that makes them safe. The backup account is a
# separate identity precisely because `mc mirror` DOES need ListBucket -- giving
# it to the proxy to save an account would trade the security model for a line
# of shell.
#
# NO ANONYMOUS POLICY IS SET, AND NONE MAY BE. See devops/values/minio.yaml.
#
# Runs `mc` inside the cluster so the MinIO root credentials are read from the
# `minio-auth` Secret by the pod itself and never touch your shell or the repo.
#
# Idempotent: re-running recreates both service accounts with fresh key pairs and
# rewrites the env files. The bucket is left alone.
#
# Usage: bash media-svcacct.sh <production|staging>
#
# After this, apply the secrets and restart:
#   bash ../secrets.sh vprod dashboard-media ../../dashboard-server/.env-media-production
#   bash ../secrets.sh vprod media-proxy     ../../media-proxy/.env-media-production
#   kubectl rollout restart deployment/gbv-dashboard    -n vprod
#   kubectl rollout restart deployment/gbv-media-proxy  -n vprod

usage() {
    echo "Usage: $(basename "$0") <production|staging>" >&2
    exit 1
}

[[ $# -eq 1 ]] || usage

ENV_NAME="$1"
DIR="$(cd "$(dirname "$0")" && pwd)"

# The bucket is env-scoped for the same reason exports are (`fly` vs `staging`):
# a shared bucket would let a staging deploy DELETE production media objects,
# and staging test uploads would become permanent production objects served
# from media.vlab.digital. planning/media-abstraction.md §4.3 does not name a
# staging bucket -- this mirrors the existing exports split.
case "$ENV_NAME" in
    production) BUCKET="media";         NAMESPACE="vprod"; SUFFIX="production" ;;
    staging)    BUCKET="media-staging"; NAMESPACE="vstag"; SUFFIX="staging" ;;
    *) usage ;;
esac

WRITER_KEY="${BUCKET}-writer"
READER_KEY="${BUCKET}-reader"
BACKUP_KEY="${BUCKET}-backup"
WRITER_SECRET="$(openssl rand -hex 20)"
READER_SECRET="$(openssl rand -hex 20)"
BACKUP_SECRET="$(openssl rand -hex 20)"

DASHBOARD_ENV="$DIR/../../dashboard-server/.env-media-$SUFFIX"
PROXY_ENV="$DIR/../../media-proxy/.env-media-$SUFFIX"
MIRROR_ENV="$DIR/../backup/.env-media-mirror"

ENV_FILES=("$DASHBOARD_ENV" "$PROXY_ENV")
# Each env file is paired with its own template. Do NOT derive the template as
# "$(dirname)/.env-example" -- the mirror's template is named differently, and
# the guessed path sent operators looking for a file that does not exist.
ENV_TEMPLATES=(
    "$DIR/../../dashboard-server/.env-example"
    "$DIR/../../media-proxy/.env-example"
)
# The mc mirror CronJob is production-only: it exists to protect the one copy of
# researchers' uploads, and staging's uploads are disposable by definition.
if [[ "$ENV_NAME" == "production" ]]; then
    ENV_FILES+=("$MIRROR_ENV")
    ENV_TEMPLATES+=("$DIR/../backup/.env-media-mirror-example")
fi

for i in "${!ENV_FILES[@]}"; do
    f="${ENV_FILES[$i]}"
    if [[ ! -e "$f" ]]; then
        echo "ERROR: $f does not exist." >&2
        echo "       Copy the committed template first:" >&2
        echo "         cp ${ENV_TEMPLATES[$i]} $f" >&2
        exit 1
    fi
    [[ -w "$f" ]] || { echo "ERROR: cannot write $f" >&2; exit 1; }
done

# Read the policies from the checked-in files and retarget their ARNs at the
# env's bucket. The rewrite is exact and fails loudly if a Resource does not
# name the `media` bucket -- a silently unmatched ARN would produce a policy
# that grants nothing, or worse, one that still points at production.
render_policy() {
    python3 - "$1" "$BUCKET" <<'PY'
import json, sys
path, bucket = sys.argv[1], sys.argv[2]
doc = json.load(open(path))
for stmt in doc["Statement"]:
    out = []
    for arn in stmt["Resource"]:
        if arn == "arn:aws:s3:::media":
            out.append(f"arn:aws:s3:::{bucket}")
        elif arn == "arn:aws:s3:::media/*":
            out.append(f"arn:aws:s3:::{bucket}/*")
        else:
            raise SystemExit(f"{path}: unexpected Resource {arn!r}; refusing to guess")
    stmt["Resource"] = out
print(json.dumps(doc))
PY
}

WRITER_POLICY="$(render_policy "$DIR/../minio-media-policy.json")"
READER_POLICY="$(render_policy "$DIR/../minio-media-readonly-policy.json")"
BACKUP_POLICY="$(render_policy "$DIR/../minio-media-backup-policy.json")"

POD="mc-provision-media-$SUFFIX"

SCRIPT=$(cat <<EOF
set -e
mc alias set m http://minio:9000 "\$MINIO_ROOT_USER" "\$MINIO_ROOT_PASSWORD" >/dev/null 2>&1
mc mb --ignore-existing m/$BUCKET

# Assert, do not assume: if a canned anonymous policy was ever set on this
# bucket, unset it. \`download\` grants ListBucket and \`public\` grants write --
# either one defeats the capability-URL model (§4.3).
mc anonymous set none m/$BUCKET >/dev/null

cat > /tmp/writer.json <<'POLICYEOF'
$WRITER_POLICY
POLICYEOF
cat > /tmp/reader.json <<'POLICYEOF'
$READER_POLICY
POLICYEOF

mc admin user svcacct rm m "$WRITER_KEY" >/dev/null 2>&1 || true
mc admin user svcacct add m "\$MINIO_ROOT_USER" \
    --access-key "$WRITER_KEY" \
    --secret-key "$WRITER_SECRET" \
    --policy /tmp/writer.json >/dev/null

mc admin user svcacct rm m "$READER_KEY" >/dev/null 2>&1 || true
mc admin user svcacct add m "\$MINIO_ROOT_USER" \
    --access-key "$READER_KEY" \
    --secret-key "$READER_SECRET" \
    --policy /tmp/reader.json >/dev/null

cat > /tmp/backup.json <<'POLICYEOF'
$BACKUP_POLICY
POLICYEOF
mc admin user svcacct rm m "$BACKUP_KEY" >/dev/null 2>&1 || true
mc admin user svcacct add m "\$MINIO_ROOT_USER" \
    --access-key "$BACKUP_KEY" \
    --secret-key "$BACKUP_SECRET" \
    --policy /tmp/backup.json >/dev/null

echo "PROVISIONED"
EOF
)

OVERRIDES=$(SCRIPT="$SCRIPT" python3 - <<'PY'
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

# Write the credentials into the gitignored env files. The env file is the
# source of truth for the k8s secret -- never `kubectl create secret` by hand.
# $1 env file, $2 access-key env-var name, $3 secret-key env-var name,
# $4 access key, $5 secret key.
write_env() {
    python3 - "$@" <<'PY'
import re, sys
path, ak_key, sk_key, ak, sk = sys.argv[1:6]
text = open(path).read()
for key, val in ((ak_key, ak), (sk_key, sk)):
    pattern = re.compile(rf"^{key}=.*$", re.M)
    text = pattern.sub(f"{key}={val}", text) if pattern.search(text) else text + f"\n{key}={val}\n"
open(path, "w").write(text)
PY
}

write_env "$DASHBOARD_ENV" S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY "$WRITER_KEY" "$WRITER_SECRET"
write_env "$PROXY_ENV"     S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY "$READER_KEY" "$READER_SECRET"
if [[ "$ENV_NAME" == "production" ]]; then
    write_env "$MIRROR_ENV" SOURCE_S3_ACCESS_KEY_ID SOURCE_S3_SECRET_ACCESS_KEY \
        "$BACKUP_KEY" "$BACKUP_SECRET"
fi

cat <<EOF

Provisioned bucket '$BUCKET' with scoped service accounts:
  $WRITER_KEY  Get/Put/Delete on $BUCKET/*  -> $DASHBOARD_ENV
  $READER_KEY  Get            on $BUCKET/*  -> $PROXY_ENV
  $BACKUP_KEY  Get + List     on $BUCKET    -> $MIRROR_ENV (production only)

Next:
  bash devops/secrets.sh $NAMESPACE dashboard-media $DASHBOARD_ENV
  bash devops/secrets.sh $NAMESPACE media-proxy     $PROXY_ENV
  kubectl rollout restart deployment/gbv-dashboard   -n $NAMESPACE
  kubectl rollout restart deployment/gbv-media-proxy -n $NAMESPACE

  # production only, and only once BACKUP_S3_ENDPOINT / BACKUP_S3_BUCKET and the
  # target's credentials are filled in -- devops/secrets.sh refuses the file
  # while it still contains __FILL_...__ placeholders:
  bash devops/secrets.sh minio minio-media-mirror devops/backup/.env-media-mirror
  kubectl apply -f devops/backup/minio-media-mirror.yaml

Deploy gate (§9.2 step 1): confirm anonymous access is denied, including via
storage-api.vlab.digital:
  curl -sS -o /dev/null -w '%{http_code}\\n' https://storage-api.vlab.digital/$BUCKET/     # expect 403
  curl -sS -o /dev/null -w '%{http_code}\\n' https://storage-api.vlab.digital/$BUCKET/a/x  # expect 403
EOF
