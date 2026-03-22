#!/bin/bash
# Build and optionally push the message-worker Docker image
#
# Usage:
#   cd message-worker && ./build.sh 0.1.0           # Build only
#   cd message-worker && ./build.sh 0.1.0 --push    # Build and push to Docker Hub

set -e

TAG="${1:-latest}"
PUSH="${2:-}"

IMAGE="vlabresearch/message-worker:${TAG}"

echo "Building $IMAGE..."

docker build -t "$IMAGE" -f Dockerfile .

echo "Successfully built $IMAGE"

if [ "$PUSH" = "--push" ]; then
    echo "Pushing $IMAGE to Docker Hub..."
    docker push "$IMAGE"
    echo "Successfully pushed $IMAGE"
fi
