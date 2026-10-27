# Audio engine (sidecar)

A single long-running CPython 3.12 process for ML audio tasks — stem separation (audio-separator), BPM & key (librosa), audio→MIDI (Basic Pitch ONNX) — installed and managed by the app with **uv**. See SPEC.md §4 and the "Audio engine" section of CLAUDE.md.

## Process model

- The app writes this project to `<support>/sidecar/`, runs `uv sync --frozen --no-dev` (CPython from uv, into `<support>/python`), and starts `<venv python> -u -X utf8 -m toolbox_sidecar` lazily on the first audio job.
- `python -m toolbox_sidecar --selftest` imports everything and prints one JSON line with versions (used after install).
- Stopped after 10 idle minutes, restarted after crashes, recycled after heavy jobs (`rssBytes` > 3 GiB).
- **No network listeners.** Talks only over stdin/stdout, JSON Lines (UTF-8, ≤ 16 MiB per line). stderr is free-form logging (written to the app log).

## Protocol

Startup (sidecar → Go, once):

```json
{"id": "", "event": "ready", "data": {"version": "0.2.0", "python": "3.12.16", "pid": 1234}}
```

Request (Go → sidecar):

```json
{"id": "01J…", "method": "stems.separate", "params": {"input": "/abs/in.wav", "outputDir": "/abs/out", "model": "htdemucs.yaml", "outputFormat": "wav", "baseName": "Song"}}
```

Events (zero or more per request):

```json
{"id": "01J…", "event": "progress", "data": {"pct": 0.42, "msg": "Separating"}}
{"id": "01J…", "event": "log", "data": {"line": "loaded model in 2.1s", "level": "info"}}
{"id": "01J…", "event": "output", "data": {"path": "/abs/out/Song - Vocals.wav"}}
```

`pct` is 0..1, or -1 for indeterminate.

Exactly one final message per request:

```json
{"id": "01J…", "result": {"stems": [{"name": "Vocals", "path": "/abs/out/Song - Vocals.wav"}], "rssBytes": 1500000000}}
{"id": "01J…", "error": {"code": "tool_failed", "message": "Model download failed", "hint": "Check your connection"}}
```

Error codes: `validation`, `tool_failed`, `cancelled`, `internal`.

Control (Go → sidecar):

```json
{"id": "01J…", "method": "$cancel"}
{"id": "", "method": "$shutdown"}
```

`$cancel` sets the request's cancel flag; handlers stop at the next `ctx.check_cancelled()` and answer with `error.code = "cancelled"`. If they can't within 3 s, Go kills and restarts the engine. `$shutdown` stops accepting work and exits within 2 s.

## Methods

| Method | Params | Result |
|---|---|---|
| `system.ping` | — | `{}` |
| `system.info` | — | `{python, packages, device}` |
| `system.warmup` | — | `{}` (populates the numba cache) |
| `stems.separate` | `input, outputDir, model, outputFormat, baseName` | `{stems: [{name, path}], model}` |
| `analysis.bpm_key` | `input` | `{bpm, bpmCandidates, key, camelot, confidence, alternatives, durationSec, truncated}` |
| `midi.transcribe` | `input, outputPath, onsetThreshold, frameThreshold, minNoteMs, minHz, maxHz, melodiaTrick` | `{notes, pitchRange, durationSec, outputPath}` |

Every result also carries `rssBytes`.

## Development

```sh
cd sidecar
uv sync                      # dev env incl. pytest
uv run pytest                # fast tests
TOOLBOX_SLOW=1 uv run pytest # + model-download tests
```
