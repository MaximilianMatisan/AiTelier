# Examples

Run the example generator inside the Podman image:

```powershell
& "C:\Program Files\RedHat\Podman\podman.exe" run --rm `
  -v "${PWD}/person3/examples:/app/examples" `
  -v "${PWD}/person3/artifacts:/app/artifacts" `
  --env LLM_MODE=mock `
  aitelier-person3:local python -m scripts.generate_example
```

This writes:

- `output.example.json` — full result including A2UI messages.
- `look-1-board.jpg`, `look-2-board.jpg` — connected garment boards.
- `lookbook.jpg` — gallery overview.
