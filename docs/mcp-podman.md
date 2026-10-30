# Local Sokosumi MCP with Podman

This workspace runs the **local Preprod** Sokosumi MCP server in a rootless
Podman container. OpenCode starts it over stdio; Claude Code can use the same
container through a separate MCP config.

## Why a container?

- Keeps Python and the MCP dependencies off the host.
- Pins the upstream server source to a known commit.
- Makes the MCP transport a normal `podman run -i` process.
- Keeps the API key in `.env`, not in the image or the OpenCode config.

## Files

| Path | Purpose |
|---|---|
| `containers/sokosumi-mcp/Containerfile` | Multi-stage image build; clones upstream at a pinned commit. |
| `containers/sokosumi-mcp/README.md` | Container-specific notes. |
| `containers/sokosumi-mcp/claude-local.mcp.json` | Claude Code local stdio config. |
| `scripts/build-sokosumi-mcp.ps1` | Build helper (Windows). |
| `scripts/build-sokosumi-mcp.sh` | Build helper (macOS/Linux). |
| `scripts/run-sokosumi-mcp.ps1` | stdio launcher used by OpenCode. |
| `scripts/run-sokosumi-mcp.sh` | stdio launcher (macOS/Linux). |
| `scripts/mcp_smoke_test.py` | MCP initialize + tools/list smoke test. |

## Prerequisites

- Podman installed and its machine running:

  ```powershell
  podman info
  podman machine list
  ```

  On Windows, if the machine is stopped:

  ```powershell
  podman machine start
  ```

- A Preprod Sokosumi API key:
  <https://preprod.sokosumi.com/connections> → **API Keys**.

## 1. Configure `.env`

From the workspace root:

```powershell
Copy-Item .env.example .env
```

Edit `.env`:

```dotenv
SOKOSUMI_API_KEY=your_preprod_key
SOKOSUMI_NETWORK=preprod
```

Do not commit `.env`. It is already in `.gitignore`.

The image sets `SOKOSUMI_NETWORK=preprod` and `SOKOSUMI_OAUTH_NETWORK=preprod`
as defaults. The `.env` value makes the intent explicit. To use mainnet, override
both explicitly and use a mainnet key — but do not do that for the hackathon.

## 2. Build the image

```powershell
powershell ./scripts/build-sokosumi-mcp.ps1
```

This builds `localhost/sokosumi-mcp:local`. The first build downloads the pinned
upstream source and Python dependencies, so it needs network access.

To rebuild without cache:

```powershell
powershell ./scripts/build-sokosumi-mcp.ps1 -NoCache
```

On macOS/Linux:

```sh
./scripts/build-sokosumi-mcp.sh
```

## 3. Smoke-test the MCP handshake

```powershell
python ./scripts/mcp_smoke_test.py
```

Expected output resembles:

```text
OK: sokosumi-mcp 1.30.0 initialized; 25 tools available
  - list_agents
  - get_agent_input_schema
  ...
```

The smoke test sends `initialize`, `notifications/initialized`, and `tools/list`
over stdio. It does not require a valid API key for `tools/list`; API calls still
need the key.

## 4. Run it manually (optional)

```powershell
powershell ./scripts/run-sokosumi-mcp.ps1
```

The process speaks MCP over stdin/stdout. It is not meant to be typed into
interactively; use an MCP client or the smoke test.

Equivalent raw command:

```powershell
podman run --rm -i --security-opt=no-new-privileges --env-file .env localhost/sokosumi-mcp:local
```

Do **not** add `-t`/`--tty`. The MCP client needs a clean stdio pipe; a TTY can
corrupt the protocol.

## 5. OpenCode

`opencode.jsonc` already contains:

```jsonc
"sokosumi": {
  "type": "local",
  "command": [
    "powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", "scripts/run-sokosumi-mcp.ps1"
  ],
  "timeout": { "startup": 60000, "catalog": 60000 }
}
```

Do **not** add `"cwd": "."`. In OpenCode V2.2.1 on Windows, a relative `cwd`
caused the launcher to run outside the workspace and fail with
`The argument 'scripts/run-sokosumi-mcp.ps1' is not recognized`. Omitting `cwd`
uses the workspace directory and works. If you need an explicit directory,
use an absolute path.

Check the connection:

```powershell
opencode mcp list
```

Or open OpenCode and run `/mcps`. The server should show as connected. Tools are
named `sokosumi_*` (or grouped under `tools.sokosumi.*` in Code Mode).

If you change `.env` or rebuild the image, disconnect/reconnect the server in
`/mcps`, or restart the OpenCode service if it is stuck:

```powershell
opencode service restart
```

### Hosted mainnet server

`sokosumi-mainnet` is disabled by default. Enable it only for intentional
mainnet work:

```jsonc
"sokosumi-mainnet": {
  "type": "remote",
  "url": "https://mcp.sokosumi.com/mcp",
  "oauth": { "client_id": "sokosumi-opencode" },
  "disabled": false
}
```

Then run `/mcps`, select `sokosumi-mainnet`, and complete the browser OAuth flow.
OpenCode stores OAuth credentials outside the project config. Do not put an API
key in `opencode.jsonc` for this server.

## 6. Claude Code

`.mcp.json` in the workspace root registers the hosted mainnet server. For the
local Preprod container, use the separate config:

```powershell
claude --mcp-config ./containers/sokosumi-mcp/claude-local.mcp.json
```

That file runs the same PowerShell launcher. On macOS/Linux, change the command
to `bash` and use `scripts/run-sokosumi-mcp.sh`.

To keep the local server available in every Claude Code session for this project,
merge the `mcpServers` entry from `claude-local.mcp.json` into `.mcp.json`, or add
it with the Claude Code MCP command. Do not add it globally.

## 7. HTTP mode (optional)

The upstream server switches to Streamable HTTP when `PORT` is set. This is
useful for debugging with curl or a remote MCP client, but stdio is the default
for OpenCode here.

```powershell
podman run --rm -d --name sokosumi-mcp-http -p 8765:8000 -e PORT=8000 --env-file .env localhost/sokosumi-mcp:local
```

Endpoint:

```text
http://127.0.0.1:8765/mcp?network=preprod
```

The HTTP middleware accepts `x-api-key` or `Authorization: Bearer` headers, or
the legacy `?api_key=` query parameter. For local debugging only; do not put keys
in URLs that get logged or shared.

Stop it:

```powershell
podman stop sokosumi-mcp-http
```

## 8. Updating the pinned upstream

The image pins the upstream Sokosumi MCP commit in
`containers/sokosumi-mcp/Containerfile`:

```dockerfile
ARG SOKOSUMI_MCP_REF=6b710a0f5aa34dbd18275091c082ac15f5255bda
```

To update:

1. Check the upstream changes:
   <https://github.com/masumi-network/Sokosumi-MCP/commits/main>
2. Change `SOKOSUMI_MCP_REF` to the new commit.
3. Rebuild with `-NoCache`.
4. Run the smoke test and a real Preprod `get_user_profile()` call.

Do not use a moving branch in the image; a pinned commit keeps the hackathon
demo reproducible.

## 9. Troubleshooting

### `podman` is not found

Install Podman Desktop or the Podman CLI, then open a new terminal. On Windows,
make sure the Podman machine is running:

```powershell
podman machine start
```

### `Image localhost/sokosumi-mcp:local not found`

Build it:

```powershell
powershell ./scripts/build-sokosumi-mcp.ps1
```

### The container exits immediately

Run it manually and read stderr:

```powershell
podman run --rm -i --env-file .env localhost/sokosumi-mcp:local
```

Common causes:

- Missing `.env`.
- Bad `--env-file` path.
- Python dependency build failure during image build.
- Upstream source clone failed because the Podman machine has no network.

### `tools/list` works but Sokosumi calls return an auth error

- `SOKOSUMI_API_KEY` is empty or wrong.
- The key is mainnet but `SOKOSUMI_NETWORK=preprod`.
- The key was revoked.

Verify the account with the CLI:

```sh
sokosumi --preprod auth whoami --json
```

### OpenCode does not show the server

- Check `opencode mcp list`.
- Check `opencode.jsonc` is valid JSONC.
- Run the smoke test outside OpenCode.
- If the error mentions `scripts/run-sokosumi-mcp.ps1` is not recognized,
  remove `"cwd": "."` from the server entry. A relative `cwd` can make the
  launcher run outside the workspace; omitting it uses the workspace.
- Restart the OpenCode service: `opencode service restart`.

### Claude Code cannot start the server

- Run the launcher manually from the workspace root.
- Confirm `powershell` is in `PATH`.
- Confirm the image exists.
- Confirm `.env` exists.

## 10. Security notes

- The container runs as a non-root user.
- `--security-opt=no-new-privileges` is set by the launcher.
- The API key is passed at runtime through `--env-file .env`; it is not baked
  into the image.
- Do not publish the HTTP port to a public interface. Bind to localhost only.
- Do not commit `.env`, logs, or OAuth credentials.
- After the hackathon, revoke the Preprod key and remove the image. See
  `DELET.md/README.md`.
