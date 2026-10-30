#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${1:-$ROOT/hackathon-agent}"
REF="${2:-}"
REPO="https://github.com/masumi-network/tum-hackathon-quickstart.git"

if [[ -e "$DEST" ]]; then
  echo "Destination already exists: $DEST. Reuse it or remove it explicitly." >&2
  exit 1
fi

git clone "$REPO" "$DEST"
if [[ -n "$REF" ]]; then
  git -C "$DEST" checkout "$REF"
fi

if [[ -f "$DEST/.env.example" && ! -f "$DEST/.env" ]]; then
  cp "$DEST/.env.example" "$DEST/.env"
  chmod 600 "$DEST/.env" || true
fi

mkdir -p "$DEST/docs" "$DEST/.local"
echo "Bootstrapped $DEST at $(git -C "$DEST" rev-parse --short HEAD)"
echo "Next: cd $DEST && npm ci && edit .env and agent/instructions.md"
