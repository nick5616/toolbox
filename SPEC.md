# Toolbox — Phase 5 Spec: Local Chat, OCR, Vault, Tool Packs

Status: **APPROVED 2026-10-28.**
Date: 2026-10-28. Author: architect session (Opus).

Phases 1–4 are shipped; their specs are archived in `docs/specs/phase-{1..4}.md`, and every contract there still holds unless changed here. "P4 §x" etc. refer to those files.

---

## 0. Research findings this spec relies on

Verified hands-on on this Windows machine (RTX 3070, 32 GB, usually ~6 GB free) on 2026-10-28, in `.dev/p5-research/{llm,ocr,vault}/`, except where marked *docs only*.

### 0.1 Local Chat

| Topic | Finding | Consequence |
|---|---|---|
| **llama.cpp `llama-server` build b11938** (MIT) | GitHub `releases/latest` (v0.7.0) has no binaries. The binaries live in `bNNNNN` prerelease tags. All assets below are at `https://github.com/ggml-org/llama.cpp/releases/download/b11938/<asset>`. | Pin `b11938` explicitly. |
| Windows asset | `llama-b11938-bin-win-vulkan-x64.zip`: 37,184,647 B, sha256 `9ecd072c6e785fa2b932229c86f845695198195c4f29b99b85ed42dccb022aa6`. It holds 53 files (104 MB unpacked). `llama-server.exe` is a stub that loads `llama-server-impl.dll`, `llama*.dll`, `ggml*.dll` and `libomp.dll`. | Keep the whole folder. |
| macOS asset | `llama-b11938-bin-macos-arm64.tar.gz`: 16,341,137 B, sha256 `b1ed33aacd0927eaa69644e6b15e3206115f7f80dfc7501de86df89dab853e9f`. Metal is built in. It contains about 20 **dylib symlinks**. | The archive extractor must support symlinks (§3.3). |
| Licence file | The Windows zip lacks the llama.cpp MIT licence. | Ship it ourselves (§3.3). |
| Port | `--port 0` binds a random port and logs `listening on http://127.0.0.1:<port>` (about 4 s after start). An occupied port gives `couldn't bind HTTP server socket` and exit code 1. | Parse the port from the log. |
| Auth | With `--api-key-file <f>` (or the env var `LLAMA_API_KEY`), `/v1/*` and `/props` return 401 without the key. **`/health` is unauthenticated.** | Meets our "127.0.0.1 plus a random per-launch token" rule. Nothing sensitive is on `/health`. |
| Streaming | `/v1/chat/completions` with `stream:true` and `stream_options.include_usage` sends SSE `data:` chunks (role, then content deltas, then finish, then a usage chunk with `timings.predicted_per_second`), then `data: [DONE]`. Closing the request **cancels generation within ~1 s**. | Use a stdlib SSE reader; cancel through the request context. |
| Speed and memory | Qwen3-4B-Instruct-2507 Q4_K_M on the RTX 3070 with Vulkan: generation 76–110 tok/s, prompt eval about 4,400 tok/s (bench). It used about 3.7 GB VRAM at `-c 8192` and a 3 GB working set. On CPU (`-ngl 0`) generation is 4–10 tok/s. | GPU is the default path. |
| GPU failures | A VRAM shortage with `--fit on` (the default) shrinks the context or offloaded layers to fit. With fit off it logs `ErrorOutOfDeviceMemory` and exits 1. | Keep fit on. On a non-zero exit, show the log tail. |
| Idle sleep | `--sleep-idle-seconds N` unloads the weights: the process drops to 22 MB and VRAM is freed. The next request reloads (about 6 s). | Use it to free memory while idle. |
| Process | A single process. A tree-kill frees its VRAM. | Run it through `core/proc`. |
| **Models** (sha256 from HF `lfs.oid`, verified on download) | Qwen3-4B-Instruct-2507 Q4_K_M (Apache-2.0, 2,497,281,120 B) was downloaded in 4 m 37 s with sha256 verified. It answered code, arithmetic and translation prompts correctly with `--jinja`. HF supports Range resume through its CDN redirect. Not chat-tested here (download cap): Qwen3.5-2B and Gemma 4 E4B. Llama 3.2 and Gemma 3 have non-permissive licences. | Catalog in §4.2. Unverified models are verified during the build or dropped. |
| Ollama (*docs only*; not installed here) | No authentication. It listens on 127.0.0.1:11434 by default. `/api/tags` lists models and `/api/chat` streams NDJSON. | Optional backend that talks to an Ollama the user already runs: outbound to localhost only, opt-in. |

### 0.2 OCR

| Topic | Finding | Consequence |
|---|---|---|
| **RapidOCR 3.10.0** (Apache-2.0; PaddleOCR weights under Apache-2.0) | The 27 MB wheel bundles the PP-OCRv6 small detection and recognition models plus the cls model. It covers Latin-script languages, Chinese and Japanese, with no download. On known text: English 0% CER, German/French 0.6%. A dense English 200 dpi scan page takes 3–5 s on CPU, a sparse page 1–1.5 s, with about 170 MB RSS. `return_word_box=True` gives word quads at no extra cost. | It becomes the OCR engine, running in the AI engine. Pages render at 200 dpi. |
| Other scripts | v6 small has no Cyrillic or Arabic. The v5 mobile recognition models cover Cyrillic, Arabic, Korean, Greek, Thai and Devanagari (7–8 MB each), paired with v5 mobile detection (4.8 MB). Downloads come from `modelscope.cn` with sha256 listed in RapidOCR's `default_models.yaml` (verified). Arabic needs `python-bidi`. | A language picker maps each choice to a detection/recognition pair (§5.1). |
| Searchable PDF prototype (`.dev/p5-research/ocr/scripts/compose.py`) | It uses pypdf (BSD). For each page it appends a content stream of hex CID text in render mode 3 (invisible), with a 624-byte embedded glyphless Type0 font and an identity ToUnicode map. A per-word `Tz` stretches each word to its box. It inverts `/Rotate` 0/90/180/270, cropbox offsets and skew. **The original image streams are byte-identical and the render diff is 0.** Text extracts correctly with pdfium and pypdf. Size grows about 10%. `pdfcpu stamp` misplaced text on rotated pages. | The PDF overlay happens in the engine with pypdf (§5.3). |
| Dependencies | `rapidocr`, `python-bidi` and `pypdf` add opencv-python-headless (113 MB installed), shapely, pyclipper, omegaconf and colorlog. All have macOS arm64 wheels, and no existing lock entry changes. | Engine 0.5.0. Existing installs show **Update**. |
| Rejected | Tesseract (installer-only on Windows), OCRmyPDF (needs Tesseract), surya (unclear weight licence), PyMuPDF (AGPL). | — |

### 0.3 Vault

| Topic | Finding | Consequence |
|---|---|---|
| **filippo.io/age v1.3.2** (BSD-3) | Pure Go; builds for darwin/arm64 with CGO off. One X25519 identity wrapped by a scrypt passphrase recipient: unwrapping takes 98 ms at work factor 15, **588 ms at 18** and 2.3 s at 20. A wrong passphrase gives a clear error. Streaming encryption of 256 MiB took 585 ms (about 440 MB/s); decryption took 389 ms. Overhead is 16 B per 64 KiB chunk plus the header. A flipped byte gives "failed to decrypt and authenticate payload chunk". | Unlocking takes one scrypt at work factor 18; file contents use the fast X25519 recipient. Tampering is detected. |

### 0.4 Tool packs (sizes measured in `.dev/support` and `.dev/p5-research/packs/` on 2026-10-28)

| Topic | Finding | Consequence |
|---|---|---|
| **FFmpeg, Windows** | Gyan's versioned release builds on GitHub persist (`GyanD/codexffmpeg`, tags `8.1` … `9.0.2`). BtbN autobuild tags are rotated away, so they can't be pinned. `ffmpeg-9.0.2-essentials_build.zip` is 114,768,076 B, sha256 `60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba` (also the GitHub asset digest). It unpacks to `ffmpeg-9.0.2-essentials_build/bin/{ffmpeg,ffprobe,ffplay}.exe` (105.4 + 105.2 + 106.9 MB, static) plus `LICENSE` (GPLv3). The encoders include libx264, libx265, libvpx-vp9, libaom-av1, libopus, libmp3lame, libwebp, aac and flac. | Pin 9.0.2 and keep only `ffmpeg.exe`, `ffprobe.exe` and `LICENSE`: **210.6 MB** on disk. |
| **FFmpeg, macOS arm64** | Martin Riedl's builds (`ffmpeg.martin-riedl.de`) are signed and notarized, with a `.sha256` next to every file. The versioned URL is `https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/{ffmpeg,ffprobe}.zip`. `ffmpeg.zip`: 28,395,699 B, sha256 `c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924`, holding one 66,332,880 B binary. `ffprobe.zip`: 28,317,701 B, sha256 `fcbe839537485eaee7a7a8bc5cbc0f90d53617e80943e8a5b2e31cb851197ea6`, holding one 66,158,064 B binary. **The first ffprobe download arrived truncated (22 MB) and failed the checksum**; the retry was fine. | Pin 9.0.2 as a two-part archive: **132.5 MB** on disk. Retry once on a checksum mismatch before failing. |
| **Deno v2.9.8** (MIT) | `deno-x86_64-pc-windows-msvc.zip`: 42,917,472 B, sha256 `cba84b26e0df5ae7f74fc66b86a95b866872a86292ebd84fa1e959927edd93bf`, holding `deno.exe` (98,081,568 B). `deno-aarch64-apple-darwin.zip`: 38,770,795 B, sha256 `9f0bf660393da2eaff044cdc7444cb08c73f235849b61d224d825a194ce7c98e`, holding `deno` (81,512,928 B). | Managed, pinned. **98.1 MB** on Windows, **81.5 MB** on Mac. |
| Installed sizes in the dev sandbox | yt-dlp 23 MB; ExifTool 35 MB; upscaler (binary + models) 52 MB; uv 31 MB + CPython 70 MB + engine venv (0.4.x) 1.3 GB; htdemucs 81 MB; Whisper small 464 MB; BiRefNet lite 224 MB; pdfium cache 21 MB. | The pack sizes in §7.2. The 0.5.0 engine (OCR adds about 150–200 MB) is measured at build time. |
| Engine and FFmpeg | The engine inherits the app's environment and never names FFmpeg itself; audio-separator writes MP3 stems through pydub, which looks for `ffmpeg` on `PATH`. | The sidecar manager puts the resolved FFmpeg folder first on the engine's `PATH` (§7.6), and the Music pack includes FFmpeg. |
| Stem output size | audio-separator writes WAV as 16-bit 44.1 kHz stereo PCM: **10.1 MB per minute per stem**. On a 19 s test clip the 4 WAV stems totalled 13.4 MB and the 4 FLAC stems 2.5 MB (−81%; music compresses less, typically −40–60%). A 3-minute song gives ~120 MB of WAV stems; the user flagged this as too big. | FLAC becomes the default stem format, with a size hint (§7.7). |

---

## 1. Goals

1. **Local Chat:** chat with local language models, fully offline after the model download.
   - It runs on an app-managed `llama-server` (GPU through Vulkan or Metal) that listens only on 127.0.0.1, on a random port, behind a random per-launch key.
   - It includes a model catalog with download, resume and delete.
   - Conversations are stored locally, answers stream, can be stopped, and can be exported as Markdown.
   - An optional "use my running Ollama" backend is available.
2. **OCR:** images to text, and scanned PDFs to **searchable PDFs** (an invisible text layer with the original pages untouched). It supports Latin, CJK, Cyrillic, Arabic, Korean, Greek, Thai and Devanagari.
3. **Vault:** a passphrase-encrypted store for files (age).
   - Encrypted copies are added, never moved.
   - Unlocking holds the key in memory only; the vault auto-locks.
   - Files can be opened as temporary decrypted copies that are wiped on lock, or exported. Images can be previewed in memory.
   - A recovery key is shown once.
4. **Tool packs and first-run setup:** on first launch a full-window setup screen offers six **tool packs** (Media, Music, Image, Speech, Documents, Local Chat). Each pack lists every download with its project link, licence and measured size, and the tools it unlocks. Shared parts (the AI engine, FFmpeg) are counted once. A disk meter shows the effect on the chosen drive, and the heavy files can live on another drive. Packs install as cancellable jobs and can be added or removed later in Settings. **FFmpeg and Deno become app-managed** (pinned, verified downloads); a copy already on the system still counts.
5. **Smaller stems by default:** the Stem Splitter defaults to FLAC and says how big each format gets.
6. **Mac verification checklist** (`docs/MAC-CHECKLIST.md`): everything from Phases 3–5 that can only be checked on the Mac, as a step-by-step list for the user.

## 2. Non-goals (Phase 5)

- Chat with documents (RAG), tool calling or web access, image input (vision), voice, and fine-tuning. Arbitrary GGUF import is a non-goal too: models come from the catalog only.
- More than one loaded model at a time; parallel conversations generating at once (one generation at a time).
- A CUDA build of llama.cpp (+670 MB for little gain over Vulkan); Linux chat runtime.
- OCR: reading-order analysis for multi-column layouts, handwriting, tables to spreadsheet, OCR of encrypted PDFs (the user removes the password first with the PDF Toolkit), Apple Vision fast path.
- Vault: sync or cloud, sharing, secure deletion of the user's originals, hiding file sizes, multiple vaults, folders more than one level deep.
- Tool packs: choosing individual models inside a pack (each pack installs its tools' default models; the other presets still download on first use, as today), user-defined packs, automatic updates, Linux packs, moving the database, settings or library (only the heavy tool files move). Tools that aren't built yet are never shown on pack cards.

---

## 3. Foundation changes

### 3.1 Dependencies
- **Go:** `filippo.io/age v1.3.2`; `golang.org/x/sys` becomes a direct dependency (free disk space on Windows).
- **Engine:** `pyproject.toml` adds `rapidocr>=3.10.0`, `python-bidi>=0.6.12` and `pypdf>=6`, and bumps the version to **0.5.0**. The description gains "OCR". Run `uv lock` and verify macOS arm64 wheels.

### 3.2 Shared PDF renderer
The go-pdfium WebAssembly pool moves from `modules/pdf/render.go` into **`core/pdfium`**, with its tests. OCR needs it too, and modules don't import each other.

API:
```go
type Renderer struct{ … } // lazy pool, no FS mounts, compilation cache dir, idle close (P4 §6.4 rules unchanged)
func New(cacheDir string) *Renderer
func (r *Renderer) Close()
func (r *Renderer) PageCount(ctx, doc []byte, password string) (int, error)
func (r *Renderer) Render(ctx, doc []byte, password string, page /*1-based*/ int, dpi int) (image.Image, error)
func (r *Renderer) PageText(ctx, doc []byte, password string, page int) (string, error) // text already on the page (for "skip pages with text")
```

`main.go` creates one renderer (`<support>/cache/pdfium`) and passes it to `pdf.New` and `ocr.New`. The behaviour of `modules/pdf` stays the same.

### 3.3 Managed archives: symlinks, licence files, pinned per-OS assets
- **Symlinks:** `extractArchive` handles tar `TypeSymlink` entries. The target must be relative and resolve inside the extraction root; anything else fails with "unsafe archive". On Windows, symlink entries are copied as files.
- **Llama runtime dep:** ID `llama-runtime`, Name "Chat engine", Purpose "llama.cpp runtime for Local Chat (≈40 MB)", Binary `llama-server`, `ArchiveDir "llama"`, `VersionFile "VERSION"`, `PinnedVersion "b11938"`, Managed. Hint for unsupported platforms: "Local Chat isn't available for this platform yet".
- **Install:** hidden installer module `system-llama-install`; bound method `DepsService.InstallChatEngine()`.
- **Assets:** one part `main`. Windows (amd64; arm64 runs it under emulation) uses the Vulkan zip; darwin/arm64 uses the macOS tarball. darwin/amd64 and linux are unsupported. The SHA256 values are pinned from §0.1.
- **Layout:** copy the whole top folder. Write `LICENSE-llama.cpp` with the MIT text (embedded in Go). Set mode 0755 on `llama-server` on unix.

### 3.4 Settings additions

| Field | Key | Default | Rules |
|---|---|---|---|
| `Chat.DefaultModel string` | `chat.defaultModel` | `"qwen3-4b"` | A catalog ID, or `"ollama:<name>"`. |
| `Chat.SystemPrompt string` | `chat.systemPrompt` | `"You are a helpful assistant. Answer concisely."` | At most 4,000 characters. |
| `Chat.Temperature float64` | `chat.temperature` | `0.7` | Between 0 and 2. |
| `Chat.ContextSize int` | `chat.contextSize` | `8192` | One of 4096, 8192, 16384, 32768. |
| `Chat.GPU bool` | `chat.gpu` | `true` | `false` passes `-ngl 0 --device none` (CPU). |
| `Chat.OllamaURL string` | `chat.ollamaURL` | `""` (off) | Empty, or an `http://` URL whose host is `127.0.0.1`, `localhost` or `::1` (validated). |
| `Vault.AutoLockMinutes int` | `vault.autoLockMinutes` | `10` | One of 1, 5, 10, 30, 60, or 0 (lock only on quit or manually). |
| `Setup.Done bool` | `setup.done` | `false` | Set by **Install** or **Skip for now** on the setup screen (§7.4). Existing installs also see the screen once, with their packs shown as installed. |
| `Stems` module state `format` | (module state) | `"flac"` | Only the default changes; a format the user already picked is kept. |

The tools folder location is **not** a setting: it's read before the database opens (§7.3).

`SettingsPatch` gets matching fields; each struct is replaced whole, as for `clipboard`.

### 3.5 Storage: migration `0004_chat.sql`

```sql
CREATE TABLE chat_conversations (
  id TEXT PRIMARY KEY,               -- ULID
  title TEXT NOT NULL,               -- first user message, trimmed to 80 chars; renameable
  model TEXT NOT NULL,               -- catalog id or "ollama:<name>"
  system_prompt TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('done','stopped','error')),
  error TEXT NOT NULL DEFAULT '',
  tokens INTEGER NOT NULL DEFAULT 0,
  tokens_per_sec REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX chat_messages_conv_idx ON chat_messages(conversation_id, created_at);
CREATE INDEX chat_conversations_updated_idx ON chat_conversations(updated_at DESC);
```

The `core.ChatStore` interface (implemented by `core/store`) has:
- `CreateConversation`, `UpdateConversation(id, title?, model?, systemPrompt?)`, `TouchConversation`, `DeleteConversation`, `GetConversation`;
- `ListConversations(search string, limit, cursor)` (LIKE on title and on message content);
- `AddMessage`, `UpdateMessage(id, content, status, error, tokens, tps)`, `ListMessages(convID)`, `DeleteMessagesFrom(convID, messageID)` (for regenerate and edit).

Wire types in `core/types.go`: `ChatConversation`, `ChatMessage`, `ChatPage`, plus the events in §4.4.

### 3.6 Placeholders
`llm-chat` and `vault` are removed from `modules/placeholders`, and the real modules reuse those IDs. Web Archiver stays a placeholder. **OCR is a new module** with ID `ocr`.

---

## 4. Local Chat (`modules/chat`, ID `llm-chat`)

The descriptor is `JobLess` (like Clipboard History). Name "Local Chat", icon `message-square`, Category ai, Order 180. `Requires []` (the view gates on `llama-runtime` only when a local model is selected). Model downloads are jobs of a hidden module, `system-chat-model` (§4.2).

### 4.1 Server lifecycle (`modules/chat/server.go`)
- **At most one `llama-server`.** It starts lazily on the first `Send` for a local model, or when a different local model is selected. A model switch stops the old server first.
- **Command line:** `llama-server -m <gguf> --host 127.0.0.1 --port 0 --api-key-file <key> --jinja -ngl 99 -c <ctx> --no-webui --sleep-idle-seconds 300`. With GPU off it uses `-ngl 0 --device none`; the builder verifies that `--device none` works with the Vulkan build, and if not, falls back to `-ngl 0` only and records that.
- **Key:** 32 random bytes as hex, written to `<support>/tmp/llama-<ulid>.key` (0600). The file is deleted once the server is ready.
- **Readiness:**
  1. Parse `listening on http://127.0.0.1:(\d+)` from the merged stdout/stderr.
  2. Poll `GET /health` every 250 ms until it returns 200, for up to 120 s.
  3. If the process exits first, fail with `tool_failed` "The chat engine didn't start" and the last 10 log lines in the error detail. "couldn't bind" retries once.
  4. If a GPU start fails with a Vulkan or out-of-memory error, retry once on CPU and emit `chat:status` with `backend:"cpu"` and a notice.
- **Stopping:** the server is fully stopped after **20 idle minutes** (no requests), at app quit (hooked in `main.go`) and when its model is deleted. Its log is kept in a 200-line ring buffer and written to the app log at debug level.
- **`Status()`** returns `ChatStatus{State: stopped|starting|ready|error, Model, Backend: gpu|cpu|ollama, Port: 0 (never exposed to the UI), Error}`, also emitted as `chat:status`.

### 4.2 Model catalog (`modules/chat/catalog.go`)
Pinned entries hold ID, label, HF repo, file, size, sha256, licence, RAM hint, context default and an `IsDefault` flag. URLs are `https://huggingface.co/<repo>/resolve/main/<file>`.

| ID | Label | Repo / file | Size | sha256 | Licence | Hint |
|---|---|---|---|---|---|---|
| `qwen3-4b` (default) | Qwen3 4B Instruct | `unsloth/Qwen3-4B-Instruct-2507-GGUF` / `Qwen3-4B-Instruct-2507-Q4_K_M.gguf` | 2,497,281,120 | `3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597` | Apache-2.0 | "Best all-rounder · needs ~4 GB free" |
| `qwen3.5-2b` | Qwen3.5 2B | `unsloth/Qwen3.5-2B-GGUF` / `Qwen3.5-2B-Q4_K_M.gguf` | 1,280,835,840 | `aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223` | Apache-2.0 | "Small and quick · ~2 GB" |
| `gemma4-e4b` | Gemma 4 E4B | `unsloth/gemma-4-E4B-it-GGUF` / `gemma-4-E4B-it-Q4_K_M.gguf` | 4,977,171,584 | `85a896a047553e842f25297ee5b031d64ff30147d9c4af17b1e4b394cd1fab87` | Apache-2.0 | "Strongest · needs ~7 GB free (16 GB Macs+)" |

- **Download job** (`system-chat-model`, options `{model}`): stream to `<support>/models/llm/<file>.part` with HTTP Range resume (a `.part` survives cancel or restart, and the next attempt resumes), verify sha256, then rename. A mismatch deletes the file and fails with "The download was corrupted — try again". Only one download runs at a time. Progress is reported as "1.2 GB of 2.5 GB · 18 MB/s".
- **Delete:** stop the server if it uses that model, remove the file and any `.part`. Models also count in Settings → Models usage and "Clear models".
- **Verification:** Qwen3.5-2B and Gemma 4 E4B must be **verified during the build**: download, load with `--jinja` and a 3-prompt check. Gemma is verified only if at least 8 GB RAM is free; otherwise it ships marked `Verified: false` and the UI shows "not tested on this machine". A model that fails is dropped from the catalog and recorded in DECISIONS.md.

### 4.3 Ollama backend (optional)
When `chat.ollamaURL` is set:
- `Models()` also lists `GET <url>/api/tags` entries as `ollama:<name>` (a 2 s timeout; unreachable gives a status note, never an error dialog).
- Chat uses `POST <url>/api/chat` with `stream:true` (NDJSON) and the same message history, and cancels by closing the request.
- The UI marks these models "via Ollama" and says once, in Settings: "Ollama has no access control; any app on this computer can use it".

### 4.4 Bound service (`chat.Service`) and events

```go
Catalog() []ModelInfo                 // catalog + installed/downloading state + Verified flag; plus ollama models when enabled
DownloadModel(id string) (core.Job, error)
DeleteModel(id string) error
Status() ChatStatus
Conversations(search string, cursor string) (core.ChatPage, error)
Conversation(id string) (ConversationView, error)   // conversation + messages
NewConversation(model string) (core.ChatConversation, error)
UpdateConversation(id string, patch ConversationPatch) (core.ChatConversation, error) // title, model, systemPrompt
DeleteConversation(id string) error
Send(conversationID string, text string) (SendResult, error)  // appends user msg + empty assistant msg; returns their IDs; streams via events
Regenerate(conversationID string) (SendResult, error)        // deletes last assistant msg, re-sends
EditAndResend(conversationID, messageID, text string) (SendResult, error) // truncates from messageID, re-sends
Stop(conversationID string) error
Export(conversationID string) (string, error)                 // Markdown file in <library>/Chats/<title>.md (UniquePath); registered as an output; returns path
```

- **Events:**
  - `chat:delta` `{conversationId, messageId, delta}`: coalesced, at most every 40 ms.
  - `chat:done` `{conversationId, messageId, status: done|stopped|error, error, tokens, tokensPerSec}`.
  - `chat:status` (ChatStatus).
- **Rules:**
  - **One generation at a time**: `Send` while one is running returns `conflict` "Wait for the current answer or stop it".
  - The assistant message is persisted every 2 s while streaming and finally on done.
  - On app quit, a running stream is stopped and saved as `stopped`.
- **History sent:** the system prompt plus every message in the conversation. If the estimated tokens (chars/3.5) exceed 75% of the context, the oldest turns are dropped and the UI shows "Older messages were left out to fit the context".
- **Title:** the first user message (trimmed). There is no LLM-generated title.

### 4.5 UI (`tools/chat/ChatView.tsx`)
- **Layout:** a left column holds conversations (New chat button, search field, list grouped Today / Earlier with a rename/delete menu). The main column holds the thread; a top bar has the model picker and a gear for the system prompt and temperature for this conversation.
- **Empty state (no model installed):** model cards (label, size, licence, hint, Download with progress, cancel). If the chat engine is missing, the DepsGate offers **Install chat engine (≈40 MB)**.
- **Thread:**
  - User and assistant bubbles; assistant text is rendered as **Markdown by a small in-house renderer**. It produces React elements and never raw HTML: paragraphs, headings, lists, blockquote, bold/italic, inline code, and fenced code blocks with a language label and a **Copy** button. Links show as text with a copy action; nothing navigates.
  - A streaming caret, then "Stopped" or error states with **Retry**.
  - Per-message actions: Copy, and for user messages Edit & resend (the last one only, or any, which truncates).
  - A footer shows "42 tok/s · GPU".
- **Composer:** an auto-growing textarea. Enter sends, Shift+Enter adds a newline, Esc or the **Stop** button stops. It is disabled while the engine starts ("Loading model…" with a spinner; the first start takes about 5 s).
- **Settings → Chat:** default model, system prompt, temperature, context size, the "Use GPU" switch, the Ollama URL field with a test button, and installed models with Delete.
- **Palette:** "New chat", "Open chat history".

---

## 5. OCR (`modules/ocr`, ID `ocr`)

Descriptor: Name "OCR", icon `scan-text`, Category document, Order 195, Accepts `.pdf .jpg .jpeg .png .webp .bmp .tif .tiff .heic .heif`, Requires `audio-engine`, OutputSubdir `OCR`, SplitInputs, MaxConcurrent 1, MaxInputs 200. Tagline "Turn scans and photos into text". Description "Extract text from images and make scanned PDFs searchable, offline."

### 5.1 Options and language presets

```go
type Language string // "latin" (default; also CJK) | "cyrillic" | "arabic" | "korean" | "greek" | "thai" | "devanagari"
type Options struct {
    Language    Language `json:"language"`
    PDFOutput   string   `json:"pdfOutput"`   // "searchable" (default) | "text" | "both"
    ImageOutput string   `json:"imageOutput"` // "text" (default) | "json" (lines + word boxes) — images only
    SkipText    bool     `json:"skipText"`    // PDFs: skip pages that already contain text (default true)
}
```

`presets.go` maps each language to `{det, rec}` model entries (file, url, sha256). Default (`latin`) uses the **bundled v6 small models**, so there is no download.

| Language | Detection | Recognition (sha256) |
|---|---|---|
| latin | bundled PP-OCRv6 det small | bundled PP-OCRv6 rec small |
| cyrillic | `ch_PP-OCRv5_det_mobile.onnx` (`4d97c44a20d30a81aad087d6a396b08f786c4635742afc391f6621f5c6ae78ae`) | `cyrillic_PP-OCRv5_rec_mobile.onnx` (`90f761b4bfcce0c8c561c0cb5c887b0971d3ec01c32164bdf7374a35b0982711`) |
| arabic | same v5 det | `arabic_PP-OCRv5_rec_mobile.onnx` (`c1192e632d0baa9146ae5b756a0e635e3dc63c1733737ebfd1629e87144e9295`) |
| korean | same v5 det | `korean_PP-OCRv5_rec_mobile.onnx` (`cd6e2ea50f6943ca7271eb8c56a877a5a90720b7047fe9c41a2e541a25773c9b`) |
| greek | same v5 det | `el_PP-OCRv5_rec_mobile.onnx` (`b4368bccd557123c702b7549fee6cd1e94b581337d1c9b65310f109131542b7f`) |
| thai | same v5 det | `th_PP-OCRv5_rec_mobile.onnx` (`de541dd83161c241ff426f7ecfd602a0ba77d686cf3ab9a6c255ea82fd08006e`) |
| devanagari | same v5 det | `devanagari_PP-OCRv5_rec_mobile.onnx` (`d6f0a906580e3fa6b324a318718f1f31f268b6ea8ef985f91c2012a37f52c91e`) |

- **URLs:** `https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv5/{det,rec}/<file>`. The builder records exact sizes, and confirms that the v5 recognition ONNX files carry their character dictionary. If one doesn't, the builder adds the dictionary file to the preset with its sha256.
- **Model directory:** `<support>/models/ocr/`. The engine is always given explicit model paths and must never self-download.

### 5.2 Images → text (sidecar `ocr.image`)
- **Params:** `{input, outputDir, baseName, det, rec (model entries; null = bundled), modelDir, output: "text"|"json"}`.
- **Steps:**
  1. Ensure the models (shared sha-verified download helper).
  2. `load_image` (HEIC included).
  3. Run RapidOCR with `return_word_box=True`.
  4. Sort lines top-to-bottom, then left-to-right.
  5. Write `<baseName> (text).txt` (lines joined with `\n`, blank line between blocks), or `.json` (`{width, height, lines:[{text, confidence, box:[[x,y]×4], words:[{text, box}]}]}`).
- **Result:** `{lines, characters, meanConfidence, output, preview (first 2,000 chars)}`.

### 5.3 PDF → searchable PDF (Go + sidecar `ocr.pdf`)
1. **Go** reads the PDF. An encrypted input fails with `validation` "Remove this PDF's password first (PDF Toolkit → Remove password)". Go then renders each page via `core/pdfium` at **200 dpi** into `TempDir/pages/p0001.png`. If `skipText` is on and `PageText` has at least 20 non-space characters, the page is skipped and recorded. Progress is page by page ("Rendering 3/30"). Cancellation is checked per page.
2. **Sidecar `ocr.pdf`:**
   - **Params:** `{input, pages:[{page, png, skip}], dpi, outputDir, baseName, det, rec, modelDir, pdfOutput}`.
   - **OCR:** each non-skipped page, with progress per page ("Reading page 3 of 30") and `check_cancelled()` between pages.
   - **Overlay:** port the prototype `compose.py` into `toolbox_sidecar/pdftext.py`: the glyphless font (generated once and embedded as a constant), word-level `Tz` fitting, the inverse `/Rotate` and cropbox transform, appended content stream, and one shared font resource.
   - **Output files:** the searchable PDF goes to `<baseName> (searchable).pdf` via pypdf `PdfWriter` (clone the reader, add the streams, keep metadata, bookmarks and links). With `text`/`both`, the text is also written to `<baseName> (text).txt`, with `\f` between pages.
   - **Result:** `{pages, pagesOcred, pagesSkipped, characters, meanConfidence, outputs[]}`.
   - **Invariants:** the original page content and images are unchanged (§10 test). The input is never modified.
3. **Go** registers the outputs and writes the message, e.g. "30 pages · 2 already had text · 41,203 characters".

### 5.4 UI (`tools/ocr/OcrView.tsx`)
FileToolLayout with these options:
- **Language** Select, with a "downloads ~13 MB on first use" note for non-Latin.
- **PDF output** SegmentedControl: Searchable PDF / Text / Both.
- **Image output** SegmentedControl: Text / Text + positions (JSON).
- **Skip pages that already have text** switch.

A DepsGate covers the AI engine. **Results:** per job a card with the output files (Reveal/Open), plus for images a **text preview panel** (the first 2,000 chars, monospace) with **Copy text**, done through the existing clipboard service write path (`ClipboardService` already writes text; add `CopyText(text string)` if no bound method exists) and recorded as a self-copy so history doesn't double it. The panel also offers **Save as…** via Reveal.

---

## 6. Vault (`modules/vault`, ID `vault`)

The descriptor is a normal module (jobs for add/export), Name "Vault", icon `lock`, Category utility, Order 210, Accepts any extension (`Accepts.Any = true`; the drop matcher lists Vault last), Requires none, OutputSubdir `Vault exports`, SplitInputs false, MaxConcurrent 1. `core.Accepts` gains `Any bool` if it doesn't exist, and the matcher puts Any-modules last.

### 6.1 On-disk format (`<library>/Vault/`)
```
vault.json      {"format":1,"created":<ms>,"kdf":"age-scrypt","workFactor":18}   (plaintext, no secrets)
identity.age    X25519 identity (AGE-SECRET-KEY-1…) encrypted to the passphrase (age scrypt recipient, work factor 18)
index.age       JSON index encrypted to the vault recipient; index.age.bak = previous version
blobs/<2-char>/<ulid>.age   each file's contents encrypted to the vault recipient (streaming)
```
- **Index:** `{version:1, entries:[{id, name, folder ("" = root, one level), size, modTime, addedAt, blob, sha256}]}`. It is written atomically (`index.age.tmp` → rename, the previous file kept as `.bak`) after every change. On load, if `index.age` fails to decrypt or parse, the app tries `.bak` and tells the user.
- **Recovery key:** the identity string, shown once at creation ("Save this somewhere safe. It's the only way in if you forget your passphrase"), with **Copy** and an "I've saved it" confirmation before the vault opens. It is also shown later after re-entering the passphrase.
- **Filesystem view:** names, folders and contents are hidden. File count and approximate sizes are visible.

### 6.2 Service (`vault.Service`, bound) and state
```go
State() VaultState                       // {exists, unlocked, entries int, autoLockMinutes, lockAt int64}
Create(passphrase string) (string, error) // returns the recovery key (shown once); passphrase ≥ 8 chars
Unlock(secret string) error              // passphrase or AGE-SECRET-KEY-1… recovery key; wrong → validation "Wrong passphrase"
Lock() error
List(folder string, search string) ([]Entry, error)      // requires unlocked
Folders() ([]string, error)
Enqueue(paths []string, folder string) ([]core.Job, error)   // add files (one job; copies, never moves)
Rename(id, name string) error; Move(ids []string, folder string) error; Delete(ids []string) error
Open(id string) error                    // decrypt to <support>/tmp/vault-open/<session>/<name>, open with the default app
Preview(id string) (string, error)       // images ≤ 20 MB → data URL, decrypted in memory only
Export(ids []string) ([]core.Job, error) // decrypt into <library>/Vault exports/ (UniquePath), registered outputs
ChangePassphrase(old, new string) error  // re-wraps identity.age only
RecoveryKey(passphrase string) (string, error)
```

- **Memory:** the unlocked identity lives only in Go memory, in a single `*age.X25519Identity` field. Lock clears it and the decrypted index (best effort; Go can't guarantee zeroing).
- **Auto-lock:** after `autoLockMinutes` without vault calls or vault jobs, at app quit, and from the tray menu item **Lock vault** (shown only while unlocked). Events: `vault:state`.
- **Lock behaviour:** any vault job queued or running fails with `validation` "The vault is locked" (running jobs are cancelled). Every file under `<support>/tmp/vault-open/` is deleted; on Windows, files still open in another app are retried every 30 s until gone. **At app start that folder is wiped** (crash leftovers).
- **Add jobs (`action: "add"`):**
  - Stream each input through age to a blob, computing the sha256 of the plaintext along the way. Progress is by bytes.
  - Cancellation removes the partial blob.
  - Files over 20 GB are refused.
  - The index is written after each file, so a cancel keeps the files already added.
  - Name clashes in a folder get " (1)" etc.
- **Export jobs (`action: "export"`):** decrypt to `<library>/Vault exports/<name>` (UniquePath) and verify the sha256. A mismatch deletes the output and fails with "This file is damaged in the vault".
- **Mutual exclusion:** add, export, delete, rename and move hold one vault mutex; index writes are serialized.

### 6.3 UI (`tools/vault/VaultView.tsx`)
- **No vault yet:** an explainer (what's encrypted, what isn't, "forgetting the passphrase means losing the files unless you kept the recovery key", "adding files copies them; your originals stay where they are — delete them yourself if you want"). Then a **Create vault** form (passphrase plus confirm, a simple strength hint based on length and character classes, minimum 8), then the recovery-key screen.
- **Locked:** a passphrase field and an **Unlock** button, plus a "Use recovery key" link that switches the field. "Wrong passphrase" is shown inline.
- **Unlocked:**
  - **Header:** a lock icon with "Unlocked · locks in 9 min" (live), a **Lock** button and an **Add files** button (picker plus drop zone).
  - **Left:** the folders list (All files, root, and folders; New folder).
  - **Main:** a table of name, size, added date and type icon, with a search field. Row actions: Open, Preview (images), Export, Rename, Move to…, Delete (ConfirmDialog: "Permanently delete from the vault?"). Multi-select allows Export, Move and Delete.
- **Settings → Vault:** the auto-lock Select, **Change passphrase…**, **Show recovery key…** (asks for the passphrase), and **Reveal vault folder**.
- **Palette:** "Lock vault", "Open vault".

---

## 7. Tool packs and first-run setup (`core/packs`, `views/setup`)

### 7.1 Concepts
- A **pack** is a named group of **components** that together unlock some tools. A **component** is either a **dep** (a `core/deps` ID with an installer) or a **model** (a module preset that downloads files).
- A component can belong to several packs (the AI engine, FFmpeg). It is installed once and **counted once**: in a selection, a shared component's size goes to the first selected pack in catalog order, and every other selected pack lists it as "with <pack>".
- A component found on the system (FFmpeg or Deno on `PATH`) has state `system`. It counts as present, costs 0 bytes and is never removed by the app.
- **Built-in tools** need no download: Clipboard History, PDF Toolkit and Vault. They're listed on the setup screen but are not a pack.
- Every non-hidden, non-placeholder, non-built-in module belongs to **exactly one** pack (a test enforces this, so a future module can't be left out).

### 7.2 Catalog (`core/packs/catalog.go`)
Pure data, with per-OS sizes measured on the pinned versions (§0.4). `Download` is what's fetched; `Disk` is what stays. Sizes for components already present are 0.

**Components**

| ID | Kind / ref | Label · link · licence | Windows download / disk | macOS arm64 download / disk |
|---|---|---|---|---|
| `ffmpeg` | dep `ffmpeg` (+`ffprobe`, same folder) | FFmpeg 9.0.2 · ffmpeg.org · GPL-3.0 | 114.8 MB / 210.6 MB | 56.7 MB / 132.5 MB |
| `yt-dlp` | dep `yt-dlp` | yt-dlp · github.com/yt-dlp/yt-dlp · Unlicense | 23 MB / 23 MB | builder measures `yt-dlp_macos` |
| `deno` | dep `deno` | Deno 2.9.8 · deno.com · MIT | 42.9 MB / 98.1 MB | 38.8 MB / 81.5 MB |
| `engine` | dep `audio-engine` (uv, CPython, venv) | AI engine (Python, PyTorch, ONNX Runtime) · github.com/astral-sh/uv · BSD/MIT/Apache | builder measures 0.5.0 (≈1.0 GB / ≈1.6 GB) | builder measures on the Mac; until then the Windows numbers |
| `stems-default` | model `stems` / `four-fast` | Demucs 4-stem · github.com/facebookresearch/demucs · MIT | 84 MB / 81 MB | same |
| `whisper-default` | model `transcribe` / `small` | Whisper small · huggingface.co/Systran/faster-whisper-small · MIT | 464 MB / 464 MB | same |
| `bg-default` | model `bgremove` / `balanced` | BiRefNet lite · github.com/ZhengPeng7/BiRefNet · MIT | 224 MB / 224 MB | same |
| `upscaler` | dep `upscayl` | Real-ESRGAN upscaler · github.com/upscayl/upscayl-ncnn · AGPL-3.0 (models BSD-3) | 47.9 MB / 52 MB | 54.8 MB / builder measures |
| `exiftool` | dep `exiftool` | ExifTool · exiftool.org · Artistic/GPL | builder measures download / 35 MB | builder measures |
| `chat-engine` | dep `llama-runtime` | llama.cpp b11938 · github.com/ggml-org/llama.cpp · MIT | 37.2 MB / 104 MB | 16.3 MB / builder measures |
| `chat-default` | model `llm-chat` / `qwen3-4b` | Qwen3 4B Instruct · huggingface.co/Qwen/Qwen3-4B-Instruct-2507 · Apache-2.0 | 2.50 GB / 2.50 GB | same |

**Packs** (catalog order = display order; Windows disk size when installed alone)

| ID | Name · icon | Components | Unlocks (module → components it needs) | Alone |
|---|---|---|---|---|
| `media` | Media · `film` | ffmpeg, yt-dlp, deno | Downloader → ffmpeg, yt-dlp, deno · Converter → ffmpeg | ≈332 MB |
| `music` | Music · `audio-lines` | engine, ffmpeg, stems-default | Stem Splitter → engine, ffmpeg, stems-default · BPM & Key → engine · Audio → MIDI → engine | ≈1.9 GB |
| `image` | Image · `wand-sparkles` | engine, bg-default, upscaler, exiftool | Background Remover → engine, bg-default · Upscaler → upscaler · EXIF → exiftool | ≈1.9 GB |
| `speech` | Speech · `captions` | engine, whisper-default | Transcribe → engine, whisper-default | ≈2.1 GB |
| `documents` | Documents · `scan-text` | engine | OCR → engine (Latin and CJK built in; other scripts ≈13 MB each on first use) | ≈1.6 GB |
| `chat` | Local Chat · `message-square` | chat-engine, chat-default | Local Chat → chat-engine, chat-default | ≈2.6 GB |

Each pack also has a one-line description (e.g. Media: "Download and convert audio and video"; Local Chat: "A private assistant that runs on your GPU · needs about 4 GB of free memory").

### 7.3 Tools folder (`core/paths.go`)
The heavy files can live somewhere other than the support dir, for example on a second drive.
- **`Paths.ToolsDir`** is new. `BinDir`, `PythonDir`, `SidecarDir` and `ModelsDir` now derive from it; the DB, logs, settings, tmp, caches and clipboard images stay in the support dir. The default is the support dir itself, so existing installs don't change.
- **Where it's stored:** a pointer file `<support>/tools-location` holding one absolute path (UTF-8), read by `ResolvePaths` before the DB opens. `TOOLBOX_TOOLS_DIR` overrides it (dev sandboxes and tests); while the env var is set, the UI shows the location as "Set by TOOLBOX_TOOLS_DIR" and disables changing it.
- **Marker:** a tools folder contains `.toolbox-tools` (empty file).
- **Picking a folder** (`PickToolsDir`): a native folder dialog. If the picked folder is empty or already has the marker, it's used as is; otherwise the app uses `<picked>/Toolbox Tools` (e.g. picking `D:\` gives `D:\Toolbox Tools`). The picker refuses the library folder and folders inside the support dir other than the support dir itself ("Pick a different folder").
- **Choosing at setup:** if the user changes the location before anything managed is installed, Install writes the pointer and `<support>/setup-pending.json` (`{packs:[…]}`), then **relaunches the app**. On start, a pending file opens the setup screen in its installing state and submits those packs, then deletes the file.
- **Moving later** (Settings → Tool packs → Move…): a job of the hidden module `system-tools-move`.
  1. Stop the engine and the chat server, and refuse while any other job is running ("Wait for running jobs to finish").
  2. Copy `bin/`, `python/`, `sidecar/` and `models/` to the new folder, with progress by bytes and cancellable (a cancel deletes the partial copy).
  3. Verify file count and total size.
  4. Rewrite the `home` line of `sidecar/.venv/pyvenv.cfg` to the new CPython folder.
  5. Write the marker and the pointer, plus `<support>/tools-move-cleanup` holding the old path.
  6. Finish with the message "Restart Toolbox to use the new folder" and a **Restart now** action.
  On the next start, if the new folder has its marker, the app deletes those four subfolders from the old path and removes the cleanup file. If the engine then fails its ready handshake, it shows as needing **Repair** (the existing re-sync).
- **Unavailable folder:** if `ToolsDir` doesn't exist at start (for example an unplugged drive), the shell shows a warning Banner: "Your tools folder `D:\Toolbox Tools` isn't available. Connect the drive or choose another folder." Its **Choose folder…** button runs the picker and, after confirmation, writes the pointer and relaunches.
- **Relaunch** (`desktop.Relaunch`): start `os.Executable()` with the same arguments, detached, then quit. Under `wails3 dev` it doesn't relaunch; it shows "Restart the dev server to use the new folder".
- **Free space** (`core/disk`): `Free(path) (free, total uint64, err)` uses `GetDiskFreeSpaceExW` on Windows (`x/sys/windows`) and `unix.Statfs` elsewhere, walking up to the nearest existing parent.

### 7.4 Setup screen (`frontend/src/views/setup/SetupView.tsx`)
**When it shows:** at start when `setup.done` is false, or when `setup-pending.json` exists. The main window renders `SetupView` full-window instead of the shell: the custom titlebar stays, but there's no sidebar, job tray or command palette. It can also be reopened from Settings → Tool packs → **Show setup screen**, which overlays the shell and has a close button.

**Layout** (tokens only; matches the approved mockup `.dev/mockups/packs.html` with the changes below):
- **Content column:** max width 1080 px, centred, padding `--space-10` / `--space-12`. Below 720 px the padding is `--space-4` and cards are 220 px wide.
- **Header:**
  - Eyebrow "Welcome to Toolbox" (mono, `--text-xs`, uppercase, `--accent`).
  - H1 "Which tool packs do you want?" (`--text-2xl`, 600).
  - Lede (`--text-lg`, `--fg-muted`): "Each pack downloads its own engines and models. Pick what you need now; you can add or remove packs any time in Settings."
- **Always included:** a row of chips (icon + name) for Clipboard History, PDF Toolkit and Vault, labelled "Always included".
- **Pack rail:**
  - Cards sit in one horizontal row with scroll-snap. When the row overflows, chevron IconButtons appear at the edges and the overflowing edge gets a fade. A vertical mouse wheel over the rail scrolls it sideways.
  - Cards are 252 px wide and all the same height.
- **Card anatomy**, top to bottom:
  1. A 40 px icon tile and, on the right, either the selection checkbox or a state badge: **Installed** (ok), **Update available** (warn), **Partly installed**, or **Not available on this computer** (muted, with the reason in a Tooltip).
  2. Name (`--text-lg`, 600).
  3. Disk size as the big number (mono, `--text-xl`) with "· 1.1 GB download" after it in `--fg-subtle`. Both are recomputed live for the current selection (§7.1).
  4. **Unlocks:** each tool's lucide icon and name. Only tools that exist.
  5. **Downloads:** one row per component with its name as a link (opens in the default browser), its licence (mono `--text-xs`) and its size, right-aligned. Special rows:
     - a shared component counted elsewhere shows "with Music" in `--fg-faint`, size struck through;
     - a system copy shows "found on this PC" in `--ok`;
     - an installed component shows a check and "installed".
  6. The pack's description in `--fg-subtle` `--text-sm`, pinned to the card bottom.
- **Selection:** the whole card is a toggle (`<button aria-pressed>`). Selected cards get an `--accent` border, an `--accent-soft` icon tile and a filled checkbox.
  - Installed packs aren't selectable: their checkbox is replaced by the badge and their text is muted.
  - Packs with an update are pre-selected.
  - On a fresh install nothing is pre-selected except **Media**.
- **Disk section** (below the rail):
  - A segmented bar (the Meter mask, 8 px tall) showing used (`--fg-faint`), this selection (`--accent`) and free (`--line-strong`), with a legend.
  - On the right, "128 GB free of 476 GB · 124 GB after" (mono numbers), then the location as a PathText field with a **Change…** button (§7.3).
  - If the selection doesn't fit, a `--warn` line "Not enough space on this drive" appears and Install is disabled. If the selection leaves less than 5 GB free, the line is "That leaves less than 5 GB free" and Install stays enabled.
- **Footer bar** (`--bg-sidebar`, top border):
  - Left: shield icon and "Everything downloads from each project's official releases and is checked against a pinned checksum."
  - Right: a ghost **Skip for now** button and a primary **Install 3 packs · 2.3 GB** button (disk size; its Tooltip gives the download size). With nothing selected the primary button reads **Install** and is disabled.
- **Installing state:**
  - Cards stop toggling. Each selected card replaces its description with a Meter (running → done or failed), a message ("Downloading FFmpeg · 48 of 115 MB", "Setting up the AI engine…") and a Cancel IconButton. Queued packs say "Waiting".
  - A failed pack shows the error message (the AppError hint in a Tooltip) and **Retry**; the other packs carry on. A cancelled pack says "Cancelled" and offers Retry.
  - The footer says "Installing 1 of 3". **Continue in background** sets `setup.done` and opens the app; the jobs keep running in the job tray.
  - When everything has finished, the primary button becomes **Open Toolbox**. It sets `setup.done` and opens the first tool of the first pack that was installed.
- **Skip for now** sets `setup.done` and opens the Library.
- **Keyboard:** Tab reaches each card; Left/Right move focus within the rail and scroll the focused card into view; Space or Enter toggles; Ctrl/Cmd+Enter installs. Focus rings use `--focus-ring`. Motion respects `prefers-reduced-motion`.
- **Both themes** come from tokens; no hard-coded colours (the existing contrast test covers the new tokens if any are added; none are expected).

### 7.5 Settings, DepsGate and palette
- **Settings → Tool packs** goes at the top of Settings, above Dependencies.
  - The same `PackCard` component appears in a wrapping grid. Instead of a selection checkbox, each card has actions: **Install**, **Update** or **Remove**.
  - **Remove** opens a ConfirmDialog built from `RemovePreview`, e.g. "Remove the Image pack? This frees 311 MB. The AI engine stays because Music uses it."
  - A **Tools folder** row shows the path, free space and a **Move…** button (§7.3).
  - A **Show setup screen** link.
- **DepsGate:** when a module's requirements are missing, the gate keeps its existing banner and adds two buttons: a primary **Install what this tool needs (35 MB)** (`InstallFor`) and a secondary **Install the Image pack (1.9 GB)**. Sizes follow §7.1. The existing per-dependency hint text stays below.
- **Palette:** "Manage tool packs" (opens the Settings section) and "Show setup screen".

### 7.6 Managed FFmpeg and Deno (`core/deps`)
- **New `Spec.AllowSystem bool`.** Normally a pinned archive only counts in its own folder. With `AllowSystem`, a copy found on `PATH` or in the known dirs also counts (source `system`) and is never marked outdated. Resolution order: the managed folder first, then the system.
- **`ffmpeg`:** `Managed`, `ArchiveDir "ffmpeg"`, `VersionFile "VERSION"`, `PinnedVersion "9.0.2"`, `AllowSystem`.
  - `ffprobe` gets the same `ArchiveDir`: one install provides both.
  - Purpose becomes "Converts and merges audio and video (≈210 MB)".
  - Installer: the hidden module `system-ffmpeg-install` and `DepsService.InstallFFmpeg()`.
  - Assets: Windows amd64 uses one part, the Gyan zip (§0.4). Keep only `bin/ffmpeg.exe`, `bin/ffprobe.exe` and `LICENSE`, flattened into `<bin>/ffmpeg/`. darwin/arm64 uses two parts, `ffmpeg.zip` and `ffprobe.zip` (§0.4), with mode 0755.
  - Unsupported platforms (darwin/amd64, linux) keep today's install hints.
- **`deno`:** `Managed`, `ArchiveDir "deno"`, `VersionFile "VERSION"`, `PinnedVersion "2.9.8"`, `AllowSystem`. Installer: `system-deno-install` and `DepsService.InstallDeno()`. The assets are in §0.4.
- **Checksum retry:** a download whose sha256 doesn't match is retried once from scratch before failing with "The download was corrupted — try again". This applies to every managed archive.
- **Settings → Dependencies:** FFmpeg and Deno rows get Install, Update and Remove like ExifTool. Remove only deletes the managed folder; a system copy then takes over.
- **Downloader:** the builder confirms that yt-dlp gets the resolved Deno path (managed or system) the same way it does today.
- **Engine `PATH`:** when `core/sidecar.Manager` starts the engine, it puts the folder of the resolved `ffmpeg` first on the engine's `PATH`. If FFmpeg is missing, `PATH` is left alone.

### 7.7 Stems: FLAC by default
- `stems.DefaultOptions()` returns `Format: FormatFLAC`.
- Under the format picker, a hint: "WAV ≈ 10 MB per minute per stem · FLAC is lossless and usually half that · MP3 ≈ 2.4 MB per minute". When the input's duration is known (Library metadata or a previous probe), it instead reads "This song: ≈ 120 MB as WAV · ≈ 60 MB as FLAC · ≈ 29 MB as MP3". Otherwise the per-minute line is shown.

### 7.8 Model providers (`core/module.go`)
```go
// ModelProvider is implemented by modules whose presets download model files.
type ModelProvider interface {
    ModelPresent(preset string) bool                                         // cheap file check, no hashing
    FetchModel(ctx context.Context, job *JobContext, preset string) error    // no-op when present; sha-verified where pinned
    RemoveModel(preset string) error
}
```
- **stems:** sidecar `stems.prefetch {model}` runs `load_model` (audio-separator downloads it). Present means the model file is in `<models>/audio-separator/`.
- **transcribe:** sidecar `transcribe.prefetch {preset}` runs the existing `snapshot_download`. Present means `<models>/whisper/<preset>/model.bin`.
- **bgremove:** sidecar `bgremove.prefetch {preset}` runs the existing sha-verified download. Present means the file is in `<models>/bg/`.
- **chat:** reuses its own Go download (Range resume, sha) inside the given job.
- **Scoped progress:** `JobContext.Scoped(from, to float64) *JobContext` returns a view whose `Progress` maps 0..1 into `[from, to]`. Logs, title and context are shared. The pack installer uses it to run dep installer modules (`reg.Module(id).Run`) and model fetches inside one pack job.

### 7.9 Service and install job (`core/packs`, bound `PacksService`)
```go
List() []core.PackStatus
Disk(path string) (core.DiskInfo, error)            // {path, free, total}; path "" = the current tools dir
ToolsDir() core.ToolsDirInfo                        // {path, isDefault, fromEnv, available}
PickToolsDir() (string, error)                      // §7.3; "" when cancelled
Install(ids []string, toolsDir string) (core.PackInstallResult, error) // {jobs, restart}; toolsDir "" = current
InstallFor(moduleID string) (core.Job, error)       // only the components that module needs
RemovePreview(id string) core.PackRemovePreview     // {freedBytes, kept:[{component, usedBy}]}
Remove(id string) error                             // never removes system copies or components another installed pack uses
MoveToolsDir(path string) (core.Job, error)
Relaunch() error
FinishSetup() error                                 // setup.done = true
```
- **Types** (`core/types.go`):
  - `PackStatus{id, name, icon, description, state: installed|partial|missing|installing|outdated|unsupported, unsupportedReason, components []PackComponentStatus, unlocks []PackUnlock{moduleId, name, icon}, jobId}`.
  - `PackComponentStatus{id, name, href, license, kind: dep|model, state: missing|installed|system|outdated|unsupported, downloadBytes, diskBytes, packs []string}`.
  - The frontend computes the selection-dependent sizes with a pure helper `packSizes(packs, selected)` in `views/setup/packSizes.ts`.
- **Event:** `packs:changed` (the full list), emitted after `deps:changed`, on pack job state changes and after model fetch or remove.
- **Install job:**
  - The hidden module `system-pack-install` takes options `{pack, only []componentId}` (`only` is used by `InstallFor`) and has `MaxConcurrent 1`. One job runs per pack, submitted in catalog order, so a shared component is installed by the first job and the next one finds it present.
  - Progress is weighted by download bytes. The title is "Install Image pack".
  - Steps per missing component: deps run their installer module in a scoped context; models call `FetchModel`.
  - Cancelling stops the current component; components already finished stay installed. A failed component fails the job with that component's AppError, and the message names the component.
- **States:** a pack is `unsupported` if any component has no asset for this OS and architecture (for example Local Chat on an Intel Mac). It's `outdated` if a managed component is outdated.

---

## 8. Mac verification checklist (`docs/MAC-CHECKLIST.md`, architect)
A numbered, copy-paste-friendly checklist, each item with the expected result. It covers:
- **Phase 3:** tray template icon, hotkeys, clipboard recording and popup, start at login, ExifTool via the system perl.
- **Phase 4:** auto-paste with Accessibility (including re-allowing after a rebuild), upscaler with MoltenVK (including first-run time), background removal RAM, `Assets.car` icon regeneration (`wails3 task common:generate:icons` on the Mac).
- **Phase 5:** chat engine with Metal, and the model RAM guidance (8 GB → Qwen3.5 2B; 16 GB → any).
- **Tool packs:** the setup screen on a fresh support dir; the managed FFmpeg and Deno run with no Gatekeeper prompt (`ffmpeg -version`, a Converter job, a Downloader job); the Mac sizes the builder couldn't measure (record them so the catalog can be updated); moving the tools folder to an external drive, restarting and running a stem split (the venv `home` rewrite); unplugging that drive and seeing the "isn't available" banner.

Also included: how to collect logs (`<support>/logs/app.log`) and what to send back.

---

## 9. Bound API changes (summary)
- **`DepsService`:** `InstallChatEngine()`, `InstallFFmpeg()`, `InstallDeno()`, plus Remove for both (same shape as the ExifTool methods).
- **`PacksService`** (new, §7.9).
- **`FilesService`:** `OpenURL(url)` only if no bound way to open a link in the default browser exists (https only).
- **`ClipboardService`:** `CopyText(text)` (only if missing).
- **New services:** `chat.Service`, `ocr.Service` (`Defaults`, `Languages() []LanguageInfo{id,label,downloadBytes}`, `Enqueue`, `ResultShape`), and `vault.Service` (§6.2).
- **New events:** `chat:delta`, `chat:done`, `chat:status`, `vault:state`, `packs:changed`.

---

## 10. Test plan

**Go**
- `core/deps`:
  - Tar symlink extraction: a safe relative link works; absolute and `..` escapes are rejected.
  - Windows copies symlink entries as files.
  - The llama archive spec: assets and layout per GOOS, licence written, 0755 on unix.
- `core/pdfium`: the existing pdf render tests move here, plus `PageText`.
- `core/store`: chat CRUD, cascade delete, search over titles and messages, truncate-from for regenerate.
- `modules/chat`:
  - Server lifecycle against a **fake `llama-server`** (re-exec helper). It prints the listening line, serves `/health`, an authenticated `/v1/chat/completions` SSE and 401 without the key, and can exit early, hang or fail to bind. Tests cover the port parse, readiness timeout, early exit with log tail, bind retry, the GPU-fail → CPU retry, idle stop, and that the key file is deleted after ready.
  - SSE parser (chunk splits, usage chunk, `[DONE]`); cancellation stops the request and saves `stopped`.
  - Context trimming; one-generation-at-a-time conflict; persistence cadence.
  - Ollama NDJSON client against httptest; URL validation (non-loopback rejected).
  - Model download job: Range resume from a partial `.part`, sha mismatch deletes it.
- `modules/ocr`:
  - Validate (encrypted PDF rejected, language enum).
  - Run against a fake Caller: page rendering into TempDir, skip-text pages, params, outputs, message.
  - `//go:build integration` with the engine: covered in the engine e2e.
- `modules/vault` (real age, temp dirs, work factor lowered via an unexported test hook):
  - Create, then unlock with the passphrase and with the recovery key; a wrong passphrase errors.
  - Add (with a cancel mid-file leaving no partial blob), list, rename, move, delete.
  - Export verifies the sha, and a tampered blob gives the "damaged" error.
  - Index `.bak` fallback.
  - Auto-lock timer with an injectable clock; lock cancels jobs and wipes the open dir; startup wipe.
  - Change passphrase keeps the files readable.
  - The vault folder contains no plaintext names (grep test).
  - Preview size limit.
- `core/packs`:
  - Catalog integrity: every non-hidden, non-placeholder, non-built-in module is in exactly one pack; every `Unlocks` component is in its pack; every component ID is used; sizes are non-zero for supported OSes.
  - Status with fake deps and fake model providers: installed, partial, missing, system, outdated, unsupported.
  - Install job: components already present are skipped; shared components are installed by the first pack only (two pack jobs in a row); progress is weighted and monotonic; cancel mid-component leaves finished components installed; a failing component names itself.
  - `InstallFor` installs only that module's components.
  - `RemovePreview`/`Remove` keep shared components used by another installed pack and never touch system copies.
- `core/paths` / tools folder: pointer file read, env override, derived dirs, the `Toolbox Tools` subfolder rule, refusing the library and support subfolders.
- Move job (temp dirs): copy and verify, `pyvenv.cfg` `home` rewrite, cleanup on next start only when the marker is present, cancel removes the partial copy.
- `core/disk`: free/total for an existing path and for a not-yet-created child path.
- `core/deps`: `AllowSystem` resolution order (managed first, then system; a system copy is never outdated); the FFmpeg asset layouts per GOOS (flattening, only the three files kept on Windows, 0755 on unix); the Deno archive; checksum retry (first download corrupt, second fine; both corrupt fails).
- `JobContext.Scoped` progress mapping.
- `core/sidecar`: the engine's `PATH` starts with the resolved FFmpeg folder.
- `modules/stems`: default format FLAC; `ModelPresent`/`FetchModel` against a fake Caller (same for transcribe and bgremove).
- Engine e2e (`integration/engine_test.go`): add `ocr.image` on a generated image with rendered text ("Toolbox OCR 2026", drawn with `golang.org/x/image/font/basicfont`, scaled) asserting the text is found, and `ocr.pdf` on a generated 2-page PDF (pdfcpu image import) asserting extractable text in the output.

**Python**
- `test_ocr.py`: line sorting, TXT/JSON writers, model selection, cancellation between pages.
- `test_prefetch.py`: `stems.prefetch`, `transcribe.prefetch` and `bgremove.prefetch` validate params and call the download paths (mocked); slow variants download for real.
- `test_pdftext.py`: the overlay on generated PDFs with `/Rotate` 0/90/180/270 and a cropbox offset. Text extracts (pypdf) in the right place (word bbox centres within tolerance), the original content stream bytes are unchanged, and metadata and outline are kept.
- Slow test: real RapidOCR on a rendered text image.

**Frontend**
- Markdown renderer: no HTML injection (a `<script>` string renders as text), code-block Copy, lists and headings.
- Chat:
  - Composer keys (Enter, Shift+Enter, Esc → Stop).
  - Streaming deltas append to the right message; Stop and Retry; the conflict toast.
  - Model cards with download progress; the DepsGate.
- OCR: options, the preview panel with Copy.
- Setup and packs:
  - `packSizes`: shared components counted once in catalog order, system and installed components cost 0, deselecting the owner moves the shared size to the next selected pack.
  - SetupView: toggling, the installed and unsupported cards aren't selectable, the disk warnings (doesn't fit; under 5 GB left), Install label and disabled states, keyboard (arrows, Space, Ctrl+Enter), installing state with per-card progress, failure with Retry, Continue in background, Skip.
  - Settings → Tool packs: Remove confirm text from `RemovePreview`; DepsGate shows both install buttons with sizes.
  - Stems: FLAC default and the size hint.
- Vault:
  - The create flow (passphrase mismatch, recovery-key confirm gating) and the unlock error.
  - Auto-lock countdown, table actions, delete confirm.

**Manual smoke (architect, Windows, sandboxed; passive capture; mind free RAM ≥ 5 GB before loading a model):**
- Chat:
  - Install the chat engine from Settings, download Qwen3-4B (or reuse the research download by copying it into the sandbox models dir, with sha verified).
  - Chat via the seeded API path; check streaming, stop and export.
  - Exactly one listening socket while the server runs, bound to 127.0.0.1, owned by `llama-server`, and 401 without the key. None after idle stop or quit.
- OCR:
  - The byford scan → searchable PDF (text extracts; page images unchanged per §10 test).
  - A photo of text → TXT.
- Vault:
  - Create, add, lock (open-dir wiped), unlock, export (checksum equal to the original).
  - The vault folder holds no plaintext names.
- Tool packs (a fresh sandbox support dir, with `TOOLBOX_TOOLS_DIR` pointing into `.dev/`):
  - The setup screen shows; FFmpeg shows "found on this PC" (winget copy). Install Media and Image; check the measured disk use against the catalog (±10%) and record the 0.5.0 engine size.
  - Take screenshots of the setup screen idle, mid-install and done, in both themes, for the summary.
  - Install FFmpeg managed in a second sandbox with the winget folder removed from `PATH`; Converter and Downloader jobs work.
  - Move the tools folder within `.dev/`, restart, run a stem split and a transcription.

---

## 11. Work packages

### Wave 0: foundation (architect)
1. Go dep `age`.
2. Core:
   - settings additions plus validation, with tests;
   - migration 0004, the `ChatStore` interface (store implementation stubbed), wire types and events;
   - `Accepts.Any` and the matcher ordering;
   - **move the pdfium renderer to `core/pdfium`**, rewire `modules/pdf`, tests green;
   - the `llama-runtime` catalog entry and installer stub;
   - `DepsService.InstallChatEngine` signature.
3. Module stubs with final options/presets/descriptors/services for `chat`, `ocr` and `vault`; placeholders removed; `main.go` wiring (pdfium renderer shared, chat server stopped at quit, vault locked at quit, vault-open dir wiped at start).
4. Sidecar: deps plus 0.5.0, `uv lock` (verify macOS arm64), handler stubs `ocr.image` and `ocr.pdf`.
5. Bindings, `lib/api.ts` re-exports, tool view stubs, palette entry stubs.
6. Docs: CLAUDE.md (chat server rule: 127.0.0.1 only, random port, key file, the only listener in the app; vault rules; OCR model rule) and `docs/MAC-CHECKLIST.md` (§8).

7. Tool packs foundation: `core.ModelProvider`, `JobContext.Scoped`, `Paths.ToolsDir` with the pointer file and env override, `Spec.AllowSystem`, the FFmpeg and Deno catalog entries (installer stubs), the managed-archive checksum retry, `core/packs/catalog.go` with the measured sizes, pack wire types and the `PacksService` signatures (stubbed), the `setup.done` setting, and the stems FLAC default.

### Wave 1 (parallel)

| WP | Owns | Acceptance |
|---|---|---|
| **CH1 Chat backend** | `modules/chat/**` (except frozen files), `core/store/chat.go` + tests, `core/deps` symlink extraction + `llama.go` installer, api `InstallChatEngine` body | §3.3, §3.5, §4.1–4.4, and `ModelProvider` for chat (§7.8); Go tests; catalog verification of the 2 unverified models (memory permitting) |
| **OC1 OCR** | `sidecar/toolbox_sidecar/handlers/ocr.py`, `toolbox_sidecar/pdftext.py`, `sidecar/tests/test_ocr.py`, `test_pdftext.py`, `modules/ocr/**` (except frozen files) | §5.1–5.3; pytest (+slow), Go tests |
| **VA1 Vault backend** | `modules/vault/**` (except frozen files), the tray "Lock vault" item (marked block in `desktop/`) | §6.1–6.2; Go tests |
| **UI-C Chat UI** | `frontend/src/tools/chat/**`, `components/Markdown.*`, `views/SettingsChat.tsx` (+ the section mount in SettingsView) | §4.5; tests |
| **UI-OV OCR + Vault UI** | `frontend/src/tools/ocr/**`, `frontend/src/tools/vault/**`, `views/SettingsVault.tsx` (+ mount), palette entries in `shell/useBuiltinCommands.ts` (chat, OCR, vault, and the two pack entries from §7.5) | §5.4, §6.3, §7.5 palette; tests |
| **PK1 Packs backend** | `core/packs/**` (except the frozen catalog), `core/disk/**`, the move job, `core/deps/ffmpeg.go` + `deno.go` installers and their Settings remove paths, the engine `PATH` change in `core/sidecar`, `ModelProvider` in `modules/{stems,transcribe,bgremove}` + sidecar `*.prefetch` handlers and `test_prefetch.py`, `desktop.Relaunch`, the unavailable-folder check at start, api bodies (`PacksService`, `InstallFFmpeg`, `InstallDeno`, `OpenURL` if needed) | §7.1–7.3, §7.6, §7.8, §7.9; Go and pytest tests |
| **UI-PK Setup + packs UI** | `frontend/src/views/setup/**` (SetupView, PackCard, DiskBar, `packSizes.ts`), `state/packs.ts`, `views/SettingsPacks.tsx` (+ mount), `tools/_kit/DepsGate.*`, the setup gate and unavailable-folder Banner in `App.tsx`/`Shell.tsx`, the stems size hint in `tools/stems/**` | §7.4, §7.5 (except palette), §7.7; tests |

### Wave 2: integration (architect)
Merge, regenerate bindings, all checks, the engine e2e (with OCR), `wails3 build`, the manual smoke from §10 (memory-aware), DECISIONS.md, and the summary.

---

## 12. Acceptance criteria
1. **Chat:**
   - The chat engine installs from Settings (pinned and verified), and the Qwen3-4B download resumes after cancel and is sha-verified.
   - A conversation streams answers on the GPU; Stop works within about 1 s; conversations persist across restarts; export writes Markdown.
   - The server is the app's **only** listener: 127.0.0.1, random port, 401 without the key. It is gone after idle stop or quit.
2. **OCR:**
   - The byford scan becomes a searchable PDF whose text is selectable and extractable, with page images byte-identical.
   - A photo of text gives a TXT file and a preview with Copy.
   - Non-Latin languages download their model once (sha-verified).
3. **Vault:**
   - Create shows the recovery key.
   - Files added are encrypted, with no plaintext names in the folder; originals are untouched.
   - Unlock works with the passphrase or the recovery key; auto-lock fires and wipes the temporary open copies.
   - Export round-trips byte-identical; tampering is detected.
4. **Tool packs:**
   - A fresh support dir opens on the setup screen. Installing Media and Image from it works end to end, with per-card progress, and the app then opens on a tool from those packs.
   - Shared components install once, and their size is counted once on screen. A system FFmpeg is detected and skipped.
   - Measured disk use matches the cards within ±10%, and the catalog is updated with the measured engine size.
   - FFmpeg and Deno install as pinned, checksum-verified managed tools; a corrupt download is retried once.
   - Removing a pack frees what the preview said and keeps shared components that are still needed.
   - The tools folder can be chosen at setup (relaunch, then the install continues) and moved later (restart, the engine still works).
5. **Stems** default to FLAC and show the size hint.
6. `docs/MAC-CHECKLIST.md` exists and covers §8.
7. All checks are clean (`go vet`, `go test`, pytest, `npm run check`, gofmt, darwin cross-vet), and DECISIONS.md is updated.

## 13. Risks
- **Memory:**
  - LLMs need 3–7 GB free; this machine often has about 6 GB.
  - The UI shows RAM hints and the server retries on CPU, but a heavily loaded machine will still swap.
  - The architect's smoke test checks free RAM before loading a model.
- **llama.cpp moves fast:** the log line used for the port and some flags could change in later builds. That is why the build is pinned, and the fake-server tests pin the behaviour we rely on.
- **`/health` is unauthenticated** (it leaks nothing but liveness). Every other endpoint requires the key.
- **modelscope.cn** (OCR model host) can be slow or unreachable. Downloads retry, and only the non-Latin languages need it.
- **OCR quality:** reading order on multi-column pages and Arabic diacritics are weak. The invisible text layer's selection feel in Preview and Acrobat isn't verified here; it's on the Mac checklist.
- **Vault limits:**
  - It protects files at rest only, not on a compromised machine while unlocked.
  - Go can't guarantee wiping keys from memory.
  - Opened files exist decrypted on disk until lock; SSD remanence means deleted temp copies may be recoverable.
  - All of this is stated in the UI.
- **Ollama has no auth;** it is opt-in and labelled.
- **FFmpeg hosts:** the macOS builds come from one person's site (Martin Riedl). They're pinned by sha256, so a change or outage makes the install fail cleanly instead of installing something different. Homebrew stays the documented fallback.
- **Moving a Python venv** isn't officially supported. The `home` rewrite is covered by tests and the Mac checklist, and the engine's Repair (a full re-sync, about 1 GB of downloads) is the fallback.
- **Static sizes drift:** the catalog sizes belong to the pinned versions. A pin bump must update the sizes, and a test fails if a pinned version changes without its size entry changing.
- **Relaunching** from inside a Wails app is new; under `wails3 dev` it's replaced by a message.
- **Free space on APFS** counts purgeable space differently from Finder, so the numbers can differ slightly from what Finder shows.
