#!/usr/bin/env bash
#
# Grow the PersistentVolumeClaims behind a StatefulSet.
#
#   ./devops/resize-statefulset-pvc.sh <namespace> <statefulset> <new-size> [--yes]
#   ./devops/resize-statefulset-pvc.sh vstag gbv-cockroachdb 20Gi
#
# WHY THIS SCRIPT EXISTS. A StatefulSet's `volumeClaimTemplates` are IMMUTABLE, so
# `helm upgrade` cannot resize an existing volume -- it either errors or silently
# leaves the PVC alone while the values file claims the new number. The only way
# through is to patch the live PVCs and then recreate the StatefulSet so its
# template agrees. That is a live mutation, which the repo otherwise forbids, so
# it is encoded HERE rather than typed by hand: the file is the record.
#
# THE VALUES FILE IS STILL THE SOURCE OF TRUTH. Edit the size there FIRST
# (for cockroachdb: `cockroachdb.storage.persistentVolume.size` in
# devops/values/<env>.yaml), then run this, then `helm upgrade`. Running this
# without changing the values file just means the next apply disagrees with the
# disk.
#
# ORDER MATTERS, AND STEP 3 IS THE ONE PEOPLE GET WRONG:
#
#   1. Patch each PVC.       -- this is what actually grows the disk
#   2. Wait for the resize.  -- online on GKE; the pod keeps running
#   3. Delete the StatefulSet with --cascade=orphan.
#                            -- WITHOUT --cascade=orphan this deletes the PODS,
#                               and for a database that is an outage. With it,
#                               the pods keep running unmanaged and the recreated
#                               StatefulSet adopts them back by label.
#   4. helm upgrade.         -- recreates the StatefulSet with the new template
#
# ONLINE RESIZE. GKE's pd.csi.storage.gke.io supports expanding a mounted volume,
# so no restart is needed to grow the filesystem. In-tree `kubernetes.io/gce-pd`
# PVs provisioned years ago are handled by the same driver through CSI migration
# and behave the same way. If a volume does stall in FileSystemResizePending, a
# pod restart completes it.
#
# SHRINKING IS NOT POSSIBLE. Kubernetes only supports growing a PVC. This script
# refuses to go smaller rather than failing halfway.
#
set -euo pipefail

NS="${1:-}"; STS="${2:-}"; SIZE="${3:-}"; CONFIRM="${4:-}"

if [[ -z "$NS" || -z "$STS" || -z "$SIZE" ]]; then
  echo "usage: $0 <namespace> <statefulset> <new-size> [--yes]" >&2
  echo "   eg: $0 vstag gbv-cockroachdb 20Gi" >&2
  exit 2
fi

# Bytes, so 20Gi vs 5Gi compares correctly and we can refuse a shrink.
to_bytes() {
  python3 - "$1" <<'PY'
import re,sys
u={'Ki':2**10,'Mi':2**20,'Gi':2**30,'Ti':2**40,'K':10**3,'M':10**6,'G':10**9,'T':10**12}
m=re.fullmatch(r'(\d+(?:\.\d+)?)([A-Za-z]*)',sys.argv[1].strip())
if not m: print('ERR'); sys.exit(1)
print(int(float(m.group(1))*u.get(m.group(2),1)))
PY
}

echo "==> StatefulSet $STS in $NS"
kubectl get statefulset "$STS" -n "$NS" >/dev/null

# Only the PVCs this StatefulSet owns. The naming is
# <volumeClaimTemplate>-<statefulset>-<ordinal>, which is stable and is how the
# recreated StatefulSet finds them again.
mapfile -t PVCS < <(kubectl get pvc -n "$NS" -o name 2>/dev/null | sed 's|persistentvolumeclaim/||' | grep -E -- "-${STS}-[0-9]+$" || true)
if [[ ${#PVCS[@]} -eq 0 ]]; then
  echo "no PVCs matching -${STS}-<ordinal> in $NS" >&2; exit 1
fi

NEW_B="$(to_bytes "$SIZE")"
SC="$(kubectl get pvc "${PVCS[0]}" -n "$NS" -o jsonpath='{.spec.storageClassName}')"
EXPAND="$(kubectl get storageclass "$SC" -o jsonpath='{.allowVolumeExpansion}')"
if [[ "$EXPAND" != "true" ]]; then
  echo "storageClass $SC has allowVolumeExpansion=$EXPAND -- cannot resize" >&2; exit 1
fi
echo "    storageClass $SC (allowVolumeExpansion=true)"

for p in "${PVCS[@]}"; do
  CUR="$(kubectl get pvc "$p" -n "$NS" -o jsonpath='{.spec.resources.requests.storage}')"
  CUR_B="$(to_bytes "$CUR")"
  echo "    $p: $CUR -> $SIZE"
  if (( NEW_B < CUR_B )); then
    echo "REFUSING: $p is $CUR; Kubernetes cannot shrink a PVC." >&2; exit 1
  fi
done

if [[ "$CONFIRM" != "--yes" ]]; then
  read -r -p "Resize ${#PVCS[@]} PVC(s) to $SIZE and recreate $STS (pods stay up)? [y/N] " a
  [[ "$a" == "y" || "$a" == "Y" ]] || { echo "aborted"; exit 1; }
fi

# 1 + 2. Grow each PVC and wait for the volume to actually report the new size.
for p in "${PVCS[@]}"; do
  CUR_B="$(to_bytes "$(kubectl get pvc "$p" -n "$NS" -o jsonpath='{.spec.resources.requests.storage}')")"
  if (( NEW_B == CUR_B )); then
    echo "==> $p already $SIZE, skipping patch"
  else
    echo "==> patching $p"
    kubectl patch pvc "$p" -n "$NS" --type=merge \
      -p "{\"spec\":{\"resources\":{\"requests\":{\"storage\":\"$SIZE\"}}}}"
  fi

  echo "==> waiting for $p to report $SIZE (status.capacity, not spec)"
  for _ in $(seq 1 60); do
    GOT="$(kubectl get pvc "$p" -n "$NS" -o jsonpath='{.status.capacity.storage}' 2>/dev/null || true)"
    [[ -n "$GOT" ]] && (( $(to_bytes "$GOT") >= NEW_B )) && { echo "    $p now $GOT"; break; }
    COND="$(kubectl get pvc "$p" -n "$NS" -o jsonpath='{.status.conditions[*].type}' 2>/dev/null || true)"
    [[ -n "$COND" ]] && echo "    ...$COND"
    sleep 5
  done
  GOT="$(kubectl get pvc "$p" -n "$NS" -o jsonpath='{.status.capacity.storage}')"
  if (( $(to_bytes "$GOT") < NEW_B )); then
    echo "WARNING: $p status.capacity is still $GOT." >&2
    echo "If it reports FileSystemResizePending, restart the pod to finish:" >&2
    echo "  kubectl delete pod ${p#*-} -n $NS" >&2
  fi
done

# 3. Orphan-delete so the pods survive; the recreated StatefulSet re-adopts them.
echo "==> deleting StatefulSet $STS (--cascade=orphan; pods keep running)"
kubectl delete statefulset "$STS" -n "$NS" --cascade=orphan

cat <<EOF

==> DONE with the part helm cannot do.

NOW RUN helm upgrade to recreate the StatefulSet with the new template. Until you
do, $STS does not exist as a controller -- the pods are running unmanaged, so
nothing would replace one that died:

  cd devops && helm upgrade gbv vlab -f values/<env>.yaml -n $NS

Then confirm the pod sees the space, which is the only check that matters:

  kubectl exec -n $NS ${STS}-0 -- df -h /cockroach/cockroach-data
EOF
