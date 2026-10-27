# Sidecar (planned)

A single long-running Python process for ML tasks (audio-separator for stems, rembg, Basic Pitch), managed with `uv`. Not built in Phase 1.

## Process model

- Started lazily by the Go side the first time a module needs it: `uv run --project <support>/sidecar python -m toolbox_sidecar`.
- One process for the app lifetime; restarted on crash with backoff.
- No network: talks only over **stdin/stdout, JSON Lines** (one JSON object per line, UTF-8). stderr is free-form logging, forwarded to job logs.

## Protocol

Request (Go → sidecar):

```json
{"id": "01J…", "method": "stems.split", "params": {"input": "/abs/in.wav", "outputDir": "/abs/out", "model": "htdemucs"}}
```

Streaming event (sidecar → Go), zero or more per request:

```json
{"id": "01J…", "event": "progress", "data": {"pct": 0.42, "msg": "Separating vocals"}}
{"id": "01J…", "event": "log", "data": {"line": "loaded model in 2.1s"}}
{"id": "01J…", "event": "output", "data": {"path": "/abs/out/vocals.wav"}}
```

Final response, exactly one per request:

```json
{"id": "01J…", "result": {"outputs": ["/abs/out/vocals.wav"]}}
{"id": "01J…", "error": {"code": "tool_failed", "message": "Model download failed", "hint": "…"}}
```

Cancellation (Go → sidecar):

```json
{"id": "01J…", "method": "$cancel"}
```

The sidecar must stop the work for that id promptly and answer with `error.code = "cancelled"`.

## Go side

A `sidecar.Client` multiplexes requests by id. Modules call it from `Run(ctx, job)`, mapping `progress`/`log`/`output` events onto `job.Progress`, `job.Log` and `job.Output`, and sending `$cancel` when `ctx` is done. The UI never learns that Python is involved.
