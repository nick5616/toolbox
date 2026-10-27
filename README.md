# Toolbox

A personal, local-only desktop app that wraps open-source media, AI and utility tools behind one fast UI. Wails v3 (Go) + React/TypeScript. No servers, no telemetry.

Phase 1: core (modules, jobs, SQLite library, dependency detection) and a yt-dlp **Downloader**.

## Run

Prerequisites: Go ≥ 1.27, Node ≥ 22.12, `wails3` v3.0.0 (`go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0`), and for downloads `ffmpeg` (+`ffprobe`) and ideally `deno`:

```sh
brew install go node ffmpeg deno          # macOS
```

```sh
cd frontend && npm install && cd ..
task dev:sandbox      # dev mode, data under .dev/
wails3 build          # production binary in bin/
```

yt-dlp is installed by the app itself: Settings → Dependencies → Install.

See `CLAUDE.md` for architecture and `SPEC.md` for the current phase.
