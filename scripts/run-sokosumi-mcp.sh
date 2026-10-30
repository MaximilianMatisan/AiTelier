#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${1:-$ROOT/.env}"
IMAGE="${SOKOSUMI_MCP_IMAGE:-localhost/sokosumi-mcp:local}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: $ENV_FILE. Copy .env.example to .env and set SOKOSUMI_API_KEY." >&2
  exit 1
fi

if ! podman image exists "$IMAGE"; then
  echo "Image $IMAGE not found. Run scripts/build-sokosumi-mcp.sh first." >&2
  exit 1
fi

exec podman run --rm --security-opt=no-new-privileges --env-file "$ENV_FILE" -i "$IMAGE"
