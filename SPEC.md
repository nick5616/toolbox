# Toolbox — Phase 4 Spec: Background Remover, Upscaler, PDF Toolkit, app icon

Status: **APPROVED 2026-10-27** — binding. Approved together with three additions (§13: HEIC input, opt-in auto-paste, CPU upscaling fallback).
Date: 2026-10-27. Author: architect session (Opus).

Phases 1–3 are shipped; their specs are archived in `docs/specs/phase-{1,2,3}.md`, and every contract there still holds unless changed here. "P1 §x" / "P2 §x" / "P3 §x" refer to those files.

---

## 0. Research findings this spec relies on

Verified hands-on on this Windows machine (i7-11700K, RTX 3070, 32 GB) on 2026-10-27, in `.dev/p4-research/{bg,upscale,pdf}/`, except where marked *docs only*.

| Topic | Finding | Consequence |
|---|---|---|
| Background removal: `rembg` 2.0.86 | It works, but adds scikit-image, pymatting (which needs numba), imageio and jsonschema (about 30 MB more). A cold `import` takes 49 s, and the default ONNX Runtime session peaks at 10.7 GB RAM. | **Don't use rembg.** We write about 100 lines of our own inference with onnxruntime, numpy, scipy and Pillow, all already in `uv.lock` with macOS arm64 wheels. Pillow becomes an explicit dependency, and the lock doesn't change. |
| Background models (CPU, warm) | All models are downloaded from `https://github.com/danielgatis/rembg/releases/download/v0.0.0/<file>`.<br>• **BiRefNet-general-lite**, `BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx`: 224 MB, about 8 s per image, MIT, sha256 `5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333`. Excellent on hair, pets, products and people.<br>• **isnet-general-use**, `isnet-general-use.onnx`: 178.6 MB, about 0.9 s, Apache-2.0, sha256 `60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a`. Good, but hair edges are soft.<br>• **BiRefNet-general**, `BiRefNet-general-epoch_244.onnx`: 972.7 MB, about 14.5 s, MIT, sha256 `58f621f00f5d756097615970a88a791584600dcf7c45b18a0a6267535a1ebd3c`. Slightly crisper than lite.<br>• The u2net, u2netp and silueta models lost the face on the portrait test.<br>• RMBG-2.0 is licensed for non-commercial use only. | The three presets are **Balanced** (BiRefNet-lite, the default), **Fast** (isnet) and **Best** (BiRefNet full). The u2net family and RMBG are not offered. |
| Background pipeline details | Pre-processing:<br>• `exif_transpose`, convert to sRGB via `ImageCms` if an ICC profile is present, then RGB.<br>• Resize to 1024² (bilinear) and scale to /255.<br>• BiRefNet normalises with ImageNet mean/std, sigmoid on its single output `output_image`.<br>• isnet normalises with mean 0.5 / std 1.0, uses output 0, min-max normalised, no sigmoid.<br>• Input name `input_image`, NCHW float32.<br>• Resize the mask back with bicubic.<br>Session settings:<br>• `enable_cpu_mem_arena=False` and `enable_mem_pattern=False` cut BiRefNet's peak RAM from 9–13 GB to **6–7 GB** (isnet 0.75 GB). After a run, RSS drops back to 0.4 / 1.1 GB.<br>• `log_severity_level=3` silences hundreds of warnings.<br>• Creating a session takes 7.5–10 s, so cache it per model.<br>• Thread count barely matters.<br>Large images: a 24 MP input processes fine (the model input is always 1024²); post-processing takes about 3 s and the PNG is about 12 MB. | Background removal becomes a sidecar handler. The session is cached per model, and cancellation is checked before and after the uninterruptible `run`. |
| Upscaler binary | **upscayl-ncnn**, tag `20251207-174704`, AGPL-3.0, maintained (repo pushed 2026-04). It is used only as a separate process. Release assets:<br>• `upscayl-bin-20251207-174704-windows.zip`: 2.42 MB, sha256 `1f0f65c5d2ade866555e2ac467d35952c35a47080a4060fe56a1ab028f67258a`.<br>• `upscayl-bin-20251207-174704-macos.zip`: 9.34 MB, sha256 `277419791281a56eae0c739c70120b974d7267cf7c2de8e86dc09798d4b314db`. The macOS binary is universal, with MoltenVK statically linked.<br>• Each zip contains only `<top>/upscayl-bin[.exe]`, a LICENSE and a README, with no models.<br>• The Windows exe imports `VCOMP140.DLL`. | It becomes a managed tool with **pinned** versions and checksums. |
| Upscaler models | Real-ESRGAN `v0.2.5.0`, `realesrgan-ncnn-vulkan-20220424-windows.zip`: 45.5 MB, sha256 `abc02804e17982a3be33675e4d471e91ea374e65b70167abc09e31acb412802d`, BSD-3. The `models/` files are byte-identical across the OS zips: `realesrgan-x4plus`, `realesrgan-x4plus-anime` and `realesr-animevideov3-x{2,3,4}` (`.param` plus `.bin`, 46 MB). The zip also ships `vcomp140.dll`. | Download the Windows zip on every OS for the models only. On Windows, `vcomp140.dll` is also copied next to `upscayl-bin.exe`. |
| Upscaler CLI | `upscayl-bin -i IN -o OUT.<ext> -n <model> -z <modelScale> -s <outScale> -m <dir>/models [-c <q>] [-t 0] [-g N]`.<br>• `-z` is the model's native scale and `-s` the output scale, so `-z 4 -s 2` gives a true 2× from x4 models.<br>• The `-m` path must contain the string `models`.<br>• The output format follows the extension (png, jpg, webp), and alpha is kept.<br>• Progress lines match `^\d+(\.\d+)?%` on stderr, unbuffered when piped (`\r\n` on Windows).<br>• Non-ASCII paths work; the original Real-ESRGAN exe crashes on CJK output paths.<br>• Killing it mid-run leaves no output file.<br>• A missing or unreadable input exits 0 with no output.<br>• With no usable GPU it exits non-zero with `invalid gpu device`, `Invalid GPU Device` or `vkCreateInstance failed`. | We parse progress and check that the output exists. GPU failure becomes a clear error (see §5.3). |
| Upscaler performance and quality | Warm runs on the RTX 3070: a 480×640 image at 4× takes 4.8 s with x4plus, 2.1 s with anime and 1.3 s with animevideov3. A 3000×1997 image at 4× takes **33 s**, 1.6 GB RAM and 1.4 GB VRAM, and makes an 87 MB PNG. **The very first run takes 18–50 s** (shader compilation). Quality: x4plus is best for photos (recovers real fur and whiskers); x4plus-anime is crispest for line art and screenshots; animevideov3 is soft but fast. There is **no CPU fallback** in ncnn. torch+spandrel on CPU takes 90 s for 480×640. | Presets **Photo**, **Illustration** and **Fast**. Output is capped at 100 MP. The first run shows an indeterminate "Starting GPU…" state. No CPU fallback in Phase 4. |
| PDF operations: **pdfcpu v0.16.4** | Apache-2.0 and pure Go (also builds for darwin/arm64), adding about 9.6 MB to the binary. The `pkg/api` functions all work: merge, split, collect (extract and reorder), remove pages, rotate, optimize, AES-256 encrypt and decrypt, image import, validate and info. Speed:<br>• The 15-page arXiv file takes about 1 s per op (default optimize-on-write; 140 ms without).<br>• A 568-page file takes 1–4 s per op.<br>• A 221 MB file takes 0.2–0.5 s, with up to 730 MB of heap.<br>Paths with non-ASCII characters work. Relaxed validation repairs common damage. **It writes a config dir under the user config dir unless `api.DisableConfigDir()` is called**; a nil configuration is an error. Collect, remove and split **drop bookmarks and metadata** (links and form fields survive). Merge keeps them and adds one bookmark per file. | All structural PDF operations run in Go via pdfcpu. Call `api.DisableConfigDir()` once and always pass `model.NewStatelessConfiguration()`. |
| PDF compression | pdfcpu optimize does not shrink scans, and grew the IRS file to 121%. A Go prototype that reads JPEG (DCT) image streams from pdfcpu's model, downsamples them, re-encodes and writes with `api.WriteContextFile` worked:<br>• the 30-page 29.6 MB scan went to 11.6 MB (q70, 1650 px) and 5.5 MB with more aggressive settings;<br>• a colour CMYK page went from 2.4 MB to 190 KB;<br>• the 221 MB file went to 21 MB in 24.5 s single-threaded.<br>pikepdf gives the same ratios but its macOS arm64 wheel needs macOS 15. Ghostscript is AGPL and only ships as an installer on Windows. | Compression is done **in Go**, with a worker pool. |
| PDF rendering: **go-pdfium v1.21.4, WebAssembly mode** (MIT; PDFium is BSD/Apache) | Pure Go via wazero and builds for darwin/arm64. The probe binary was 15 MB. Initialisation takes **2.6 s**. Renders take 10–23 ms per page at 36 dpi and 20–60 ms at 150 dpi, including JBIG2 scans and forms, at excellent quality. **By default it mounts the host filesystem root into the WASM sandbox.** It opens documents from bytes (`requests.OpenDocument{File: &b, Password}`). | Thumbnails and PDF → images are rendered **in Go**, with no frontend PDF library. Mount **no filesystem**; open documents from bytes. Use a wazero compilation cache in `<support>/cache/pdfium` to cut the start time. |
| Engine additions (`.dev/p4-research/engine04`) | **pillow-heif 1.8.1** (BSD-3; bundles the LGPL libheif) and **spandrel 0.4.2** (MIT; pulls in safetensors 0.8.0 and einops 0.8.2) resolve together with the engine lock, and all have macOS arm64 wheels. A HEIC write/read round trip works. spandrel loads the Real-ESRGAN `.pth` files. CPU timings for 320×240 → 4× (torch 2.14.1+cpu, 8 threads) are below. Roughly 120, 36 and 4 s per input megapixel. | HEIC goes through pillow-heif in the engine, and CPU upscaling through spandrel in the engine (§13). |
| pdf.js 6.4.299 | Works offline in the webview, but adds 7 MB of assets and renders outside the job system. | Not used (go-pdfium covers it). |

---

## 1. Goals

1. **Background Remover:** photo in, transparent PNG of the subject out. Three model presets, plus options for a solid background colour, mask only, cropping to the subject, and edge cleanup. Runs in the existing Python engine on CPU.
2. **Upscaler:** 2× or 4× with Real-ESRGAN models through the managed `upscayl-bin`, on the GPU via Vulkan (or MoltenVK on macOS). Three presets.
3. **PDF Toolkit:** merge, split, organize pages (extract, delete, reorder, rotate), compress, images → PDF, PDF → images, add a password and remove a password. Everything runs in Go, with page thumbnails.
4. **A real app and tray icon**, replacing the Wails "W".
5. **Shared image preview plumbing:** a thumbnail service that can show huge outputs, and a before/after compare slider.

## 2. Non-goals (Phase 4)

- **GPU or CoreML acceleration for background removal.**
- **Batch "remove background then upscale" pipelines.**
- **PDF features left out:** text editing, OCR, form filling, signatures, watermarks, PDF/A conversion, keeping bookmarks through split or organize, and permission flags beyond a plain password.
- Local Chat, Web Archiver and Vault stay placeholders.
- macOS hands-on QA. Windows is verified here; macOS is covered by cross-builds plus docs, as in earlier phases.

---

## 3. Foundation changes

### 3.1 Go dependencies
`github.com/pdfcpu/pdfcpu v0.16.4`, `github.com/klippa-app/go-pdfium v1.21.4` (WebAssembly subpackage only, and never the cgo `single_threaded`/`multi_threaded` packages), and `golang.org/x/image` promoted to a direct dependency (webp, bmp and tiff decoders; `draw` for scaling).

### 3.2 Engine update (sidecar 0.4.0)
- `pyproject.toml`: add `"pillow>=12"` (it already arrives via torchvision, but becomes explicit), bump the version to `0.4.0` and the description to "Toolbox engine: stems, BPM & key, MIDI, transcription, background removal". Run `uv lock`. The lock should change only in the root package entry, and the macOS arm64 wheels must still be there.
- **The engine is renamed for users.** The dep ID stays `audio-engine` (`sidecar.DepID`), so stored state and code don't churn. Its display name becomes **"AI engine"**, with Purpose "Python runtime for stems, BPM & key, MIDI, transcription and background removal (≈1.4 GB)". Every UI string that says "audio engine" becomes "AI engine", including the DepsGate banner, Settings and the CLAUDE.md user-facing notes. Code identifiers keep their names.
- Existing installs then show **Update** (the Phase 2 flow).

### 3.3 Managed archives v2: pinned, multi-part (`core/deps/archive.go`)

`ArchiveSpec` is generalised so the upscaler (two archives, pinned checksums) and ExifTool (one archive, `checksums.txt`) share one installer:

```go
type ArchivePart struct {
    Name   string                                             // "main", "models", …
    Asset  func(goos, goarch, version string) (string, error) // asset file name
    URL    func(asset string) string                          // download URL (may redirect)
    SHA256 func(asset string) string                          // pinned hex; "" → look up in ArchiveSpec.ChecksumsURL
}
type ArchiveSpec struct {
    DepID        string
    InstallDir   string // relative to BinDir
    VersionURL   string // latest version as plain text; "" when Version is pinned
    Version      string // pinned version (no network version check)
    ChecksumsURL string // "SHA2-256(<asset>)= <hex>" lines, for parts without a pinned SHA256
    Parts        []ArchivePart
    // Layout builds installDir (which does not exist yet) from the extracted
    // parts: roots maps part name → extracted root (top folder unwrapped).
    Layout       func(roots map[string]string, installDir string) error
    MaxBytes     int64 // per part
}
```

- **Flow:** resolve the version (fetch it, or use the pinned one). Skip the install if `<installDir>/VERSION` already matches. For each part: compute the checksum, download with progress (the overall progress is split across parts in proportion to their sizes, or evenly when the size is unknown), verify, and extract into its own temp dir. Then run `Layout` into `<bin>/<InstallDir>.new` and **write `<bin>/<InstallDir>.new/VERSION`**. Swap the folders atomically (the Phase 3 logic). Finally re-detect.
- **Migration:** ExifTool becomes a single part named `"main"`. The behaviour stays the same and its tests are adapted.
- **Detection by VERSION file:** `deps.Spec` gains `VersionFile string`. When set (relative to `ArchiveDir`), the version comes from that file instead of running the binary, and the binary only has to exist.
- **Outdated state:** a new field `PinnedVersion string` marks the dep as `outdated` when the installed VERSION differs. This lets future app updates bump pins.

**Upscaler dep** (`deps.Upscayl = "upscayl"`):
- Name "Upscaler engine", Purpose "Real-ESRGAN image upscaling on your GPU (≈50 MB)", Binary `upscayl-bin`.
- `ArchiveDir "upscaler"`, `VersionFile "VERSION"`, `PinnedVersion "20251207-174704+models-0.2.5.0"`, Managed.
- Install hint (Linux and unsupported architectures): "The upscaler isn't available for this platform yet".

`UpscaylArchive()` has two parts:
- **`main`**: `upscayl-bin-20251207-174704-{windows|macos}.zip` from `https://github.com/upscayl/upscayl-ncnn/releases/download/20251207-174704/<asset>`, with the pinned sha256 values from §0. Supported platforms are windows/amd64, windows/arm64 (runs under x64 emulation) and darwin/any (universal binary). Anything else returns an error with the hint.
- **`models`**: `realesrgan-ncnn-vulkan-20220424-windows.zip` from `https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/<asset>`, with the pinned sha256 from §0, on every OS.

Layout:
- `<dir>/upscayl-bin[.exe]`, with mode 0755 on unix.
- `<dir>/LICENSE-upscayl`.
- `<dir>/models/{realesrgan-x4plus, realesrgan-x4plus-anime, realesr-animevideov3-x2, realesr-animevideov3-x3, realesr-animevideov3-x4}.{param,bin}` (only these 10 files).
- Windows only: `<dir>/vcomp140.dll`, taken from the models archive.
- Then `VERSION`.

A hidden installer module `system-upscaler-install` and a bound method `DepsService.InstallUpscaler() (core.Job, error)`. The Phase 3 DepsGate pattern gains an Install/Update button for this dep.

### 3.4 Image thumbnails (`api/files.go`)

```go
// ImageThumb decodes an image (jpg, png, gif, webp, bmp, tif/tiff) and returns a
// data URL scaled so its longest side is ≤ maxDim (64..1600, clamped).
// Encoded as PNG when the image has any non-opaque pixel, else JPEG q85.
// Guards: file ≤ 400 MB; DecodeConfig first, refuse > 300 MP ("Too large to preview").
// Results are cached in memory (LRU, 64 entries, key path+size+mtime+maxDim).
ImageThumb(path string, maxDim int) (string, error)
```

- Scaling uses `golang.org/x/image/draw.CatmullRom` for small images and `ApproxBiLinear` above 40 MP.
- Thumbnails decode on a bounded worker (2 at a time), so the UI never blocks the Go event loop.
- Like `ImageDataURL`, it accepts any existing file with an image extension.
- `ImageDataURL` stays for small originals (EXIF uses it).

### 3.5 Shared UI pieces (frontend)
- **`components/CompareSlider.tsx`:** two images stacked (before/after) with a draggable vertical divider. It responds to keyboard (←/→ 5%, Home/End), has `aria-valuenow`, and has an optional checkerboard background (a `--checker-*` token pair for light and dark). It is used by the Background Remover and the Upscaler.
- **`components/Checkerboard` CSS utility class** for transparent previews.
- **`components/ColorSwatchPicker.tsx`:** swatches for white, black and transparent, plus a custom hex field (validated `#rrggbb`).

### 3.6 App and tray icon
- **Design:** a rounded-square app icon (macOS squircle proportions, 824 px tile on a 1024 canvas, per Apple's grid) with a graphite vertical gradient (`#2a2d33` → `#111316`) and a **toolbox glyph** in the app accent orange `#ff8c42`. The glyph is a trapezoid lid with a handle arch, a box body, and a latch notch, drawn with a 1 px lighter top highlight. It is legible at 16 px.
- **Generator:** the geometry lives in one place. `build/icongen/main.go` (`//go:build ignore`) rasterises it with `golang.org/x/image/vector` and writes:
  - `build/appicon.png` (1024).
  - `build/appicon.icon/Assets/toolbox.svg`, also referenced from `icon.json`, which drops the Wails SVG.
  - `desktop/icons/tray.png`: a 32 px orange glyph on transparent (Windows and Linux).
  - `desktop/icons/tray_template.png`: a 32 px black glyph with alpha (the macOS template image).
  - `frontend/src/assets/logo.svg`: the glyph, shown next to "Toolbox" in the sidebar.
- **Platform files:** run `wails3 task common:generate:icons` (or the equivalent `wails3 generate icons …`) to regenerate `build/windows/icon.ico` and `build/darwin/icons.icns`. `build/darwin/Assets.car` can only be rebuilt on a Mac (Xcode `actool`), so the darwin Taskfile regenerates it from `appicon.icon` on the next Mac build. This is recorded as a Mac follow-up.
- `desktop/icons/gen.go` (the Phase 3 downsampler) is deleted.

### 3.7 Placeholders
`bg-remover`, `upscaler` and `pdf` are removed from `modules/placeholders`. The real modules reuse those IDs, so stored module state and links keep working.

---

## 4. Background Remover (`modules/bgremove` + sidecar `handlers/bgremove.py`)

Descriptor:

| Field | Value |
|---|---|
| ID | `bg-remover` |
| Name | "Background Remover" |
| Icon | `wand-sparkles` |
| Category | image |
| Order | 140 |
| Accepts | `.jpg .jpeg .png .webp .bmp .tif .tiff` |
| Requires | `audio-engine` |
| OutputSubdir | `Cutouts` |
| SplitInputs | true |
| MaxConcurrent | 1 |
| MaxInputs | 200 |

Tagline and description are kept from the placeholder.

### 4.1 Options

```go
type Model string      // "fast" | "balanced" | "best"
type Output string     // "transparent" | "color" | "mask"
type Options struct {
    Model      Model  `json:"model"`      // default "balanced"
    Output     Output `json:"output"`     // default "transparent"
    Color      string `json:"color"`      // "#rrggbb", used when Output=="color"; default "#ffffff"
    Crop       bool   `json:"crop"`       // crop to subject bounds; default false
    Padding    int    `json:"padding"`    // px around the crop, 0..500; default 24
    CleanEdges bool   `json:"cleanEdges"` // edge colour decontamination; default true
    Refine     bool   `json:"refine"`     // guided-filter edge refinement; default false
}
```

`presets.go` defines `Presets() []core.PresetInfo` (ID, Label, `DownloadBytes`) plus a Go table mapping preset → `{file, sha256, url, kind: "birefnet"|"isnet"}`, using the values from §0:
- **fast**: label "Fast", isnet, 179 MB.
- **balanced**: label "Balanced", BiRefNet lite, 224 MB.
- **best**: label "Best", BiRefNet, 973 MB.

### 4.2 Sidecar method `bgremove.run`

Params: `{input, outputDir, baseName, model: {file, sha256, url, kind}, modelDir, output, color, crop, padding, cleanEdges, refine}`.

1. **Validate** the params (`HandlerError("validation")`).
2. **Downloading model:** if `<modelDir>/<file>` is missing, download it via the existing download/progress shim used by transcribe (urllib with streaming, written to a `.part` file in the model dir). Verify the **sha256**; on mismatch delete it and fail with "Model download was corrupted — try again". Rename into place.
3. **Loading model:** create an ONNX Runtime session with the options from §0 (no mem arena, no mem pattern, severity 3, CPU EP). Cache one session per model file in the process and evict the others, so only one model is resident.
4. **Load the image** (`Image.open`, `exif_transpose`, ICC → sRGB via `ImageCms` when `icc_profile` is present, then RGB). Pillow errors become "Couldn't read this image".
5. **Run the model.** Pre-process per kind (§0), then a single `session.run`. Call `check_cancelled()` before and after.
6. **Build the mask:** produce the per-kind output, then uint8, then resize back with bicubic. If `refine` is set, apply a guided filter (grey guide, r=8, eps=1e-3, `scipy.ndimage.uniform_filter`).
7. **Compose:**
   - `transparent`: RGBA = image + mask. If `cleanEdges` is set, pixels with alpha < 250 within 6 px of the opaque region (alpha ≥ 250) take the colour of the nearest opaque pixel (`scipy.ndimage.distance_transform_edt` with `return_indices`).
   - `color`: alpha-composite onto the colour (cleanEdges applied first) and save as RGB.
   - `mask`: L-mode mask.
   - If `crop` is set, crop to the bbox of alpha > 8, expand by `padding`, and clamp to the image. If the mask is empty, don't crop and log "No subject found".
8. **Save** as PNG (optimize=False, compress_level=6) to `<baseName> (no background).png`, `(on colour).png` or `(mask).png`, using the Python unique-path helper (numbering from " (1)", as in Phase 3). Then call `ctx.output(path)`.
9. **Result:** `{width, height, subjectCoverage (0..1 share of alpha>127), model, output}`.

Progress stages: "Downloading model" (0–100%), "Loading model", "Removing background" (indeterminate), "Saving". Model dir: `$TOOLBOX_MODELS_DIR/bg/`.

### 4.3 Go module
`Run` calls `job.Tool(sidecar.DepID)`, then `Call("bgremove.run", …)` with the P2 §6 event mapping, then `SetResult(...)`.

- **Title** = the file name.
- **Message:** "Subject covers 38% · 1600×1200". If coverage is below 0.5%, the message reads "No clear subject found".
- **Validate:** enums; a colour hex is required when Output is `color`; padding range.

### 4.4 UI (`tools/bgremove/BgRemoveView.tsx`)

FileToolLayout. Options:
- **Model** as 3 radio cards: label, download size and a hint. Fast: "~1 s, softer hair". Balanced: "~8 s, great edges". Best: "~15 s, finest detail, needs ~7 GB RAM". Balanced also says "needs ~7 GB RAM".
- **Background** as a SegmentedControl (Transparent / Colour / Mask only). Colour shows the `ColorSwatchPicker`.
- **Crop to subject** switch, plus a padding Stepper when it's on.
- **Clean edges** switch.
- **Refine edges** switch, with the help text "Sharper hair, may leak on busy backgrounds".

A DepsGate covers the AI engine (install/update).

**Results:** a grid of cards per finished job.
- Each card shows a `CompareSlider` (original thumbnail vs result thumbnail via `ImageThumb(…, 800)`, with a checkerboard under the result), the file name, dimensions, and Reveal/Open/Copy path actions.
- Clicking a card opens a large preview dialog with the slider at 1600 px.
- Running jobs show the stage and progress (Meter).

---

## 5. Upscaler (`modules/upscale`)

Descriptor:

| Field | Value |
|---|---|
| ID | `upscaler` |
| Name | "Upscaler" |
| Icon | `maximize-2` |
| Category | image |
| Order | 150 |
| Accepts | `.jpg .jpeg .png .webp` |
| Requires | `upscayl` |
| OutputSubdir | `Upscaled` |
| SplitInputs | true |
| MaxConcurrent | 1 (one GPU) |
| MaxInputs | 200 |

### 5.1 Options

```go
type Model string  // "photo" | "illustration" | "fast"
type Format string // "same" | "png" | "jpg" | "webp"
type Options struct {
    Model  Model  `json:"model"`  // default "photo"
    Scale  int    `json:"scale"`  // 2 | 4; default 4
    Format Format `json:"format"` // default "same"
}
```

Each preset maps to a model and the `-z`/`-s` flags:

| Preset | 2× | 4× |
|---|---|---|
| photo | `realesrgan-x4plus`, `-z 4 -s 2` | `realesrgan-x4plus`, `-z 4 -s 4` |
| illustration | `realesrgan-x4plus-anime`, `-z 4 -s 2` | `realesrgan-x4plus-anime`, `-z 4 -s 4` |
| fast | `realesr-animevideov3-x2`, `-z 2 -s 2` | `realesr-animevideov3-x4`, `-z 4 -s 4` |

Format `same` keeps png/jpg/webp as is. When the input is a PNG with an alpha channel, the output is **always PNG**, whatever the chosen format. JPG and WebP use `-c` quality 90. The builder verifies `-c` semantics against the real binary and records them in DECISIONS.md.

### 5.2 Validation (at submit, in Go)
- `image.DecodeConfig` (with the webp decoder registered) gives the dimensions. If the output would exceed **100 MP** (W·s × H·s), the error is "Too large to upscale {s}× ({W}×{H} → {W·s}×{H·s}); try 2× or a smaller image". Undecodable files: "Couldn't read this image".
- Scale must be 2 or 4. The enums are checked.

### 5.3 Run
1. `job.Tool(deps.Upscayl)` gives the exe; the models dir is `<exe dir>/models`. If `<model>.param` or `<model>.bin` is missing, fail with `dependency_missing` "Upscaler models are missing" and the hint "Reinstall the upscaler from Settings → Dependencies".
2. Output: `core.UniquePath(OutputDir, stem+" ("+s+"x)", ext)`. Write to a temp name in the same dir (`.<ulid>.tmp.<ext>`; the extension is needed for format selection), then rename.
3. Run `proc` with `-i in -o tmp -n model -z Z -s S -m modelsDir [-c 90] -t 0`. Progress:
   - Before the first `%` line: indeterminate "Starting GPU…". After 8 s without one, it becomes "Starting GPU — the first run can take up to a minute".
   - After that, `pct/100` with the message "Upscaling · 42%".
   - Log stderr lines (excluding `%` lines) to the job log.
4. Cancellation: `proc` kills the tree, then the tmp file is removed.
5. Errors:
   - Stderr matching `(?i)invalid gpu device|vkCreateInstance failed|no vulkan|vkEnumeratePhysicalDevices` gives `dependency_missing` "No compatible GPU found", with the hint "The upscaler needs a GPU with Vulkan support (any Apple Silicon Mac, or a recent NVIDIA/AMD/Intel GPU with current drivers)".
   - A non-zero exit, or **a missing or empty tmp file after exit 0**, gives `tool_failed` "Upscaling failed" plus the last 5 stderr lines in the job log.
6. Result: `{inWidth, inHeight, outWidth, outHeight, model, scale, bytes}`. The message reads "640×480 → 2560×1920".

### 5.4 UI (`tools/upscale/UpscaleView.tsx`)

FileToolLayout. Options:
- **Model** as radio cards: Photo ("Best for photos"), Illustration ("Line art, anime, screenshots & text"), Fast ("Quickest, softer").
- **Scale** as a SegmentedControl (2× / 4×).
- **Format** Select.
- **Input rows** show "W×H → W·s×H·s". The size is read via `FilesService.ImageThumb`'s companion `FilesService.ImageSize(path) (core.Size, error)` (new; DecodeConfig only). Rows over the cap show an inline warning, and the Start button excludes them with a toast.

DepsGate covers `upscayl`, with Install/Update (≈50 MB). Results use the same card grid as the Background Remover: `CompareSlider` with the original scaled to the same display box, and pixel-crisp off for the before image so the improvement is visible. A banner appears if the last job failed with "No compatible GPU found".

---

## 6. PDF Toolkit (`modules/pdf`)

Descriptor:

| Field | Value |
|---|---|
| ID | `pdf` |
| Name | "PDF Toolkit" |
| Icon | `file-text` |
| Category | document |
| Order | 190 |
| Accepts | `.pdf` + `.jpg .jpeg .png .tif .tiff .webp` (images only for images → PDF) |
| Requires | none |
| OutputSubdir | `PDF` |
| SplitInputs | **false** (the service decides per action) |
| MaxConcurrent | 2 |
| MaxInputs | 500 |

### 6.1 Options

```go
type Action string // "merge" | "split" | "organize" | "compress" | "images-to-pdf" | "pdf-to-images" | "protect" | "unlock"
type PageEdit struct {
    Page   int `json:"page"`   // 1-based source page
    Rotate int `json:"rotate"` // 0 | 90 | 180 | 270 (clockwise, added to the page's rotation)
}
type Options struct {
    Action Action `json:"action"`

    // split
    SplitMode string `json:"splitMode"` // "every" | "ranges"; default "every"
    Every     int    `json:"every"`     // ≥1; default 1
    Ranges    string `json:"ranges"`    // "1-3, 5, 8-" (8- = to end); each range → one file

    // organize (single input): the output pages, in order
    Pages []PageEdit `json:"pages"` // ≥1

    // compress
    Level string `json:"level"` // "small" | "balanced" | "high"; default "balanced"

    // images-to-pdf
    PageSize string `json:"pageSize"` // "a4" | "letter" | "fit"; default "a4"
    Margin   string `json:"margin"`   // "none" | "small" (≈ 0.5 in); default "small"

    // pdf-to-images
    ImageFormat string `json:"imageFormat"` // "png" | "jpg"; default "png"
    DPI         int    `json:"dpi"`         // 72 | 150 | 300; default 150
    PageRange   string `json:"pageRange"`   // "" = all, else ranges syntax

    // protect / unlock / any encrypted input: never persisted (see 6.2)
    PasswordRef string `json:"passwordRef"` // opaque ID of an in-memory secret
}
```

### 6.2 Passwords are never persisted
Job options are stored in SQLite, so passwords never go in them.

- `pdf.Service` holds an in-memory `secrets` map from ref (ULID) to `{password, newPassword}`. The bound methods take passwords as separate arguments, store them, and put only `PasswordRef` in the options.
- `Run` takes the secret by ref. A secret is deleted when its job reaches a terminal state, and **retries keep it** until then.
- After an app restart, a queued job whose secret is missing fails with `validation` "The password isn't kept after a restart — run this again".

### 6.3 Bound service

```go
type PdfInfo struct {
    Path      string    `json:"path"`
    Pages     int       `json:"pages"`
    Encrypted bool      `json:"encrypted"`
    NeedsPassword bool  `json:"needsPassword"` // can't open without a user password
    Restricted bool     `json:"restricted"`    // owner-password permissions block edits
    Title     string    `json:"title"`
    PageSizes []core.Size `json:"pageSizes"`   // points, after rotation
    Bytes     int64     `json:"bytes"`
}
Defaults() Options
Info(path string, password string) (PdfInfo, error)               // wrong password → validation "Wrong password"
Thumbnail(path string, page int, width int, password string) (string, error) // data URL (JPEG q80), width 80..1200
Enqueue(paths []string, opts Options, password string, newPassword string) ([]core.Job, error)
```

- **Job split by action.** `merge` and `images-to-pdf` make **one** job with all inputs, in the given order. Every other action makes one job **per input**. `organize` requires exactly one input.
- **Input validation:** PDF actions accept only `.pdf` and `images-to-pdf` only images, each with a clear message. Ranges are parsed and checked against the page count at submit time, using `Info`. Inputs larger than 500 MB get "PDFs over 500 MB aren't supported".
- **Password meanings:**
  - `protect`: `newPassword` is required, and `password` opens an already-encrypted input.
  - `unlock`: `password` is required.
  - Any other action on an encrypted input needs `password`.

### 6.4 Implementation (`modules/pdf/`)
- **`pdfcpu.go`:**
  - `init` calls `api.DisableConfigDir()`.
  - `conf(password)` returns `model.NewStatelessConfiguration()` with `UserPW` and `OwnerPW` = password and `ValidationMode` relaxed.
  - Each pdfcpu call goes through a helper that runs it in a goroutine and returns early on `ctx.Done()`. pdfcpu has no context, so the goroutine finishes in the background and its partial output is deleted.
- **`render.go`:** one lazy go-pdfium WebAssembly pool, used both by `Thumbnail` and by `pdf-to-images`.
  - Pool settings: `MinIdle 0`, `MaxIdle 1`, `MaxTotal 2`, `FSConfig: wazero.NewFSConfig()` (**no mounts**), and a `RuntimeConfig` built from go-pdfium's defaults plus `WithCompilationCache(wazero.NewCompilationCacheWithDir(<support>/cache/pdfium))`. The core features go-pdfium needs must be kept.
  - Documents open from bytes, and a small LRU (2 docs) is keyed by path, mtime and password hash. Thumbnails are cached in memory (LRU 300).
  - The pool closes after 5 idle minutes and at app quit (`Close()` hooked in `main.go`).
- **Actions** (`<stem>` is the input file name without extension; all outputs via `core.UniquePath`):

  | Action | How | Output |
  |---|---|---|
  | merge | `api.MergeCreateFile(ctx, inputs, out, false, conf)` | `<first stem> (merged).pdf` |
  | split, every | `api.SplitFile` (every N pages) | `<stem> (pages a-b).pdf` |
  | split, ranges | `api.CollectFile` once per range | `<stem> (pages a-b).pdf` |
  | organize | `CollectFile` with the page order, then `RotateFile` for each rotation group, on output page numbers, in place on the temp file, then move | `<stem> (edited).pdf` |
  | compress | see below | `<stem> (compressed).pdf` |
  | images-to-pdf | `api.ImportImagesFile` with `pdfcpu.Import` config: `a4`/`letter` give `f:A4`/`f:Letter`, `pos:c`, `sc:1 rel`, plus margin; `fit` gives `pos:full` with DPI-correct page size | `<first stem>.pdf` |
  | pdf-to-images | the pdfium pool renders the selected pages at DPI, each encoded PNG or JPEG q90 | `<stem> (pages)/page 001.png` etc. in a subfolder of OutputDir; each file registered via `job.Output` |
  | protect | `api.EncryptFile` with AES-256, user = owner = newPassword | `<stem> (protected).pdf` |
  | unlock | `api.DecryptFile` | `<stem> (unlocked).pdf` |

  Details:
  - **Merge:** progress is per input (indeterminate within).
  - **Split:** every input page produces a file.
  - **Images to PDF:** the builder verifies tif and webp support. Formats that fail are removed from Accepts and recorded.
  - **PDF to images:** progress is pages done ÷ total, and cancellation is checked per page.
  - **Unlock:** the password must be right.
- **Compress** (`compress.go`), based on the research prototype `.dev/p4-research/pdf/gopdf/recomp/`:
  1. Read the context (`api.ReadContextFile`). Collect image XObjects whose filter is `DCTDecode`, or `FlateDecode` 8-bpc DeviceRGB/DeviceGray, with **no SMask/Mask** and both sides ≥ 300 px.
  2. Work out the largest page each image appears on (via page resources). The pixel cap is `targetDPI × page long edge in inches`, which is conservative and never upsamples.

     | Level | Target DPI | JPEG quality |
     |---|---|---|
     | small | 110 | 55 |
     | balanced | 150 | 70 |
     | high | 220 | 82 |
  3. Decode with Go's `image/jpeg` (for CMYK DCT, honour a `/Decode [1 0 …]` array or the Adobe APP14 inversion, test against `scan_color.pdf`) or zlib with raw pixels. Downscale with `draw.ApproxBiLinear` when above the cap. Re-encode as JPEG (Gray stays Gray, CMYK becomes RGB). Replace the stream with `/Filter /DCTDecode`, the new dims and `/ColorSpace`, and drop `DecodeParms`/`Decode`. **Keep the original when the new stream isn't smaller.**
  4. Run on a worker pool of `max(1, NumCPU/2)`, checking ctx between images.
  5. Write with `api.WriteContextFile`, then run `api.OptimizeFile` on the result (dedupe). If the final size is ≥ 95% of the input, **delete the output**, and the job succeeds with the message "Already compact — couldn't make it meaningfully smaller" and no output.
  6. Result: `{bytesBefore, bytesAfter, imagesRecompressed}`, with the message "29.6 MB → 11.6 MB (−61%)".
- **Errors:**
  - Malformed PDF (after relaxed repair): `validation` "This PDF is damaged and couldn't be read".
  - Wrong password: "Wrong password".
  - Restricted file without the owner password: "This PDF's permissions block editing — enter its owner password".
- **Bookmarks:** the result message notes "Bookmarks aren't kept" for split and organize, and only when the input had bookmarks.

### 6.5 UI (`tools/pdf/PdfView.tsx`)

**Layout:** a left column with an **action picker**: a vertical list of 8 items with icon, title and one-line description. The right side is the action's panel.

- The current action is remembered via module state.
- Dropped files go to the current action when they fit it. Otherwise the view switches to the first action that fits: images go to images → PDF, several PDFs go to merge, and one PDF stays on the current PDF action.
- Each panel has its own inputs (FileList) and a **Run** button. A password field appears when `Info` reports `needsPassword` or `restricted`; an inline "Wrong password" error comes from `Info`.

**Panels:**
- **Merge:** an ordered list with drag handles, plus up/down buttons for keyboard use. Each row shows the page count and a first-page thumbnail at 48 px. The total page count is shown.
- **Split:**
  - A segmented control: "Every N pages" (with a Stepper) or "Custom ranges" (a text field with live parsing). The live parsing produces chips like "1–3", "5" and "8–end", with errors shown inline.
  - A preview line: "Creates 4 files".
- **Organize pages:** one PDF. A **page grid** of thumbnails, 140 px wide, lazy-loaded with an IntersectionObserver, rendering at most 4 at once.
  - **Selection:** click selects, Shift-click selects a range, Mod-click toggles, Mod+A selects all.
  - **Toolbar:** Rotate left/right (the selection), Delete (selection), Keep only selected, Reverse, Reset.
  - **Moving pages:** drag to reorder (HTML5 DnD with a drop indicator); with the keyboard, the arrows move focus and Alt+←/→ moves the focused or selected pages.
  - Each tile shows the original page number, plus a rotation badge when rotated. The output is described as "12 pages (3 removed, 2 rotated)".
  - **Save as new PDF** enqueues `organize`.
- **Compress:** three radio cards: Small ("Smallest file, 110 dpi images"), Balanced (default) and High quality. A note says "Text and vector graphics are never degraded; only photos and scans shrink". The result shows before → after.
- **Images → PDF:** an ordered image list with thumbnails (`ImageThumb` 96) and drag/up/down reordering. Page size is a SegmentedControl (A4 / Letter / Fit to image) and Margin a Switch.
- **PDF → images:** Format (PNG / JPG), Resolution (72 "Screen" / 150 "Standard" / 300 "Print") and Pages (All / Range field). An estimate line reads "Creates 24 images".
- **Add password:** a password field plus confirm (they must match, length ≥ 1), with a show/hide toggle. A note says "Uses AES-256. There's no way to recover a forgotten password".
- **Remove password:** a password field. The text "You need the current password; this tool can't crack PDFs".

Results: the shared recent-outputs list for the module (Reveal/Open). Compress shows the size delta and pdf → images shows a "Open folder" button.

---

## 7. Shell, settings and misc

- **Settings → Dependencies:**
  - The **Upscaler engine** row has Install/Update (managed, pinned) and shows "Pinned version 20251207-174704". The detection details reuse the existing row.
  - The AI engine row is renamed.
- **Settings → Models:** the existing "Clear models" now lists the subfolders with their sizes (`whisper/`, `bg/`). The `ModelsInfo` already exists if P2 shipped it; otherwise a simple total is fine. The builder checks and records what it finds.
- **Command palette:** "Remove background…", "Upscale image…", and "Merge PDFs…", "Compress PDF…" and "Organize PDF pages…" (open the tool with the action preselected via the module handoff).
- **Drop matching:** images now match Background Remover, Upscaler, EXIF, Converter and PDF (images → PDF). The existing chooser handles several matches; the order follows each module's Order.

---

## 8. Bound API changes

```go
// api/files.go — FilesService additions
ImageThumb(path string, maxDim int) (string, error)
ImageSize(path string) (core.Size, error)            // core.Size{W, H int} (new type, also used by PdfInfo in points)

// api/services.go — DepsService
InstallUpscaler() (core.Job, error)

// modules
bgremove.Service { Defaults() Options; Presets() []core.PresetInfo; Enqueue(paths []string, opts Options) ([]core.Job, error) }
upscale.Service  { Defaults() Options; Enqueue(paths []string, opts Options) ([]core.Job, error) }
pdf.Service      { Defaults() Options; Info(...); Thumbnail(...); Enqueue(paths, opts, password, newPassword) }
```

---

## 9. Test plan

**Go**
- **`core/deps`:**
  - `InstallManagedArchive` v2 against httptest: two parts with pinned checksums, a mismatch on one part leaves the old install intact, `VERSION` is written, a matching version is skipped, and `PinnedVersion` produces outdated.
  - The ExifTool tests keep passing on the migrated spec.
  - The upscaler `Layout` keeps exactly the 10 model files, the binary, `vcomp140.dll` on Windows only, and LICENSE, with mode 0755 on unix (run with a fake GOOS argument).
  - Asset and URL functions for each GOOS/GOARCH, including the unsupported ones.
- **`api/files`:** `ImageThumb` on png with alpha (gives PNG), jpg (gives JPEG), webp, bmp and tiff; scaling bounds; the cache hit; refusal of oversize images (synthetic `DecodeConfig` header); `ImageSize`.
- **`modules/bgremove`:** Validate; Run against a fake Caller (params include the model table entry, the event mapping, the result message including "No clear subject found").
- **`modules/upscale`:**
  - Validate, including the 100 MP cap using generated PNG headers.
  - Run against a **fake `upscayl-bin`** (re-exec helper) covering: progress lines with `\r\n` → progress, the GPU-error stderr → `dependency_missing`, exit 0 with no output → `tool_failed`, cancellation removes the tmp file, alpha PNG forcing PNG output, and the `-z`/`-s` mapping table.
  - `//go:build integration`: install the real pinned upscaler into a temp bin dir and upscale a generated 64×64 PNG at 2× and 4×. Assert the output dimensions. Skip with a message when no Vulkan GPU is present.
- **`modules/pdf`:**
  - Fixtures are generated at test time with pdfcpu (`api.CreateDemo`-style or import of generated images); any extra PDF fixtures committed under `modules/pdf/testdata/` stay ≤ 200 KB total.
  - Each action on a 6-page generated PDF: merge page counts; split by every N and by ranges (including `8-` to the end); organize order plus rotation (read back via `PageDimsFile` and the rotate attribute); protect then Info shows NeedsPassword; unlock with the wrong password gives the error, the right one works; images → PDF page sizes.
  - pdf-to-images output count and dimensions at 72 dpi.
  - Compress on a generated PDF with a large noisy JPEG produces a smaller file with the same page count and recompressed images, and the "already compact" path for a text-only PDF.
  - Range parser table tests.
  - Secrets: there is no password in the persisted options JSON, and a missing secret after a simulated restart gives the error.
  - **The config dir is never created:** run with `HOME`/`APPDATA` pointing at a temp dir and assert it is still empty.
  - **pdfium has no FS mount:** a test opens a document from bytes, then asserts a temp file can't be opened through it.

**Python**
- `tests/test_bgremove.py` (pure functions, synthetic images): pre-processing shapes and normalisation per kind; cleanEdges colour bleed; crop with padding and clamping; the empty-mask no-crop; colour and mask compose modes; sha256 mismatch deletes the file; param validation.
- The slow test (`TOOLBOX_SLOW=1`) runs `fast` (isnet) on a generated image with a clear foreground disc and asserts the mask IoU is above 0.8.

**Frontend**
- CompareSlider (pointer and keyboard).
- ColorSwatchPicker validation.
- BgRemove options: colour only when Output is colour.
- Upscale over-cap warning row.
- PDF action routing for dropped files, split range parsing chips, organize grid (selection, keyboard move, rotate, delete, the "N pages" summary), password fields (protect confirm mismatch), and merge reordering.
- DepsGate upscaler install button.
- Sidebar logo renders.

**Manual smoke (architect, Windows, sandboxed; passive capture only, no keystroke injection):**
- AI engine update to 0.4.0 in place.
- Background removal on the research photos with all three presets plus colour, mask and crop.
- Upscaler install from Settings, 2× and 4× of a photo and an illustration (check the dimensions and look at the crops).
- PDF: every action on the research PDFs (merge, split, organize via seeded job options, compress the scanned PDF with a size drop, images → PDF, PDF → images, protect, unlock).
- Thumbnails render in the organize grid (screenshot).
- New icon in the window and title bar, the taskbar, and the tray.
- No listening sockets.
- No `pdfcpu` dir under `%APPDATA%`.

---

## 10. Work packages

### Wave 0: foundation (architect)
1. Go deps (§3.1).
2. Core and API:
   - `core.Size`.
   - Placeholders removed.
   - Module stubs with **final** options, presets, descriptors and service signatures for `bgremove`, `upscale` and `pdf`.
   - `FilesService.ImageThumb`/`ImageSize` implemented with tests (small).
   - The `deps.Upscayl` catalog entry, the `Spec.VersionFile` and `PinnedVersion` fields, and a stub of `UpscaylArchive()` with the final part/asset table.
   - `DepsService.InstallUpscaler` signature.
   - `main.go` wiring (including pdf pool `Close()` at quit).
3. Sidecar: pyproject (Pillow explicit, 0.4.0), `uv lock` (verify macOS arm64 wheels), the AI engine display rename, a `handlers/bgremove.py` stub registered.
4. **App icon** (§3.6): the generator, regenerated `.ico`/`.icns`/tray PNGs, and the sidebar logo.
5. Bindings regenerated; `lib/api.ts` re-exports; tool view stubs; "AI engine" string changes in the frontend.
6. Docs: CLAUDE.md (pdf module notes: config dir and the no-mount rule; the image tools; the AI engine name; archive v2).

### Wave 1 (parallel)

| WP | Owns | Acceptance |
|---|---|---|
| **BG1 Background removal backend** | `sidecar/toolbox_sidecar/handlers/bgremove.py`, `sidecar/tests/test_bgremove.py`, `modules/bgremove/**` (except frozen files) | §4.2–4.3; pytest (+slow) and Go tests |
| **UP1 Upscaler backend + archive v2** | `core/deps/archive.go`, `core/deps/*upscayl*`, the detection changes in `core/deps/detect.go` for `VersionFile`/`PinnedVersion`, `modules/upscale/**` (except frozen files), `api` body of `InstallUpscaler` | §3.3, §5.2–5.3; Go tests and integration |
| **PDF1 PDF backend** | `modules/pdf/**` (except frozen files) | §6.2–6.4; Go tests |
| **UI1 Image tools UI** | `frontend/src/tools/{bgremove,upscale}/**`, `components/CompareSlider.*`, `components/ColorSwatchPicker.*`, the checkerboard tokens/class, the DepsGate upscaler branch in `tools/_kit/DepsGate.tsx` | §3.5, §4.4, §5.4; tests |
| **UI2 PDF UI** | `frontend/src/tools/pdf/**`, palette entries in `shell/useBuiltinCommands.ts` | §6.5, §7; tests |

The UI packages code against the Wave 0 bindings and run in parallel with the backends.

### Wave 2: integration (architect)
- Merge and regenerate bindings.
- Full checks: Go, pytest, frontend, gofmt, and the darwin cross-vet (`./core/... ./modules/...` plus `GOOS=darwin go build` of `modules/pdf`).
- Engine e2e extended with a `bgremove` `fast` run on the dev photo.
- Upscaler integration test.
- `wails3 build`, then the manual smoke from §9.
- Update DECISIONS.md and write the summary.

---

## 11. Acceptance criteria

1. **Background Remover:** turns the research portrait, cat, product and logo photos into clean transparent PNGs with the Balanced preset. Fast and Best work. Colour, mask and crop work. The first use downloads the model with progress, and a corrupted download is rejected. Existing engine installs show **Update** and upgrade in place.
2. **Upscaler:** installs from Settings (verified pinned checksums) and upscales a photo 2× and 4× with correct output dimensions and visibly better detail than bicubic. Progress is live, cancel leaves no partial file, and missing-GPU and oversize inputs give clear errors.
3. **PDF Toolkit:** all 8 actions produce correct outputs on the research PDFs, and inputs are untouched (checksums). Compress cuts `scan_synth_30p.pdf` by at least 40% at Balanced. The organize grid shows real thumbnails and saves the edited order and rotation. Passwords never reach the DB, nothing is written to the user config dir, and the WASM renderer has no filesystem access.
4. **Icon:** the new icon appears in the window, the taskbar and the tray on Windows, and the macOS assets are generated (`icons.icns`, template tray icon).
5. **Rules:** no listening sockets. Nothing is written outside the support and library dirs. All checks are clean (`go vet`, `go test`, pytest, `npm run check`, gofmt, darwin cross-vet). DECISIONS.md is updated.

## 12. Risks

- **macOS is unverified for the new pieces.** These are: upscayl-bin with MoltenVK (universal binary, exec bit, Gatekeeper; a Go HTTP download sets no quarantine flag), BiRefNet RAM on smaller Macs (6–7 GB peak), and regenerating `Assets.car`.
- **No GPU means no upscaler.** Acceptable for this user's machines (RTX 3070 and Apple Silicon); revisit if needed.
- **Compression ratio depends on content.** Only DCT and 8-bit Flate images shrink. JBIG2 and CCITT scans and vector PDFs won't, and the tool says so instead of writing a bigger file. CMYK images become RGB, which shifts colour slightly.
- **pdfcpu memory** is about 1–3× the file size; inputs are capped at 500 MB.
- **upscayl-bin is AGPL-3.0**, run only as a separate process and never linked. Fine for a personal app; noted in DECISIONS.md.
- **First upscaler run** is slow (shader compilation), which the UI messaging covers.

---

## 13. Additions approved with the spec (2026-10-27)

### 13.1 HEIC/HEIF input
- **Engine:** `pyproject.toml` adds `"pillow-heif>=1.8"` and `"spandrel>=0.4.2"` (the latter for §13.3). The version stays `0.4.0`. A shared helper, `toolbox_sidecar/imageio.py`, registers the HEIF opener once and exposes `load_image(path) -> PIL.Image`. That function does the `exif_transpose`, converts ICC to sRGB, and returns RGB, or RGBA when the image has alpha. The bgremove and upscale handlers both use it.
- **New sidecar method `image.convert`:** takes `{input, output}`, writes a PNG via `load_image` (alpha is kept) and returns `{width, height}`. Go calls it when a tool needs a HEIC decoded.
- **Background Remover:** Accepts gains `.heic .heif`, and the handler reads them directly.
- **Upscaler:** Accepts gains `.heic .heif`. Go can't decode HEIC, so:
  - Validate skips the size cap for HEIC inputs.
  - `Run` first converts the file via the engine into `TempDir/<stem>.png` (`job.Tool(sidecar.DepID)`). If the engine is missing, it fails with `dependency_missing` "HEIC photos need the AI engine" plus the install hint.
  - It then checks the cap on the converted size and upscales the PNG.
  - Format `same` gives PNG for HEIC inputs.
- **Thumbnails and sizes:** `ImageThumb` and `ImageSize` return `validation` "No preview for HEIC" for `.heic`/`.heif`. The UI shows a file-type tile instead, and "HEIC" where the dimensions would be. EXIF already handles HEIC through ExifTool, so nothing changes there.

### 13.2 Auto-paste from the clipboard popup (opt-in)
- **Setting:** `ClipboardSettings.AutoPaste bool` (json `autoPaste`, default **false**).
  - Settings → Clipboard and the tool's settings panel get a switch, "Paste into the previous app after picking an item", with platform notes.
  - On Linux the switch is disabled ("Not supported on Linux yet").
- **Interface:** the code lives in `desktop/paste_{windows,darwin,other}.go`, behind `type Paster interface { Remember(); Paste(ctx context.Context) error; Permission() string; RequestPermission() error }`.
- **Remember:** the shell calls `Remember()` **just before the popup is shown**, whether it was opened by the hotkey or from the tray.
  - Windows: `GetForegroundWindow`, ignored if it is one of our own windows.
  - macOS: the frontmost app's PID via `NSWorkspace.sharedWorkspace.frontmostApplication` (purego/objc, already an indirect dependency).
- **Paste sequence:** it runs only after a successful copy from the **popup** (not the main tool view) with `AutoPaste` on. Steps:
  1. Hide the popup.
  2. Re-activate the remembered window or app. Windows: `SetForegroundWindow`, which is allowed because we are in the foreground at that moment. macOS: `activateWithOptions:`.
  3. Wait until no modifier keys are held, polling every 15 ms. Windows: `GetAsyncKeyState` for Ctrl, Alt, Shift and Win. macOS: `CGEventSourceFlagsState`. If they are still held after 1 s, skip the paste; the item stays copied.
  4. Wait a further 60 ms.
  5. Send exactly one paste chord. Windows: `SendInput` Ctrl↓ V↓ V↑ Ctrl↑. macOS: `CGEventCreateKeyboardEvent` for keycode 9 with `kCGEventFlagMaskCommand`, posted to `kCGHIDEventTap`.
  If nothing was remembered, or that window or app is gone, the item is only copied.
- **macOS permission:** posting events needs Accessibility permission.
  - `Permission()` returns `"granted"`, `"denied"` or `"unsupported"` (via `AXIsProcessTrusted()` on macOS). Windows always reports `"granted"`.
  - Turning the setting on calls `RequestPermission()` (`AXIsProcessTrustedWithOptions` with the prompt option).
  - The UI shows a status line: "Allowed", or "Needs Accessibility permission" with a button that opens `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`.
  - Without permission the item is copied and the popup shows a one-line notice rather than failing.
  - The UI also notes that dev builds may need re-allowing after each rebuild.
- **Bound methods:** `DesktopService.PastePermission() string`, `DesktopService.RequestPastePermission() error` and `DesktopService.PasteAfterCopy() error`. The popup's copy path calls `ClipboardService.Copy`, then `PasteAfterCopy()`, which does nothing unless auto-paste is enabled.
- **CLAUDE.md privacy rule update:** the app may send exactly one paste chord, only when the user has enabled auto-paste and picked an item in the popup. Never otherwise.
- **Tests (fake injector):**
  - The order is hide, activate, wait for modifiers, then the chord.
  - It is skipped when the setting is off, when nothing was remembered, when the modifiers never release, and when permission is denied.
  - `Remember` ignores our own windows.
- **Hands-on check:** this is **not exercised hands-on** by the architect, since there is no keystroke injection on the user's desktop. The summary lists it as something the user verifies.

### 13.3 Upscaler CPU fallback (AI engine)
- **Option:** `Options.Device string` (json `device`) is one of `"auto"` (the default), `"gpu"` or `"cpu"`.
  - `gpu` uses upscayl-bin only (§5.3).
  - `cpu` uses the engine only.
  - `auto` uses the GPU when `upscayl` is installed. It reruns on the engine when all three of these hold:
    - the GPU run failed with the no-GPU error, or `upscayl` isn't installed;
    - the engine is installed;
    - the input is within the CPU cap.
    In that case it logs "No compatible GPU — using the CPU (slower)". Otherwise the original error stands.
- **CPU cap:** the input must be at most **2 MP**. With `cpu`, validation fails with "Too large for CPU upscaling (max 2 megapixels); use the GPU or a smaller image". The UI shows a time estimate per model from the §0 rates.
- **Sidecar method `upscale.run`:** params `{input, output, model: {file, sha256, url}, modelDir, scale, format}`.
  1. Download and verify the model with the same helper as bgremove, into `$TOOLBOX_MODELS_DIR/upscale/`.
  2. Load it with `spandrel.ModelLoader().load_from_file`, cached per model.
  3. Use the `mps` device if `torch.backends.mps.is_available()`, else `cpu`.
  4. Read the image with `load_image`. For alpha images, upscale the RGB and resize the alpha with Lanczos.
  5. Process in 256 px tiles with 16 px overlap, reporting progress and calling `check_cancelled()` per tile.
  6. If `scale == 2`, downscale the 4× result with Lanczos.
  7. Save as PNG, JPEG q90 or WebP q90, then `ctx.output`.
  8. Result: `{inWidth, inHeight, outWidth, outHeight, device}`.
- **Models:** pinned in Go `modules/upscale/presets.go`. Sizes and sha256 are verified (the files are in `.dev/p4-research/engine04/models/`).

  | Preset | File | Release | Size | sha256 | CPU time, 320×240 → 4× |
  |---|---|---|---|---|---|
  | photo | `RealESRGAN_x4plus.pth` | v0.1.0 | 67,040,989 B | `4fa0d38905f75ac06eb49a7951b426670021be3018265fd191d2125df9d682f1` | 9.4 s |
  | illustration | `RealESRGAN_x4plus_anime_6B.pth` | v0.2.2.4 | 17,938,799 B | `f872d837d3c90ed2e05227bed711af5671a6fd1c9f7d7e91c911a61f155e99da` | 2.8 s |
  | fast | `realesr-animevideov3.pth` | v0.2.5.0 | 2,504,012 B | `b8a8376811077954d82ca3fcf476f1ac3da3e8a68a4f4d71363008000a18b75d` | 0.3 s |

  URLs follow `https://github.com/xinntao/Real-ESRGAN/releases/download/<release>/<file>`.
- **Descriptor:** `Requires` stays `["upscayl"]`, which drives the DepsGate. The view shows the AI engine gate instead when Device is `cpu`.
- **UI:** a "Processor" Select (Automatic / GPU / CPU (slower)) below the options. The result message names the device, e.g. "… · CPU".
- **Tests:**
  - Go: the device selection matrix with fakes. Cases: GPU works; GPU fails with the no-GPU error and falls back to the CPU; no engine keeps the original error; over the CPU cap keeps the original error; `cpu` forced.
  - Python: tiled output reassembles to the same result as untiled on a tiny fake model (identity ×4 via nearest); alpha handling; the 2× downscale; cancellation between tiles.

### 13.4 Work package changes
- **Wave 0** also adds:
  - the `autoPaste` setting;
  - the `Paster` interface and stubs, and the `DesktopService` paste methods;
  - `imageio.py` and the `image.convert` and `upscale.run` stubs;
  - the engine deps (pillow-heif, spandrel);
  - the `Device` Options field and the HEIC accepts.
- **BG1** also owns `toolbox_sidecar/imageio.py`, `image.convert`, and `handlers/upscale.py` with `tests/test_upscale.py`. That makes BG1 the owner of all engine-side image handlers.
- **UP1** also owns device selection and HEIC conversion in `modules/upscale`.
- **New D2 Auto-paste (Go):** owns `desktop/paste_*.go`, the paste wiring in `desktop/` (a marked block in `shell.go`/`popup.go`), and the paste method bodies in `api/desktop.go`. Tests per §13.2.
- **UI1** also takes:
  - the Processor select and CPU estimate;
  - the HEIC tiles;
  - the auto-paste switch and permission status in `tools/clipboard/**` and `views/SettingsClipboard.tsx`;
  - the popup's call to `PasteAfterCopy`.
