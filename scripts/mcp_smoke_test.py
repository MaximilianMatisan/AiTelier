#!/usr/bin/env python3
"""Smoke-test the local Sokosumi MCP container over stdio.

Sends initialize, notifications/initialized, and tools/list one at a time,
reading each response before continuing. Does not require a valid API key for
tools/list.
"""

from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
IMAGE = os.environ.get("SOKOSUMI_MCP_IMAGE", "localhost/sokosumi-mcp:local")
ENV_FILE = ROOT / ".env"


def _pump(stream, target: queue.Queue[str | None]) -> None:
    for line in stream:
        target.put(line)
    target.put(None)


def main() -> int:
    cmd = [
        "podman",
        "run",
        "--rm",
        "--security-opt=no-new-privileges",
    ]
    if ENV_FILE.exists():
        cmd += ["--env-file", str(ENV_FILE)]
    else:
        print(
            f"warning: {ENV_FILE} not found; starting without an API key",
            file=sys.stderr,
        )
    cmd += ["-i", IMAGE]

    try:
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
    except FileNotFoundError:
        print("ERROR: podman was not found in PATH", file=sys.stderr)
        return 1

    stdout_q: queue.Queue[str | None] = queue.Queue()
    stderr_lines: list[str] = []
    threading.Thread(target=_pump, args=(proc.stdout, stdout_q), daemon=True).start()
    threading.Thread(
        target=lambda: stderr_lines.extend(proc.stderr.readlines()), daemon=True
    ).start()

    def send(message: dict) -> None:
        assert proc.stdin is not None
        proc.stdin.write(json.dumps(message) + "\n")
        proc.stdin.flush()

    def wait_for(response_id: int, timeout: float = 90.0) -> dict:
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"timed out waiting for response {response_id}")
            try:
                line = stdout_q.get(timeout=remaining)
            except queue.Empty:
                raise TimeoutError(
                    f"timed out waiting for response {response_id}"
                ) from None
            if line is None:
                raise EOFError("server closed stdout before replying")
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(obj, dict) and obj.get("id") == response_id:
                return obj

    try:
        send(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": {
                        "name": "sokosumi-mcp-smoke-test",
                        "version": "1.0.0",
                    },
                },
            }
        )
        init = wait_for(1)
        if "error" in init:
            raise RuntimeError(f"initialize failed: {init['error']}")

        send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        send({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
        listing = wait_for(2)
        if "error" in listing:
            raise RuntimeError(f"tools/list failed: {listing['error']}")

        server = init.get("result", {}).get("serverInfo", {})
        tools = listing.get("result", {}).get("tools", [])
        print(
            f"OK: {server.get('name', 'MCP server')} "
            f"{server.get('version', '')} initialized; {len(tools)} tools available"
        )
        for tool in tools[:12]:
            print(f"  - {tool.get('name', '?')}")
        if len(tools) > 12:
            print(f"  ... and {len(tools) - 12} more")
        return 0
    except (TimeoutError, EOFError, RuntimeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        if stderr_lines:
            print("--- stderr ---", file=sys.stderr)
            print("".join(stderr_lines), file=sys.stderr)
        return 1
    finally:
        try:
            if proc.stdin is not None:
                proc.stdin.close()
        except OSError:
            pass
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())
