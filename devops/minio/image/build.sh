#!/usr/bin/env bash
# Build a MinIO community-edition release from source and push it to our
# Artifact Registry. Usage: ./build.sh [RELEASE.tag] [--push]
set -euo pipefail

RELEASE=${1:-RELEASE.2025-09-07T16-13-09Z}
IMAGE=us-west1-docker.pkg.dev/toixotoixo/vlab-research/minio:${RELEASE}
cd "$(dirname "$0")"

rm -rf src
git clone -q --depth 1 --branch "$RELEASE" https://github.com/minio/minio.git src
COMMIT=$(git -C src rev-parse HEAD)

docker build -f Dockerfile --build-arg RELEASE="$RELEASE" --build-arg COMMIT="$COMMIT" -t "$IMAGE" src
docker run --rm --entrypoint /usr/bin/minio "$IMAGE" --version

if [[ "${2:-}" == "--push" ]]; then
  docker push "$IMAGE"
fi
