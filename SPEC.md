# Toolbox — Phase 6 Spec: Video Trimmer, Subtitles, Audio Cleanup, Lyric Video, Redact, Object Eraser, Dev Utilities

Status: **DRAFT — awaiting review.**
Date: 2026-10-28. Author: architect session (Opus).

Phases 1–5 are shipped; their specs are archived in `docs/specs/phase-{1..5}.md`, and every contract there still holds unless changed here. "P5 §x" etc. refer to those files. The order and intent come from `docs/ROADMAP.md`.

---

## 0. Research findings this spec relies on

Verified hands-on on this Windows machine on 2026-10-28, in `.dev/p6-research/`, except where marked *docs only*.

### 0.1 FFmpeg (the pinned 9.0.2 builds from P5 §7.6)

| Topic | Finding | Consequence |
|---|---|---|
| Filters, Windows (Gyan essentials) | `subtitles`, `ass`, `arnndn`, `afftdn`, `anlmdn`, `loudnorm`, `highpass`, `equalizer`, `showwaves`, `showfreqs`, `gblur`, `boxblur`, `drawtext`, `zscale` all present. Built with libass, libfreetype, libharfbuzz, libfribidi, fontconfig. Encoders: libx264, libx265, libvpx-vp9, aac, libmp3lame, libopus, mov_text, plus h264_nvenc/amf/qsv. | Every Phase 6 audio/video operation runs on the FFmpeg we already manage. No new binary. |
| Filters, macOS arm64 (Martin Riedl) | The binary's configure line has `--enable-libass --enable-libfreetype --enable-libharfbuzz --enable-fontconfig --enable-libx264 --enable-libopus --enable-libmp3lame`, and the binary contains `arnndn`, `subtitles`, `drawtext` and `videotoolbox`. | Same on the Mac (checked statically; the Mac checklist runs it). |
| Karaoke render (`.dev/p6-research/lyric/`) | An ASS file with `\kf` word timings over a `color` source plus a `showwaves` overlay, `libx264 -preset veryfast -crf 20`: **30 s of 1080p30 rendered in 3.1 s** (≈10× real time), 0.4 MB. The word fill sweeps correctly (checked on a frame). Fonts resolve through DirectWrite on Windows (`Arial` → `Arial-BoldMT`); CoreText on macOS (*docs only*). | Lyric videos and burned-in subtitles are rendered by libass from an ASS file we generate. Fonts come from a short list present on both OSes (§3.6). |

### 0.2 Playing local media in the window

| Topic | Finding | Consequence |
|---|---|---|
| Today | No tool plays audio or video; previews are images (`ImageThumb`). | Phase 6 adds a media route and a player kit (§3.2, §3.9). |
| Wails v3 `AssetOptions.Middleware` | Runs in-process in front of the asset handler for every request the webview makes to the app origin (WebView2 `WebResourceRequested`, WKWebView scheme handler). **No socket is opened.** | Local media is served from `/media/<token>/<name>` by a middleware: no listener, so the app rule holds. |
| Windows response writer (`internal/assetserver/webview/responsewriter_windows.go`) | Buffers the **whole response body** in a `bytes.Buffer` before handing it to WebView2. | Every media response is capped at **4 MiB** (a 206 partial response). Chromium's media stack asks for the next range by itself. |
| Codecs (*docs only*) | WebView2 (Chromium): H.264/AAC/MP3/Opus/Vorbis/FLAC/WAV, VP8/VP9/AV1 in MP4/WebM/Ogg; no HEVC without the OS extension; MKV unreliable. WKWebView: H.264/HEVC in MP4/MOV, AAC/MP3/ALAC/FLAC/WAV; WebM VP9 on macOS 14+. | Files outside a conservative per-OS table get a **preview copy** (720p H.264 proxy, §3.3). Outputs always use the original file, never the proxy. |

### 0.3 What already exists and is reused

| Topic | Finding | Consequence |
|---|---|---|
| `transcribe.run` (engine) | Writes word timestamps (`segments[].words[] {start,end,word}`) into the JSON output when `json` is among the formats. Supports `task: translate` (to English only). | Subtitles and Lyric Video call it with `formats: ["json"]` into their TempDir and do the cue/line logic in Go. |
| `stems.run`, preset `vocals-fast` | UVR-MDX-NET-Inst_HQ_3 (≈67 MB), outputs **Vocals** + **Instrumental**. | Lyric Video isolates vocals before transcribing a song (Whisper does much worse over a full mix) and offers the instrumental as a karaoke track. |
| OpenCV in the engine | `opencv-python-headless` is already installed (a RapidOCR dependency, P5 §0.2). | Face detection uses `cv2.FaceDetectorYN`; image ops use cv2/numpy. It becomes an explicit dependency (§3.1). |
| Local Chat | One generation at a time (`modules/chat/generate.go`, `reserve`). llama-server supports `response_format` with a JSON schema (*docs only*). | A new `core.TextGenerator` lets other tools run one-shot prompts on the chat model (subtitle translation now, pipelines in Phase 7). |
| Converter progress | `modules/converter/progress.go` folds `-progress pipe:1` output into progress. | Moves to `core/media` so every FFmpeg-based tool shares it. |

### 0.4 Models

Tested with onnxruntime 1.31.1 and numpy 2.5.4 on Python 3.12, CPU only (i7-11700K), in `.dev/p6-research/` (full notes: `.dev/p6-research/models.md`; reference scripts: `.dev/p6-research/scripts/{yunet,plates,lama2,migan2,dfn3_numpy}.py`, readable from the main checkout at `C:\Users\nickb\repos\toolbox\.dev\p6-research\`). Every size and sha256 below was computed on the downloaded file.

| Use | Model, licence | Pinned URL | Bytes · sha256 | Shape and findings |
|---|---|---|---|---|
| **Faces** | YuNet 2023mar, MIT (code + weights) | `https://huggingface.co/opencv/face_detection_yunet/resolve/3cc26e7f1014a5ee5d74a42acee58bafc9d0a310/face_detection_yunet_2023mar.onnx` | 232,589 · `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4` | **Input:** `input` `[1,3,640,640]` BGR 0..255, no normalisation. It runs at any size that is a multiple of 32 once the input/output dims are marked dynamic at load (patched in memory; see `yunet.py`). **Outputs:** `cls/obj/bbox/kps_{8,16,32}`, decoded as in OpenCV: score = √(cls·obj), centre `(col+b0)·s`, size `exp(b2)·s`. Then NMS 0.3. **Results:** all 7 faces of the NASA crew portrait (public domain) at 640 in 9 ms and at 1280×1024 in 78 ms. Detects faces of about 10–300 px, so **use two scales** (long side 640 and ≤ 1920) and merge them. SCRFD rejected: its weights are non-commercial. |
| **Number plates** | open-image-models `yolo-v9-t-640-license-plates-end2end`; code MIT, **weights licence not stated** (trained with a GPL-3.0 YOLOv9 fork, not Ultralytics) | `https://github.com/ankandrew/open-image-models/releases/download/assets/yolo-v9-t-640-license-plates-end2end.onnx` | 7,835,770 · `c3c1026ca7d0585dd88084d68182dd897113712fa734ae1557ca70174440c076` | **Input:** `images` `[1,3,640,640]` RGB/255, letterboxed with grey 114, centred. **Output:** `output0` `[n,7]` = batch, x1, y1, x2, y2, class, score. NMS built in; threshold 0.25. 50–65 ms. **Results:** all plates in 4/4 test photos (CC BY-SA, Geograph), small distant plates scoring 0.31–0.38, so tile large images. The t-384 variant missed plates. Strictly permissive fallback: DEIMv2-nano (MIT card, 16 MB, 2/3 plates). The `assets` tag can be re-uploaded, so the sha check is what protects us. |
| **Inpainting, best** | LaMa (big-lama ONNX port by Carve), Apache-2.0 | `https://huggingface.co/Carve/LaMa-ONNX/resolve/c3c0c9e468934d62e79c329e35d82dd09ff8c444/lama_fp32.onnx` | 208,044,816 · `1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6` | **Inputs:** `image` f32 `[1,3,512,512]` RGB 0..1; `mask` f32 `[1,1,512,512]`, 1 = hole. **Output:** `output` f32 **0..255**. The size is **fixed at 512**, so we crop, resize and paste back. **1.85 s per call.** Clean result on the test photo **only with the mask dilated ~10–15 px**; an undilated mask leaves a dark ghost. |
| **Inpainting, fast** | MI-GAN pipeline v2, MIT (code + weights) | `https://huggingface.co/andraniksargsyan/migan/resolve/406830d0fa60666da0071c342ad2fbc8f30c5c64/migan_pipeline_v2.onnx` | 28,079,181 · `6f1f3530a1a2324b19752018ce756088b07973cda8d7d890034ace5c8a48c40b` | **Inputs:** `image` u8 `[1,3,H,W]` RGB; `mask` u8 `[1,1,H,W]`, **255 = keep, 0 = hole** (the opposite of LaMa), binary. **Output:** `result` u8, full size. Any size (it crops and pastes back itself), about 0.8 s. Fine for small objects; it smears large ones. |
| **Voice denoise (AI)** | DeepFilterNet3 ONNX, MIT/Apache-2.0 | `https://raw.githubusercontent.com/Rikorose/DeepFilterNet/d375b2d8309e0935d165700c91da9de862a99c31/models/DeepFilterNet3_onnx.tar.gz` | 7,983,136 · `c94d91f70911001c946e0fabb4aa9adc37045f45a03b56008cb0c8244cb63616` | The tarball holds `enc.onnx` (1,954,042 · `7c5399d3…1916`), `erb_dec.onnx` (3,292,397 · `ab669a1d…d895`) and `df_dec.onnx` (3,340,803 · `23114ce3…278a`): 8,587,242 B on disk. `pip install deepfilternet` is impossible (numpy < 2, no py3.12 wheel). **A ~70-line numpy port** (`dfn3_numpy.py`: STFT, ERB/spec features with running normalisation, 2-frame lookahead, mask and 5-tap deep filter) matches the official v0.5.6 binary (correlation 0.99998, −43.7 dB difference). About 35× real time. The models are stateless across calls, so process **30–60 s chunks with a crossfade** (whole-file needs ~2 GB per 10 min). |
| **Denoise (FFmpeg)** | RNNoise `std.rnnn` (Xiph), BSD-3 | `https://raw.githubusercontent.com/richardpl/arnndn-models/0fda24c46d78f0207d820bb970fbe85c1971b39c/std.rnnn` | 302,903 · `6b8943dc4a9b6b24425873992a44f29c0577503276456af46a8854774faeb294` | For FFmpeg's `arnndn`. About 33× real time, 10 ms delay. Small enough to **embed in the Go binary**. |

**Denoise comparison** (30 s of public-domain speech + pink noise + 60 Hz hum; SI-SDR in dB on the speech band, higher is better):

| Input SNR | Noisy | arnndn `std` | DeepFilterNet3 |
|---|---|---|---|
| 5 dB | 9.2 | 12.3 | **14.6** |
| 0 dB | 4.2 | 8.7 | **11.3** |

DeepFilterNet3 leaves rumble below 150 Hz alone, so it's always paired with the 80 Hz high-pass.

**Samples for tests** in `.dev/p6-research/samples/` (local only, never committed):
- `STS-125_crew_portrait.jpg` (NASA, public domain);
- two Geograph car photos (CC BY-SA 2.0);
- `schumer_pd.ogg` (public-domain speech).

---

## 1. Goals

1. **Video Trimmer:** cut one or more ranges out of a video or audio file. A player with frame stepping and a filmstrip timeline. A **lossless fast mode** (stream copy, cuts on keyframes) and a **precise mode** (re-encode), with optional reframing to 9:16 / 1:1 / 4:5 and a "fit under N MB" limit.
2. **Subtitles:** generate subtitles from speech (Whisper), edit them against the video, **translate** them (Whisper to English, or Local Chat to ~30 languages), then save `.srt`/`.vtt`, **add them as a track** (lossless) or **burn them in** with a choice of styles.
3. **Audio Cleanup:** high-pass, hum removal, noise reduction (light, strong, or AI voice isolation) and loudness normalisation to a target (podcast −16 LUFS, streaming −14, broadcast −23). It has a 10-second A/B preview and before/after loudness, for audio files and the audio of video files.
4. **Lyric Video:** song → timed lyrics (detected from the vocals, pasted lyrics aligned to the song, or an `.lrc`/`.srt` file) → an editable lyric sheet with tap-to-sync → a rendered MP4. It offers a word-by-word karaoke fill, cover-art or colour backgrounds, an optional visualiser, 16:9 / 9:16 / 1:1, and an instrumental (karaoke) audio option.
5. **Redact:** find faces and number plates in photos and videos, review the detections (toggle, add boxes by hand), then blur, pixelate or black them out. Metadata is removed from the output.
6. **Object Eraser:** paint over something in a photo and it is filled in from its surroundings (inpainting, on the AI engine). You can erase again on the result.
7. **Dev Utilities:** JSON, Base64, URL, hashes (text and files), UUID/ULID, JWT, timestamps, number bases, colours, regex, diff and text case tools. Offline and built in.
8. **Shared foundations:** a no-socket media route, media probing, a preview-copy (proxy) job, filmstrips and waveforms, a media player kit for the UI, an ASS writer, and `core.TextGenerator`.
9. **Phase 5 follow-ups** (§11): the small open issues from the Phase 5 summary.

## 2. Non-goals (Phase 6)

- **Chaining tools** (that is Phase 7's Pipelines). Each tool still hands off through Library → Send to.
- **Video Trimmer:** multi-track editing, transitions, effects, titles, speed changes; "smart cut" (re-encoding only the frames around a cut); joining different files.
- **Subtitles:** speaker labels, styling individual cues, ASS/SSA editing (`.ass` import is out; `.srt` and `.vtt` only), image subtitles (PGS/VobSub) extraction, translating with an online service.
- **Audio Cleanup:** multitrack, manual EQ, de-essing, de-reverb, click repair.
- **Lyric Video:** looking lyrics up online (no outbound calls), animated text effects beyond the karaoke fill and fades, multiple singers, video-clip backgrounds longer than the song's needs (they loop).
- **Redact:** text and document redaction (PDFs, screenshots of text), licence-plate *reading*, tracking that follows a box the user drew by hand in a video (manual video boxes are fixed-position over a time range), audio bleeping.
- **Object Eraser:** video, prompt-based generative fill, automatic object selection (click-to-select).
- **Dev Utilities:** anything that goes on the network (HTTP client, DNS, ping), code formatting for programming languages, cron or SQL helpers.
- New tool packs: the seven tools join existing packs (§3.8).

---

## 3. Foundation changes (Wave 0, architect)

### 3.1 Dependencies
- **Engine:** `pyproject.toml` adds `opencv-python-headless` explicitly (no version change: pin `>=` the locked version) and bumps the version to **0.6.0**. The description gains "redaction and object removal". Run `uv lock`; no other lock entry may change.
- **Frontend:** `yaml@2` (ISC, no dependencies) for Dev Utilities' JSON ↔ YAML.
- **Go:** nothing new.

### 3.2 Media route (`api/media.go`, middleware in `main.go`)
- `api.MediaMiddleware(m *MediaService) application.Middleware` handles paths under `/media/` and passes everything else to `next`.
- URLs look like `/media/<token>/<url-escaped basename>`. The token is 128 random bits (hex) and maps to an absolute path in an in-memory LRU of 512 entries, filled only by `MediaService` methods. An unknown token gives 404. The basename is only there so the browser sees an extension; it is ignored.
- Only `GET` and `HEAD`; anything else gives 405.
- Range handling (own code, not `http.ServeContent`, so the cap applies):
  - `Range: bytes=a-b` / `a-` / `-n`: answer **206** with `Content-Range`. The body is at most **4 MiB** (`b` is clamped).
  - No `Range` header: the whole file with 200 if it is ≤ 4 MiB, else a 206 for the first 4 MiB.
  - Invalid or unsatisfiable range: 416 with `Content-Range: bytes */size`.
  - Always `Accept-Ranges: bytes`, `Cache-Control: no-store`, and `Content-Type` from the extension (mp4, m4v, mov, webm, mkv, mp3, m4a, aac, wav, flac, ogg, opus, jpg, png; else `application/octet-stream`).
- Files are opened per request and closed after; a file that disappeared gives 404.
- The middleware never logs paths.

### 3.3 `core/media` (new package)
`core/media` imports `core` and `core/proc` only.

```go
// Info is the probed shape of a media file (times in ms).
type Info struct {
    DurationMs int64        `json:"durationMs"`
    StartMs    int64        `json:"startMs"`   // container start_time (≠ 0 for some TS/MKV files)
    Container  string       `json:"container"` // ffprobe format_name, first entry
    SizeBytes  int64        `json:"sizeBytes"`
    BitRate    int64        `json:"bitRate"`   // bit/s, 0 = unknown
    Video      *VideoStream `json:"video"`     // nil = no video (cover art is not video)
    Audio      []AudioStream    `json:"audio"`
    Subtitles  []SubtitleStream `json:"subtitles"`
    HasCover   bool              `json:"hasCover"` // attached_pic stream
    Tags       map[string]string `json:"tags"`     // lowercased keys: title, artist, album, …
}
type VideoStream struct {
    Index         int     `json:"index"`
    Codec         string  `json:"codec"`
    Width, Height int     `json:"width" / "height"` // display size: rotation and SAR applied
    FPS           float64 `json:"fps"`              // avg_frame_rate; 0 = unknown
    Rotation      int     `json:"rotation"`         // 0/90/180/270 from the display matrix
    PixFmt        string  `json:"pixFmt"`
}
type AudioStream struct {
    Index int; Codec string; Channels, SampleRate int; Language string // ISO 639-2 tag or ""
}
type SubtitleStream struct {
    Index int; Codec string; Language, Title string
    Text bool // subrip/ass/webvtt/mov_text: extractable as text
}

func Probe(ctx context.Context, ffprobe, path string) (Info, error)
// Keyframes lists video keyframe times (ms, ascending) using
// -skip_frame nokey -select_streams v:0 -show_entries frame=pts_time.
func Keyframes(ctx context.Context, ffprobe, path string) ([]int64, error)
// Playable reports whether the webview on goos can play the file directly (§0.2 table).
func Playable(info Info, ext, goos string) bool
```

- `Probe` caches results in memory by (path, size, mtime), up to 256 entries. Errors are `AppError`s: "Couldn't read this file as audio or video" with ffprobe's last stderr line as the hint.
- `Playable` uses a conservative table:
  - **Windows:** containers mp4/m4v/mov/webm/ogg/mp3/m4a/wav/flac; video h264/vp8/vp9/av1; audio aac/mp3/opus/vorbis/flac/pcm.
  - **macOS:** containers mp4/m4v/mov/mp3/m4a/wav/flac/aiff; video h264/hevc; audio aac/mp3/alac/flac/pcm.
- **Progress:** `progressTracker` moves from `modules/converter` to `core/media` as an exported `ProgressTracker` (same behaviour, tests move too). The converter then uses it.
- **ASS writer** (`core/media/ass.go`):
  - `ASSDoc{PlayResX, PlayResY int; Styles []ASSStyle; Events []ASSEvent}` and `(d ASSDoc) WriteTo(w io.Writer)`.
  - `ASSStyle` carries the V4+ style fields we use: name, font, size, primary/secondary/outline/back colours as `#RRGGBB` plus alpha, bold, border style, outline, shadow, alignment, margins.
  - `ASSEvent{Layer int; StartMs, EndMs int64; Style, Text string}`.
  - `ASSEscape(text)` escapes `{`, `}` and `\`, and turns newlines into `\N`.
  - `ASSColor("#rrggbb", alpha)` gives `&HAABBGGRR`.
  - `ASSTime(ms)` gives `H:MM:SS.cc`.
- **Running FFmpeg with an ASS file:** tools write it as `subs.ass` in the job's TempDir and run FFmpeg with that as its working directory, referencing it relatively (`ass=subs.ass`). This avoids filtergraph escaping of Windows paths. `core/proc` gains `Cmd.Dir` if it lacks it.

### 3.4 `MediaService` (bound, `api/media.go`)

```go
type MediaSource struct {
    URL        string     `json:"url"`        // "" while a preview copy is being made
    Info       media.Info `json:"info"`
    Proxy      bool       `json:"proxy"`      // URL points at the preview copy
    ProxyJobID string     `json:"proxyJobId"` // set when a preview-copy job was started or is running
}
func (s *MediaService) Open(path string) (MediaSource, error)
func (s *MediaService) Keyframes(path string) ([]int64, error)
// Filmstrip renders count (4–60) frames, height px (40–160), evenly spaced, as one
// horizontal JPEG sprite and returns its /media URL.
func (s *MediaService) Filmstrip(path string, count, height int) (string, error)
// Waveform returns buckets (100–4000) peak values in 0..1 over the whole file (mono mix).
func (s *MediaService) Waveform(path string, buckets int) ([]float32, error)
// Frame returns a /media URL for a JPEG of the frame at ms, longest side ≤ maxDim (64–4096).
func (s *MediaService) Frame(path string, ms int64, maxDim int) (string, error)
// URLFor returns a /media URL for any existing file (images, outputs, cached previews).
func (s *MediaService) URLFor(path string) (string, error)
```

- **Open:**
  - Probes the file.
  - If it's playable, returns its URL.
  - If a preview copy is cached, returns that URL with `proxy: true`.
  - If a preview-copy job for this file is queued or running, returns its ID.
  - Otherwise submits one and returns its ID. The UI waits for the job and calls `Open` again.
- **Preview copies** (hidden module `media-proxy`, in `api` or `core/media`, registered in `main.go`):
  - Output: H.264 (`-preset veryfast -crf 26`, at most 720p tall, `yuv420p`), AAC 128k, `+faststart`.
  - Keep the timeline identical: `-map 0:v:0? -map 0:a:0?` and no trimming. The proxy starts at 0, so callers subtract `Info.StartMs` the same way for both.
  - Audio-only files (an unplayable codec such as ALAC on Windows, or AIFF) become a 192k AAC `.m4a`.
  - Stored in `<support>/cache/media/proxy/<sha1(path|size|mtime)>.mp4`. A preview copy for a missing or changed file is never used.
  - The cache is pruned at start and after every proxy job: oldest first, until under **5 GB**.
  - The job title is "Preparing preview — <name>". It's cancellable, with progress through `ProgressTracker`.
- **Filmstrip / Waveform / Frame:**
  - Cached under `<support>/cache/media/{strip,wave,frame}/` by the same key plus parameters. That cache shares the 5 GB prune.
  - **Filmstrip:** one FFmpeg call: `-vf fps=<count/duration>,scale=-2:<h>,tile=<count>x1 -frames:v 1`.
  - **Waveform:** FFmpeg decodes to mono s16le at 8 kHz on a pipe; Go computes per-bucket peaks.
  - All three take a context with a 60 s timeout. For a file without video, Filmstrip and Frame return a `validation` AppError.

### 3.5 `core.TextGenerator` (`core/textgen.go`)

```go
// TextGenerator runs one-shot prompts on the local chat model. modules/chat implements it.
type TextGenerator interface {
    // Ready returns the model that would be used, or a dependency_missing AppError
    // ("Download a model in Local Chat first") without starting anything.
    Ready() (model string, err error)
    // Complete waits (ctx-cancellable) for the chat engine's generation slot, starts the
    // server if needed, and returns the whole reply. Nothing is stored as a conversation.
    Complete(ctx context.Context, req CompletionRequest) (string, error)
}
type CompletionRequest struct {
    System      string
    Prompt      string
    JSONSchema  json.RawMessage // optional; constrains the reply (llama: response_format; Ollama: format)
    MaxTokens   int             // 0 = 2048
    Temperature float64         // used as given (0 is valid)
    Purpose     string          // shown in Local Chat while it runs, e.g. "Translating subtitles"
}
```

- **Model choice:** `settings.chat.defaultModel` if it is downloaded (or an `ollama:` model while Ollama is configured). Otherwise the first downloaded catalog model in catalog order.
- **Sharing the slot with interactive chat:**
  - A background completion holds the generation slot for **one request only**.
  - While it holds the slot, a user's Send waits up to 60 s for it instead of failing at once. If it is still busy after that, the existing conflict error appears, with the text "Local Chat is busy: <Purpose>".
  - Interactive requests take priority: a waiting interactive Send is served before the next background request.
- **Status:** `chat:status` reports `busy: <Purpose>` while a background completion runs. The Local Chat composer shows "Busy: translating subtitles…" and stays usable.

### 3.6 Fonts for rendered text (`core/media/fonts.go`)
`media.Fonts() []string` returns `Arial`, `Verdana`, `Georgia`, `Trebuchet MS`, `Impact` and `Courier New`. All six ship with both Windows and macOS. libass picks a fallback font for scripts these lack (CJK, Arabic, …) through DirectWrite or CoreText. The default is `Arial`.

### 3.7 Settings, events, storage
- No new settings keys. Tools remember their options with `SettingsService.SetModuleState`, as today.
- No new events: proxy, preview and render work are ordinary jobs.
- No migration.

### 3.8 Tool packs (`core/packs/catalog.go`)
New components (the sizes are filled in with measured values during Wave 0; the downloads come from §0.4):

| Component | Kind | Provider (module, preset) | Packs |
|---|---|---|---|
| `stems-vocals` (UVR-MDX-NET-Inst_HQ_3) | model | `stems`, `vocals-fast` | Music |
| `face-detect` (YuNet, 232,589 B) | model | `redact`, `faces` | Image |
| `plate-detect` (YOLOv9-t plates, 7,835,770 B) | model | `redact`, `plates` | Image |
| `inpaint` (LaMa, 208,044,816 B) | model | `object-eraser`, `best` | Image |
| `voice-denoise` (DeepFilterNet3, 7,983,136 B download, 8,587,242 B on disk) | model | `audio-cleanup`, `voice` | Speech |

MI-GAN (`object-eraser`, `fast`) isn't in a pack; it downloads on first use, like the other non-default presets. RNNoise is embedded and needs no component.

**Model downloads** follow the bgremove pattern (P4):
- Go holds `{file, url, sha256, bytes}` per preset and implements `core.ModelProvider`.
- `FetchModel` calls an engine `<area>.prefetch` handler that does the sha-verified download into `<models>/<dir>/`.
- The run handlers are always given explicit model paths and never download.

| Preset | Directory |
|---|---|
| redact | `<models>/redact/` |
| object-eraser | `<models>/eraser/` |
| voice-denoise | `<models>/denoise/dfn3/` |

The DeepFilterNet3 tarball is extracted with `tarfile` (`filter="data"`), keeping only the three `.onnx` files; it's verified by the tarball's sha and then by each file's sha.

Unlocks:
- **Media:** + `trimmer` {ffmpeg}.
- **Speech:** + `subtitles` {engine, ffmpeg, whisper-default}, + `audio-cleanup` {ffmpeg, engine, voice-denoise}. FFmpeg and `voice-denoise` join the Speech pack's components. Audio Cleanup also works with FFmpeg alone, minus Voice isolation.
- **Music:** + `lyric-video` {engine, ffmpeg, whisper-default, stems-vocals}. Whisper small and `stems-vocals` join the Music pack's components and are counted once with Speech (P5 §7.1).
- **Image:** + `redact` {engine, ffmpeg, face-detect, plate-detect}, + `object-eraser` {engine, inpaint}. FFmpeg joins the Image pack.
- **`BuiltIn`** gains `dev-utils`.

The pack descriptions are updated to name the new tools. `TestEveryToolIsInOnePack` keeps passing.

### 3.9 Module stubs and wiring
- Wave 0 creates every module with its final `options.go`, descriptor, `Register`, bound service signatures, `Validate` (complete) and a `Run` that returns `core.Errorf(core.CodeInternal, "not built yet")`.
- It registers them in `main.go` and regenerates bindings.
- It adds tool view stubs in `frontend/src/tools/<id>/` and the `tools/index.ts` lines.
- It adds the empty engine handler files with their `@handler` names, imported in `handlers/__init__.py`.

| ID | Name | Icon (lucide) | Category | Order | Accepts | Requires | OutputSubdir |
|---|---|---|---|---|---|---|---|
| `trimmer` | Video Trimmer | `scissors` | media | 135 | video + audio exts (§4.1), MaxInputs 1 | ffmpeg, ffprobe | `Trimmed` |
| `subtitles` | Subtitles | `captions` | media | 172 | video + audio + `.srt .vtt`, MaxInputs 1 | ffmpeg, ffprobe (+ engine for generate) | `Subtitles` |
| `audio-cleanup` | Audio Cleanup | `audio-waveform` | audio | 125 | audio + video, SplitInputs, MaxInputs 50 | ffmpeg, ffprobe | `Cleaned audio` |
| `lyric-video` | Lyric Video | `mic-vocal` | audio | 115 | audio exts, MaxInputs 1 | ffmpeg, ffprobe (+ engine for detect/align) | `Lyric videos` |
| `redact` | Redact | `scan-face` | image | 155 | image + video exts, MaxInputs 100 (1 video) | engine, ffmpeg, ffprobe | `Redacted` |
| `object-eraser` | Object Eraser | `eraser` | image | 145 | image exts, MaxInputs 1 | engine | `Erased` |
| `dev-utils` | Dev Utilities | `braces` | utility | 220 | none (not matched by drops) | — | "" |

- **Extension lists:**
  - Video: `.mp4 .m4v .mov .mkv .webm .avi .ts .mts .m2ts .wmv .flv .3gp`.
  - Audio: `.mp3 .m4a .aac .wav .flac .ogg .opus .wma .aiff .aif`.
  - Image (Redact): `.jpg .jpeg .png .webp .bmp .tif .tiff .heic .heif`.
  - Image (Object Eraser): the same list.
- The icons `scissors`, `captions`, `audio-waveform`, `mic-vocal`, `scan-face`, `eraser`, `braces`, plus `play`, `pause`, `skip-back`, `skip-forward`, `repeat`, `brush`, `undo-2`, `redo-2`, `zoom-in`, `zoom-out`, `crop`, `type`, `languages`, `hash`, `clock`, `palette`, `regex`, `diff`, `key-round`, `binary`, `link`, `file-json` and `case-sensitive` are registered in `components/Icon.tsx` (P5 lesson: a missing icon silently falls back to a box).
- **Pre-cleanup on start:** delete everything under `<support>/tmp/eraser/` and cleanup previews older than 1 day (§6, §9).

### 3.10 Clipboard copy helper
- **Go:** `ClipboardService.CopyText(text string) error` writes text through the same path Clipboard History uses for its own copies, so the self-copy marker applies and the copy isn't recorded twice.
- **Frontend:** `lib/copy.ts` exports `copyText(text)`, which calls it, plus a toast "Copied".
- Every Copy button added in this phase uses it, and OCR's Copy text switches to it. This fixes P5 open issue "OCR Copy text has no self-copy marker".

### 3.11 Media UI kit (`frontend/src/components/media/`, built in Wave 1 by UI-M)
These are shared by Trimmer, Subtitles, Audio Cleanup, Lyric Video and Redact. Wave 0 creates the files with their final props, types and exports, and stub bodies.

- **`useMediaSource(path | null)`** returns `{status: "idle"|"loading"|"preparing"|"ready"|"error", source?: MediaSource, progress?: number, error?: AppError, retry()}`.
  - It calls `MediaService.Open`.
  - While a preview-copy job runs, it follows it through the jobs store ("Preparing a preview copy… 42%"), then re-opens.
  - When the path is cleared, it cancels nothing (the job keeps its cache value).
- **`<MediaPlayer>`** props: `{source, kind: "video"|"audio", onTime?(ms), onDuration?, overlay?: (rect: ContentRect) => ReactNode, className}`. The `ref` exposes `play() pause() toggle() seek(ms) step(frames) currentMs() playing()`.
  - **Video:** a `<video>` with our own controls: play/pause, the time as `TimecodeInput`, frame back/forward, volume, playback speed 0.25–2×.
  - **Audio:** cover art (Frame at 0 if `hasCover`) or a waveform, plus the same controls.
  - **`ContentRect`** is the letterboxed rectangle of the actual picture inside the element, recomputed on resize. Overlays position against it in 0..1 coordinates.
  - **Keys** (when the player or its tool has focus, not inside text inputs): Space play/pause; `,`/`.` one frame (at `info.video.fps`, else 1/30 s); Shift+`,`/`.` 1 s; ←/→ 5 s; Home/End.
  - Times reported are media times minus `info.startMs`. Seeking adds it back.
- **`<Timeline>`** props: `{durationMs, playheadMs, onSeek, filmstripUrl?, waveform?: number[], ranges?: Range[], onRangesChange?, selectedRange?, onSelectRange?, keyframes?: number[], markers?: Marker[], zoomable}`.
  - It draws the filmstrip or waveform track, the ranges with draggable start/end handles (snapping to the playhead within 6 px), the playhead, and markers (for subtitle cues and lyric lines).
  - Zoom: Ctrl+wheel. Horizontal scroll: wheel/Shift+wheel. A click seeks.
  - It is keyboard-accessible: a focused handle moves one frame with ←/→ (1 s with Shift).
- **`<BoxOverlay>`** draws boxes on a `ContentRect`: `{boxes: Box[]; onChange?; editable; drawMode}`, where `Box = {id, x, y, w, h (0..1), kind: "face"|"plate"|"manual", enabled, label?}`.
  - A click toggles `enabled`. Drag on an empty area draws a manual box (in `drawMode`). Corner handles resize the selected box. Delete removes a manual box.
  - Disabled boxes show dashed and dim; enabled ones show solid in the accent colour.
- **`<CropOverlay>`**: `{aspect: number; x: number; y: number; onChange}`. A draggable window of the given aspect at full height (or full width when the target is wider than the source), with the outside dimmed.
- **`<Waveform>`**: a canvas renderer used by Timeline and the audio player.
- **`<ABToggle>`**: an "Original | Cleaned" segmented control that swaps the source of a player and keeps the playhead and playing state.

---

## 4. Video Trimmer (`modules/trimmer`, ID `trimmer`)

### 4.1 Options
```go
type Mode string   // "fast" (stream copy) | "precise" (re-encode)
type Join string   // "merge" (one file) | "separate" (a file per segment)
type Aspect string // "keep" | "9:16" | "1:1" | "4:5" | "16:9"
type Segment struct { StartMs, EndMs int64 `json:"startMs"/"endMs"` }
type Options struct {
    Segments    []Segment `json:"segments"`    // 1–50
    Mode        Mode      `json:"mode"`
    Join        Join      `json:"join"`
    Aspect      Aspect    `json:"aspect"`
    CropX       float64   `json:"cropX"`       // 0..1, centre of the crop window
    CropY       float64   `json:"cropY"`
    MaxSizeMB   int       `json:"maxSizeMB"`   // 0 = none, else 1–4000
    MaxHeight   int       `json:"maxHeight"`   // 0 = keep, or 2160/1440/1080/720/480
    RemoveAudio bool      `json:"removeAudio"`
}
// DefaultOptions: no segments (the UI fills one covering the file), fast, merge, keep, centre, no limit.
```

**Validate:**
- Segments are sorted, don't overlap, are each ≥ 100 ms, and lie within the probed duration.
- `aspect ≠ keep`, `maxSizeMB > 0` or `maxHeight > 0` require `precise` ("Cropping, resizing and size limits need Precise mode").
- A crop needs a video stream. `removeAudio` on an audio-only file is an error.
- The size limit is checked against the total length: if the video bitrate would fall under 150 kbit/s, the error is "That's too long to fit in N MB; raise the limit or trim more".

### 4.2 Run
- **Fast:**
  - Each segment: `ffmpeg -ss <start> -to <end> -i <in> -map 0 -c copy -avoid_negative_ts make_zero -map_metadata 0 [-an]`.
  - Output: the input's container. `.ts`/`.mts`/`.m2ts` stay `.ts`, `.avi` and `.wmv` stay as they are, and audio files stay their type.
  - **Merge:** segments go to TempDir, then the concat demuxer (`-f concat -safe 0 -c copy`) writes the output.
  - Cuts land on the keyframe at or before `start`. The result's message says so when any cut moved by more than 0.5 s.
- **Precise:**
  - One FFmpeg run with a filter graph: `trim`/`atrim` + `setpts`/`asetpts` per segment, `concat` (or one run per segment for `separate`), then crop/scale, `libx264 -preset medium -crf 18 -pix_fmt yuv420p`, `aac -b:a 192k`, `+faststart`, MP4.
  - Audio-only input is re-encoded to its own family: mp3 → `libmp3lame -q:a 0`, m4a/aac → aac 256k, wav → pcm_s16le, flac → flac, ogg/opus → libopus 160k, others → m4a.
  - **Crop:** computed on display size. For a target narrower than the source: `h = H`, `w = even(H·a)`, `x = clamp(CropX·W − w/2)`. The wider case is symmetric with `CropY`.
  - **Max size:** two-pass x264. Video bitrate = `(MB·8·1024·1024·0.97 − audio·dur) / dur`. Pass logs live in TempDir.
- **Output names:** `<base> (trim).<ext>`, or `<base> (part N).<ext>` for separate files, made unique by the existing helper.
- **Progress:** the sum of segment durations is the total, fed through `media.ProgressTracker`.
- **Cancellation:** kills FFmpeg and leaves no output.

### 4.3 UI (`tools/trimmer/TrimmerView.tsx`)
**Empty state:** DropZone "Drop a video or audio file", plus Choose file.

**Loaded:**
- **Top:** `MediaPlayer`, filling the width. A `CropOverlay` appears when the aspect isn't Keep.
- **Below it:** `Timeline` with a 30-frame filmstrip (video) or waveform (audio), the segments as ranges, and keyframes drawn as ticks in fast mode when zoomed in enough.
- **Right panel, Segments:**
  - Rows show `#`, start and end `TimecodeInput`, duration, and delete. Clicking a row selects it and seeks to its start.
  - Buttons: "Set start (I)", "Set end (O)" (apply to the selected segment), and "Add segment (+)" (adds one from the playhead, 5 s long or to the end).
  - In fast mode, a row whose start moves to an earlier keyframe shows "starts 1.4 s earlier (keyframe)".
- **Right panel, Export:**
  - Mode as a SegmentedControl (Fast · no quality loss / Precise · re-encode) with a one-line hint each.
  - Join (shown when there are ≥ 2 segments).
  - Frame: Keep / 9:16 / 1:1 / 4:5 / 16:9. Choosing one switches to Precise and shows the toast "Switched to Precise — cropping re-encodes".
  - Size limit: None / 10 / 25 / 50 / 100 MB / Custom. Max height. Remove audio.
- **Footer:** a summary ("2 segments · 1:23 total · ≈ 34 MB") and an "Export" primary button (Ctrl+Enter).
  - **Estimate:** fast → source bytes × fraction kept; precise with a limit → the limit; precise without a limit → "size depends on the content".
- **States:**
  - Preparing a preview copy: a player placeholder with progress and the note "This format can't play in the app directly; making a preview copy. Your export uses the original."
  - Probe error: a Banner.
  - Job running: a progress row in the footer with Cancel.
  - Done: the result card (`FileActions`: Open, Show in folder, Send to…).
- Options persist through module state, but segments do not.

---

## 5. Subtitles (`modules/subtitles`, ID `subtitles`)

### 5.1 Options and actions
```go
type Action string // "generate" | "extract" | "save" | "translate" | "burn" | "embed"
type Cue struct { StartMs, EndMs int64; Text string } // json: startMs, endMs, text; Text may contain "\n" (max 2 lines)
type Style string  // "classic" | "boxed" | "yellow" | "minimal"
type Options struct {
    Action Action `json:"action"`
    // generate
    Model              string `json:"model"`    // "base" | "small" | "turbo" (Transcribe's presets)
    Language           string `json:"language"` // "" auto or a Transcribe language code
    TranslateToEnglish bool   `json:"translateToEnglish"`
    MaxLineChars       int    `json:"maxLineChars"` // 32–60, default 42
    MaxLines           int    `json:"maxLines"`     // 1 or 2, default 2
    // extract
    StreamIndex int `json:"streamIndex"`
    // save | translate | burn | embed
    Cues           []Cue    `json:"cues"`           // ≤ 20,000
    Formats        []string `json:"formats"`        // save: ≥ 1 of "srt","vtt"
    SourceLanguage string   `json:"sourceLanguage"` // translate: code or "" (unknown)
    TargetLanguage string   `json:"targetLanguage"` // translate: code from TranslationLanguages()
    Style          Style    `json:"style"`          // burn
    Size           string   `json:"size"`           // burn: "s" | "m" | "l"
    Position       string   `json:"position"`       // burn: "bottom" | "top"
    Font           string   `json:"font"`           // burn: from media.Fonts()
    TrackLanguage  string   `json:"trackLanguage"`  // embed: ISO 639-1 code or ""
}
```

**Input** (exactly one):
- generate, extract, burn and embed: the media file;
- save and translate: the media or subtitle file the cues belong to, used for naming.

**Validate:**
- per action, the fields it needs;
- cues sorted with `end > start`; text ≤ 500 chars;
- burn and embed need a video stream; extract needs a text subtitle stream.

**Service extras:**
- `Load(path) ([]Cue, error)` parses `.srt` or `.vtt`: UTF-8 with or without a BOM, otherwise Windows-1252 fallback; VTT tags are stripped and positions ignored.
- `TranslationLanguages() []Language` lists about 30 languages: Transcribe's list plus Bengali, Filipino, Swahili, Tamil and Urdu.
- `Styles() []StyleInfo`.

### 5.2 Generate (Go + `transcribe.run`)
1. `job.Tool(engine)`. Call `transcribe.run` with `{path, model, language, task, formats:["json"], vad:true, outDir: TempDir}` and map progress to 0–0.9.
2. Read the JSON. **Segment into cues** (`segment.go`, pure and table-tested):
   - **Words** come from `segments[].words`. A segment without words becomes one cue split by characters.
   - **Breaks are preferred, in order, at:** a sentence end (`. ? ! … 。 ？ ！`), then a pause ≥ 300 ms, then `, ; : 、 ，`, then the character limit.
   - **Limits:**
     - A cue holds ≤ `MaxLines` lines of ≤ `MaxLineChars` characters (CJK and Thai use 16 per line and break between characters).
     - A cue lasts ≤ 7 s and ≥ 1 s; short cues extend into the gap, keeping ≥ 80 ms before the next cue.
     - Reading speed: a cue over 20 chars/s extends into any gap.
   - **Line split:** the word boundary that best balances the two lines, preferring after punctuation. Otherwise one line.
3. Write `<base>.srt` (and `.vtt` when the user's formats include it). Result: `{language, cues, outputs}`. The UI loads the cues with `Load`.

**Extract:** `ffmpeg -i in -map 0:<idx> -c:s srt out.srt`, then the same result shape.

### 5.3 Save, translate
- **Save:** writes the given cues to `<base>.srt`/`.vtt` in `Subtitles/` (unique names). The UI keeps saving to the path it got the first time in a session by passing that path as the input; overwriting is allowed only when the input path is inside the module's own output folder **and** ends in `.srt`/`.vtt`. Inputs elsewhere are never modified.
- **Translate** (`translate.go`):
  - `textgen.Ready()` first; a missing model fails fast with the hint and a "Open Local Chat" action.
  - **Batching:** batches of up to 40 cues or 2,500 characters.
  - **Prompt:**
    - System: "You translate subtitles from {source or 'the original language'} to {target}. Translate each item; keep each one short enough to read on screen; keep line breaks (\n) where natural; keep names; never add notes."
    - User: the JSON array of strings, preceded by the previous batch's last 3 translated lines as context.
    - `JSONSchema`: an array of strings with `minItems = maxItems = n`. Temperature 0.2. `Purpose: "Translating subtitles"`.
  - **Recovery:** a reply that doesn't parse or has the wrong count is retried once. After that, that batch is translated cue by cue.
  - Timings are copied unchanged. Lines over the length limit are re-wrapped with the same line-split rule.
  - Output: `<base>.<target>.srt`. Progress is per batch, and cancel stops between batches (and cancels the request in flight).

### 5.4 Burn, embed
- **Burn:**
  - Write `subs.ass`:
    - `PlayResX/Y` = the video's display size.
    - Font size from Size: s/m/l = 4.5/5.5/6.5% of the shorter side, ×1.25 for portrait video.
    - Margins 6% of the height. Alignment 2 (bottom) or 8 (top).
  - **Styles:**

    | Style | Text | Outline | Box |
    |---|---|---|---|
    | classic | white | black outline 6% of the font size | no box |
    | boxed | white | — | BorderStyle 3, black at 55% |
    | yellow | `#FFE14D` bold | black outline | no box |
    | minimal | white | — | soft shadow, no box |

  - Encode: `ffmpeg -i in -vf ass=subs.ass -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p`. Audio is copied when it's AAC/MP3, else AAC 192k. Output `+faststart` MP4, `<base> (subtitled).mp4`.
- **Embed:**
  - `ffmpeg -i in -i subs.srt -map 0 -map 1 -c copy -c:s <codec> -metadata:s:s:<n> language=<iso639-2>`, where n is the new stream.
  - Codec by container: mp4/mov/m4v → `mov_text`; mkv → `srt`; webm → `webvtt`.
  - Other containers are remuxed into `.mkv`, with a hint.
  - Output `<base> (subs).<ext>`. Existing subtitle streams are kept.

### 5.5 UI (`tools/subtitles/SubtitlesView.tsx`)
The page has a stepper header: **Source → Edit → Translate → Export**. Each step is reachable once the previous one has produced cues.

1. **Source.** Drop a video, an audio file, or an `.srt`/`.vtt`.
   - For media there are three choices:
     - "Generate from speech": model, language, the "Translate to English" switch, and line options under "More";
     - "Use a subtitle file…";
     - "Use the subtitles inside this video": listed per text stream with its language and title.
   - For a subtitle file: pick a matching video (optional) to preview against.
   - Generation shows job progress inline, with Cancel.
2. **Edit.**
   - **Left:** the player (video) with the current cue drawn in an HTML overlay approximating the chosen burn style, and the Timeline with cue markers.
   - **Right: the cue list.** A windowed list for more than 200 cues. Each row has the index, start/end `TimecodeInput`, and a 2-line text area. Warnings show over 42 chars per line or 20 chars/s.
     - The current cue is highlighted while playing; clicking a row seeks.
     - Row menu: Split at cursor, Merge with next, Insert after, Delete.
   - **Toolbar:**
     - Shift all times (±ms with a stepper: "Subtitles are late by…"), Find & replace.
     - Undo/Redo (Ctrl+Z / Ctrl+Shift+Z, 100 steps), Save (Ctrl+S → `save` job).
     - Unsaved changes show a dot on the step and a confirm when leaving.
3. **Translate.**
   - The target language and the source language (prefilled from detection).
   - The model in use, from `TextGenerator.Ready` via `subtitles.Service.TranslatorStatus()`. If none: "Download a model in Local Chat to translate" with a button.
   - Translate → job progress → the translated cues open as a second tab in the Edit list ("Original | Spanish"). The export step uses the active tab.
4. **Export.**
   - Save as SRT / VTT.
   - **Add as a track** (with the "no quality loss, the player can turn them off" note) and a track language.
   - **Burn into the video:** style cards with a live mini preview (a still frame from `MediaService.Frame` with the HTML overlay), size, position and font.
   - Each export is a job with the result card.
   - Burn and embed need the source video; when the session started from a subtitle file without a video, these show "Pick the video".

Nothing about the editing session is persisted except through Save.

---

## 6. Audio Cleanup (`modules/audio-cleanup`, ID `audio-cleanup`)

### 6.1 Options
```go
type Denoise string  // "off" | "light" | "strong" | "voice"
type Hum string      // "off" | "auto" | "50" | "60"
type Loudness string // "off" | "podcast" | "streaming" | "broadcast"
type Format string   // "same" | "wav" | "flac" | "mp3" | "m4a"
type Options struct {
    HighPass       bool     `json:"highPass"` // 80 Hz rumble filter
    Hum            Hum      `json:"hum"`
    Denoise        Denoise  `json:"denoise"`
    Loudness       Loudness `json:"loudness"`
    Format         Format   `json:"format"`   // ignored for video inputs (container kept)
    Preview        bool     `json:"preview"`  // 10 s A/B excerpt instead of the whole file
    PreviewStartMs int64    `json:"previewStartMs"`
}
// DefaultOptions: high-pass on, hum auto, denoise voice, loudness podcast, format same.
```

**Loudness targets:**

| Target | Integrated | True peak | LRA |
|---|---|---|---|
| podcast | −16 LUFS | −1.5 dBTP | 11 |
| streaming | −14 LUFS | −1.0 dBTP | 11 |
| broadcast | −23 LUFS | −1.0 dBTP | 11 |

### 6.2 Run (`chain.go`, pure filter construction, table-tested)
1. Probe. A video input keeps its video stream (`-c:v copy`) and container; its audio is re-encoded (AAC 192k for MP4/MOV, Opus 160k for WebM/MKV).
2. **Hum `auto`:** decode 30 s from the middle to mono 4 kHz PCM. Goertzel energy at 50/100/150 and 60/120/180 Hz versus the ±8 Hz neighbours. Mains frequency F is picked when its fundamental is ≥ 10 dB above the neighbours; else no hum filter. The result reports what was found.
3. **Filter chain, in order:**
   - `highpass=f=80` (if on);
   - hum notches `bandreject=f=F·k:width_type=q:w=30` for k = 1..4;
   - denoise:
     - light = `afftdn=nr=12:nf=-50:tn=1`;
     - strong = `arnndn=m=std.rnnn`. The model is embedded with `//go:embed` from `modules/audio-cleanup/rnnoise/std.rnnn` (plus its BSD-3 `LICENSE`), copied into TempDir, and FFmpeg runs with TempDir as its working directory;
     - voice = DeepFilterNet3 on the engine, run as three steps:
       - **(a)** FFmpeg applies the high-pass and hum filters and writes 48 kHz f32 WAV (channels kept) to TempDir.
       - **(b)** `denoise.dfn3 {path, out, modelDir}` processes each channel in 30 s chunks with 1 s linear crossfades and writes WAV. It reports progress by chunk and checks cancellation between chunks. The implementation follows `dfn3_numpy.py` with no attenuation limit, in `toolbox_sidecar/dfn3.py` with `handlers/denoise.py`.
       - **(c)** The loudness passes and encode (and the video mux) run on that WAV.

       Without the engine or the model, Voice isolation shows the DepsGate. The view's default switches to Strong when the engine isn't installed. `DefaultOptions` keeps `voice`.
   - loudness: pass 1 runs the chain + `loudnorm=I:TP:LRA:print_format=json` to `-f null`; pass 2 runs the chain + `loudnorm` with the measured values and `linear=true`, then `aresample=48000` (44100 when the input is 44.1 kHz).
4. **Output:** `<base> (clean).<ext>`. Formats: same (WAV in → WAV out; lossy in → same codec at a high bitrate), or as chosen.
5. **Result:** `{files: [{input, output, lufsBefore, lufsAfter, humHz}]}`. Loudness is measured by the loudnorm passes, or by a final `ebur128` pass when loudness is off.
6. **Preview:**
   - Excerpts 10 s from `PreviewStartMs` of the original (decoded to WAV) and the cleaned version.
   - Both go to `<support>/cache/cleanup-preview/<jobID>-{a,b}.wav`, not the Library.
   - Result `{previewOriginal, previewCleaned, lufsBefore, lufsAfter, humHz}`.
   - Pruned at start (> 1 day) and when the tool view unmounts.

### 6.3 UI (`tools/audio-cleanup/AudioCleanupView.tsx`)
- FileToolLayout with the file list (batch).
- **Options panel:** Rumble filter (switch), Hum (Auto / 50 Hz / 60 Hz / Off), Noise reduction (Off / Light / Strong / Voice isolation (AI)), each with a one-line hint: Light = gentle FFT denoise, Strong = RNNoise, Voice isolation = DeepFilterNet (best for speech; needs the AI engine). Loudness target with the numbers. Output format (hidden when every input is video).
- **Preview card** (for the selected file):
  - Its waveform (MediaService.Waveform). Click to set the preview start (a 10 s band is drawn).
  - "Preview 10 s" → job → an `ABToggle` player and "−27.4 LUFS → −16.0 LUFS · hum 50 Hz removed".
  - Changing an option marks the preview stale ("Options changed — preview again").
- **Footer:** "Clean N files". The result table lists before/after loudness per file.
- **Voice isolation** without its model shows the DepsGate install buttons inline.

---

## 7. Lyric Video (`modules/lyric-video`, ID `lyric-video`)

### 7.1 Options and actions
```go
type Action string // "lyrics" | "render" | "preview" | "lrc"
type Source string // "detect" | "align" | "file"
type LyricWord struct { StartMs, EndMs int64; Text string }
type LyricLine struct { StartMs, EndMs int64; Text string; Words []LyricWord } // Words may be empty
type Look struct {
    Background     string `json:"background"`     // "blur-cover" | "cover" | "color" | "gradient" | "image" | "video"
    BackgroundPath string `json:"backgroundPath"` // image or video file for those backgrounds
    Color1, Color2 string `json:"color1"/"color2"`  // #rrggbb
    Font           string `json:"font"`           // media.Fonts()
    TextColor      string `json:"textColor"`
    HighlightColor string `json:"highlightColor"`
    Karaoke        bool   `json:"karaoke"`        // word-by-word fill
    Position       string `json:"position"`       // "center" | "lower"
    ShowNext       bool   `json:"showNext"`       // the next line dimmed under the current one
    Visualizer     string `json:"visualizer"`     // "none" | "wave" | "bars"
    TitleCard      bool   `json:"titleCard"`
    Title, Artist  string `json:"title"/"artist"`
}
type Options struct {
    Action     Action      `json:"action"`
    Source     Source      `json:"source"`     // lyrics
    Language   string      `json:"language"`   // lyrics: "" auto or a Transcribe code
    Text       string      `json:"text"`       // align: pasted lyrics, ≤ 20,000 chars
    LyricsPath string      `json:"lyricsPath"` // file: .lrc, .srt, .vtt or .txt (txt = align)
    Lines      []LyricLine `json:"lines"`      // render/preview: 1–2,000
    Look       Look        `json:"look"`
    Audio      string      `json:"audio"`      // "original" | "instrumental"
    Aspect     string      `json:"aspect"`     // "16:9" | "9:16" | "1:1"
    Height     int         `json:"height"`     // 720 | 1080 (the short side)
    PreviewStartMs int64   `json:"previewStartMs"`
}
```

The input is the song.

**Validate:**
- `detect`/`align`/`instrumental` need the engine (DepsGate);
- `file` needs `LyricsPath` to exist;
- `image`/`video` backgrounds need `BackgroundPath`;
- colours are `#rrggbb`;
- lines are sorted and non-overlapping.

### 7.2 Lyrics action (Go, `lyrics.go`, `align.go`, `lrc.go`; pure parts table-tested)
- **Vocals (detect, align):**
  - `stems.run` preset `vocals-fast` into the cache dir `<support>/cache/lyric-video/<sha1(path|size|mtime)>/` (Vocals + Instrumental FLAC). It's reused if present; this is progress 0–0.5.
  - Then `transcribe.run` on the vocals with `formats:["json"]`, model `small`, the language and `vad:true` (0.5–0.95).
- **detect:** words → lines.
  - A break happens at a Whisper segment boundary, a pause ≥ 600 ms, or > 8 words / 40 chars (16 for CJK).
  - A line's end is its last word's end, extended to ≤ the next line's start − 100 ms and at most +1.5 s.
- **align:** the user's text gives the lines (blank lines dropped).
  - **Tokens:** NFKC, lowercased, punctuation stripped.
  - **Alignment:** Needleman–Wunsch between the lyric tokens and the recognised words.
    - Match score is `2·(1 − lev(a,b)/max(len))`, counted as a match when ≥ 0.8 (normalised similarity ≥ 0.6).
    - Gap −1. Matched tokens take the word's times.
  - **Unmatched runs** are interpolated between their matched neighbours in proportion to character length. Leading and trailing runs extend at 0.3 s per word.
  - Result `matched` = matched tokens / all tokens. Under 0.4 the UI warns "Couldn't follow the song well — check the timings".
- **file:**
  - **LRC:** `[mm:ss.xx]` line tags (repeated tags duplicate the line), `[offset:±ms]`, and enhanced-LRC `<mm:ss.xx>` word tags.
  - **SRT/VTT:** cues become lines.
  - **TXT:** treated as `align`.
  - Words are spread over each line by character share when the file has no word times. No engine is needed except for TXT.
- The stems cache is pruned at start (folders untouched for > 7 days).
- **Result:** `{lines, matched, hasInstrumental}`. Lines are returned through the job result (this is the one place a result carries up to about 200 KB).

### 7.3 Render / preview action (`render.go`)
- **Canvas:**

  | Aspect | 1080 | 720 |
  |---|---|---|
  | 16:9 | 1920×1080 | 1280×720 |
  | 9:16 | 1080×1920 | 720×1280 |
  | 1:1 | 1080×1080 | 720×720 |

  All at 30 fps.
- **Background input:**
  - The cover art comes from the song (`-map 0:v:0 -frames:v 1` to `cover.png`). If there's none, the background falls back to `gradient` with a hint.
  - **blur-cover:** the cover is scaled to fill and cropped, with `gblur=sigma=40`, `eq=brightness=-0.12`.
  - **cover:** the same blurred fill plus the sharp cover:
    - 16:9: in the left third, 60% of the height, lyrics in the right two-thirds;
    - 9:16 and 1:1: at the top, 45% of the width, lyrics below.
  - **color:** a `color` source. **gradient:** a `gradients` source (vertical, Color1 → Color2).
  - **image:** fill + crop. **video:** `-stream_loop -1`, fill + crop, muted.
  - All looped to the song's length.
- **Visualiser:** `showwaves` (mode `cline`) or `showfreqs` (mode `bar`, log scale) of the song, in the highlight colour at 60%, a strip of 18% of the height at the bottom (above the lyrics when Position is lower).
- **ASS** via `core/media`:
  - One `Lyric` style: the font, size 6.5% of the shorter side (5.5% for lines over 30 chars), bold, outline 3% of the size, shadow 0, alignment 5 (centre) or 2 (lower, margin 14%).
  - **Karaoke** (and the line has words): `{\kf<cs>}` per word, with the gap before each word added to that word's duration. PrimaryColour = highlight, SecondaryColour = text.
  - **Without karaoke:** text colour, with `\fad(150,150)`.
  - **ShowNext:** a second event with the next line at 55% alpha, 80% size, one line below, during the current line.
  - **Title card:** title (larger) and artist, from 0 to `min(3 s, firstLine − 200 ms)`, faded.
- **Audio:** original, or the cached instrumental (made by the lyrics action, or now if missing).
- **Encode:** `libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -r 30`, AAC 192k, `-shortest`, `+faststart`.
- **Outputs:**
  - `<base> (lyric video).mp4`;
  - `<base>.lrc`, an enhanced LRC with word times when present (written by `lrc.go`).
- **Preview:** renders 10 s from `PreviewStartMs` (the same graph with `-ss`/`-t`, the ASS times shifted) to `<support>/cache/lyric-video/preview-<jobID>.mp4`. The result is `{previewPath}`, not a Library output.

### 7.4 UI (`tools/lyric-video/LyricVideoView.tsx`)
The steps are **Song → Lyrics → Look → Render**.

1. **Song.** Drop an audio file.
   - Shows the cover (Frame) and editable Title and Artist (from tags).
   - Audio: Original / Instrumental (karaoke) with "makes a vocals-free version on the AI engine".
2. **Lyrics.**
   - **Source** (SegmentedControl):
     - "Detect from the song";
     - "Paste lyrics" (a text area; recommended, with the hint "Paste the words and Toolbox times them to the song");
     - "From a file" (.lrc/.srt/.vtt/.txt).
   - Language select. "Get timings" → job progress.
   - **The sheet:** a row per line with its start time (`TimecodeInput`), text (editable), ±0.1 s nudge buttons, and play-from-here.
     - Edits that change a line's start shift its word times with it. Text edits re-spread the words.
     - Toolbar: Insert line, Delete, Shift all (±ms).
   - **Tap to sync:** plays from the start; Space stamps the current line's start and moves to the next; Backspace goes back a line; Esc ends.
   - Low-match warning Banner.
3. **Look.**
   - **Left:** a live HTML preview: the background (cover blurred via CSS filter, colour or gradient), the current and next line, and a karaoke fill done with a CSS gradient clip from word times. It is driven by an audio `MediaPlayer` and shown at the chosen aspect. A note says "Preview is approximate — Render preview shows the exact result."
   - **Right:** the aspect, the background (cards), colours (`ColorSwatchPicker`), font, text and highlight colours, Karaoke fill, Position, Show next line, Visualiser, Title card, and Quality (720p / 1080p).
4. **Render.**
   - "Render 10 s preview" from the current playhead → plays the exact clip in a player.
   - "Render video" → job progress → result card (video + `.lrc`).

The Look persists in module state. The lyric sheet lives in the view only. Its menu has "Export .lrc", which runs the action `"lrc"` (a fourth `Action` value): it writes only `<base>.lrc` from `Lines`, needs no engine, and ignores the look.

---

## 8. Redact (`modules/redact`, ID `redact`)

### 8.1 Options
```go
type Action string      // "detect" | "apply" | "auto" (detect + apply, no review)
type Style string       // "blur" | "pixelate" | "solid"
type Sensitivity string // "normal" | "high"
type Box struct {       // coordinates 0..1 of the upright (EXIF-rotated / display-rotated) frame
    ID      string  `json:"id"`
    X, Y, W, H float64 `json:"x"/"y"/"w"/"h"`
    Kind    string  `json:"kind"`    // "face" | "plate" | "manual"
    Enabled bool    `json:"enabled"`
    Score   float64 `json:"score"`
}
type TimedBox struct { Box; StartMs, EndMs int64 } // manual boxes in a video
type Options struct {
    Action        Action      `json:"action"`
    Faces, Plates bool        `json:"faces"/"plates"`
    Sensitivity   Sensitivity `json:"sensitivity"`
    Style         Style       `json:"style"`
    Strength      int         `json:"strength"`      // 1–10, default 6
    Padding       int         `json:"padding"`       // % added around each box, 0–50, default 15
    StripMetadata bool        `json:"stripMetadata"` // default true
    // apply, images: input path → its boxes (only enabled ones are drawn)
    ImageBoxes map[string][]Box `json:"imageBoxes"`
    // apply, video
    DetectionsPath string     `json:"detectionsPath"`
    DisabledTracks []string   `json:"disabledTracks"`
    ManualBoxes    []TimedBox `json:"manualBoxes"`
}
// DefaultOptions: faces + plates, normal, blur, 6, 15 %, strip metadata.
```

**Inputs:** 1–100 images, or exactly one video (mixing gives "Redact images and videos separately").

**Validate:**
- at least one of faces/plates for detect/auto;
- apply needs boxes for every input (images) or `DetectionsPath` inside `<support>/cache/redact/` (video).

**Thresholds** (face / plate):
- normal: 0.6 / 0.3;
- high: 0.45 / 0.2.

**Presets** (`ModelProvider`): `faces` and `plates` (§0.4) in `<models>/redact/`. A missing model shows the DepsGate; `auto`/`detect` fetch nothing silently.

### 8.2 Engine (`handlers/redact.py`, `toolbox_sidecar/redact/{detect,track,render}.py`)
- **`redact.detect_image {path, faces, plates, sensitivity, faceModel, plateModel}`** → `{width, height, boxes}`.
  - Loads with Pillow (HEIC through pillow-heif) and applies `exif_transpose`.
  - **Faces:** YuNet with the in-memory dynamic-shape patch at two scales (long side 640, and min(1920, the long side)), padded to multiples of 32. Decoded as in §0.4, NMS 0.3 across scales.
  - **Plates:** YOLOv9-t on the letterboxed whole image. Images with a long side > 1280 are also run in 2×2 tiles with 20% overlap. Merged with NMS 0.5.
  - Boxes are returned normalised.
- **`redact.detect_video {path, ffmpeg, faces, plates, sensitivity, faceModel, plateModel, cachePath}`**:
  - **Decoding:** FFmpeg on a pipe (`-vf fps=min(src,15),scale=<long side 1280>`, rawvideo bgr24); frame times come from the sample rate.
  - **Detection** on every sampled frame: faces at one scale (the 1280 frame), plates letterboxed.
  - **Tracker** (`track.py`, pure):
    - Greedy matching by IoU ≥ 0.3, or a centre distance < 0.5 × box diagonal.
    - A track ends after 0.5 s without a hit; gaps up to that are linearly interpolated.
    - Positions are smoothed with an EMA (α 0.6), and each track is extended by 200 ms at both ends.
    - Tracks with < 3 hits are returned with `enabled: false` (likely false positives) unless their max score ≥ 0.9.
  - **Writes** `cachePath` as JSON `{width, height, fps, tracks: [{id, kind, hits: [{ms, x, y, w, h, score}]}]}`.
  - **Returns** `{width, height, durationMs, tracks: [{id, kind, startMs, endMs, maxScore, enabled, samples: [{ms, x, y, w, h}]}]}`, sampled every 200 ms for the UI.
  - Progress is per frame.
- **`redact.apply_image {path, out, boxes, style, strength, padding, stripMetadata}`**:
  - Each enabled box grows by `padding`.
  - Faces use an elliptical mask with a 4 px feather; plates and manual boxes are rectangles.
  - **Styles:**
    - blur: Gaussian, σ = (0.04 + 0.016·strength) × the box's shorter side, applied twice, so it can't be reversed in practice;
    - pixelate: block = shorter side / (16 − strength);
    - solid: black.
  - Writes the same format (JPEG q95, PNG, WebP q95, TIFF → PNG, HEIC → JPEG).
  - With `stripMetadata`, no EXIF/XMP/IPTC is written (the ICC profile is kept). Otherwise EXIF is copied minus GPS.
- **`redact.apply_video {path, ffmpeg, out, detectionsPath, disabledTracks, manualBoxes, style, strength, padding, stripMetadata}`**:
  - **Decoding:** full resolution on a pipe (`-fps_mode passthrough`, rawvideo bgr24, autorotated).
  - Boxes for each frame's time are interpolated from the track hits; manual boxes apply between their times.
  - **Encoding:** a second FFmpeg (`-f rawvideo -s WxH -r <avg fps> -i - -i <original> -map 0:v -map 1:a? -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p`). Audio is copied (AAC 192k if it can't go in MP4). `-map_metadata -1` when stripping, `+faststart`, MP4.
  - Progress is per frame. Cancel kills both FFmpeg processes and deletes the partial output.
- **`redact.prefetch {model: {file, url, sha256}, modelDir}`**, same contract as `bgremove.prefetch`.
- Outputs are `<base> (redacted).<ext>`.
- **Go:**
  - **detect:** puts the video's cache file at `<support>/cache/redact/<jobID>.json`, sets `job.SetResult`, registers no outputs. The cache is pruned at start (> 7 days).
  - **auto:** detect → apply, using the default `enabled` flags.

### 8.3 UI (`tools/redact/RedactView.tsx`)
- **Banner** (always visible): "Detection can miss faces and plates. Check every image or frame before sharing."
- **Options panel:** Find faces, Find number plates, Sensitivity, Style (three small preview tiles), Strength, Padding, Remove location and camera info (on).

**Images:**
- Dropping images runs `detect` on all of them in one job.
- **One image:** opens the review straight away.
  - **Left:** the image (`MediaService.URLFor`, fit to the panel), with `BoxOverlay` and a live approximate effect (a canvas preview of blur/pixelate/solid inside the enabled boxes).
  - **Right:** the detection list (kind icon, score, toggle), Add box (draw mode, `B`), and Delete.
  - Footer: "Save redacted".
- **Several images:** a gallery grid with a "3 faces · 1 plate" count per image. Click → review that image (with prev/next and the arrow keys). "Redact all N" applies the current boxes for every image; reviewed images are marked ✓.
- Edits live in the view until applied.

**Video:**
- A `detect` job (progress, Cancel).
- **Then the review:**
  - `MediaPlayer` with `BoxOverlay` showing each enabled track's box at the current time (interpolated from samples) and the manual boxes.
  - `Timeline` with track spans as markers.
  - **Track list:** kind, start–end, max score, toggle; clicking seeks to its start.
  - **Add box:** draw on the current frame → a manual box from now for 3 s, with start/end `TimecodeInput`s in the list (`I`/`O` set them to the playhead).
- "Redact video" → apply job → a result card with a player of the output.

**DepsGate** when the engine or models are missing (with the Image pack button).

### 8.4 Acceptance
- On `STS-125_crew_portrait.jpg` all 7 faces are found at Normal.
- On the car-park photo all 3 plates are found at Normal (at High, if Normal misses a distant one, record which in DECISIONS.md).
- Applied outputs: no pixel changes outside the padded boxes (for PNG), and `exiftool` shows no GPS or camera tags with Remove on.
- **Video:** on a generated 10 s clip of the crew-portrait face crop moving across `testsrc2` (`overlay=x=t*120`), the redacted output has the face covered on every 10th frame checked (the face crop's mean colour isn't visible inside its known position).
- A 1-minute 1080p30 clip: detect ≤ 90 s and apply ≤ 3 min on this machine's CPU.
- A manual box covers exactly its time range. Cancel leaves no output.

---

## 9. Object Eraser (`modules/object-eraser`, ID `object-eraser`)

### 9.1 Options and service
```go
type Model string // "best" (LaMa) | "fast" (MI-GAN)
type Options struct {
    Model    Model  `json:"model"`
    MaskPath string `json:"maskPath"` // set by the service; never from the UI
}
// DefaultOptions: best.
```

**`eraser.Service` (bound):**
- `Defaults()`.
- `ModelStatus() []ModelInfo` with id, label, downloadBytes, present.
- `Erase(input string, maskPNG string, opts Options) (core.Job, error)`:
  - `maskPNG` is base64 PNG data from the canvas: white = erase, any size with the image's aspect ratio (±1%).
  - Go decodes and validates it: a PNG, ≤ 8192 px, not empty (otherwise "Paint over what to erase first").
  - It writes it to `<support>/tmp/eraser/<random hex>.png` (0600), sets `MaskPath`, and submits.
- **`Validate`** rejects a `MaskPath` outside `<support>/tmp/eraser/`.
- **`Run`** deletes the mask file when it finishes (defer), in every outcome.
- `<support>/tmp/eraser/` is emptied at app start.

### 9.2 Engine (`handlers/eraser.py`, `toolbox_sidecar/eraser.py`)
**`eraser.inpaint {path, mask, out, model, modelPath}`:**
1. Load the image (`exif_transpose`, HEIC through pillow-heif; keep the ICC profile and EXIF minus orientation). Load the mask, resize nearest to the image, threshold > 127.
2. Dilate by `round(12 × longSide / 1024)` px (min 8, max 40). Reject an empty mask. More than 35% of the image sets `warning: "Large areas may look smeared"` in the result.
3. **best (LaMa):**
   - Split the dilated mask into connected regions and merge regions whose crops overlap.
   - For each region: a square crop of side `max(512, 2 × max(bbox w, h))`, centred on the bbox and shifted to stay inside the image (smaller images use the whole image padded by reflection to square).
   - Resize to 512 (area) with the mask nearest, run, and take the output (0..255) back to the crop size (Lanczos).
   - Composite only inside the dilated mask, feathered with a Gaussian of 3 px at crop scale.
   - Regions run sequentially, each on the updated image. Progress is per region; cancellation is checked between regions.
4. **fast (MI-GAN):** run the pipeline on the full image with the mask inverted (255 = keep), then composite with the same feather.
5. Write the same format (JPEG q95, PNG, WebP q95, TIFF/BMP → PNG, HEIC → JPEG) to `<base> (erased).<ext>`.

**Result:** `{regions, warning}`.

**`eraser.prefetch`** follows the bgremove contract. The presets are `best` and `fast` (§0.4) in `<models>/eraser/`.

### 9.3 UI (`tools/object-eraser/ObjectEraserView.tsx`)
**Empty state:** DropZone "Drop a photo".

**Editor:**
- **Canvas:** the image (`MediaService.URLFor`) on a canvas fitted to the panel. Zoom with Ctrl+wheel or the buttons (fit, 100%); pan with Space+drag or the middle button.
- **Mask:** painted on an offscreen canvas at the image's size, capped at 4096 px on the long side (scaled). It's shown as the accent colour at 45% over the image.
- **Tools:**
  - Brush (`B`) and Unpaint (`E`, or hold Alt);
  - brush size 4–300 screen px (`[` / `]`), with the cursor drawn as a circle;
  - Clear (`Ctrl+Backspace`), Undo/Redo per stroke (Ctrl+Z / Ctrl+Shift+Z, 50 steps);
  - Model: Best / Fast, with sizes and download state.
- **"Erase"** (Enter, enabled when the mask isn't empty) calls `Erase` with the mask as PNG data. A progress overlay with Cancel appears. When it's done, the canvas shows the result with a "Before / After" `CompareSlider` toggle and `FileActions`. A warning shows as a toast.
- **"Keep erasing"** makes the output the new input (the mask is cleared); each round saves a new file.
- Without the engine or model: DepsGate. The model-size hint: "Best · 208 MB · Fast · 28 MB".

### 9.4 Acceptance
- Erasing a person painted roughly on the crew portrait (or a lamp post on a car photo) leaves no dark ghost or visible seam at normal zoom (screenshot in the summary).
- Pixels outside the dilated mask are byte-identical in PNG output.
- A 12 MP photo with one object completes in < 10 s on CPU (best).
- The mask file is gone after the job, whether it succeeded, failed or was cancelled.

---

## 10. Dev Utilities (`modules/dev-utils`, ID `dev-utils`)

### 10.1 Backend
- A normal module whose only job is **hashing files**: `Options{Algorithms []string /* md5, sha1, sha256, sha512, crc32 */}`, inputs 1–100 files, `SplitInputs: false`.
- It streams each file once through all the chosen hashes (`io.MultiWriter`), with progress by bytes and cancellation between 1 MiB reads.
- Result: `{files: [{path, size, hashes: {algo: hex}}]}`. It has no outputs.
- **Service (bound):**
  - `Defaults()`, `Enqueue(inputs, opts)`;
  - `HashText(text string) []HashResult` (all five algorithms, UTF-8);
  - `FileBase64(path string) (string, error)` (≤ 10 MiB, else a validation error);
  - `PickFiles() ([]string, error)` (multi-select through the existing dialog helper).

### 10.2 UI (`tools/dev-utils/DevUtilsView.tsx`)
- A left list of utilities (with search); the last one used is remembered in module state.
- Each utility is its own component under `tools/dev-utils/utils/`, with pure logic in `*.logic.ts` files that are unit-tested.
- Inputs live-update outputs (debounced 150 ms). Every output has a Copy button (§3.10).

| Utility | Does |
|---|---|
| JSON | Format (2/4 spaces, tab), minify, sort keys, validate with `line:col` and the caret on the error, JSON ↔ YAML |
| Base64 | Text encode/decode (UTF-8, URL-safe toggle, padding toggle); file → Base64 or data URL |
| URL | Encode/decode a component; parse a URL into parts and an editable query table that rebuilds it |
| Hash | Text: MD5, SHA-1, SHA-256, SHA-512, CRC32 (via `HashText`). Files: pick or drop → hash job → table; a "Compare" field highlights the matching value |
| UUID | v4 and v7, ULID; count 1–1,000; upper/lower case; Copy all |
| JWT | Decode header and payload (pretty JSON); `exp`/`iat`/`nbf` as local time with "expired" / "not yet valid" badges. It never verifies; the note says "Decoded locally — nothing leaves this computer" |
| Time | Unix s/ms/µs ↔ ISO 8601 UTC, local, and relative ("in 3 hours"); a time-zone picker (`Intl`); Now |
| Numbers | Decimal / hex / octal / binary (BigInt); bit width 8–64 with a two's-complement view |
| Colour | Hex / RGB / HSL / OKLCH conversion with a swatch; WCAG contrast ratio of two colours with AA/AAA badges |
| Regex | Pattern + flags, test text with highlighted matches, a groups table, a replace preview (JavaScript flavour, stated) |
| Diff | Two texts → line diff (Myers, in TS), unified or side by side, ignore whitespace / case |
| Text | Case conversions (camel, Pascal, snake, kebab, CONSTANT, Title, lower, UPPER), slugify, counts (chars, words, lines, UTF-8 bytes), sort / dedupe / trim lines |

- **Palette commands:** "Dev Utilities: <name>" for each utility.

---

## 11. Phase 5 follow-ups

| # | Issue (P5 summary) | Fix |
|---|---|---|
| F1 | A conversation reopened while an answer streams shows the partial answer as finished | `ConversationView` marks the message `streaming` when it is the running generation's message; the view subscribes to its deltas |
| F2 | OCR Copy text has no self-copy marker | §3.10 |
| F3 | The vault index restored from `.bak` isn't shown | `VaultState.notice` ("The vault index was restored from its backup copy") shown once as a Banner after unlock |
| F4 | Setup cards scroll slightly at the default window height | Tighten the card's vertical rhythm so the six cards fit at the default 1100×720 window with no vertical scroll |
| F5 | The ffprobe row lacks managed actions | Settings → Dependencies shows ffprobe as "Installed with FFmpeg" with no separate buttons |
| F6 | Chat uses GiB while packs use GB | Chat's sizes switch to the shared decimal `formatSize` |

---

## 12. Bound API changes (summary)
- **New:**
  - `MediaService` (§3.4);
  - `trimmer.Service` (`Defaults`, `Enqueue`);
  - `subtitles.Service` (`Defaults`, `Enqueue`, `Load`, `TranslationLanguages`, `Styles`, `TranslatorStatus`);
  - `audiocleanup.Service` (`Defaults`, `Enqueue`);
  - `lyricvideo.Service` (`Defaults`, `Enqueue`, `Fonts`);
  - `redact.Service` (§8);
  - `eraser.Service` (§9);
  - `devutils.Service` (§10.1).
- **Changed:** `ClipboardService.CopyText` (§3.10); `VaultState.notice` (F3).
- **Not bound:** `core.TextGenerator` (Go only); the `/media/` middleware.

---

## 13. Test plan

**Go**
- `core/media`:
  - `Probe` parsing on recorded ffprobe JSON fixtures: rotation from the display matrix, SAR, `start_time`, an attached picture not counted as video, text vs image subtitle codecs.
  - `Playable` table per OS.
  - `ProgressTracker` (moved tests).
  - The ASS writer: escaping, colours, times, a golden file.
  - `Keyframes` against a fake ffprobe (re-exec helper).
- **Media route** (`api/media_test.go`, httptest against the middleware):
  - unknown token 404; HEAD;
  - `bytes=0-` capped at 4 MiB with the right `Content-Range`; `bytes=a-b` exact; suffix `-n`;
  - 416; no Range on small and large files; method 405; a deleted file 404;
  - the content types.
- `MediaService`: the proxy decision (playable / cached / running / new) with a fake jobs submitter; cache key changes with mtime; the 5 GB prune is oldest-first; Waveform peaks from a fake FFmpeg producing a known PCM ramp.
- `modules/chat`:
  - `Complete` against the fake llama-server: response_format passed through, the slot taken and released per request, ctx cancel aborts;
  - an interactive Send waits for a background completion and then runs; priority over a queued background request;
  - `Ready` errors when nothing is downloaded.
- `modules/trimmer`: Validate matrix; fast-mode argument building (per container, merge via concat list, `-an`); precise filter graph for 1/3 segments, crop maths for each aspect on landscape and portrait sources, two-pass bitrate maths and the "too long" error; audio-only codec families; a `Run` against a fake FFmpeg (outputs registered, names, cancel leaves nothing).
- `modules/subtitles`:
  - `segment.go` tables: sentence and pause breaks, char limits, CJK, min/max duration, reading speed, line balancing;
  - SRT/VTT writers and `Load` (BOM, CRLF, 1252 fallback, VTT tags, hours > 99 min);
  - translate batching, schema, the count-mismatch retry and per-cue fallback (fake `TextGenerator`), re-wrapping;
  - burn ASS styles (golden); embed codec per container and the stream index;
  - the Save overwrite rule (only own `.srt`/`.vtt` in the output folder).
- `modules/audio-cleanup`: filter chain building per option set; loudnorm JSON parsing; Goertzel hum detection on generated 50/60 Hz tones + noise, and none on clean noise; the preview paths and pruning; video keeps `-c:v copy`.
- `modules/lyric-video`:
  - line building from words; alignment (exact, misheard words, missing and extra words, all unmatched, CJK);
  - LRC parse/write (enhanced tags, offsets, repeated tags), SRT → lines;
  - ASS for karaoke, plain, show-next and title card (golden);
  - background filter graphs per background × aspect; the cache key.
- `modules/redact`, `modules/object-eraser`: Validate; params passed to the fake Caller; the mask file written 0600 and deleted after Run; results decoded.
- `modules/dev-utils`: hashes on known vectors (empty, "abc", a 3 MiB file), cancel mid-file, `FileBase64` limit.
- `core/packs`: the new components and unlocks; `TestEveryToolIsInOnePack`; sizes non-zero.
- **Engine e2e** (`integration/engine_test.go`), extended:
  - `redact.detect_image` on a generated image with a pasted face crop from a CC0 sample in `.dev/p6-research/samples` (skip if absent) and a rendered plate;
  - `eraser.inpaint` on a generated image with a painted square (the masked area changes, pixels outside the dilated mask are unchanged).
- **Integration** (`//go:build integration`, real FFmpeg):
  - trimmer fast + precise on a generated 10 s test clip (`testsrc2` + `sine`): durations within one frame (precise) or one GOP (fast);
  - subtitles burn + embed (the stream exists in ffprobe);
  - audio cleanup on pink noise + 50 Hz hum + a tone: the result measures within ±1 LU of −16;
  - lyric video render of 5 s.

**Python**
- `test_redact.py`: box decoding/NMS on synthetic outputs, the IoU tracker (linking, gap interpolation, padding, track filtering), blur/pixelate/solid only change pixels inside boxes, EXIF orientation applied, metadata stripped, cancellation.
- `test_eraser.py`: mask region splitting and the crop/resize/paste-back maths (with a stub model that returns a constant colour), feathering stays inside the dilated mask, the ICC profile is kept.
- `test_denoise.py`: chunking and crossfade maths (a stub model that returns unity gain reproduces the input within −60 dB), multichannel handling, cancellation between chunks; the slow test runs the real model on `schumer_pd.ogg` + noise and checks SI-SDR improves by ≥ 4 dB.
- `test_prefetch.py` additions for the new presets (incl. the DFN3 tarball extraction keeping only the three `.onnx` files).
- Slow tests (`TOOLBOX_SLOW=1`): the real models on the samples.

**Frontend**
- The media kit:
  - `useMediaSource` state machine with mocked service and jobs (playable, proxying → ready, error);
  - Timeline range dragging and snapping, keyboard handles, zoom maths;
  - BoxOverlay draw/toggle/resize/delete;
  - CropOverlay clamping; ABToggle keeping the time.
- Trimmer: I/O keys set segments, overlap prevention, the fast-mode keyframe note, the mode auto-switch with its toast, the estimate text.
- Subtitles: editor ops (split, merge, insert, delete, shift all, find & replace, undo/redo), warnings, the step gating, the translate-unavailable state, the Original | Translation tabs.
- Audio Cleanup: the preview stale marker, the result table.
- Lyric Video: tap to sync (Space, Backspace, Esc), nudge shifting words, the karaoke CSS progress from word times, the low-match Banner.
- Redact: §8 UI states. Object Eraser: §9 UI states.
- Dev Utilities: every `*.logic.ts` (JSON errors with line:col, YAML round-trip, Base64 URL-safe/padding, URL rebuild, UUID v7 ordering/format, ULID format, JWT decode and badges, time conversions incl. ms/µs detection, number bases with BigInt and two's complement, colour conversions and contrast, regex groups, Myers diff, case conversions).
- F1–F6 regressions.

**Manual smoke (architect, Windows, sandboxed, passive screenshots only):**
- Trimmer on an MP4 and on an MKV (preview copy).
- Subtitles generate → edit → translate to Spanish with Qwen3-4B (if free RAM allows) → burn and embed.
- Audio Cleanup preview + full on a noisy voice recording.
- Lyric Video with pasted lyrics on a CC-licensed song from `.dev/p6-research/samples` (if none is available, a generated voice clip) → render.
- Redact on the sample photo and a short clip.
- Object Eraser on the sample photo.
- Dev Utilities: a quick pass of each utility.
- Media route memory: play and seek a ≥ 1 GB file; the app's working set stays within +200 MB.

---

## 14. Work packages

### Wave 0: foundation (architect)
1. Archive P5's spec (done) and update `docs/ROADMAP.md` (Phase 6 marked in progress).
2. `core/media`: types, `Probe`, `Keyframes`, `Playable`, `ProgressTracker` (moved, converter rewired), the ASS writer, `Fonts`, with tests. `core/proc` `Dir` if missing.
3. `core/textgen.go` (interface only). `ClipboardService.CopyText` + `lib/copy.ts`.
4. `MediaService` signatures and the route middleware wired in `main.go` with a stub (404).
5. Module stubs (§3.9) with final options, descriptors, `Validate` and services; `main.go` wiring; placeholders unchanged.
6. The packs catalog (§3.8) with measured sizes for the new models; `BuiltIn += dev-utils`.
7. Engine 0.6.0: the explicit OpenCV dep, `uv lock` (macOS arm64 wheels unchanged), handler stubs and prefetch stubs.
8. Bindings, `lib/api.ts` re-exports, tool view stubs, the media kit stubs (§3.11 props and types), and the icons.
9. CLAUDE.md: a Phase 6 section (the media route rule: no socket, token LRU, 4 MiB cap; preview copies never used for outputs; `TextGenerator` sharing; caches and their prune). `docs/MAC-CHECKLIST.md`: Phase 6 steps.

### Wave 1 (parallel)

| WP | Owns | Acceptance |
|---|---|---|
| **MD1 Media backend** | `api/media.go` (+ tests), the `media-proxy` module, the cache dirs and prune | §3.2, §3.4; Go tests |
| **TG1 TextGenerator** | `modules/chat/complete.go` (+ tests), the slot-priority change in `generate.go`, `chat:status` busy text, the composer busy line in `tools/chat/**`, plus F1 and F6 | §3.5, F1, F6; Go + FE tests |
| **TR1 Trimmer backend** | `modules/trimmer/**` (except frozen files) | §4.1–4.2; Go + integration tests |
| **SB1 Subtitles backend** | `modules/subtitles/**` (except frozen files) | §5.1–5.4; Go + integration tests |
| **AC1 Audio Cleanup** | `modules/audio-cleanup/**`, `tools/audio-cleanup/**`, `sidecar/.../handlers/denoise.py`, `toolbox_sidecar/dfn3.py`, `sidecar/tests/test_denoise.py` | §6; Go + FE + integration tests |
| **LV1 Lyric Video backend** | `modules/lyric-video/**` (except frozen files) | §7.1–7.3; Go + integration tests |
| **RD1 Redact backend** | `modules/redact/**`, `sidecar/.../handlers/redact.py`, `toolbox_sidecar/redact/**`, `sidecar/tests/test_redact.py` | §8 backend; Go + pytest (+slow) |
| **ER1 Eraser backend** | `modules/object-eraser/**`, `sidecar/.../handlers/eraser.py`, `toolbox_sidecar/eraser.py`, `sidecar/tests/test_eraser.py` | §9 backend; Go + pytest (+slow) |
| **DU1 Dev Utilities** | `modules/dev-utils/**`, `tools/dev-utils/**`, the palette entries for it | §10; Go + FE tests |
| **UI-M Media kit** | `frontend/src/components/media/**` | §3.11; FE tests |
| **FX1 P5 follow-ups** | F2 (OCR switch to `copyText`), F3, F4, F5: `tools/ocr/**` copy call, `modules/vault` notice + `tools/vault/**`, `views/setup/**`, the Settings dependency rows | §11; tests |

### Wave 2 (parallel, after UI-M and each tool's backend are merged)

| WP | Owns | Acceptance |
|---|---|---|
| **UI-TR Trimmer UI** | `tools/trimmer/**` | §4.3 |
| **UI-SB Subtitles UI** | `tools/subtitles/**` | §5.5 |
| **UI-LV Lyric Video UI** | `tools/lyric-video/**` | §7.4 |
| **UI-RD Redact UI** | `tools/redact/**` | §8 UI |
| **UI-ER Eraser UI** | `tools/object-eraser/**` | §9 UI |

Each Wave 2 package also adds its palette entries in a marked block of `shell/useBuiltinCommands.ts` (one block per package, created empty in Wave 0, to avoid conflicts).

### Wave 3: integration (architect)
Merge, regenerate bindings, run all checks, the engine e2e, the integration tests and `wails3 build`. Install the Image pack's new models in a sandbox and measure the disk use against the catalog (±10%). Then the manual smoke from §13, DECISIONS.md, and the summary.

---

## 15. Acceptance criteria
1. **Media route:**
   - Videos and audio play and seek in the app with no listening socket (checked with `netstat`: only llama-server, and only while chat runs).
   - Responses never exceed 4 MiB. Playing a 1 GB file keeps the working set within +200 MB.
   - Unplayable files get a preview copy automatically, and exports use the original.
2. **Video Trimmer:**
   - Fast mode cuts an MP4 in about a second with no re-encode, and the merge of 2 segments plays through.
   - Precise mode is frame-accurate (± one frame).
   - 9:16 reframing and "under 50 MB" produce a file ≤ 50 MB at 9:16.
3. **Subtitles:**
   - Generating from a talking-head clip gives readable cues (≤ 2 lines of ≤ 42 chars, ≤ 7 s).
   - Edits save to `.srt`.
   - Translation to Spanish with the local model keeps every cue's timing.
   - Embedding adds a toggleable track without re-encoding; burning in renders the chosen style.
4. **Audio Cleanup:**
   - Podcast target lands within ±1 LU of −16 LUFS with true peak ≤ −1.5 dBTP.
   - Hum auto-detects 50/60 Hz on the test signal.
   - The preview A/B swaps without losing position.
   - Video inputs keep their video stream bit-identical (`-c:v copy`).
5. **Lyric Video:**
   - Pasted lyrics align to a sung test song with lines starting within ~0.5 s of the vocals on most lines; tap-to-sync and nudge fix the rest.
   - The render shows the karaoke fill and plays in sync. 9:16 and cover backgrounds work.
   - The instrumental option removes the vocals.
6. **Redact:** §8.4.
7. **Object Eraser:** §9.4.
8. **Dev Utilities:** every utility in §10.2 works offline; file hashes match `certutil`/`shasum` for a test file; copies don't duplicate in Clipboard History.
9. **Packs:**
   - Every new tool is on exactly one pack card (Dev Utilities built in).
   - Installing the Image pack in a fresh sandbox makes Redact and Object Eraser ready; disk use is within ±10% of the cards.
10. **Follow-ups F1–F6** are fixed.
11. All checks are clean (`go vet`, `go test`, pytest, `npm run check`, gofmt, darwin cross-vet), the engine e2e passes, `docs/MAC-CHECKLIST.md` has the Phase 6 steps, and DECISIONS.md is updated.

## 16. Risks
- **WKWebView and range requests from a custom scheme** (macOS) aren't verified here. If AVFoundation refuses to stream from the scheme handler, the fallback is to serve the preview-copy route with the full file for files ≤ 64 MiB and otherwise show the player as unavailable with the export still working. This is on the Mac checklist as step 1.
- **The 4 MiB cap** relies on Chromium asking for the next range itself, which is standard behaviour (*docs only*). The media-route acceptance test checks it on WebView2.
- **Whisper on singing** is much weaker than on speech, even on isolated vocals. That's why "Paste lyrics" is the recommended source (alignment tolerates misheard words), with tap-to-sync and nudges as the fallback.
- **Small local models translating subtitles:**
  - Qwen3-4B is fine for major languages and weaker for low-resource ones.
  - At ~80 tok/s, a 1-hour film (~800 cues) takes about 3–5 minutes on the GPU and much longer on CPU. The job shows progress per batch and can be cancelled.
  - The JSON schema keeps the cue count right.
- **Redaction is best effort.** Detectors miss small, blurred or side-on faces and odd plates. The review step is the default for single files, the UI says "Check every frame before sharing", and manual boxes cover misses.
- **The plate detector's weights have no stated licence** (code MIT; trained with a GPL-3.0 fork). For a personal, never-distributed app this is acceptable; DEIMv2-nano (MIT, slightly less sensitive) is the drop-in fallback if that changes.
- **Inpainting** works well for small and medium objects and poorly for large areas or structured backgrounds; the UI says so, and erasing again on the result is supported.
- **Font fallback** for non-Latin subtitles and lyrics depends on the OS's fonts through libass. Verified on Windows for Latin only; the Mac checklist has a CJK case.
- **Cache growth:** preview copies, filmstrips and lyric-video stems are capped and pruned (5 GB for media, 7 days for lyric-video stems).
