# Toolbox — Phase 17 Spec: Compress to Size

Status: **BUILT 2026-11-05, uncommitted for review.** The user asked for it directly (no review stop, it changes no app rule):

> "build a new tool like compress anything or something like that where you can specify under what size you want the file to be, and to have the tool make it so, through compression, downscaling, whatever. Or you could write what it's for like Discord, whatever and just know the file size limits."

Phase 13 (Local File Transfer) stays in `SPEC.md`; Phase 16 is in `docs/specs/phase-16.md`. Every Phase 14/15/16 rule still holds: every tool is an automatic pipeline step with a `StepUI` and parameter labels; every file row is draggable with Send to; the polish rules apply.

## 1. What the user gets
- A tool **Compress to Size** (`compress`, Utilities, icon `shrink`, order 225, right above Local File Transfer). Drop any files. Pick **where they're going** (Discord, Gmail, WhatsApp, …) or type a size. Press **Compress**. Each file comes out under the limit, as good as it can be at that size.
- **Before you run**, every file shows what will happen and how it'll look: `12.4 MB → under 20 MB · 1080p → 720p, 30 fps · Good`, `Already fits`, `Can't fit (needs 3 parts)`. This is a quick estimate from probing, no encoding.
- **What it does per kind** (§4): video re-encoded to an exact bitrate (two-pass), scaled down and frame rate lowered only as far as the budget needs; audio re-encoded at the highest bitrate that fits; photos re-encoded at the best quality that fits and shrunk only if needed; animated GIFs shrunk (size/fps/colours); PDFs' pictures recompressed harder until it fits; Word/PowerPoint/Excel files get their embedded pictures recompressed; anything else is zipped.
- **If it can't look decent at that size** ("If it would look bad"): *Lower the quality anyway* (default) or *Split into parts* (video/audio: `name (part 1 of 3).mp4`, each under the limit).
- A file that already fits is copied unchanged (so pipelines always get a file) and marked **Already fits**.
- Results show `original → new size`, a bar against the limit, the plan that was used and the quality grade, as `ResultRow`s (draggable, Send to — e.g. straight into Local File Transfer).

## 2. Non-goals
- Folders (zip a folder to a size): not in v1.
- Splitting PDFs or other files into parts; split zips.
- Lossless-only modes, codec choice beyond H.264/H.265, AV1.
- Uploading anywhere. Targets are only numbers; nothing talks to Discord etc.

## 3. Targets (`modules/compress/targets.go`)
Frozen data, decimal MB (1 MB = 1,000,000 bytes; conservative against services that count MiB). `TargetsAsOf = "2026-11"`. Values that count something other than the file say so in `Note`.

| ID | Label | Group | Bytes | Note |
|---|---|---|---|---|
| discord | Discord | Chat | 20 MB | Free accounts (raised from 10 MB in Aug 2026) |
| discord-basic | Discord Nitro Basic | Chat | 50 MB | |
| discord-nitro | Discord Nitro | Chat | 500 MB | |
| whatsapp | WhatsApp (as video/photo) | Chat | 16 MB | Sent as a document it's 2 GB, uncompressed |
| signal | Signal | Chat | 100 MB | |
| imessage | iMessage | Chat | 100 MB | |
| telegram | Telegram | Chat | 2000 MB | |
| slack | Slack | Chat | 1000 MB | |
| mms | Text message (MMS) | Chat | 1 MB | Carriers vary; 1 MB is the common floor |
| gmail | Gmail attachment | Email | 18 MB | The 25 MB limit counts the email's encoding (+33%) |
| outlook | Outlook attachment | Email | 14 MB | 20 MB counting encoding |
| icloud-mail | iCloud Mail | Email | 14 MB | 20 MB counting encoding (Mail Drop not used) |
| bluesky-image | Bluesky photo | Social | 2 MB | |
| bluesky-video | Bluesky video | Social | 300 MB | Also max 10 minutes |
| x-image | X photo | Social | 5 MB | |
| x-video | X video | Social | 512 MB | |
| mastodon-image | Mastodon photo | Social | 16 MB | Server default |
| mastodon-video | Mastodon video | Social | 99 MB | Server default |
| reddit-image | Reddit photo | Social | 20 MB | |
| github-image | GitHub image | Work | 10 MB | Issues, PRs and comments |
| github-video | GitHub video | Work | 10 MB | 100 MB on paid plans |
| github-file | GitHub file | Work | 25 MB | |
| floppy | Floppy disk | Fun | 1.44 MB | 1,474,560 bytes |

`custom` = the user's own number (`TargetMB`).

## 4. Backend (`modules/compress/`)
Module `compress`: `Accepts{Any: true}`, `Requires: []`, `Recommends: ["ffmpeg","ffprobe"]` (media kinds call `job.Tool("ffmpeg")`, which fails fast with the install hint; photos, PDFs, Office and zip are pure Go), `SplitInputs`, `MaxInputs 200`, `OutputSubdir "Compressed"`. Pack: Media (`Needs: ["ffmpeg"]`).

### 4.1 Options (`options.go`)
```go
type Options struct {
    TargetID    string     // a Target ID or "custom"
    TargetMB    float64    // used when TargetID == "custom"; 0.05..100000
    IfTooSmall  TooSmall   // "lower" (default) | "split"
    VideoCodec  VideoCodec // "h264" (default, plays everywhere, Discord embeds) | "h265"
    MaxHeight   int        // 0 = auto; else 2160/1440/1080/720/480/360 cap
    KeepAudio   bool       // video: keep the sound (default true)
    ImageFormat ImageFormat // "auto" (default) | "jpeg" | "webp" | "keep"
    KeepMetadata bool      // default false: location and camera data are dropped
}
```
`Options.Limit() int64` resolves the byte limit (preset wins over `TargetMB`; unknown ID → validation error). Default: `discord`.

### 4.2 Kinds (`kind.go`)
By extension: video (`media.VideoExtensions`), audio (`media.AudioExtensions`), image (jpg/jpeg/png/webp/bmp/tif/tiff/heic/heif), gif (`.gif`; a single-frame GIF is treated as an image), pdf, office (`.docx .pptx .xlsx`), other (everything else).

### 4.3 The plan
Every kind has `estimate<Kind>(ctx, env, path, opts) Estimate` (fast: probe only) and `run<Kind>(ctx, job, env, path, opts) (Result, error)`. Both use the same pure planner, so the estimate is what the run does. Byte budget: `limit × 0.97`; after a run the real file is measured; over the **limit** → retry with the budget scaled by `limit×0.97/actual` (at most 3 attempts per file/part), then fail with what it reached.

**Video** (`video.go`, `planVideo(VideoFacts, budgetBytes, opts) VideoPlan`, pure, table-tested):
- Audio bitrate from the total kb/s: >2000 → 160k, >800 → 128k, >300 → 96k, >150 → 64k, else 48k mono; none when `!KeepAudio` or no audio. Container overhead 1.5%.
- Candidate heights 2160, 1440, 1080, 720, 540, 480, 360, 240, 144 (≤ source, ≤ `MaxHeight`); fps kept smooth while the picture shrinks: at ≥ 720p each size at the source rate (≤ 60) then 30; 540p–360p at ≤ 30; below 360p at ≤ 24; 15 fps only at 240p/144p as the last resort. Pick the first (height, fps) whose bits-per-pixel-frame ≥ 0.07 (H.264; ÷1.4 for H.265); else the smallest with video bitrate ≥ 30 kb/s.
- Grade by bpp: ≥ 0.10 great, ≥ 0.06 good, ≥ 0.035 fair, else poor; capped at fair below 480p or under 24 fps (from a smoother source), poor below 360p (sources already that small aren't penalised). Impossible: < 30 kb/s at 144p/15 fps.
- Split (`IfTooSmall=split`) when the grade would be poor or impossible: the fewest parts whose plan grades ≥ fair (max 50 parts); each part `-ss/-t` re-encoded and planned on its own duration.
- Encode: libx264/libx265 two-pass (`-b:v`, `-maxrate 1.5×`, `-bufsize 2×`, `-preset medium`, passlog in TempDir), `yuv420p`, AAC, `+faststart`, `.mp4`. Rotation applied (FFmpeg autorotate). `-map_metadata -1` unless `KeepMetadata`.

**Audio** (`audio.go`): kb/s = budget×8/duration (minus 1%). MP3 (largest standard CBR ≤ that: 320…32; below 64k downmix mono 22.05 kHz) when ≥ 32k; Opus in `.ogg` 6k–32k below that (grade fair/poor). Grade: ≥ 128 great, ≥ 96 good, ≥ 64 fair, else poor. Split like video (each part ≥ fair).

**Photos** (`image.go`): orient (EXIF) and HEIC via `imaging.ToReadable`. Format: `auto` → JPEG if opaque, WebP (FFmpeg) if it has transparency, PNG (downscale only) when FFmpeg is missing; `keep` keeps JPEG/PNG/WebP. Binary-search quality 92…40; if 40 doesn't fit, scale by `sqrt(budget/size)×0.95` and search again; floor 160 px long side. Grade by quality and scale (≥ 80 at full size great; ≥ 65 good; ≥ 50 fair; else poor).

**GIF** (`gif.go`): FFmpeg palette two-pass; ladder over (scale, fps ≤ source, colours 256/128/64) chosen by `size ∝ w·h·fps`, at most 6 encodes. Output `.gif`.

**PDF** (`pdf.go`): `pdf.CompressImages(ctx, in, out, password "", dpi, quality, progress)` (exported in `modules/pdf`) over the ladder (220,82) (150,70) (110,55) (90,45) (72,35) (50,25), binary search for the gentlest that fits. Encrypted PDFs → "Unlock it with PDF Toolkit first". Nothing fits → "Mostly text and fonts; the smallest it gets is X".

**Office** (`office.go`): unzip `.docx/.pptx/.xlsx`, recompress JPEG/PNG under `*/media/` (same format and name; JPEG quality and long-side ladder (2400,85) (1920,80) (1600,75) (1280,70) (1024,60) (800,50); opaque PNGs only downscaled), re-zip with best deflate, keep every other part byte-identical and in order.

**Other** (`other.go`): zip with best deflate to `name.ext.zip`. Doesn't fit → "This kind of file doesn't compress below X".

### 4.4 Results and estimates (`options.go`)
```go
type Grade string // "great" | "good" | "fair" | "poor" | "" (n/a)
type Estimate struct {
    Path, Name string; Kind Kind
    OriginalBytes, LimitBytes int64
    AlreadyFits, Possible bool
    Plan    string // "1080p → 720p · 30 fps · H.264 1.4 Mb/s · AAC 96 kb/s"
    Grade   Grade
    Parts   int    // > 1 when it would be split
    Note    string // e.g. "PDF results depend on its pictures"
    Problem string // can't read it, encrypted, …
}
type Result struct {
    Input string; Kind Kind
    Outputs []string // one, or the parts
    OriginalBytes, FinalBytes, LimitBytes int64 // FinalBytes = largest output
    Fits, AlreadyFit bool
    Plan string; Grade Grade; Attempts, Parts int
}
```
Service (`service.go`): `Defaults`, `Targets() []Target`, `Estimate(paths, opts) ([]Estimate, error)` (bounded, 30 s per file), `Enqueue(paths, opts)`, `ResultShape`, `StepShape`.

### 4.5 Pipeline step (`pipeline.go`)
StepOptions = Options. Produces role `compressed` (the input's kind) and `part` for split parts. Vars: `size_mb` (number, final size), `fits` (toggle), `grade` (text). One job per file. Summary: `under 20 MB (Discord) · lower quality`.

## 5. Frontend (`frontend/src/tools/compress/`)
- `CompressView.tsx` on the kit's `FileToolLayout`. Primary: **Target** picker (a `Select` grouped by Chat/Email/Social/Work/Fun + "Custom size…"; custom shows a MB `Stepper`), the target's note in one line, then the **estimate list** (one dense row per file: name, `size → under N`, plan, grade chip; debounced `Estimate` on input/option change). Advanced click-in: If it would look bad (Lower quality / Split into parts), Video codec, Max height, Keep sound, Photo format, Keep metadata.
- Results: `ResultTable` rows: file, `before → after`, a bar of after/limit, grade, `FileActions`. Split results list each part.
- `options.ts`: defaults/sanitise/limits, `formatBytes`, grade labels; `compress.test.tsx`.
- Step editor `pipelines/steps/compress.tsx` + `paramDefs.ts` entries (primary: target, custom MB) + `catalogFixture.ts` row; keywords (`compress, shrink, smaller, size, mb, limit, discord, email, whatsapp, fit`); `shrink` in `components/Icon.tsx`.

## 6. Tests and acceptance
- Go: planner tables (video/audio/photo/pdf ladders, grades, split counts, impossible), targets (unique IDs, positive bytes, labels), Options validation, kinds, office zip round-trip keeps non-media parts identical, integration (`-tags integration`) compresses a generated 20 s 1080p video to 2 MB and checks `size ≤ limit`.
- Frontend: view renders estimates and results, custom size, step parse/editor, params labelled, `TestEveryToolIsAPipelineStep` + `everyTool.test.tsx` pass.
- Acceptance: in the sandbox app a real video, a photo, a PDF and a .pptx each come out under the chosen limit; `go build/vet/test`, `gofmt -l .` and `npm run check` are clean.

## 7. Work packages
- **Foundation (architect):** `modules/compress` types, targets, descriptor, kinds, service, pipeline step, stubs; `pdf.CompressImages`; main.go, packs, root test registrations; bindings; `api.ts`; stub view + step registration.
- **WP-A (Go, media):** `video.go`, `audio.go` (+ tests, `integration_test.go`).
- **WP-B (Go, files):** `image.go`, `gif.go`, `pdf.go`, `office.go`, `other.go` (+ tests).
- **WP-F (frontend):** everything in §5.
