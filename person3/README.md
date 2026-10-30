# AiTelier Person 3 — Stylist + Final Check

**Status:** first version (v0.1)

Python/FastAPI/LangGraph service. It runs only in Podman for the project workflow.

## What it does

1. Normalizes the Person 2 catalogue and customer brief.
2. Selects layered outfits with Gemini (or a deterministic mock).
3. Re-checks live price, stock, size, shipping, and delivery.
4. Evaluates five guarantees: budget, fit, availability, price integrity, delivery.
5. Composes garment product images into one connected board per outfit.
6. Builds an A2UI v0.9.1 gallery with layer tabs and product links.
7. Returns JSON, A2UI messages, and a Markdown fallback.

The board uses the garment product images themselves; no person or mannequin body is drawn.

## Build and run

```powershell
$podman = "C:\Program Files\RedHat\Podman\podman.exe"
& $podman build -t aitelier-person3:local -f person3/Containerfile person3
& $podman run --rm --name aitelier-person3 `
  -p 127.0.0.1:21951:8000 `
  --env-file .env `
  -v person3-artifacts:/data/artifacts `
  aitelier-person3:local
```

`ARTIFACT_BASE_URL` defaults to `http://127.0.0.1:21951`. If the A2UI renderer is remote,
set it to a URL it can reach.

## API

```text
GET  /healthz
POST /v1/style                 canonical input JSON -> full result
GET  /v1/style/{task_id}       stored result
GET  /v1/style/{task_id}/a2ui  A2UI messages as a JSON array
GET  /artifacts/...            generated boards and lookbook
GET  /static/...               fixture images
```

## Environment

- `GEMINI_API_KEY` or `ZAI_API_KEY`
- `GEMINI_BASE_URL` or `ZAI_BASE_URL` (OpenAI-compatible endpoint)
- `GEMINI_MODEL` or `ZAI_MODEL`
- `LLM_MODE=auto|mock|gemini` (default auto; mock when no key)
- `LIVE_CHECK_MODE=snapshot|stale|person1`
- `PERSON1_REFRESH_URL` for live re-checks
- `ARTIFACT_DIR`, `ARTIFACT_BASE_URL`
- `STATIC_DIR`, `FIXTURE_IMAGE_DIR`
- `MAX_ITEMS`, `MAX_IMAGES`, `REQUEST_TIMEOUT_SECONDS`

## Tests

All tests run inside Podman:

```powershell
& $podman run --rm aitelier-person3:local pytest -q
```

Default tests use a deterministic mock Gemini and local fixture images. The opt-in live test:

```powershell
& $podman run --rm --env-file .env -e RUN_LIVE_TESTS=1 aitelier-person3:local pytest -q -m live
```

For a deterministic example inside the image:

```powershell
& $podman run --rm `
  -v "${PWD}/person3/examples:/app/examples" `
  -v "${PWD}/person3/artifacts:/app/artifacts" `
  --env LLM_MODE=mock aitelier-person3:local python -m scripts.generate_example
```
