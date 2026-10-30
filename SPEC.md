# Toolbox — Phase 7 Spec: Visualizer (reactive visuals for songs, lyrics and subtitled videos)

Status: **APPROVED 2026-10-30** (r3).
- r2 added a local mood reader instead of relying on Local Chat (§0.3, §5.4), and Visualizer backgrounds inside Lyric Video and Subtitles (§9).
- r3 makes the visuals a step of Lyric Video's wizard: a quick picker, or the full designer embedded in place, with instrument separation and saving the stems (§9.2). Subtitles' "Make a video" gets the same choice (§9.3). The round trip to the Visualizer is replaced by the embedded designer (§9.4).
Date: 2026-10-29. Author: architect session (Opus).

Phases 1–6 are shipped; their specs are archived in `docs/specs/phase-{1..6}.md`, and every contract there still holds unless changed here. "P6 §x" etc. refer to those files.

This phase was cut in line on 2026-10-29: Pipelines moves to Phase 8, and the later phases shift by one (`docs/ROADMAP.md`).

**Where it comes from:** the user's `song-visualizer` repo (`../song-visualizer`, read only). It has:
- **`song-visualizer/`:** 16 Canvas2D modes (waveform, geometry, tunnel, lissajous, spectrum bars, particles, radial, helix, starfield, terrain, aurora, kaleidoscope, ripples, vortex, a Guitar-Hero note highway and its reverse), 20 palettes, 4 background modes, mode cycling and switching on the beat, offline 5-band onset analysis for the highway, and MediaRecorder export.
- **`golden-hour/`:** a party visualiser with aurora bands, rising embers, wave rings tinted blue/red by the left/right channel levels, bass and treble burst rings, a light sweep when a song starts, and palettes that drift with the time of day.
- **`pitch-hero/`:** a background of rotating Lissajous figures, rings in the colour of the sung pitch, and drifting motes.

Phase 7 keeps those ideas and their look, and rebuilds them as a GPU engine. The engine reacts to the instruments separately, to the beat and song structure, to the chords, to the words being sung or said and what they mean. It renders the same frames in the live preview and in the exported video.

---

## 0. Research findings this spec relies on

Verified hands-on on 2026-10-29 on the Windows box (i7-11700K, RTX 3070, WebView2 156), in `.dev/p7-research/`, except where marked *docs only*. The full notes are in `.dev/p7-research/notes.md`. The test harness is `.dev/p7-research/harness`, a throwaway Wails v3 app built with a plain `go build`.

### 0.1 Rendering in the webview

| Topic | Finding | Consequence |
|---|---|---|
| WebGL2 in a Web Worker (`OffscreenCanvas`) | 1920×1080, RGBA16F targets, a domain-warped fBm scene plus a 2× separable bloom at half resolution plus tonemapping: **1,063 fps** render-only (ANGLE on D3D11). | The engine is WebGL2. It is the same code in the preview (main thread) and the export (worker). |
| Canvas2D, song-visualizer style | 160 `shadowBlur` strokes, 300 particles and a line of text in a worker: **47 fps**. | No Canvas2D drawing in the engine. Glow comes from bloom, and lines and shapes are drawn with signed distances in shaders. Canvas2D is only used to rasterise text into textures. |
| WebCodecs `VideoEncoder` (in a worker) | Supported: H.264 High 1080p (hardware and software), **1920×2160** (`avc1.640033`), 3840×2160, 1080×1920, VP9, AV1. Not supported: HEVC, and **VP9 with alpha**. | Exports are H.264. Overlays with alpha are sent as one frame twice as tall, colour on top and the alpha matte below, and FFmpeg recombines them (§7.4). |
| Sending bytes to Go: `fetch` POST to the asset middleware | **3.2–4.2 MB/s**, whatever the body size (64 KB–8 MB), the Go read buffer or the concurrency (1–8). WebView2's request-body path is the bottleneck. | Not used for video. |
| Sending bytes to Go: `chrome.webview.postMessage(base64)` → Wails `Options.RawMessageHandler` | **42–46 MB/s**, with messages of 64 KB–4 MB and the native `Uint8Array.prototype.toBase64`. Messages reach Go on a goroutine (Wails' 64-slot message buffer). Wails reserves the `wails:` prefix and **echoes every raw message back to the page**. | The export streams encoded video to Go as raw messages (§7.2). **No socket and no listener.** The `wails:` prefix is avoided, and the page ignores the echoes. |
| Full pipeline | Worker GL render → `VideoEncoder` (hardware, 12 Mbps) → transfer to the main thread → base64 → postMessage → Go appends Annex-B to a file. **1080p30: 290 fps** (1,800 frames, 9.7× real time). 1920×2160 stacked: 154 fps. 1080×1920: 255 fps. Everything drains 70 ms after the last frame. | A 4-minute song exports at 1080p in under 30 s on this machine. |
| Hidden window | The same pipeline with the window hidden (`Hidden: true`): **308 / 167 / 286 fps**. | Renders keep running while Toolbox is in the tray. The renderer lives in the main window's JS context, which exists for the app's whole life. |
| JPEG fallback | `OffscreenCanvas.convertToBlob` JPEG at q 0.92: **34 fps**, 112 KB per frame. | Used when `VideoEncoder` can't do H.264 (§7.3). It is about real time. |
| FFmpeg checks | Every stream decodes as H.264 High with the exact frame count. The mux `-f h264 -framerate 30 -i v.h264 -i song -c:v copy` takes 0.7 s for 60 s. Recombining stacked colour and alpha with `split → crop → alphamerge → overlay` works. | §7.4. |
| macOS (*docs only*) | WKWebView on macOS 14+ has WebGL2 in workers (Safari 17), `VideoEncoder` with H.264 through VideoToolbox (Safari 16.4+), and WKScriptMessageHandler for raw messages. `Uint8Array.prototype.toBase64` needs Safari 18.2. | A JS base64 fallback (§7.2). The Mac checklist covers the encoder, the transport speed and text in workers. |

### 0.2 Song analysis (CPU, librosa 1.0, a 180 s synthetic 120 bpm track; `.dev/p7-research/analysis_bench.py`)

| Step | Time | Note |
|---|---|---|
| STFT, 64 mel bands, RMS, onset strength at 60 Hz | 0.93 s | |
| Beat tracking | 1.18 s | 120.2 bpm (true: 120) |
| Chroma (15 Hz), 24 chord templates, median filter | 1.42 s | Flickers between relatives, so chords are decided **per beat** (§5.3) |
| Agglomerative segmentation (beat-synced MFCC + chroma) | 0.62 s | Missed the loudness jumps, so a separate **loudness-novelty** detector finds lifts and drops |
| pYIN on the vocals (16 kHz, hop 320) | 4.1 s | YIN takes 0.33 s, but pYIN's voicing is far more reliable |
| Demucs 4-stem (`htdemucs`, P2 §0) | about 1× real time | Already installed by the Music pack (`stems-default`) |

The audio features for a 3-minute song take **about 9 s** on top of the stems. Words come from `transcribe.run` (Whisper small) on the vocals stem, as in Lyric Video.

### 0.3 Reading the words without a chat model (`.dev/p7-research/nlp/`)
I tested on 34 lines written for the test: 28 English and 6 in Spanish, French, German, Portuguese and Japanese. Each line has an expected emotion out of 8 (joy, love, sadness, anger, fear, calm, hope, awe) and expected imagery out of 12 motifs. The models ran on CPU with onnxruntime 1.31.1 and `tokenizers` 0.23.3, **both already in the engine**.

| Approach | Model, licence, size | Emotion (en / other) | Motifs (precision / recall) | Speed |
|---|---|---|---|---|
| Emotion classifier (GoEmotions, 28 labels mapped to 8) | `SamLowe/roberta-base-go_emotions-onnx` int8, MIT, 125 MB | 0.57 / 0.00 (English only; poetic lines come out "neutral") | — | 6 ms/line |
| Zero-shot NLI (20 hypotheses per line) | `MoritzLaurer/multilingual-MiniLMv2-L6-mnli-xnli`, MIT, 428 MB | 0.21 (nearly everything "fear") | 0.67 / 0.57 | 34 ms/line |
| Multilingual embeddings + written anchor phrases | `intfloat/multilingual-e5-small` int8, MIT, 118 MB | 0.68 / 1.00 | 0.62 / 0.46 | 1.3 ms/line |
| **Multilingual embeddings + written anchor phrases** | **`sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`**, Apache-2.0, **118 MB** (uint8) | **0.86 / 0.67** | **0.86 / 0.64** | **1.5 ms/line** |

How the anchor method works:
- Each emotion has 8 short English example phrases and each motif has 3; none of them are test lines.
- A line's emotion score is the mean cosine of its 3 nearest anchors for that emotion.
- A motif counts when its best anchor's cosine is ≥ 0.54.
- Because the model is multilingual, English anchors also work for other languages.

**Chosen:** the paraphrase-multilingual MiniLM model as the **mood reader**. It's small, fast, multilingual, and one model gives both the emotion and the imagery. The arm64-quantised file gives the same answers: embeddings agree to within cosine 0.984, and it scores 0.89 on English. The **Local Chat model is optional** on top, as a "deeper reading" that also picks the words to emphasise.

| File | URL (revision `e8f8c211226b894fcb81acc59f3b34ba3efd5f42` of `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`) | Bytes · sha256 |
|---|---|---|
| model (Windows / Intel) | `…/resolve/<rev>/onnx/model_quint8_avx2.onnx` | 118,453,870 · `98a01d88b7de996cdea58c32ca71208c09968d143798814b2ea09d3439dc334f` |
| model (macOS arm64) | `…/resolve/<rev>/onnx/model_qint8_arm64.onnx` | 118,412,398 · `783fea82d71a58179b830a4dbd2d58447e640609e98eedf9ffa12622d375a672` |
| tokenizer | `…/resolve/<rev>/tokenizer.json` | 9,081,518 · `2c3387be76557bd40970cec13153b3bbf80407865484b209e655e5e4729076b8` |

### 0.4 What already exists and is reused
- **Stems:** `stems.separate` with preset `four-fast` (`htdemucs`): Vocals, Drums, Bass, Other.
- **Words:** `transcribe.run` with word timestamps (P6 §0.3).
- **Lyrics logic:** Lyric Video's alignment (Needleman–Wunsch), LRC/SRT/VTT parsing and words-to-lines rule (P6 §7.2). These move to a shared `core/lyrics` package (§4.2).
- **Local Chat model:** optionally, `core.TextGenerator` with JSON-schema replies (P6 §3.5) gives a deeper reading of the words (§5.4).
- **Media route:** `MediaService.URLFor` serves the analysis files and textures to the renderer (P6 §3.2). Responses are capped at 4 MiB, so the client reads larger files in ranges (§6.2).
- **Media kit:** `MediaPlayer`, `Timeline`, `useMediaSource` (P6 §3.11).

---

## 1. Goals

1. **Visualizer tool:** drop a song or a video and get a reactive visual video.
   - **Song:** full-frame visuals, optionally with lyrics that react to the music.
   - **Video:** visuals laid **over the video** (with alpha), plus optional reactive subtitles. Or the video's sound alone drives full-frame visuals.
2. **Hear the song the way a VJ would.** One analysis pass (cached) produces:
   - the **instruments separately** (drums split into kick, snare and hi-hats; bass; vocals; other);
   - the **beat and bars**, the **sections** (intro, verse, chorus, drop, bridge, outro) and **lifts/drops**;
   - the **chords and key**, and the **vocal pitch** and **held notes**;
   - the **words** with their timings, and the **meaning** of each line: mood (valence and energy), emotion, imagery ("fire", "rain", "stars"…) and the words to emphasise.
   - The meaning comes from a small local **mood reader** model (118 MB, any language, about 2 ms per line). The Local Chat model can optionally give a deeper reading.
3. **Control what shows, when, and why:**
   - **Presets** to start from.
   - A **Reactions** panel: what drives what, for example "Kick → rings 80%".
   - A **visual mix** with one fader per instrument, for words and for mood.
   - A **Song Map** timeline that lets you choose the scene for each section.
   - A live **"Why"** readout of what is driving the picture at the playhead.
   - An **Advanced** layer stack where any parameter can be bound to any signal.
4. **Beauty and variety:** a big step up from the source repo.
   - **Light:** HDR rendering, bloom, filmic tonemapping, dithering (no banding in H.264), and SDF anti-aliasing.
   - **Colour and motion:** palettes in OKLab, envelopes that breathe instead of flicker, and adaptive normalisation for each song.
   - **Variety:** **31 layer types** and **20 curated presets**, covering every mode from the source repo plus new ones.
5. **Exact, fast export:** the frames the preview shows are the frames the export writes.
   - Speed: ≥ 4× real time at 1080p30 on the Windows box.
   - Formats: 16:9, 9:16, 1:1 and 4:5; 720p to 2160p; 30 or 60 fps.
   - Audio: original or instrumental.
6. **Visuals as a background in the video-making tools** (§9):
   - **Lyric Video** (with lyrics) gets a **Visuals step** in its wizard. **Subtitles' "burn into a video"** (without lyrics) gets the same choice:
     - **Quick:** a preset or saved design, picked from live thumbnails that react to your own file;
     - **Full designer:** the Visualizer's designer embedded in place, with instrument separation (and saving the stems) and the tool's own words as input.
   - Those tools keep drawing their own text on top. The visuals react to the music and to the tool's own words and their mood.
   - Subtitles can now make a video from an **audio file** (a captioned audiogram for podcasts and voice notes), with visuals, a colour or an image behind the subtitles.
   - Both tools can also hand the timed text to the Visualizer to make the whole video there, with reactive words. Subtitles cues keep word timings from generation.

## 2. Non-goals (Phase 7)

- **Live input:** microphone, system audio or BlackHole capture, live party mode. The tool works on files; the preview can play full screen.
- The source repo's **games and practice tools** (Pitch Hero scoring, MIDI Muse, the mic monitor).
- **3D models, video textures inside scenes, or user-written shaders.** Video goes under the visuals through FFmpeg (§7.4), not into the GPU scene.
- **Online services:** looking up lyrics, cloud sentiment, stock footage. Everything stays local.
- **Keyframe animation by hand:** the timeline assigns scenes and palettes per section; it doesn't keyframe individual parameters.
- **Rewriting Lyric Video's or Subtitles' text rendering:** they keep libass text on top. The Visualizer supplies their backgrounds (§9). Reactive *words* (karaoke pop, emphasis glow…) are made in the Visualizer itself.
- **HDR/10-bit output, ProRes, or alpha-channel video files as outputs** (overlays are composited by Toolbox).
- Inputs longer than **60 minutes**.

---

## 3. Architecture

```
            ┌──────────────── Go ────────────────┐            ┌──────────── webview (main window) ───────────┐
 song/video │ modules/visualizer (analyze/render) │  events    │ tools/visualizer (UI)                         │
 ──────────▶│ lyric-video / subtitles (backgrounds)│──────────▶ │   ├─ live preview: viz Engine (WebGL2, main)  │
            │ core/viz  Analyzer ──▶ engine:      │            │   └─ Song Map, Reactions, Layers, Export      │
            │           stems.separate            │            │ components/viz/VisualsPicker (LV, Subtitles)  │
            │           viz.analyze  (features)   │            │ viz/RenderHost (in the app shell, always on)  │
            │           transcribe.run (words)    │  raw msgs  │   └─ render.worker: same Engine on            │
            │           viz.mood (mood reader)    │ ◀───────── │      OffscreenCanvas → VideoEncoder (H.264)   │
            │           TextGenerator (optional)  │ (postMsg)  │                                               │
            │ core/viz  RenderBroker ──▶ FFmpeg   │            │      chunks → main thread → System.invoke     │
            │           mux / overlay composite   │            └───────────────────────────────────────────────┘
            └─────────────────────────────────────┘
```

- **Analysis is a Go job.** It runs the engine handlers, then writes `audio.json` + `features.bin` (the music) and `text.json` (the words and their meaning) into a cache.
- **The engine** (`frontend/src/viz/`) is pure TypeScript + WebGL2. It turns (show, analysis, time) into a frame.
- **Render is a Go job.** It hands a render plan to the always-mounted `RenderHost`. The host renders in a worker with the same engine and streams H.264 to Go over raw messages. Go muxes the audio, or composites the overlay onto the video, with FFmpeg.
- **Lyric Video and Subtitles** call the same `core/viz` render for their backgrounds and burn their own text on top in their FFmpeg pass.
- **No new listener, no new binary, no new Python dependency.** There is one new model download: the mood reader, 127 MB.

---

## 4. Foundation changes (Wave 0, architect)

### 4.1 Dependencies
- **Engine:** no new packages. `onnxruntime` and `tokenizers` are already locked; the mood reader uses them. The version goes to **0.7.0**, and the description gains "music visualisation analysis". No lock change apart from the version.
- **Model:** the mood reader (§0.3).
  - It's pinned in Go as `{file, url, sha256, bytes}` per OS (the arm64 file on darwin/arm64, the avx2 file elsewhere) plus the tokenizer.
  - It's fetched through the `visualizer` module's `core.ModelProvider` (preset `mood`) into `<models>/mood/`, following the bgremove pattern. The handlers get explicit paths and never download.
- **Frontend:** none. WebGL2, WebCodecs and OffscreenCanvas are built into the webview.
- **Go:** none.

### 4.2 `core/lyrics` (moved from `modules/lyricvideo`, tests move too)
```go
type Word struct { StartMs, EndMs int64; Text string }               // json: startMs, endMs, text
type Line struct { StartMs, EndMs int64; Text string; Words []Word } // json: startMs, endMs, text, words

func WordsToLines(segments [][]Word, cjk bool) []Line      // P6 §7.2 "detect" rule
func Align(text string, recognised []Word) ([]Line, float64) // P6 §7.2 "align" (returns matched 0..1)
func ParseFile(path string) (lines []Line, needsAlign bool, err error) // .lrc/.srt/.vtt; .txt → needsAlign
func SpreadWords(l Line) Line                                // words by character share when none
func WriteLRC(w io.Writer, lines []Line) error
```
- Lyric Video keeps its frozen `LyricLine`/`LyricWord` types and converts at the boundary. Its behaviour is unchanged, and its tests keep passing.

### 4.3 `core/viz` (new package; imports `core`, `core/proc`, `core/media`, `core/lyrics`, `core/sidecar`)

**Analysis types** (the full file schemas are in §5.5):
```go
type WordsSource string // "none" | "detect" | "align" | "file" | "given"
type AnalyzeOptions struct {
    Stems      bool        `json:"stems"`      // separate instruments (Demucs 4-stem)
    SaveStems  bool        `json:"saveStems"`  // also write the 4 stems to the Library (§9.7)
    Words      WordsSource `json:"words"`
    Language   string      `json:"language"`   // "" auto or a Transcribe code
    LyricsText string      `json:"lyricsText"` // align: ≤ 20,000 chars
    LyricsPath string      `json:"lyricsPath"` // file: .lrc .srt .vtt .txt
    Lines      []lyrics.Line `json:"lines"`    // given: ≤ 20,000 lines (from a handoff)
    Mood       bool        `json:"mood"`       // read mood/imagery with the mood reader (default on with words)
    DeepRead   bool        `json:"deepRead"`   // also ask the Local Chat model (default off)
}
type AnalysisRef struct {
    Key          string          `json:"key"`          // cache folder name
    AudioJSON    string          `json:"audioJson"`    // absolute paths
    FeaturesPath string          `json:"featuresPath"`
    TextJSON     string          `json:"textJson"`     // "" when Words = none
    Instrumental string          `json:"instrumental"` // "" without stems
    Summary      AnalysisSummary `json:"summary"`
}
type AnalysisSummary struct {
    DurationMs int64    `json:"durationMs"`
    Tempo      float64  `json:"tempo"`
    Key        string   `json:"key"`        // "A minor"
    Sections   []string `json:"sections"`   // labels in order
    HasStems   bool     `json:"hasStems"`
    HasWords   bool     `json:"hasWords"`
    HasMeaning bool     `json:"hasMeaning"`
    Language   string   `json:"language"`
    Lines      int      `json:"lines"`
    MoodSource string   `json:"moodSource"` // "music" | "reader" | "reader+chat"
    Warnings   []string `json:"warnings"`   // e.g. "Mood reader not installed: mood comes from the music only"
}
type Analyzer struct{ /* paths, caller, textgen */ }
func (a *Analyzer) Analyze(ctx context.Context, job *core.JobContext, input string, o AnalyzeOptions) (AnalysisRef, error)
func (a *Analyzer) Lookup(key string) (AnalysisRef, bool)
```

**Render types:**
```go
type RenderMode string // "opaque" | "overlay"
type RenderPlan struct {
    Analysis   AnalysisRef `json:"analysis"`
    ShowJSON   string      `json:"showJson"`   // ≤ 512 KiB; validated by the renderer
    Width      int         `json:"width"`      // even, 320..3840
    Height     int         `json:"height"`     // even, 320..3840 (opaque) / ≤ 1440 (overlay)
    FPS        int         `json:"fps"`        // 24 | 25 | 30 | 50 | 60
    StartMs    int64       `json:"startMs"`
    EndMs      int64       `json:"endMs"`
    Mode       RenderMode  `json:"mode"`
    CoverPath  string      `json:"coverPath"`  // optional texture (song cover art), "" = none
    ImagePath  string      `json:"imagePath"`  // optional still background texture
    Seed       int64       `json:"seed"`
}
type RenderBroker struct{ /* see §7.2 */ }
// Render blocks until the renderer finishes, returning the elementary stream it wrote
// (video.h264, or frames.mjpeg for the JPEG fallback) in job.TempDir.
func (b *RenderBroker) Render(ctx context.Context, job *core.JobContext, plan RenderPlan) (RenderOutput, error)
type RenderOutput struct { Path string; Codec string /* "h264" | "mjpeg" */; Frames int; Encoder string }
// HandleRawMessage is wired to application.Options.RawMessageHandler in main.go.
func (b *RenderBroker) HandleRawMessage(msg string, origin, topOrigin string)
```

**Visual backgrounds for other tools** (used by Lyric Video and Subtitles, §9):
```go
// VisualsSpec is a design chosen in a VisualsPicker.
type VisualsSpec struct {
    ShowJSON string `json:"showJson"` // a preset or saved design (≤ 512 KiB)
    Stems    bool   `json:"stems"`    // separate instruments for the analysis
    UseWords bool   `json:"useWords"` // feed the tool's own timed text into the analysis (word pulses, mood)
}
// RenderVisuals analyses the input (cached), then renders the design without text
// (show.text forced to null) at w×h/fps. Mode "opaque" (a background) or "overlay"
// (over a video). Progress is mapped into [p0, p1].
func RenderVisuals(ctx context.Context, job *core.JobContext, a *Analyzer, b *RenderBroker,
    input string, spec VisualsSpec, lines []lyrics.Line, w, h, fps int, mode RenderMode, p0, p1 float64) (RenderOutput, error)
```

**FFmpeg helpers:**
```go
func MuxOpaque(ctx, ffmpeg string, out RenderOutput, audio string, startMs, endMs int64, fps int, ass, dst string, onProgress func(float64)) error
func CompositeOverlay(ctx, ffmpeg string, out RenderOutput, base string, loopBase bool, audio string, fps, w, h int, ass, dst string, onProgress func(float64)) error
// ass: "" or a subtitle file name in the job's TempDir, burned in last (§9.6).
```
The arguments are in §7.4. Arg construction is pure and table-tested.

**Cache:** `<support>/cache/visualizer/`. It is pruned at start: folders untouched for more than 30 days, then oldest first until the total is under 3 GB.

### 4.4 Raw message channel (`main.go`)
- `application.Options.RawMessageHandler` is set to call `broker.HandleRawMessage(msg, originInfo.Origin, originInfo.TopOrigin)` for messages starting with `vz1|`. Everything else is ignored (today nothing else is sent).
- The broker accepts a message only if:
  - its token matches an active render (128-bit random, made per render);
  - `Origin == TopOrigin`, so it comes from the main frame;
  - the origin is the app's own origin, captured from the first asset request (`http://wails.localhost` on Windows, `wails://wails` on macOS).
- Anything else is dropped silently. It is counted in a debug log line, never logged with content.

### 4.5 Events (registered in `api/events.go`, typed in the bindings)
| Event | Payload | Direction |
|---|---|---|
| `viz:render` | `{token, planUrl, jobId}` | Go → RenderHost: start a render |
| `viz:render-ack` | `{token, bytes}` | Go → RenderHost: bytes written so far (every ≥ 4 MiB) |
| `viz:render-cancel` | `{token}` | Go → RenderHost: stop now |

### 4.6 Module stub and wiring (`modules/visualizer`, ID `visualizer`)
| ID | Name | Icon | Category | Order | Accepts | Requires | OutputSubdir |
|---|---|---|---|---|---|---|---|
| `visualizer` | Visualizer | `sparkles` | audio | 110 | audio + video exts (P6 §3.9), MaxInputs 1 | engine, ffmpeg, ffprobe | `Visualizer` |

- Wave 0 writes:
  - `options.go`, `module.go` and `service.go`, with final signatures and complete `Validate`;
  - a stub `Run`;
  - the `main.go` wiring (`viz.NewAnalyzer`, `viz.NewRenderBroker`, the RawMessageHandler), the bindings and `lib/api.ts` re-exports;
  - the engine handler stubs `viz.analyze`, `viz.mood` and `viz.prefetch` in `handlers/viz.py`, imported in `handlers/__init__.py`;
  - the mood reader's model pins and the `ModelProvider` stub in `modules/visualizer/models.go`;
  - the frontend skeleton (§4.8).
- New icons in `components/Icon.tsx`: `sparkles`, `layers`, `sliders-horizontal`, `wand-sparkles`, `map`, `waves`, `drum`, `guitar`, `mic`, `heart-pulse`, `maximize`, `film`, `eye`, `eye-off`, `grip-vertical`.

### 4.7 Tool packs
- **New component** `mood-reader` (model, module `visualizer`, preset `mood`, Apache-2.0).
  - Size: 127,535,388 B download and disk on Windows (model + tokenizer), 127,493,916 B on macOS. The catalog stores the larger figure.
  - It joins the **Music** and **Speech** packs (counted once, P5 §7.1).
- **Music** pack: `+ visualizer` with Needs `{engine, ffmpeg}`.
  - The Stems option needs `stems-default`; Words needs `whisper-default`; mood needs `mood-reader`. All three are Music components.
  - The views show DepsGate rows for those options only when they're switched on.
- The Music and Speech pack sizes grow by the mood reader. `TestEveryToolIsInOnePack` keeps passing.

### 4.8 Frontend skeleton (`frontend/src/viz/`, Wave 0 writes the contracts and a working minimum)
```
viz/
  types.ts        Show, Scene, LayerConfig, Param, Mod, SignalId, PaletteId, TextStyle, PlanForWorker (final)
  analysis.ts     loadAnalysis(urls) → Analysis; ranged fetch; sampling; cumulative sums; event lookups
  signals.ts      SIGNALS catalogue, fallbacks without stems, pulses, envelope cache, evaluate(mod, t)
  palette.ts      PALETTES (24), OKLab mixing, palette modes (fixed/journey/mood/chords/sections)
  director.ts     autoTimeline(analysis, show) → TimelineEntry[]; transitions
  engine.ts       class Engine { constructor(canvas, opts); setShow; setAnalysis; setTextures; render(tMs); dispose }
  gl/             context, shader compile cache, targets (RGBA16F), fullscreen triangle, bloom, tonemap, dither, feedback
  layers/         registry.ts + one file per layer type (Wave 0: `gradient` and `bars` as references)
  text/           atlas.ts, layout.ts, TextLayer (Wave 0: interface only)
  post/           registry.ts (Wave 0: bloom, tonemap, vignette, dither)
  presets/        index.ts + one file per preset (Wave 0: `spectrum-classic` as the reference)
  worker/         render.worker.ts, encoder.ts, transport.ts (Wave 0: skeleton with the message protocol)
  RenderHost.tsx  mounted once in App.tsx (main window only, not popups)
  lab/            VizLab.tsx: dev view behind TOOLBOX_VIZLAB=1 (§11.4)
```
- `tools/visualizer/VisualizerView.tsx` is a stub, with its `tools/index.ts` line.
- `state/ui.ts` `Handoff` gains `seed?: ToolSeed` (§9.1).

### 4.9 Docs
- **CLAUDE.md:** a Phase 7 section.
  - The raw-message render channel: no socket, token plus origin checks, the `vz1|` prefix.
  - Engine determinism rules (§6.1).
  - "Layers never use `Math.random`, `Date` or `performance.now`."
  - How to add a layer and a preset.
  - The cache.
- **`docs/MAC-CHECKLIST.md`:** Phase 7 steps (§11.5).
- **`docs/ROADMAP.md`:** renumbered (done with this draft).

---

## 5. Song analysis

### 5.1 Flow (`core/viz/analyze.go`)
1. **Key:** `sha1(path|size|mtime)` → folder `<cache>/visualizer/<key>/`.
   - Audio products are named by `s<0|1>` (stems off/on).
   - Text products are named by `t-<sha1 of the words options + lines>` and the mood source (`m0` music only, `m1` reader, `m2` reader + chat).
   - Anything already there is reused, and progress jumps past that step.
2. **Stems** (if on): `stems.separate {preset: "four-fast", format: "flac", out: <folder>/stems}`. Progress 0–0.45.
3. **Features:** `viz.analyze {path, stems: {drums, bass, vocals, other} | null, outDir: <folder>, name: "s1"}`, then 0.45–0.6 (0–0.4 without stems). It writes `s1.json` + `s1.bin`.
4. **Instrumental** (stems on): FFmpeg `amix=inputs=3:normalize=0` of drums, bass and other → `instrumental.flac`. Then **the stems folder is deleted**, keeping only the vocals until step 5 is done.
5. **Words:**
   - `detect`: `transcribe.run` on the vocals stem, or on the input if stems are off. Model `small`, `formats:["json"]`, `vad:true`, the language. Then `lyrics.WordsToLines`.
   - `align`: the same transcription, then `lyrics.Align(text, words)`. The warning "Couldn't follow the song well — check the timings" appears below 0.4 matched.
   - `file`: `lyrics.ParseFile`. If it `needsAlign`, align as above.
   - `given`: the lines from the handoff; words are spread with `SpreadWords` where missing.
   - Progress 0.6–0.85.
6. **Emphasis (no model needed):** a word is emphasised when its mean `vocals.level` (or `mix.presence` without stems) is in the song's top 12% **and** it lasts ≥ 280 ms, or when it overlaps a held note (§5.3).
7. **Mood** (§5.4), progress 0.85–1:
   - If `Mood` is on and the mood reader is installed: `viz.mood`.
   - Then, if `DeepRead` is on and `TextGenerator.Ready()` succeeds: the chat reading, which refines the reader's result.
   - A missing reader or chat model adds a warning, and mood falls back to the music (§5.4).
8. **Write `t-….json`.** Delete the vocals stem. Return the `AnalysisRef`.

Cancellation is honoured between steps and inside each engine call. A failed step deletes its partial files.

### 5.2 Engine handler `viz.analyze` (`handlers/viz.py` + `toolbox_sidecar/viz/{features,beats,harmony,sections,pitch}.py`)

**Params:** `{path, stems: {drums, bass, vocals, other} | null, outDir, name, fps?: 60}`.
- `fps` is 60 for inputs ≤ 20 min and 30 above. Inputs over 60 min are a validation error.

**Decode:** librosa at 22,050 Hz, mono, plus left/right RMS from a stereo decode for the balance. Stems are decoded the same way.

**Normalisation (per song, per channel):** percentile p5 → 0 and p98 → 1, clipped. Onset envelopes are divided by their p99. Quantised to u8.

**Channels at `fps`** (`hop = round(22050/fps)`):

| Group | Channels |
|---|---|
| mix | `level` (RMS), `onset`, `brightness` (spectral centroid, log-scaled 200 Hz–8 kHz), `balance` (0.5 = centre), 8 bands: `sub` 20–60, `bass` 60–250, `lowmid` 250–500, `mid` 500–2k, `highmid` 2–4k, `presence` 4–6k, `brilliance` 6–12k, `air` 12k+ Hz |
| drums *(stems)* | `level`, `onset`, `kick` (onset of 20–150 Hz), `snare` (onset of 150 Hz–2.5 kHz with the kick band removed), `hats` (onset > 6 kHz) |
| bass / vocals / other *(stems)* | `level`, `onset` |
| vocals *(stems; from the mix's 300 Hz–4 kHz band otherwise)* | `pitch` (MIDI 40–84 → 0..1, held through unvoiced gaps ≤ 150 ms), `voiced` (0/1) |
| vectors | `spectrum`: 64 log-spaced bins 30 Hz–16 kHz (dB, normalised per song), `wave`: 64 signed samples per frame (the mix over one frame, peak-normalised, stored as u8 with 128 = 0) |

**Events** (`[ms, strength 0–255]`, peak-picked with `librosa.onset.onset_detect`, 110 ms minimum gap per channel):
- `kick`, `snare`, `hats`, `bass`, `vocals`, `other` (stems) or their mix fallbacks: kick from `sub+bass`, snare from `mid`, hats from `brilliance`, vocals from `presence`;
- `mix`.

**Beats** (`beats.py`):
- `librosa.beat.beat_track` on the mix onset envelope gives tempo and beat times.
- **Downbeats:** for each phase p ∈ {0,1,2,3}, score the beats with `i % 4 == p` by kick (or sub+bass) onset strength within ±70 ms, + 0.5 × a chord change on that beat; the best phase wins. `beatsPerBar` is 4.

### 5.3 Harmony, sections, pitch
- **Chords** (`harmony.py`):
  - `chroma_cqt` at 15 Hz is beat-synchronised (median) and matched against 24 major/minor templates by cosine.
  - Smoothing is a Viterbi pass with self-transition 0.9 and uniform others.
  - Equal neighbours merge. Chords shorter than 1 beat merge into the previous one. A cosine below 0.5 gives `N` (no chord).
  - **Key:** `rank_keys` (as in `analysis.bpm_key`) on the mean chroma.
- **Sections** (`sections.py`):
  1. Beat-synchronised MFCC(13) + chroma(12), standardised, then `librosa.segment.agglomerative` with k = clamp(round(duration / 20 s), 4, 12).
  2. Boundaries snap to the nearest downbeat. Segments shorter than 4 bars merge into the more similar neighbour.
  3. **Groups:** segment mean feature vectors are clustered greedily, joining when cosine ≥ 0.9, and named A, B, C…
  4. **Energy:** the mean `mix.level` per segment, rescaled 0..1 across the song.
  5. **Labels**, in this order:
     - `intro`: the first segment if energy < 0.45 and length < 30 s;
     - `outro`: the last segment, by the same rule;
     - `chorus`: segments of the highest-energy group that occurs ≥ 2 times;
     - `verse`: segments of the most frequent other repeated group;
     - `bridge`: a non-repeating segment in the second half;
     - `drop`: a segment that starts at a drop event (below);
     - otherwise `section`.
  6. **Lift / drop / break events** from the 1-bar mean loudness (dB):
     - `drop`: +6 dB vs the previous 2 bars;
     - `lift`: a rise of ≥ 4 dB spread over the previous 2–4 bars, ending on a downbeat;
     - `break`: −6 dB.
- **Pitch** (`pitch.py`): pYIN on the vocals (16 kHz, fmin 65, fmax 1000, hop 320), resampled to `fps`.
  - **Held notes:** voiced runs ≥ 600 ms with pitch within ±0.5 semitone of their median → events `held: [[startMs, endMs, midi]]`.

### 5.4 Meaning

**The mood reader** (engine `viz.mood`, `toolbox_sidecar/viz/mood.py`; the default, no chat model needed):
- **Params:** `{lines: [text…] (≤ 20,000), modelPath, tokenizerPath, anchorsCachePath}`.
- **Encoding:**
  - The `tokenizers` tokenizer truncates at 128 tokens; `onnxruntime` (CPU, 2 intra-op threads) runs batches of 64.
  - Mean pooling over the attention mask, then L2-normalisation.
- **Anchors** (`toolbox_sidecar/viz/anchors.json`, shipped with the engine):
  - 8 English phrases per emotion and 3 per motif, from `.dev/p7-research/nlp/embed.py` (AN3 may extend them; ≤ 12 per emotion, ≤ 6 per motif).
  - Their embeddings are computed on first use and cached in `<models>/mood/anchors-<sha1(anchors.json + model sha)>.npy`.
- **Per line:**
  - **Emotion scores:** for each emotion, the mean cosine of the line's 3 nearest anchors. The emotion is the argmax.
  - **Confidence:** the margin between the best and second emotion, scaled to 0..1 (margin ÷ 0.1, clipped). A confidence below 0.2 is recorded as a weak reading.
  - **Valence and energy:** the softmax of the scores (temperature 0.03) weights this table:

    | Emotion | Valence | Energy |
    |---|---|---|
    | joy | 0.8 | 0.8 |
    | love | 0.7 | 0.4 |
    | sadness | −0.7 | 0.25 |
    | anger | −0.6 | 0.9 |
    | fear | −0.6 | 0.7 |
    | calm | 0.3 | 0.15 |
    | hope | 0.6 | 0.5 |
    | awe | 0.5 | 0.6 |

  - **Motifs:** a motif counts when its best anchor cosine is ≥ 0.54 (AN3 tunes one threshold per motif on the test set, §11.2). At most the top 3 are kept.
- **Result:** `{lines: [{emotion, confidence, valence, energy, motifs, scores: {emotion: cos}}]}`.
- **Speed:** about 2 ms per line on CPU (§0.3); the model loads in about 1 s and is dropped when the call ends.
- Lines with no letters ("♪", "(instrumental)") get a neutral reading: calm, confidence 0.

**Deeper reading with Local Chat** (optional, off by default; `core/viz/meaning.go`):
- **Batches:** up to 30 lines or 2,500 characters, with the previous batch's last 3 lines as context.
- **System prompt:**
  > "You read song lyrics or speech and describe how each line feels, for a music visualiser. For each line give: valence from -1 (dark, sad) to 1 (bright, happy); energy from 0 (still) to 1 (intense); one emotion; up to 3 visual motifs only if the line clearly evokes them; up to 2 words from the line to emphasise. Answer only with the JSON."
- **JSON schema:** an array of exactly n objects:
  - `valence`: number, −1..1;
  - `energy`: number, 0..1;
  - `emotion`: enum of joy, love, sadness, anger, fear, calm, hope, awe;
  - `motifs`: array ≤ 3 from the enum of fire, rain, snow, stars, ocean, flowers, hearts, city, sun, night, storm, smoke;
  - `emphasis`: array ≤ 2 of strings.
- **Settings:** temperature 0.2; `Purpose: "Reading the mood of the words"`.
- **Recovery:** a reply that fails the schema or has the wrong count is retried once, then the batch goes line by line. A line that still fails gets a neutral reading (valence 0, energy 0.5, calm, no motifs).
- **Emphasis words** must match a word of the line (NFKC, case-insensitive, punctuation stripped). Matches add to the loudness emphasis (§5.1 step 6); the rest are dropped.
- **Merging with the reader:**
  - Where the reader's confidence is < 0.5, the chat's emotion, valence and energy replace the reader's. Otherwise valence and energy are averaged, and the emotion stays the reader's.
  - Motifs are the union, best-scored first, at most 3.
- The chat reading can be used without the reader. If the mood reader isn't installed, the chat result is used alone.

**Mood keyframes** (written to `text.json`; the same for every source):
- One keyframe per line start: its valence, energy and emotion. A weak reading (confidence < 0.2) counts at half weight.
- It is blended 70/30 with the **musical mood** at that time: valence 0.5·(major ? 1 : −1)·0.6 + 0.4·(brightness − 0.5); energy = section energy.
- Between lines the mood eases towards the musical mood over 4 s.
- **Without a reading** (mood off, no words, or no models): keyframes every bar from the musical mood alone, with the emotion from a lookup:

    | Valence | Energy < 0.33 | 0.33–0.66 | > 0.66 |
    |---|---|---|---|
    | < −0.2 | sadness | fear | anger |
    | −0.2..0.2 | calm | awe | anger |
    | > 0.2 | calm | hope | joy |

### 5.5 File schemas (version 1; written by Python (audio) and Go (text); read by `viz/analysis.ts`)

**`s<0|1>.json`:**
```json
{ "version": 1, "durationMs": 214000, "fps": 60, "frames": 12840, "stems": true,
  "tempo": 120.2, "beatsPerBar": 4, "beats": [512, 1011], "downbeats": [512, 2510],
  "key": { "name": "A minor", "camelot": "8A", "minor": true },
  "chords": [ { "startMs": 512, "endMs": 2510, "name": "Am", "root": 9, "minor": true } ],
  "sections": [ { "startMs": 0, "endMs": 15800, "label": "intro", "group": "A", "energy": 0.21 } ],
  "events": { "kick": [[512, 230]], "snare": [], "hats": [], "bass": [], "vocals": [], "other": [], "mix": [],
              "lift": [], "drop": [[61000, 255]], "break": [], "held": [[70500, 72100, 64]] },
  "blocks": [ { "id": "mix.level", "kind": "scalar", "offset": 0, "width": 1 },
              { "id": "spectrum", "kind": "vector", "offset": 488160, "width": 64 } ],
  "features": "s1.bin" }
```

**`s<0|1>.bin`:**
- Blocks are back to back. A scalar block is `frames` bytes. A vector block is `frames × width` bytes, frame-major.
- All u8 (`wave` is offset by 128).
- A 4-minute song at 60 Hz is about 2.1 MB with stems.

**`t-<hash>-m<0|1|2>.json`:**
```json
{ "version": 1, "source": "detect", "language": "en", "matched": 0.0, "moodSource": "reader",
  "lines": [ { "startMs": 15800, "endMs": 19200, "text": "We were burning bright",
               "words": [ { "startMs": 15800, "endMs": 16100, "text": "We", "emphasis": false } ],
               "meaning": { "valence": 0.4, "energy": 0.8, "emotion": "joy", "confidence": 0.62, "motifs": ["fire"] } } ],
  "mood": [ { "ms": 0, "valence": -0.1, "energy": 0.2, "emotion": "calm" } ] }
```
`meaning` is absent with `m0`.

---

## 6. The visual engine (`frontend/src/viz/`)

### 6.1 Frame model and determinism
- **`Engine.render(tMs)`** draws the frame at time tMs. Its output is a pure function of `(show, analysis, textures, size, seed, tMs)`, plus GPU feedback state for layers marked `stateful`.
- **Rules for every layer:**
  - No `Math.random`, `Date` or `performance.now`. Use `rng(seed, key)` (a PCG32 hash).
  - **Motion that accumulates** (particle drift, rotation speed driven by bass, highway scroll) uses the analysis's **cumulative signals**: prefix sums of a channel, computed once at load. For example the angle is `base·t + k·(cum(bass, t) − cum(bass, t0))`, so any frame can be computed directly.
  - **Spawned things** (particles, ripples, notes) come from events within a lookback window ≤ 8 s. Their state is closed-form in age; a damped velocity is `v0·(1 − dᵃᵍᵉ)/(1 − d)`.
  - **Stateful layers** (feedback trails, kaleidoscope-of-feedback) read the previous frame. After a seek, the engine **warms up** by rendering the previous 1 s at the same fps without presenting. The export renders sequentially, so it never needs this.
- **Preview/export parity:** at the same tMs, size and show, the preview and the export produce the same pixels. Stateful layers match from 1 s after a seek.
- **Draft quality** (preview only, automatic below 45 fps for 2 s, or chosen by the user): bloom at quarter resolution and particle counts ×0.5. The export is always full quality.

### 6.2 Analysis loading (`analysis.ts`)
- `loadAnalysis({audioJsonUrl, featuresUrl, textJsonUrl?})`:
  - fetches each URL in **4 MiB ranges** until done (the media route caps responses);
  - checks `version`, `frames` and block sizes;
  - builds `Float32Array` views (0..1) lazily per block, and prefix sums on first use.
- **Sampling** is linear interpolation between frames. Events are queried by binary search (`eventsBetween(id, t0, t1)`, `lastEvent(id, t)`). `sectionAt(t)`, `chordAt(t)`, `lineAt(t)` and `wordAt(t)` are O(log n).

### 6.3 Signals (`signals.ts`)
Every reactive parameter is driven by named signals (0..1 unless noted). The UI names are in brackets.

| Signal id | [UI name] | Definition |
|---|---|---|
| `mix.level`, `mix.onset`, `mix.brightness`, `mix.balance` | Whole song, Hits, Brightness, Left/right | channels |
| `mix.sub` … `mix.air` (8) | Sub, Bass band, … Air | channels |
| `kick`, `snare`, `hats` | Kick, Snare, Hi-hats | pulse from events (τ 90 / 110 / 60 ms) × strength |
| `drums.level`, `bass.level`, `vocals.level`, `other.level` | Drums, Bass, Vocals, Other instruments | channels |
| `bass.onset`, `vocals.onset`, `other.onset` | … hits | pulse from events (τ 120 ms) |
| `vocals.pitch`, `vocals.voiced`, `vocals.held` | Vocal pitch, Singing, Held note | channels / 1 during held notes, easing in and out over 150 ms |
| `beat.pulse`, `beat.phase`, `bar.pulse`, `bar.phase` | Beat, Beat position, Bar, Bar position | pulse (τ 120 / 300 ms) / 0..1 saw |
| `section.energy`, `section.progress`, `song.progress` | Section energy, … | from sections / 0..1 |
| `lift.pulse`, `drop.pulse`, `break.pulse` | Build-up, Drop, Break | pulse (τ 2,000 / 1,200 / 800 ms); lift ramps up over its 2–4 bars |
| `chord.change`, `chord.hue`, `key.minor` | Chord change, Chord colour, Minor key | pulse (τ 250 ms) / root on the circle of fifths → 0..1 / 0 or 1 |
| `word.pulse`, `word.emphasis`, `line.progress`, `line.active` | Words, Emphasised words, Line progress, Singing a line | pulse at word starts (τ 150 ms) / pulse at emphasised words (τ 400 ms) / 0..1 / 0 or 1 |
| `mood.valence` (−1..1 → 0..1), `mood.energy` | Mood (bright ↔ dark), Mood energy | mood keyframes, eased |
| `lfo.slow`, `lfo.mid`, `time` | Slow drift, Sway, — | 0.03 / 0.2 Hz sine, seconds |

- **Fallbacks without stems:**
  - `drums.level` → `mix.onset` envelope; `bass.level` → `mix.bass`; `vocals.level` → `mix.presence`; `other.level` → `mix.mid`.
  - Kick, snare and hats come from the mix events (§5.2). Presets work either way.
- **Without words:** the word, line and mood signals that depend on lines are 0, except mood, which uses the musical mood.
- **Modulation** (`Param`, §6.4):
  - `value = clamp(base + Σ amountᵢ · shape(env(signalᵢ)) · mixGain(group(signalᵢ)) · reactivity, min, max)`.
  - `env` is a one-pole attack/release envelope (default 10 ms / 180 ms), precomputed per (signal, attack, release) over the whole song and cached.
  - Shapes: `linear`, `ease` (smoothstep), `exp` (x²), `gate` (x > 0.5).
  - `mixGain`: the visual-mix fader of the signal's group (drums, bass, vocals, other, words, mood; default 1, range 0–2).
  - `reactivity`: the global Reactivity slider, 0–2.

### 6.4 Show format (`types.ts`; the source of truth, round-tripped as `ShowJSON`)
```ts
export interface Show {
  version: 1;
  name: string;
  presetId: string | null;           // preset it came from
  scenes: Scene[];                   // 1–6; variants like "calm", "main", "full"
  timeline: { mode: "auto" | "manual"; entries: TimelineEntry[] }; // manual entries; auto computes them
  palette: { mode: "fixed" | "journey" | "mood" | "chords" | "sections"; ids: PaletteId[] }; // ids: 1 (fixed), 2–5 (journey/sections)
  mix: Record<"drums" | "bass" | "vocals" | "other" | "words" | "mood", number>; // 0–2
  reactivity: number;                // 0–2
  speed: number;                     // 0.25–2, scales time-based motion
  text: TextStyle | null;            // null = no words on screen
  motifs: boolean;                   // add motif layers where the words evoke them
  post: PostConfig[];                // global post chain (after scenes)
  controls: ReactionSlot[];          // the Reactions panel rows (§8.3)
}
export interface Scene { id: string; name: string; layers: LayerConfig[]; post: PostConfig[] }
export interface LayerConfig {
  id: string; type: LayerType; enabled: boolean;
  blend: "normal" | "add" | "screen" | "multiply"; opacity: Param;
  params: Record<string, Param | string | boolean>;   // numbers may be reactive
}
export type Param = number | { base: number; mods: Mod[] };
export interface Mod { signal: SignalId; amount: number; shape: "linear" | "ease" | "exp" | "gate"; attackMs?: number; releaseMs?: number }
export interface TimelineEntry { startMs: number; endMs: number; sceneId: string; transition: Transition; paletteId?: PaletteId }
export interface Transition { kind: "cut" | "crossfade" | "flash" | "zoom" | "sweep" | "glitch"; ms: number }
export interface ReactionSlot { label: string; target: string /* "<layerId>.<param>" or "post.<id>.<param>" */ }
```
- **Validation** (`validateShow`): types exist; params are within each layer's spec ranges; signals exist; ids are unique; ≤ 12 layers per scene; JSON ≤ 512 KiB. The renderer validates before rendering.
- An invalid show fails the render with "This design couldn't be read" and the first problem as the hint.

### 6.5 Rendering pipeline (`engine.ts`, `gl/`)
1. **Scene pass:** the active timeline entry (and, during a transition, the next one) is drawn into its own HDR target (RGBA16F).
   - Layers draw in order with their blend mode and opacity.
   - Background-group layers are skipped in overlay mode.
2. **Scene post chain:** the scene's `post` effects.
3. **Transition:** `crossfade` mixes; `flash` adds white decaying over its length; `zoom` scales the outgoing scene up while the new one fades in; `sweep` is golden-hour's light band moving left → right; `glitch` is RGB-split blocks for 4 frames.
   - Transitions start on the downbeat nearest the section boundary (±1 bar) and last `ms` (default: 1 bar for crossfade).
4. **Text layer** (§6.8), unless the show has no text.
5. **Global post chain:**
   - bloom: 6-level dual-filter downsample/upsample, threshold 0.8, knee 0.5, intensity a param;
   - chromatic aberration, film grain, vignette;
   - **ACES-fit tonemap**;
   - **blue-noise dither** to 8-bit (removes banding in gradients after H.264).
6. **Output:**
   - **opaque:** sRGB 8-bit to the canvas;
   - **overlay:** a canvas twice as tall, with un-premultiplied colour on top and alpha as grey below. Alpha is the tonemapped coverage: `max(r,g,b)` of additive light, clamped, combined with text alpha.

**Shapes:**
- Lines, rings, bars and dots are drawn as **instanced quads with SDF fragment shaders** (analytic anti-aliasing at any resolution, round caps, soft glow falloff).
- Particles are instanced point sprites with SDF discs, streaks, or soft sprites from a small generated atlas: ember, snowflake, raindrop streak, petal, star, heart, bokeh.

### 6.6 Palettes (`palette.ts`)
- **24 palettes**, each `{id, name, bg, colors[4], accent, glow}` as hex, converted to OKLab for every mix:
  - the 20 from song-visualizer (cyber, fire, ice, mono, sunset, matrix, neon, galaxy, lava, ocean, toxic, vaporwave, rose, plasma, gold, arctic, candy, blood, forest, synthwave);
  - golden-hour's four phases as `deep-night`, `dawn`, `golden`, `electric`;
  - The palette backgrounds are made darker than the source where needed, so bloom has room.
- **Modes:**
  - `fixed`: one palette.
  - `journey`: interpolates through 2–5 palettes over `song.progress` (golden hour: deep-night → dawn → golden → electric).
  - `mood`: a palette per emotion:

    | Emotion | Palette |
    |---|---|
    | joy | sunset |
    | love | rose |
    | sadness | ocean |
    | anger | blood |
    | fear | galaxy |
    | calm | arctic |
    | hope | dawn |
    | awe | plasma |

    It crossfades over 2 s at mood changes. Valence shifts lightness ±8% and energy shifts chroma ±15%.
  - `chords`: the base palette rotated in hue so that `colors[0]` sits at the chord root's angle (circle of fifths). It eases over 400 ms per change.
  - `sections`: one palette per section group (A, B, C…), cycling through the listed ids.

### 6.7 Layer catalogue (31 types; every numeric param is reactive)
Each layer type is a file in `layers/` exporting a `LayerDef`:
```ts
export interface LayerDef { type: LayerType; label: string; group: "background" | "shape" | "particles" | "accent" | "highway" | "motif";
  stateful?: boolean; params: Record<string, ParamSpec>; create(ctx: LayerContext): LayerInstance }
export interface LayerInstance { render(f: FrameInput, out: RenderTarget): void; resize?(w: number, h: number): void; dispose(): void }
// FrameInput: { tMs, dtMs, params (resolved numbers/strings/bools), palette (resolved), analysis, signals, w, h, seed, quality, mode }
```
Common params on most layers: `intensity`, `scale`, `x`, `y`, `rotation`, `colorIndex` (0–3 or "cycle"), `glow`. "src" lists where each idea comes from: SV = song-visualizer, GH = golden-hour, PH = pitch-hero, new.

| # | Type | Group | What it draws | Main params (default drivers in presets) | src |
|---|---|---|---|---|---|
| 1 | `gradient` | background | Slow mesh gradient of the palette (4 moving colour points) | speed, contrast, pointDrift ← mood.energy | new |
| 2 | `nebula` | background | Domain-warped fBm clouds with star sparkle | warp ← bass.level, detail, sparkle ← hats, drift | new |
| 3 | `aurora` | background | Curtains or bands of light; left half follows L, right half R; blue/red edge tint by channel level | bands 3–8, height ← mix.mid, tint ← mix.balance, style curtains/bands | SV, GH |
| 4 | `ink` | background | Metaball ink in water, slow and soft (ballads, speech) | blobs 4–12, viscosity, swell ← vocals.level | new |
| 5 | `synthgrid` | background | Horizon sun with scanlines, a perspective grid floor scrolling at tempo, spectrum mountains | gridSpeed ← beat (scroll locked to beats), sunPulse ← kick, mountains ← spectrum | new (SV terrain) |
| 6 | `tunnel` | background | Polar tunnel of rings, a new ring per beat, twisting | ringsPerBeat, twist ← bass.level, speed ← drums.level | SV |
| 7 | `starfield` | background | 3D stars with streaks; warp speed | speed ← drums.level, warp ← drop.pulse, density | SV |
| 8 | `terrain` | background | Scrolling spectrogram terrain lines in perspective under a sky | rows 24–64, height ← mix.level | SV |
| 9 | `image` | background | Cover art or the user's image: fill, slow Ken Burns, blur, breathing zoom | blur 0–40, zoom ← bass.level, kenBurns speed, darken | new (P6 cover) |
| 10 | `kaleido` | background (stateful) | Kaleidoscope of a feedback buffer seeded by the layers beneath | segments 4–16, spin ← bar.phase, zoom ← kick | SV |
| 11 | `bars` | shape | Spectrum bars: straight, mirrored or reflected, rounded SDF caps, peak caps that fall | count 16–128, mirror, height ← spectrum, peakFall | SV |
| 12 | `radial` | shape | Radial bars around a centre glow | count 48–256, innerR ← kick, length ← spectrum | SV |
| 13 | `ribbons` | shape | 3 layered waveform ribbons with thickness and soft trails | layers 1–4, amplitude ← mix.level, source spectrum/wave | SV |
| 14 | `wavering` | shape | Noisy rings that wobble with bass; optional L/R pair tinted blue/red | radius, wobble ← bass.level, pair (GH) | GH |
| 15 | `oscilloscope` | shape | The actual waveform as a glowing line, or an X/Y Lissajous of L/R | mode line/xy, gain, persistence | new |
| 16 | `lissajous` | shape | Layered Lissajous curves; frequency ratio from vocal pitch | ratio ← vocals.pitch, layers 1–3, phaseDrift ← hats | SV, PH |
| 17 | `helix` | shape | Double helix with rungs lit by the spectrum | turns, amplitude ← bass.level | SV |
| 18 | `vortex` | shape | Lines from the centre twisting with energy | lines 24–160, twist ← bass.level | SV |
| 19 | `geometry` | shape | Nested rotating polygons with perturbed edges, rays on hits | shapes 3–8, rays ← kick | SV |
| 20 | `pitchribbon` | shape | A ribbon tracing the vocal melody across the screen over the last 4 s, thicker on held notes | height ← vocals.pitch, width ← vocals.level | new |
| 21 | `embers` | particles | Rising embers and sparks that speed up with energy (bounded count) | count 20–600 ← mix.level, rise ← bass.level | GH |
| 22 | `bursts` | particles | Particles fired from onsets, one colour per instrument, with trails | sources (kick/snare/hats/bass/vocals/other), spread, trail | SV |
| 23 | `fireflies` | particles | Soft drifting motes that brighten with vocals | count, glow ← vocals.level | PH |
| 24 | `ripples` | accent | Expanding rings on events | trigger (kick/snare/beat/word…), maxRadius, width | SV |
| 25 | `shockwave` | accent | A screen-space distortion ring plus flash on drops and downbeats | trigger, strength | new |
| 26 | `sweep` | accent | Golden-hour light band sweeping across on section starts | trigger section/drop, width | GH |
| 27 | `lightrays` | accent | God rays from a point, pulsing | rays, length ← vocals.held, origin | new |
| 28 | `frame` | accent | A glowing frame/border around the picture (for videos) | thickness ← beat.pulse, corners only | new |
| 29 | `highway` | highway | Note highway: lanes = instruments (kick, snare, hats, bass, vocals by default, or 5 bands without stems), hyperbolic perspective, notes hitting the fret on time, sustains from held notes, fret flashes; `reverse` option | lanes, lookahead 1.5–4 s, reverse | SV (both GH modes) |
| 30 | `motif` | motif | One of the 12 motifs, rendered as a particle/overlay effect while active (fire: rising flames + embers; rain: streaks + drops; snow; stars: twinkling field; ocean: wave lines at the bottom; flowers: drifting petals; hearts: soft bokeh hearts; city: bokeh lights; sun: warm rays; night: moon glow + darker grade; storm: lightning on snares; smoke: drifting fog) | motif, amount ← line.active | new |
| 31 | `text` | (special) | The words (§6.8) | | new |

**Post effects** (`post/`): `bloom`, `tonemap`, `dither`, `vignette`, `grain`, `chromatic` (RGB split ← kick, or L/R balance like GH), `feedback` (zoom/rotate/decay trails), `mirror` (kaleidoscope post), `shake` (camera shake ← kick, bounded 0–2% of the short side), `zoompulse` (← beat.pulse), `glitch` (← drop.pulse, rare blocks), `grade` (lift/gamma/gain and saturation, ← mood). Each has a `PostDef` like layers.

### 6.8 Text layer (`text/`)
- **Source:** the `text.json` lines. Without words, there is no text.
- **TextStyle:**
```ts
export interface TextStyle {
  preset: "karaoke" | "pop" | "rise" | "typewriter" | "fade" | "wave" | "subtitle" | "subtitle-boxed";
  font: string;                     // media.Fonts() (P6 §3.6)
  weight: 400 | 700 | 900;
  size: number;                     // % of the short side, 3–12
  color: string; highlight: string; // #rrggbb ("mood" allowed for highlight: from the palette's accent)
  position: "center" | "lower" | "upper";
  showNext: boolean;
  uppercase: boolean;
  outline: number;                  // 0–0.15 of size
  glow: number;                     // 0–1 (text added to bloom input)
  emphasis: { scale: number; glow: number; color: "highlight" | "mood"; sparks: boolean };
  react: { signal: SignalId | null; amount: number };  // e.g. scale with vocals.level
}
```
- **Animations:**
  - `karaoke`: the word fill sweeps across each word as it is sung.
  - `pop`: words appear at their start with a 120 ms overshoot scale.
  - `rise`: the line slides up 3% and fades in, then out.
  - `typewriter`: characters appear between word start and end.
  - `fade`: plain fades.
  - `wave`: words bob along a travelling sine while sung.
  - `subtitle` / `subtitle-boxed`: plain readable subtitles at the bottom; boxed puts them on a black 55% box.
- **Emphasised words** get `emphasis.scale` (default 1.25), more glow, the highlight or mood colour and, when `sparks` is on, a burst of particles at the word.
- **Layout:**
  - Lines wrap at 80% width (16:9) or 88% (9:16); at most 2 lines.
  - Text keeps to the 5% title-safe area. `lower` sits at 14% from the bottom (24% in 9:16).
  - `showNext` draws the next line at 55% alpha and 80% size below.
  - A title card from the song tags (title and artist), when enabled in the look, shows for up to 3 s before the first line.
- **Rasterising:**
  - Each line is drawn once into a shared atlas texture (2048² RGBA8; a second page when full) with Canvas2D at the output resolution: R = fill, G = outline (`strokeText`), B = glow mask.
  - Word boxes come from `measureText`.
  - The shader draws word quads with per-word transforms and colours (karaoke progress per word).
  - On the main thread this uses `OffscreenCanvas` (or a DOM canvas); in the worker, `OffscreenCanvas` 2D.
  - Fonts are referenced by family name (system fonts). A font that isn't available falls back to Arial, with a warning in the render log.

### 6.9 Director (`director.ts`)
**`autoTimeline(analysis, show)`**, used when `timeline.mode = "auto"`:
- Every section gets the scene its preset maps for its label (`preset.director.sceneFor: Record<SectionLabel, sceneId>`). The default map:

  | Section | Scene |
  |---|---|
  | intro, outro, bridge | `calm` |
  | verse, section | `main` |
  | chorus, drop | `full` |

  A scene id missing from the show falls back to `main`.
- Transitions: the preset's `director.transitions[label]`. Default: crossfade, 1 bar; `drop` → flash; `chorus` after `lift` → zoom.
- **Motifs** (when `show.motifs` is on and lines have motifs): a `motif` layer is added on top of the scene for each line's motifs, from 1 beat before the line to its end + 1 bar. At most 2 motifs at once; the newest wins.
- `section.energy` is available to every scene as a signal, so a single scene still builds with the song.

**`manual` mode:** the Song Map lets the user set the scene, palette override and transition per section (§8.3). New entries copy from auto. The manual entries are stored in the show.

### 6.10 Presets (`presets/`, 20)
Every preset is a `Show` template plus `director` rules plus its `controls` (Reactions rows). Each has a one-line description shown on its card.

| # | Preset | Scenes (calm / main / full) — key layers | Palette | Best for |
|---|---|---|---|---|
| 1 | **Golden Hour** | aurora + wavering pair (L/R blue/red) + embers + ripples on kick + sweep on sections | journey deep-night → dawn → golden → electric | Any song; the party look |
| 2 | **Neon Highway** | synthgrid floor + highway (instrument lanes) + bloom; full adds starfield streaks | synthwave | Dance, rock, anything with drums |
| 3 | **Nebula** | nebula + fireflies + pitchribbon; full adds lightrays on held notes | chords (galaxy) | Ambient, ballads, cinematic |
| 4 | **Synthwave** | synthgrid sun + terrain mountains + chromatic on snare | synthwave | Synthpop, retrowave |
| 5 | **Spectrum Classic** | gradient + mirrored bars with peaks + reflection | fixed cyber | Clean, universal |
| 6 | **Radial Pulse** | radial bars + centre glow on kick + ripples; full adds shockwave on downbeats | neon | EDM, hip-hop |
| 7 | **Silk Waves** | ribbons with feedback trails + soft gradient | vaporwave | Pop, R&B |
| 8 | **Warp Drive** | starfield warp on drums + flash on drops + shake on kick | ice | Drum & bass, energetic |
| 9 | **Kaleido Bloom** | nebula base → kaleido + mirror post, spin on bars | plasma | Psychedelic, electronic |
| 10 | **Ink & Water** | ink + fireflies, slow; mood grade | mood | Ballads, speech, poetry |
| 11 | **Particle Storm** | bursts per instrument (each instrument its colour) + feedback | candy | Busy mixes; shows the stems |
| 12 | **Aurora Curtains** | aurora curtains + snow motif-style particles | arctic | Chill, winter, piano |
| 13 | **Tunnel Run** | tunnel rings per beat + zoompulse + glitch on drops | lava | Techno, trance |
| 14 | **Night Terrain** | terrain + starfield sky + moon glow | galaxy | Lo-fi, chill |
| 15 | **Oscilloscope Lab** | oscilloscope XY + lissajous + helix, phosphor green persistence | matrix | Electronic, experimental |
| 16 | **Vortex** | vortex + geometry rays on kick + chromatic | toxic | Heavy, bass music |
| 17 | **Lyric Stage** | image (cover, blurred, breathing) + light rays + dust fireflies + big karaoke text | mood (from cover accent) | Lyric videos |
| 18 | **Mood Field** | gradient + motifs everywhere + mood grade; scenes follow emotion, not sections | mood | Songs with strong imagery; spoken word |
| 19 | **Clean Captions** *(overlay)* | no background; subtitle text that pops on emphasis with mood colour; tiny sparks | mood | Talking-head videos with subtitles |
| 20 | **Frame Pulse** *(overlay)* | frame glow on the beat + corner bursts + karaoke-style captions | neon | Music clips, reels |

- Presets marked *(overlay)* are offered first when the input is a video in "Over the video" mode. All presets work in both modes; background layers are dropped in overlay mode.
- **User presets:** "Save as my preset" stores the show in module state (`visualizer.myPresets`, ≤ 50, ≤ 512 KiB each, ≤ 4 MiB total). They can be renamed and deleted.

---

## 7. Rendering and export

### 7.1 Render job (`modules/visualizer`, actions `render` and `preview`)
1. Validate:
   - the analysis key exists (`Analyzer.Lookup`);
   - ShowJSON ≤ 512 KiB;
   - size, fps and range are within bounds;
   - overlay mode needs a video input;
   - `instrumental` needs stems.
2. **Size:**
   - **full mode:** from aspect and height; the short side is `height`:

     | Aspect | Size at 1080 |
     |---|---|
     | 16:9 | 1920×1080 |
     | 9:16 | 1080×1920 |
     | 1:1 | 1080×1080 |
     | 4:5 | 1080×1350 |

     The same ratios apply at 720/1440/2160.
   - **overlay mode:** the video's display size, scaled so the overlay height is ≤ 1440 (FFmpeg scales it back up, §7.4).
   - **fps:** full mode uses the chosen 30/60. Overlay mode uses the video's fps rounded to 24/25/30/50/60; variable or unknown fps becomes 30.
3. **Textures:** the cover art is extracted as in P6 §7.3 into TempDir. The image background is copied by path; the renderer loads both through `MediaService.URLFor`.
4. **Plan:** write the plan JSON to TempDir. URLs replace paths: the analysis files, textures and the plan itself go through `URLFor`.
5. `broker.Render(...)`. Progress 0–0.9 from the renderer's frame count; the title is "Rendering visuals — <name>".
6. **Finish:**
   - **full mode, no background video:** `MuxOpaque`, using the original or `instrumental.flac`.
   - **full mode with a background video, or overlay mode:** `CompositeOverlay`. Progress 0.9–1, or 0.5–1 when compositing is the slow part.
7. **Outputs:**
   - `<base> (visualizer).mp4` in `Visualizer/`;
   - **preview:** 10 s from `PreviewStartMs` at the chosen size but at most 1080p, to `<support>/cache/visualizer/preview-<jobID>.mp4`. The result is `{previewPath}`. Previews are pruned at start (more than 1 day old) and when the view unmounts.
8. **Result:** `{outputs, previewPath, encoder, speed}`, where speed = media seconds ÷ wall seconds.

### 7.2 Render broker and transport (`core/viz/broker.go`, `viz/RenderHost.tsx`, `viz/worker/*`)
**Broker:**
- One render at a time (a semaphore). A waiting job shows "Waiting for another render to finish".
- `Render` creates a token, records `{jobID, tempDir, expectedBytes: 0, nextSeq: 0}`, and emits `viz:render {token, planUrl, jobId}`.
- **Timeouts:**
  - no `start` within 20 s → AppError "The visual renderer didn't start", hint "Show Toolbox's window and try again";
  - no message for 30 s → "The visual renderer stopped responding".
- **Cancel** (ctx): emits `viz:render-cancel`, waits ≤ 3 s for `cancelled`, then returns `context.Canceled` regardless. Partial files are left to TempDir cleanup.

**RenderHost** (mounted once in `App.tsx` for the main window):
- It listens for `viz:render` and starts **one** `render.worker.ts` per render, posting `{token, planUrl}`.
- It relays worker messages to Go with `System.invoke` (Wails runtime).
- It ignores the echoes Wails sends back (it never adds a `message` listener for them).
- It relays `viz:render-cancel` and `viz:render-ack` to the worker.

**Worker:**
1. Fetches the plan and the analysis (§6.2) and loads the textures (`createImageBitmap(await fetch(url).blob())`).
2. Validates the show. Builds an `Engine` on an `OffscreenCanvas` (twice as tall in overlay mode).
3. **Picks the encoder (§7.3)**, then sends `start`.
4. **For each frame i in [0, n):** `tMs = StartMs + i·1000/fps` → `engine.render(tMs)` → `new VideoFrame(canvas, {timestamp: i·1e6/fps})` → `encoder.encode(frame, {keyFrame: i % (2·fps) == 0})` → `frame.close()`.
5. **Back-pressure:**
   - The worker waits while `encodeQueueSize > 6`.
   - It also waits while bytes sent − acked bytes > 16 MiB.
6. **Batching:** output chunks are packed into ≤ 2 MiB batches and transferred to the main thread, which sends them in order.
7. **Progress** every 15 frames.
8. **Finish:** `flush()`, the last batch, then `done`. Any exception → `error` with a message; the worker then exits.

**Raw message format** (pipe-separated; the base64 payload is last):
```
vz1|<token>|start|{"encoder":"h264-hw"|"h264-sw"|"jpeg","width":1920,"height":1080,"fps":30,"frames":6420}
vz1|<token>|data|<seq>|<base64>          // seq 0,1,2,…; decoded ≤ 2 MiB
vz1|<token>|progress|<frame>|<frames>
vz1|<token>|done|{"frames":6420,"bytes":91234567}
vz1|<token>|cancelled
vz1|<token>|error|{"message":"…","detail":"…"}
```
- **Go checks:**
  - `seq` must equal `nextSeq`; a gap or repeat → error "The renderer sent data out of order".
  - Base64 must decode.
  - The total must stay ≤ 8 GiB.
  - `done.frames` must equal the planned frame count, and the byte count must match.
- **Writes:** data is appended to `TempDir/video.h264` (or `frames.mjpeg`) by a single writer goroutine. It emits `viz:render-ack` every ≥ 4 MiB.
- **base64:** `Uint8Array.prototype.toBase64` when present; otherwise a chunked `btoa(String.fromCharCode(...sub))` over 32 KiB slices.

### 7.3 Encoder choice (`viz/worker/encoder.ts`)
1. **H.264 High:**
   - Codec `avc1.640028` for ≤ 1920×1088, `avc1.640033` up to 4096×2304 (stacked 1080p overlays are 1920×2160).
   - Settings: `avc: {format: "annexb"}`, `latencyMode: "quality"`, `bitrateMode: "variable"`, and `hardwareAcceleration: "prefer-hardware"`. If `isConfigSupported` says no, retry with `"prefer-software"`.
   - **Bitrate:**

     | Output | Bitrate |
     |---|---|
     | 720p30 | 8 Mbps |
     | 1080p30 | 14 Mbps |
     | 1440p30 | 24 Mbps |
     | 2160p30 | 45 Mbps |

     60 fps is ×1.5 and overlay stacks are ×1.6. Vertical uses the same pixel-count rule.
2. **JPEG fallback** (no H.264 encoder):
   - `canvas.convertToBlob({type: "image/jpeg", quality: 0.92})` per frame, concatenated as MJPEG.
   - Go transcodes with libx264 (§7.4).
   - The render log notes "Using the slower JPEG path".
3. No WebGL2 → error "This computer's graphics can't run the visualizer" (with the GPU string in the detail).

### 7.4 FFmpeg (`core/viz/mux.go`)
**MuxOpaque:**
```
ffmpeg -f h264 -framerate <fps> -i video.h264 [-ss <start> -to <end>] -i <audio>
       -map 0:v -map 1:a -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart out.mp4
```
- For MJPEG: `-f mjpeg -framerate <fps> -i frames.mjpeg … -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p`.

**CompositeOverlay** (base = the input video, or a background video looped with `-stream_loop -1`):
```
ffmpeg -i <base> -f h264 -framerate <fps> -i overlay.h264 [-i <audio>]
  -filter_complex "[1:v]split[a][b];[a]crop=iw:ih/2:0:0[c];[b]crop=iw:ih/2:0:ih/2,format=gray[m];
                   [c][m]alphamerge,scale=<W>:<H>:flags=bicubic[ov];
                   [0:v]fps=<fps>[bg];[bg][ov]overlay=0:0:format=auto:shortest=1,format=yuv420p[v]"
  -map "[v]" -map <0:a:0? | 2:a> -c:v libx264 -preset medium -crf 18 -c:a copy|aac -b:a 192k -movflags +faststart out.mp4
```
- **Audio:** copied when it's AAC/MP3 and comes from the base; otherwise AAC 192k. In overlay mode the audio is the video's own.
- **Size:** W×H is the base's display size (rotation applied, as in P6 §3.3), or the plan size for a looping background.
- Progress comes from `media.ProgressTracker`.

---

## 8. Visualizer UI (`tools/visualizer/`)

Steps: **Source → Analyze → Design → Export**.

### 8.1 Source
- **Drop an audio or video file** (or receive a handoff, §9).
  - Audio shows the cover and tags. Video shows a still frame plus duration.
- **Video choice:** "Over the video" (default) or "Use only its sound".
- **Words (SegmentedControl):**
  - "Detect from the audio";
  - "Paste lyrics" (text area);
  - "From a file" (.lrc/.srt/.vtt/.txt);
  - "No words".
  - A handoff pre-selects a fourth option, "From <Lyric Video / Subtitles>".
  - Language select for detect and paste.
- **Separate instruments:** a switch, on by default for audio and off for video. Hint: "Lets drums, bass, vocals and other instruments drive different visuals. Takes about as long as the song."
  - Under it, **"Also save the stems to the Library"** (off by default; §9.7).
- **Read the mood of the words:** a switch, on by default when words are on. Hint: "A small local model reads how each line feels and what it pictures (fire, rain, stars…), in any language."
  - Under it, **"Deeper reading with Local Chat"** (off by default; disabled with "Download a model in Local Chat" when none is ready). Hint: "Slower, picks the words to emphasise and catches subtler lines."
- DepsGate rows appear for:
  - the engine;
  - `stems-default` when stems are on;
  - `whisper-default` when words are detect or paste;
  - `mood-reader` when mood is on.
- Footer: **Analyze**.

### 8.2 Analyze
- Job progress with the stage list:
  1. Separating instruments
  2. Listening (beat, chords, sections)
  3. Finding the words
  4. Reading the mood
- Steps that are cached show "✓ from earlier".
- **The Song Map** is the result, and it stays visible in Design. Lanes, top to bottom, all sharing one time axis with zoom and a playhead:
  - **sections** as labelled coloured blocks (intro/verse/chorus…);
  - **beats and bars** as ticks;
  - **drums** (kick/snare/hats dots), **bass**, **vocals** (energy plus the pitch line), **other**;
  - **chords** as a strip with names;
  - **mood** as a colour strip by emotion, with valence as brightness;
  - **lyrics**: line blocks with emphasised words bold and motif icons.
- **Summary chips:** tempo, key, sections, "4 instruments", "86 lines · English", and warnings as a Banner.
- "Re-analyze with different options" goes back to Source and keeps the cache.

### 8.3 Design
**Left: the preview.**
- A WebGL canvas at the export aspect (letterboxed), driven by an audio `MediaPlayer` (or the video `MediaPlayer` with the canvas as its overlay in "Over the video" mode).
- Controls: play/pause, the Song Map below for seeking, "Full screen" (F key; Esc leaves), and a quality toggle (Auto / Full / Draft) with an fps readout.

**Under the preview: "Why" (live).** Up to 4 short facts for the playhead, updated 4× per second. For example:
> Chorus (B) · energy 0.86 · Kick → Rings 80% · "burning" → Fire motif · Mood: joy → Sunset palette

They are built from the active section, the 3 strongest active mods (amount × current signal), the active motifs and the palette mode.

**Right panel tabs:**
1. **Presets:**
   - A grid of cards with live thumbnails from `PresetThumbs` (`components/viz/`, shared with the `VisualsPicker`, §9.1): one hidden `Engine` renders each visible preset at 320×180 at the playhead every 500 ms.
   - The name and one-line description; "My presets" listed first.
   - Clicking applies the preset; the current design is kept in undo.
2. **Look:**
   - Palette mode and palettes (swatches);
   - Reactivity, Speed, Intensity, Glow, Grain;
   - **Visual mix** faders: Drums, Bass, Vocals, Other, Words, Mood;
   - Motifs on/off;
   - **Text:** style preset cards, font, size, colours, position, show next line, uppercase, emphasis options, "React to" signal and amount, title card.
3. **Reactions:**
   - The preset's `controls` rows. Each row is a label (e.g. "Rings", "Camera", "Background colour"), a driver Select of signal UI names grouped as Instruments, Rhythm, Song, Voice, Words & mood, Drift, and an amount slider (−2..2).
   - "Add reaction" picks any reactive parameter of any layer (a two-level menu: layer → param) and adds a row.
   - Rows show a tiny live meter of the driver.
4. **Layers** (Advanced):
   - The scenes as tabs (calm/main/full…).
   - Each scene's layer stack: drag to reorder; toggle; blend; opacity; add from the catalogue grouped by kind with icons; duplicate; delete.
   - Selecting a layer shows its params. Each numeric param has a ⚡ button that opens its mods list (signal, amount, shape, attack/release).
   - Post effects per scene and global.
5. **Timeline:**
   - Director **Auto / Manual**.
   - The Song Map's section lane becomes editable: click a section to pick its scene, palette override and transition (with a preview of the transition when played).
   - "Reset to auto".

**Undo/redo** (Ctrl+Z / Ctrl+Shift+Z, 100 steps) covers every design change.
- The current design is kept in module state (`visualizer.lastShow`) so it survives a restart. The analysis key is kept per input path, so returning to a file reuses the analysis.

### 8.4 Export
- **Size:**
  - Aspect (16:9 / 9:16 / 1:1 / 4:5; hidden in overlay mode, which keeps the video's shape);
  - Quality (720p / 1080p / 1440p / 2160p — 2160p only when the encoder supports it, checked with `isConfigSupported`);
  - FPS (30/60; overlay mode follows the video).
- **Range:** whole song, or the selection on the Song Map (shift-drag).
- **Audio:** Original / Instrumental (with stems).
- **Background** (full mode): none / cover art / image… / video… (looped under the visuals; this uses the overlay composite).
- **Buttons:**
  - "Render 10 s preview" from the playhead → plays the clip.
  - "Render video" → progress with fps and "×N real time", then a result card (video, Open, Show in folder, Send to).
- If the encoder is the JPEG fallback, a note says "This computer can't encode video in the window, so rendering will be slower."

---

## 9. Visuals in Lyric Video and Subtitles

- **With lyrics:** Lyric Video's wizard gets a **Visuals step**.
- **Without:** Subtitles' "burn into a video", which now also works from an audio file, gets a **Visuals** choice.
- In both, the user picks either:
  - **Quick:** a card that moves to your own song, then render;
  - **Full designer:** everything the Visualizer can do, embedded in the step, fed by the tool's own lyrics or cues and by the separated instruments.
- The tool keeps drawing its own words on top.

### 9.1 `VisualsPicker` (`frontend/src/components/viz/VisualsPicker.tsx`, shared)
```ts
interface VisualsPickerProps {
  inputPath: string;                 // the song / audio / video the tool works on
  lines: TimedLine[] | null;         // the tool's timed text (lyrics or cues), for word reactions and mood
  value: VisualsSpec | null;         // { showJson, stems, useWords } (= core/viz.VisualsSpec)
  onChange(v: VisualsSpec): void;
  mode: "background" | "overlay";    // overlay = over a video (background layers dropped)
  aspect: number;                    // the tool's output aspect, for the thumbnails
  playheadMs?: number;               // the tool's player position, if it has one
}
```
**What it shows, top to bottom:**
1. **Listening (only when needed).**
   - `VisualizerService.AnalysisFor(path, stems)` is checked first.
   - If there is no analysis yet, it submits a `visualizer` analyze job by itself: stems as chosen (off by default), words `given` from `lines` when `useWords`, mood on when the reader is installed.
   - Inline progress shows "Listening to the song… 40%" (about 10 s without stems). The cards show still previews until it finishes.
2. **Cards:**
   - "My designs" (saved in the Visualizer), then the 20 presets. In `overlay` mode the overlay presets come first.
   - Each card is a **live thumbnail reacting to this file**, rendered by the shared thumbnail engine (§8.3), at the tool's playhead or, without a player, looping the loudest 8 s.
   - A click selects the card.
3. **Two simple controls:**
   - **Intensity** (`show.reactivity`, 0–2);
   - **Colours**: "Design's own" or one of 8 palette swatches, which sets `palette = {mode: "fixed"}`.
4. **Two switches:**
   - "Separate instruments", with the hint "richer reactions; takes about as long as the song". It re-analyses.
   - "React to the words" (`useWords`, shown when `lines` exist, on by default).
5. **"Open the full designer"**, a secondary button. It switches the step to the embedded designer (§9.4), keeping the selection.

**Around it:**
- The picker never renders text: the tool draws its own words.
- `VisualsCanvas` (same folder) is the live background for the tools' previews: `{spec, analysis, timeMs, aspect}` → a WebGL canvas with one shared `Engine`.

### 9.2 Lyric Video
- **`Look`:**
  - `Background` gains `"visualizer"`.
  - `Look` gains `Visuals viz.VisualsSpec` (`json:"visuals"`).
  - The default stays `blur-cover` until the user picks visuals.
- **Wizard steps: Song → Lyrics → Visuals → Look → Render.** The new Visuals step sits between Lyrics and Look.
- **Visuals step:**
  - **Top: "Instruments" panel.**
    - "Separate instruments (drums, bass, vocals, other)" switch: on by default when `stems-default` is installed; DepsGate otherwise.
    - "Also save the stems to the Library" checkbox (off by default): the 4 FLAC stems go to `Stems/<song>/`, named as the Stems tool names them (`AnalyzeOptions.SaveStems`, §9.7).
    - The separation and the listening start by themselves when the step opens. It is one `visualizer` analyze job with the lyric sheet as `given` words and the mood reader on, cached, with progress inline.
    - When separation is done, the Song Map's instrument lanes appear. The Song step's Audio choice (Original / Instrumental) then uses the 4-stem instrumental when there is one.
  - **A SegmentedControl:**
    - **Quick:** the `VisualsPicker`.
    - **Full designer:** the embedded `VisualDesigner` (§9.4), with the Song Map, Presets, Look (colours and motion), Reactions, Layers, Timeline and the Why readout. The words are drawn as Lyric Video's own preview text over the designer's canvas.
    - **Classic background:** no visuals; the Look step shows the P6 backgrounds.
  - The step's footer shows the chosen design ("Golden Hour", "Custom design" or "Classic") and Next.
- **Look step:**
  - With visuals, the background area shows "Visuals: <design>" with a "Change" link back to the Visuals step. Text options are unchanged.
  - The live preview's background becomes `VisualsCanvas` under the existing HTML lyrics. The "approximate" note stays; Render preview is exact.
  - The old `Visualiser` strip option (wave/bars) is hidden with visuals.
- **Render / preview** (`render.go`), with `Background == "visualizer"`:
  1. `viz.RenderVisuals(…, mode "opaque", w×h of the canvas, 30 fps, lines = the sheet when UseWords)`. Progress 0–0.6, or 0–0.8 for preview. Preview renders only the 10 s range.
  2. The FFmpeg graph takes `-f h264 -framerate 30 -i visuals.h264` as its background input instead of the cover/colour source. The ASS lyrics, title card and audio (original or instrumental) are unchanged. Progress 0.6–1.
  - Validate: `"visualizer"` needs `Visuals.ShowJSON` (≤ 512 KiB).
- **"Make the whole video in Visualizer"**, a link in the Visuals step: hands off `{inputs: [song], seed: {kind: "timed-text", from: "lyric-video", lines, look}}` for reactive karaoke words drawn by the engine (§9.5).

### 9.3 Subtitles
- **`Cue` gains `Words []CueWord`** (`json:"words,omitempty"`, `CueWord {startMs, endMs, text}`):
  - Generate fills it from the Whisper words it already reads.
  - Editing a cue's text re-spreads its words by character share. Shifting times shifts the words.
  - Split and merge split or concatenate them.
  - `.srt`/`.vtt` saving ignores them, and loading files leaves them empty.
- **Burn from an audio file** (new; today burn needs a video). New options:
  ```go
  Canvas          string           `json:"canvas"`          // burn, audio input: "16:9" | "9:16" | "1:1"
  CanvasHeight    int              `json:"canvasHeight"`    // 720 | 1080 (short side)
  Background      string           `json:"background"`      // burn, audio input: "visualizer" | "color" | "image"
  BackgroundColor string           `json:"backgroundColor"` // #rrggbb
  BackgroundPath  string           `json:"backgroundPath"`  // image
  Visuals         *viz.VisualsSpec `json:"visuals"`         // audio: the background design; video: optional overlay visuals
  ```
  - Visualizer background: `RenderVisuals(opaque, canvas size, 30 fps, lines = cues)` → `MuxOpaque` with the ASS burned in (§9.6) and the input's audio.
  - Colour: a `color` source. Image: fill + crop.
  - The output is `<base> (subtitled).mp4`, with the font size rules of P6 §5.4 applied to the canvas.
- **Burn onto a video with visuals** (optional): with `Visuals` set, `RenderVisuals(overlay, the video's size, its fps, lines = cues)` → `CompositeOverlay` with the ASS burned in **after** the overlay, so subtitles stay on top and readable.
- **Export step:**
  - The Burn card gains a **"Visuals"** row.
  - **For a video:** "None" (default) or "Add visuals over the video". The latter shows Quick (`VisualsPicker`, `overlay` mode) and "Open the full designer".
  - **For audio:** the burn card is now enabled and titled **"Make a video"**, with Canvas, Quality and Background: **Visualizer (default)** / colour / image.
    - Visualizer shows the "Separate instruments" switch (off by default here; speech rarely needs it), Quick (`VisualsPicker`, `background` mode) and "Open the full designer".
  - **"Open the full designer"** opens the embedded `VisualDesigner` in a full-height sheet over the Subtitles view. The cues are its `given` words and are drawn as the burn-style preview text. "Done" closes the sheet and keeps the design; Esc asks to discard changes.
  - The burn style's mini preview draws the cue over `VisualsCanvas` (or the colour or image) at the current time.
- **"Make it fully reactive in Visualizer"**, a link: hands off `{inputs: [file], seed: {kind: "timed-text", from: "subtitles", lines: cues, overlay: <is video>}}`.

### 9.4 The embedded designer (`tools/visualizer/designer/VisualDesigner.tsx`)
The Visualizer's Design step (§8.3) is built as one component, so Lyric Video and Subtitles can embed it.
```ts
interface VisualDesignerProps {
  inputPath: string;
  analysis: Analysis;                 // loaded by the host (useVisualsAnalysis)
  show: Show;
  onChange(show: Show): void;         // every edit; the host owns undo (useShowHistory, exported too)
  aspect: number;                     // locked when the host fixes the output shape
  mode: "full" | "overlay";
  player: MediaPlayerHandle | null;   // the host's player drives time; null = the designer's own audio player
  text: "engine" | { overlay: (rect: ContentRect, timeMs: number) => ReactNode }; // engine text (Visualizer) or the host's preview text
  tabs?: Array<"presets" | "look" | "reactions" | "layers" | "timeline">;          // default: all
  onSavePreset?(show: Show): void;    // "Save as my preset" (writes visualizer.myPresets)
}
```
- **Inside the Visualizer:** `text: "engine"` and the Look tab includes the text section.
- **Inside Lyric Video and Subtitles:** the host's overlay draws its words, and the Look tab hides the text section. Shows passed to `RenderVisuals` always have `text: null`.
- **Shared hooks** (`tools/visualizer/designer/`):
  - `useVisualsAnalysis(path, {stems, saveStems, lines, mood})`: looks up `AnalysisFor`, submits the analyze job when needed, follows its progress, and loads the files;
  - `useShowHistory(initial)`: undo and redo, 100 steps.
- **State:** the hosts keep their design in their own options and module state, and their sheets and cues in their view stores. Nothing is handed between tools.

**The handoff seed** (only for sending timed text to the Visualizer, §9.5):
```ts
// state/ui.ts
export interface Handoff { moduleId: string; inputs: string[]; seed?: ToolSeed }
export type ToolSeed = {
  kind: "timed-text"; from: "lyric-video" | "subtitles"; lines: TimedLine[];
  look?: { font: string; textColor: string; highlightColor: string; karaoke: boolean; position: "center" | "lower" };
  overlay?: boolean;
};
```

### 9.5 Timed text into the Visualizer
The Visualizer reads a `timed-text` seed on `takeHandoff`:
- Words become "From Lyric Video/Subtitles" (`Words: "given"` with those lines).
- The look's font and colours prefill the text style.
- From Lyric Video, the **Lyric Stage** preset is selected; from Subtitles, **Clean Captions**, in "Over the video" mode when `overlay`.

### 9.6 FFmpeg helpers with burned text
`MuxOpaque` and `CompositeOverlay` (§7.4) take an optional `ass string`, a file name in the job's TempDir.
- When it is set, FFmpeg runs with TempDir as its working directory (P6 §3.3).
- `,ass=subs.ass` is appended to the final video chain (after `overlay` in the composite).
- `MuxOpaque` then re-encodes (`libx264 -preset medium -crf 18 -pix_fmt yuv420p`) instead of copying.

### 9.7 Saving stems from an analysis
- `viz.AnalyzeOptions` gains `SaveStems bool` (`json:"saveStems"`), which only applies with `Stems`.
- After separation, the analyze job copies the 4 FLAC stems into the Library as outputs under `Stems/<base>/`, named `<base> - <Stem>.flac` as `stems.separate` names them in the Stems tool (P2 §6). It does this before deleting its own copies.
- If the analysis is cached and the stems were already deleted, separation runs again (the features are reused).

---

## 10. Bound API changes (summary)
- **New:** `visualizer.Service`:
  - `Defaults() Options`
  - `Enqueue(inputs []string, opts Options) ([]core.Job, error)`
  - `Analysis(key string) (viz.AnalysisRef, error)`
  - `AnalysisFor(path string, stems bool) (viz.AnalysisRef, bool)` (reuse on return)
  - `Fonts() []string`
  - `ChatStatus() (model string, ready bool)`
- **`visualizer.Options`:**
```go
type Action string // "analyze" | "render" | "preview"
type Mode string   // "full" | "overlay"
type Options struct {
    Action  Action             `json:"action"`
    Analyze viz.AnalyzeOptions `json:"analyze"`        // analyze
    AnalysisKey string         `json:"analysisKey"`    // render/preview
    ShowJSON    string         `json:"showJson"`       // ≤ 512 KiB
    Mode        Mode           `json:"mode"`
    Aspect      string         `json:"aspect"`         // "16:9" | "9:16" | "1:1" | "4:5" (full)
    Height      int            `json:"height"`         // 720 | 1080 | 1440 | 2160 (short side, full)
    FPS         int            `json:"fps"`            // 30 | 60 (full)
    StartMs     int64          `json:"startMs"`        // 0 = start
    EndMs       int64          `json:"endMs"`          // 0 = end
    Audio       string         `json:"audio"`          // "original" | "instrumental"
    Background  string         `json:"background"`     // "none" | "cover" | "image" | "video" (full)
    BackgroundPath string      `json:"backgroundPath"`
    PreviewStartMs int64       `json:"previewStartMs"`
    Seed        int64          `json:"seed"`
}
type Result struct {
    Action      Action           `json:"action"`
    Analysis    *viz.AnalysisRef `json:"analysis"`    // analyze
    PreviewPath string           `json:"previewPath"` // preview
    Outputs     []string         `json:"outputs"`     // render
    Encoder     string           `json:"encoder"`
    Speed       float64          `json:"speed"`
}
```
- **`visualizer.Module`** implements `core.ModelProvider` (preset `mood`).
- **`lyricvideo.Look`:** `Background` gains `"visualizer"` and a new `Visuals viz.VisualsSpec` field.
- **`subtitles`:**
  - `Cue` gains `Words`.
  - `Options` gains `Canvas`, `CanvasHeight`, `Background`, `BackgroundColor`, `BackgroundPath` and `Visuals`.
  - `Validate` allows burn on an audio input when a background is set.
- **`Handoff`** gains `seed` (§9.4).
- **New events:** `viz:render`, `viz:render-ack` and `viz:render-cancel` (§4.5).

---

## 11. Test plan

### 11.1 Go
- **`core/lyrics`:** the moved Lyric Video tests, plus `SpreadWords` and `WordsToLines` edge cases.
- **`core/viz`:**
  - **Broker**, with a fake raw-message source:
    - happy path and ordering;
    - seq gap or repeat; wrong token; wrong origin; child frame;
    - start and idle timeouts; cancel; ack cadence;
    - frame/byte mismatch; the 8 GiB cap.
  - **Plan writing:** URLs, not paths.
  - **Mux / composite** arg tables: rotation, VFR → 30, audio copy vs AAC, loop base, MJPEG.
  - **Cache:** keys, reuse per step, prune by age and size.
  - **Mood:**
    - the reader result is mapped into `text.json`;
    - a missing reader → music mood plus a warning;
    - with a fake `TextGenerator`, the chat merge rules (confidence < 0.5 replaces; the motif union capped at 3).
  - **Deeper reading:** with a fake `TextGenerator`:
    - batching and context lines;
    - schema retries and the line-by-line fallback;
    - emphasis filtering;
    - mood blending and the no-model keyframes;
    - the emotion table.
- **`modules/visualizer`:**
  - `Validate` tables;
  - `Run` analyze and render against fakes (a fake engine caller, a fake broker that writes a canned H.264);
  - outputs and result fields.
- **`core/viz` SaveStems:** stems are copied as outputs with Stems-tool names before deletion; on a cached analysis without stems, separation runs again.
- **`core/viz.RenderVisuals`:** with fakes. The show's text is forced to null, progress maps into [p0, p1], the analysis is reused when cached, and lines are passed as `given` words.
- **`modules/subtitles`:**
  - words carried through generate, edit, split, merge and shift;
  - burn from audio: Validate (canvas and background rules), and the argument graph for visualizer, colour and image backgrounds;
  - burn on video with `Visuals`: overlay then ASS.
- **`modules/lyricvideo`:** the `visualizer` background replaces the background input in the graph; preview renders only its 10 s range; Validate needs `Visuals.ShowJSON`.
- **`modules/visualizer`:** `ModelPresent`/`FetchModel` for `mood`, with the OS-specific file chosen by `runtime.GOOS/GOARCH`.
- **Integration** (`-tags integration`):
  - `MuxOpaque` and `CompositeOverlay` with a libx264 Annex-B stream generated by FFmpeg in the test as the "renderer output". The test checks:
    - the frame count, duration and audio;
    - the overlay alpha: a known red square with half alpha over a grey video gives the expected pixel ±3.

### 11.2 Python (`sidecar/tests/test_viz.py`, generated signals like `analysis_bench.py`)
- **Tempo** within ±1 bpm on the 120 bpm track; beat count ±2; the downbeat phase matches the kick pattern (bar-level kick accent).
- **Chords:** a 4-chord loop (Am F C G) is ≥ 85% correct per beat; key A minor or C major in the top 2.
- **Sections:**
  - a boundary within ±1 bar of a +8 dB jump, labelled `drop`;
  - the intro is detected for a quiet first 16 s;
  - the repeated loud group is labelled `chorus`.
- **Pitch:** a synthetic sung sine at MIDI 64 for 1 s gives a held note `[…, 64]`; unvoiced noise gives none.
- **Features:**
  - shapes, block offsets and the u8 range;
  - `fps` 30 for a fake 21-minute duration (mocked length);
  - a 61-minute input is a validation error.
- **Stem fallbacks** produce the same channel ids without stems.
- **Mood reader** (`test_viz_mood.py`):
  - The labelled set `tests/data/mood_lines.json` has ≥ 120 lines written for the tests, ≥ 25 of them non-English across ≥ 5 languages, with an emotion and motifs for each. The 34 lines of `.dev/p7-research/nlp/bench.py` are a seed, and none of them may be an anchor.
  - The test runs only when the model is present (`TOOLBOX_SLOW=1` downloads it).
  - Targets: emotion accuracy ≥ 0.75 overall and ≥ 0.6 on non-English; motif precision ≥ 0.8 with recall ≥ 0.5.
  - Unit tests without the model use a fake encoder: pooling and normalisation, the anchor cache key, the valence/energy softmax table, empty and symbol-only lines.
- **Slow** (`TOOLBOX_SLOW=1`): real `htdemucs` on a 20 s mix, then `viz.analyze` with stems.

### 11.3 Frontend (Vitest, jsdom, no WebGL)
- **`analysis.ts`:** ranged fetch reassembly (a mocked 206 sequence), sampling and interpolation, prefix sums, event queries, schema version errors.
- **`signals.ts`:** pulses (τ and strength), envelopes (attack/release on a step), fallbacks without stems or words, the modulation formula with mix gains, reactivity and clamping.
- **`palette.ts`:** OKLab round trip; `journey` at 0, 0.5 and 1; mood crossfade timing; chord hue rotation.
- **`director.ts`:** the auto timeline on a fixture analysis (labels → scenes, downbeat snapping, the drop flash, motif insertion and the cap of 2), and manual overrides.
- **`types.ts`:** `validateShow` (every rule in §6.4). **Every preset validates.** Every preset only references existing layers, params and signals, and has ≥ 3 `controls`.
- **Transport:** batching ≤ 2 MiB, seq numbering, base64 fallback equals native, back-pressure waits on acks, message format.
- **Text layout:** wrap and safe areas at 16:9 and 9:16 with a stub `measureText`; animation timing functions.
- **UI:**
  - Source options and DepsGate visibility;
  - the analyze stage list from job progress;
  - Song Map lanes render from a fixture;
  - Reactions add, change and remove update the show; Layers reorder and delete;
  - undo/redo;
  - Export option rules (2160p gating, overlay hiding aspect);
  - the `timed-text` seed prefills the Source;
  - `VisualDesigner` works with the host's text overlay and a locked aspect, hides the text section, and never puts text into the show it emits;
  - `useVisualsAnalysis` reuses a cached analysis, submits one with `saveStems` when asked, and reports progress.
- **`VisualsPicker`:**
  - it starts an analysis only when `AnalysisFor` misses, and shows its progress;
  - selecting a card calls `onChange` with that preset's show;
  - Intensity and Colours edit the show;
  - "Open the full designer" keeps the selection.
- **Lyric Video:**
  - the wizard has the Visuals step;
  - analysis starts on entering it, with the sheet as words;
  - Quick, Full designer and Classic switch correctly and persist;
  - "Also save the stems" sets `saveStems`;
  - Look shows "Visuals: <design>" and hides the strip option;
  - the "whole video" link hands off `timed-text`.
- **Subtitles:**
  - an audio input enables "Make a video" with Visualizer as the default background;
  - a video input shows the Visuals row with None as the default;
  - the designer sheet keeps the design on Done and asks before discarding on Esc.

### 11.4 Visual lab and checks (`viz/lab/VizLab.tsx`, `TOOLBOX_VIZLAB=1`)
- A dev-only view (`TOOLBOX_VIEW=vizlab` with `TOOLBOX_VIZLAB=1`; otherwise the route doesn't exist):
  1. loads a fixture analysis from `.dev/p7/fixture/` (any analysed song);
  2. renders every preset at 5 moments (intro, verse, chorus, drop or loudest bar, outro) at 960×540;
  3. sends PNGs over the raw channel (`vzlab|…`, accepted only with that env var) into `<support>/tmp/vizlab/<preset>-<moment>.png`;
  4. writes `fps.json` (mean fps of 300 preview frames per preset at 1280×720) and `hash.json` (pixel hashes of 10 frames per preset).
- Builders of layers and presets use it to see their work (they can read PNGs).
- The architect reviews the contact sheets in Wave 3.
- **Determinism check:** two lab runs produce the same `hash.json`.
- **Parity check:** the lab renders frames via the export worker path (encode skipped, `readPixels` hashed) and the preview path, and compares them.

### 11.5 Mac checklist (new steps)
1. The preview renders and plays in sync.
2. Export uses `h264-hw` (render log) at ≥ 2× real time at 1080p.
3. Exporting with the window hidden works.
4. Raw-message throughput: a 4-minute export finishes and `done` arrives without timeouts.
5. Text renders in the worker with the chosen fonts; a CJK lyric falls back to a system font.
6. The overlay composite on a 9:16 iPhone HEVC video keeps rotation and audio.
7. The JPEG fallback path (forced with `TOOLBOX_VIZ_FORCE_JPEG=1`) still produces a correct video.

---

## 12. Work packages

### Wave 0: foundation (architect)
1. Archive P6's spec (done); update `docs/ROADMAP.md` (done).
2. `core/lyrics`, moved with its tests; Lyric Video converts at its boundary.
3. `core/viz` types, the Analyzer/RenderBroker/mux signatures with stub bodies, the cache paths and prune; RawMessageHandler wiring and events in `main.go`/`api/events.go`.
4. `modules/visualizer` stub (§4.6) with final options, `Validate` and service, plus the mood reader's pins and `ModelProvider` stub.
   - Packs (§4.7): the `mood-reader` component with its measured size.
   - Engine 0.7.0 with the `viz.analyze`, `viz.mood` and `viz.prefetch` stubs.
   - The new option fields of Lyric Video (`Look.Visuals`) and Subtitles (§9.3), with `Validate`.
   - `core/viz.VisualsSpec` and the `RenderVisuals` signature.
5. Bindings, `lib/api.ts` re-exports, icons, the `Handoff.seed` type, the tool view stub, `RenderHost` mounted.
6. **`viz/` working minimum:**
   - `types.ts` (final), `validateShow`, and `analysis.ts`, `signals.ts` and `palette.ts` complete with tests;
   - the GL core: context, targets, bloom, tonemap, dither, the overlay output;
   - the layer and post registries;
   - reference layers `gradient` and `bars`; the reference preset `spectrum-classic`;
   - the engine rendering a show at a time;
   - the worker skeleton with the message protocol and the H.264 encoder (no JPEG yet);
   - VizLab with the PNG sink.
   - Builders branch from a state where a preset renders end to end in the lab.
7. **CLAUDE.md** Phase 7 section; `docs/MAC-CHECKLIST.md` Phase 7 steps.

### Wave 1 (parallel)
| WP | Owns | Acceptance |
|---|---|---|
| **AN1 Analysis engine** | `sidecar/.../handlers/viz.py`, `toolbox_sidecar/viz/**`, `sidecar/tests/test_viz.py` | §5.2–5.3, §5.5 audio schema; §11.2 |
| **AN2 Analysis orchestration** | `core/viz/analyze.go`, `meaning.go`, `cache.go`, `visuals.go` (`RenderVisuals`) (+ tests) | §4.3 visuals, §5.1, §5.4 merge rules, §5.5 text schema; §11.1 |
| **AN3 Mood reader** | `toolbox_sidecar/viz/mood.py`, `anchors.json`, the `viz.mood`/`viz.prefetch` parts of `handlers/viz.py` (AN1 owns the rest of that file; a marked block), `sidecar/tests/test_viz_mood.py`, `tests/data/mood_lines.json` | §5.4 reader; §11.2 targets |
| **RB1 Render broker + FFmpeg** | `core/viz/broker.go`, `mux.go`, `plan.go` (+ tests, integration) | §7.2 (Go side), §7.4; §11.1 |
| **VM1 Visualizer module** | `modules/visualizer/**` (except frozen files) | §7.1, §10; Go tests against fakes |
| **RH1 Render host + worker** | `viz/RenderHost.tsx`, `viz/worker/**` | §7.2 (web side), §7.3; transport tests; a real export from VizLab |
| **L1 Backgrounds** | `viz/layers/{nebula,aurora,ink,synthgrid,tunnel,starfield,terrain,image,kaleido}.ts` + shaders | §6.7 #2–10; lab PNGs; ≥ 50 fps each at 720p |
| **L2 Shapes + highway** | `viz/layers/{radial,ribbons,wavering,oscilloscope,lissajous,helix,vortex,geometry,pitchribbon,highway}.ts` (+ `bars` polish) | §6.7 #11–20, #29 |
| **L3 Particles, accents, motifs** | `viz/layers/{embers,bursts,fireflies,ripples,shockwave,sweep,lightrays,frame,motif}.ts`, the sprite atlas generator | §6.7 #21–28, #30 |
| **PX1 Post + transitions** | `viz/post/**` (beyond Wave 0's), transitions in `engine.ts`' transition module (`viz/transitions.ts`) | §6.5 steps 3 and 5, §6.7 post list |
| **TX1 Text layer** | `viz/text/**` | §6.8; layout tests; lab PNGs at 16:9 and 9:16 |
| **SB3 Subtitles words** | `modules/subtitles` Cue words + the edit operations in `tools/subtitles/**` | §9.3 (words), tests. SB4 builds on it in Wave 2 |

### Wave 2 (parallel, after Wave 1 merges; VP1 also needs PR1's preset list, so it starts with the reference preset and picks up the rest when PR1 merges)
| WP | Owns | Acceptance |
|---|---|---|
| **PR1 Presets + director** | `viz/presets/**`, `viz/director.ts` | §6.9, §6.10: 20 presets that validate; contact sheets reviewed by the architect; each ≥ 50 fps at 720p in the lab |
| **UI-V1 Source + Analyze + Song Map** | `tools/visualizer/{SourceStep,AnalyzeStep,SongMap}*` | §8.1, §8.2 |
| **UI-V2 Design + Export** | `tools/visualizer/designer/**` (`VisualDesigner`, `useVisualsAnalysis`, `useShowHistory`, Preview, WhyPanel, the tabs), `tools/visualizer/{DesignStep,ExportStep,useSeed}*`, `VisualizerView.tsx` | §8.3, §8.4, §9.4, §9.5 |
| **VP1 Visuals picker** | `frontend/src/components/viz/**` (`VisualsPicker`, `VisualsCanvas`, the shared `PresetThumbs` thumbnail engine that UI-V2's Presets tab also uses) | §9.1; FE tests |


Palette commands for the Visualizer (open, Analyze, Render, Render preview, Full screen) go in the marked block of `shell/useBuiltinCommands.ts` (UI-V2).

### Wave 3 (parallel, after UI-V2 and VP1 merge)
| WP | Owns | Acceptance |
|---|---|---|
| **LV3 Lyric Video visuals** | `modules/lyricvideo` (`Look.Visuals`, the render/preview graph) + `tools/lyric-video/**` (the Visuals step with Instruments panel, Quick / Full designer / Classic, the Look summary, the preview background, the "whole video" link) | §9.2; Go + FE tests; a real render |
| **SB4 Subtitles visuals** | `modules/subtitles` (audio burn, overlay burn) + `tools/subtitles/**` (Make a video, the Visuals row, the designer sheet, the reactive link) | §9.3; Go + FE + integration tests |

### Wave 4: integration (architect)
1. Merge, regenerate bindings, and run every check, the engine e2e (extended with `viz.analyze` on the synthetic track with stems) and `wails3 build`.
2. VizLab contact sheets: review all 20 presets × 5 moments and send back any that look poor.
3. Determinism and parity checks.
4. Measurements against §13.
5. A real song end to end (detect + mood reader; then with Deeper reading).
6. A subtitled talking-head video in overlay mode.
7. A Lyric Video through the Visuals step: once Quick, once with the full designer, stems on and saved.
8. A podcast-style audio file → Subtitles "Make a video" with a Visualizer background.
9. The `timed-text` handoffs.
10. No listeners during a render.
11. The mood-reader download in a fresh sandbox (Music pack): disk use within ±10% of the card.
12. DECISIONS.md and the summary.

---

## 13. Acceptance criteria
1. **No sockets:**
   - A full export runs with no listening socket other than llama-server's (P5).
   - The raw-message channel ignores wrong tokens, wrong origins and child frames (tests).
2. **Analysis (Windows box, 4-minute song):**
   - audio features without stems ≤ 20 s;
   - with stems + detect + mood reader ≤ 1.5× the song length (Deeper reading adds the chat model's reply time);
   - a second analysis of the same file ≤ 2 s (cache).
   - On a real song: tempo matches a manual count (or its double or half), and the chorus is labelled on at least 2 of its occurrences.
3. **Export speed (Windows box):**
   - 1080p30 full ≥ 4× real time for the 3 heaviest presets (measured in the render log);
   - 2160p30 ≥ 1× real time;
   - a 1080p overlay over a 1080p 30 fps video ≥ 1× real time end to end (composite included).
4. **Preview:** every preset ≥ 50 fps at 1280×720 (VizLab `fps.json`).
5. **Exactness:**
   - two renders of the same plan give identical pre-encode hashes (VizLab);
   - preview and export frames match (VizLab parity, mean absolute difference ≤ 1/255);
   - the exported video's frame count equals duration × fps, and its audio stays in sync (±1 frame at the end of a 4-minute render).
6. **Reactivity you can see:**
   - on the contact sheets, every preset differs visibly between verse and chorus;
   - on a kick vs no-kick frame pair, every preset with a kick-driven control changes measurably (mean pixel difference > 2%);
   - the "Why" readout names the drivers that are actually active.
7. **Words:**
   - with lyrics, karaoke text is in sync (word fill within ±1 frame of the word times);
   - emphasised words stand out;
   - with the mood reader alone, the mood strip and motifs follow the lyrics on a test song (e.g. a line about fire shows the fire motif); the mood-reader targets in §11.2 pass.
8. **Video overlay:**
   - Over a subtitled talking-head video, Clean Captions shows readable subtitles that pop on emphasis.
   - The output keeps the video's size, rotation, fps and audio.
9. **Visuals in the other tools:**
   - In Lyric Video's Visuals step, a Quick choice takes ≤ 2 clicks after ~10 s of listening (more with stems), and the preview moves to the song.
   - The render has the visuals under the libass lyrics.
   - The Visuals step's full designer edits the design with the lyrics shown, and the stems can be saved from it.
   - Subtitles makes a captioned video from an audio file with a Visualizer background, and adds overlay visuals under the subtitles of a video.
   - The `timed-text` handoffs open the Visualizer with the defaults of §9.5.
10. **Quality:** no visible banding in dark gradients after export (dither), no jagged lines (SDF), no flicker from raw signals (envelopes) — checked on the contact sheets and one exported video.
11. **Housekeeping:**
    - all checks are clean (`go vet`, `go test`, pytest, `npm run check`, gofmt, darwin cross-vet);
    - the engine e2e passes;
    - CLAUDE.md, the Mac checklist, ROADMAP and DECISIONS are updated.

## 14. Risks
- **Raw messages on macOS** (WKScriptMessageHandler) aren't measured. If they're slow, a 4-minute 1080p export (~400 MB of base64) could take minutes. Two mitigations:
  - **Bitrate:** export bitrate scales down automatically if the measured transport rate is below 3× the stream rate. The worker measures it from acks.
  - **Fallback:** the JPEG path doesn't help here, so the fallback is a lower bitrate with a note.
  - Mac checklist step 4.
- **Hardware encoder availability** varies by GPU and driver. The software H.264 path in Chromium (OpenH264) was 65 fps at 1080p here, and the JPEG path is last.
- **Analysis quality on real music:**
  - Beat tracking and section labels are heuristics. Labels can be wrong (the Song Map lets users reassign scenes per section, and nothing depends on a label being right).
  - Whisper on singing is weak (P6 risk), so "Paste lyrics" stays recommended.
- **The mood reader is approximate.** It scored 0.86 on English test lines and 4 of 6 on other languages in research, and lines that only hint at a feeling come out weak. Weak readings count half, mood always blends with the musical mood, the "Why" readout shows what it read, and Deeper reading (Local Chat) is there for subtler lyrics. Imagery has a high threshold, so a wrong motif is rarer than a missed one.
- **GPU differences** (ANGLE D3D11 vs Metal) can change shader precision. Shaders use `highp` and avoid derivative-dependent tricks in the parity path; VizLab parity runs on each OS.
- **Text in workers on macOS** (`OffscreenCanvas` 2D fonts) is *docs only*. If system fonts don't resolve there, text is rasterised on the main thread and transferred as `ImageBitmap`s to the worker (the atlas is small).
- **Scope:** 31 layers and 20 presets is a lot of art direction for builders. VizLab contact sheets make every layer visible to its builder, and the architect reviews them before the presets are accepted. Presets can ship in fewer numbers if some don't meet the bar (logged in DECISIONS).
- **Cache growth:** analyses are small (a few MB each), plus `instrumental.flac` per song (~30 MB). Capped at 3 GB and 30 days.
