# Sokosumi MCP container

This directory builds the upstream
[Sokosumi MCP server](https://github.com/masumi-network/Sokosumi-MCP) into a
local Podman image.

## Image

```text
localhost/sokosumi-mcp:local
```

The build pins upstream commit
`6b710a0f5aa34dbd18275091c082ac15f5255bda` in `Containerfile`. The source is
cloned during the build, not committed to this repository.

## Build

From the workspace root:

```powershell
powershell ./scripts/build-sokosumi-mcp.ps1
```

or:

```sh
./scripts/build-sokosumi-mcp.sh
```

## Run

stdio (used by OpenCode):

```powershell
podman run --rm -i --security-opt=no-new-privileges --env-file .env localhost/sokosumi-mcp:local
```

HTTP (debugging only):

```powershell
podman run --rm -d --name sokosumi-mcp-http -p 8765:8000 -e PORT=8000 --env-file .env localhost/sokosumi-mcp:local
```

Then use `http://127.0.0.1:8765/mcp?network=preprod`.

## Environment

| Variable | Purpose |
|---|---|
| `SOKOSUMI_API_KEY` | Preprod API key for stdio mode. |
| `SOKOSUMI_NETWORK` | `preprod` or `mainnet`. The image defaults to `preprod`. |
| `SOKOSUMI_OAUTH_NETWORK` | OAuth network for HTTP mode. Defaults to `preprod`. |
| `PORT` | Set to switch from stdio to Streamable HTTP. |

Pass secrets with `--env-file`, never in the image or a committed config.

## Notes

- The server runs as UID 10001, not root.
- The launcher adds `--security-opt=no-new-privileges`.
- The image includes `git` only in the build stage, not the runtime stage.
- The upstream server uses in-memory OAuth sessions; restarting the container
  invalidates them. That is fine for local stdio use.
- For the full runbook, see `docs/mcp-podman.md`.
