#!/usr/bin/env bash
#
# Build the fenced POC image locally. See docs/fenced-poc.md.
#
#   scripts/build-poc-image.sh            -> log10x/poc:local
#   scripts/build-poc-image.sh 1.29.39    -> log10x/poc:1.29.39
#
# There is deliberately no publish step. Pushing this image is a separate,
# human decision: it carries the engine binary and the symbol library, and the
# tag a customer runs should name a build, not whatever `latest` was that day.
set -euo pipefail

cd "$(dirname "$0")/.."

TAG="${1:-local}"
IMAGE="log10x/poc:${TAG}"
ENGINE_IMAGE="${ENGINE_IMAGE:-log10x/edge-10x:latest}"

echo "engine base: ${ENGINE_IMAGE}"
echo "building:    ${IMAGE}"

docker build \
  -f Dockerfile.poc \
  -t "${IMAGE}" \
  --build-arg "ENGINE_IMAGE=${ENGINE_IMAGE}" \
  --build-arg "GIT_SHA=$(git rev-parse HEAD)" \
  --build-arg "BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  .

echo
# `docker images` reports the on-disk size across every layer; `inspect .Size`
# under containerd snapshotting reports only part of it, which reads as a
# 5x-smaller image and is not the number the user will see.
docker image inspect "${IMAGE}" --format 'built {{.Id}}'
docker images "${IMAGE}" --format 'size on disk: {{.Size}}'
echo
echo "Engine inside the image:"
docker run --rm --network none --hostname localhost --entrypoint /opt/tenx-edge/bin/tenx-edge "${IMAGE}" --version

cat <<'NEXT'

Next:
  1. Mint a licence, outside any container:
       export TENX_LICENSE_KEY=$(curl -s https://api.log10x.com/api/v1/license/demo -d '{}' \
         | sed -n 's/.*"license":"\([^"]*\)".*/\1/p')
  2. Point your MCP host at the docker run line in docs/fenced-poc.md.
NEXT
