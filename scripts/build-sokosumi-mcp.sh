#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTEXT="$ROOT/containers/sokosumi-mcp"
IMAGE="${SOKOSUMI_MCP_IMAGE:-localhost/sokosumi-mcp:local}"

if [[ ! -f "$CONTEXT/Containerfile" ]]; then
  echo "Containerfile not found: $CONTEXT/Containerfile" >&2
  exit 1
fi

podman build -f "$CONTEXT/Containerfile" -t "$IMAGE" "$CONTEXT"
echo "Built $IMAGE"
