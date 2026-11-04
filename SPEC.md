# Toolbox — Phase 9 Spec: Edit Studio (beat-synced music edits)

Status: **APPROVED 2026-11-03** (r1; "ok keep going").
Date: 2026-11-03. Author: architect session (Opus). Source brief: "Toolbox Edit Studio: Spec" (Nicole, Nov 3 2026), written against `be0e76b`.

Phases 1–8 are shipped; their specs are archived in `docs/specs/phase-{1..8}.md`, and every contract there still holds unless changed here. "P7 §x" refers to `docs/specs/phase-7.md` (Visualizer), "P8 B6" to `docs/specs/phase-8.md` Part B (Video Editor).

Edit Studio is a creator tool for song-driven edits. You pick a song and get every beat, kick, drop and lyric word as a snap marker. You drop in clips and photos and auto-fill a draft. Then you add cut-outs, captions and hit effects. It renders on the Visualizer's GPU engine and exports through the Visualizer's render broker.

---

## 0. What exists, corrections to the brief, and answers to its open questions

### 0.1 Verified facts (surveyed 2026-11-03 at `be0e76b`)

| Need | What the repo has (verified) | Consequence here |
|---|---|---|
| Analysis | `viz.Analyzer` (`core/viz/analyzer.go`), one instance shared by Visualizer, Lyric Video, Subtitles, Video Editor. `Analyze(ctx, job, input, AnalyzeOptions) (AnalysisRef, error)` is get-or-create. `AnalysisFor(path, stems)` finds the newest cached one. Key `<fileKey>-s<0\|1>-<textKey>-m<0\|1\|2>`; audio features are shared across word/mood variants | Edit Studio calls the same Analyzer; no new handler |
| Grid | 60 fps up to 20 min, 30 fps above (`viz/io.py choose_fps`) | Markers sit within ~17 ms of the hit |
| Beats | librosa `beat_track` on `mix.onset`; downbeat phase 0..3 picked by kick strength (+0.5 per chord change); always 4/4 | Add a **bar offset** control (§5.4) for wrong downbeats |
| Events | `events.{kick,snare,hats,bass,vocals,other,mix,lift,drop,break}` as `[ms, 0..255]`, plus `held`. From stems when `stems`, else from mix bands. Peak picking drops strength < 25 and keeps ≥ 110 ms gaps | Lanes read them directly; a lower threshold re-picks from the `drums.*` curves (§5.3) |
| Curves | `.bin` u8 per frame: `mix.*` always; `drums.{level,onset,kick,snare,hats}`, `bass.*`, `vocals.level/onset`, `other.*` with stems; `vocals.pitch/voiced` always | `stop` and `phrase` fallbacks derive from `mix.level` and `vocals.voiced` |
| Sections | `{startMs, endMs, label, group, energy}`; drops/breaks force boundaries; lift/drop/break are bar-loudness rules | Section bands and lanes |
| Stems | **Not kept.** Stems are separated into a temp folder and deleted; only `instrumental.flac` stays in the cache. `SaveStems` writes them to the Library and forces a re-separation | Stem rows show the stem **level curves**, not stem waveforms |
| Engine | `viz/engine.ts` renders a `Show` (scenes ≤ 6 × layers ≤ 12, a scene timeline) **synchronously** in `render(tMs)` | A 500-clip multitrack edit doesn't fit a Show; Edit Studio gets its own compositor on the same GL pieces (§8) |
| Posts | Pass posts: `chromatic, feedback, mirror, shake, zoompulse, glitch, grade`. **`bloom`, `vignette`, `grain` are "output" effects** applied once in the final output pass | Output effects can only be project-wide (the Look, §9.1) |
| Drivers | `shake` reads `kick`, `zoompulse` reads `beat.pulse`, `glitch` reads `drop.pulse` **hard-wired**; `chromatic` has a `source` enum | Add a `trigger` param so the effect can follow its Amount's reactions instead (§9.2) |
| Params | `Param = number \| {base, mods}`; **no keyframes**. `Mod.signal` is a `SignalId` | Edit Studio adds `EditParam` (keys + mods) and `EditMod` (marker signals) (§6.3) |
| Transitions | `Transitions.render(kind, a, b, mix, out, tMs)`, kinds `cut, crossfade, flash, zoom, sweep, glitch`; flash peaks at mix 0 | Clip transitions start at the cut (§8.6) |
| Text | `createTextLayer` renders `TextStyle` presets `karaoke, pop, rise, typewriter, fade, wave, subtitle, subtitle-boxed`; words come from `f.analysis.text` | Captions; edited words need `Analysis.withText` (§16) |
| Export | Go writes a `PlanForWorker` JSON, emits `viz:render`; `RenderHost` spawns `render.worker.ts`, which renders, encodes H.264 (WebCodecs, Annex-B) or JPEG, and streams `vz1|…` raw messages to `RenderBroker`. One render at a time (broker semaphore). `MuxOpaque` muxes with audio | Edit renders reuse all of it with an additive plan kind (§12) |
| Media | `/media/<token>/<name>` via `MediaService.URLFor(path)`; Range requests, ≤ 4 MiB per response; `fetchAll` reads big files in chunks | Frame streams are read by keyframe-aligned ranges |
| Projects | `core/projectdocs` + `core.ProjectStore`; kinds `post`, `composition`, `video`; ≤ 4 MiB JSON; `Duplicate` copies the project folder | New kind `edit` |
| Video Editor | `VideoProject` is a single sequence; DOM timeline (`TimelinePanel.tsx`), `history.ts` (200 steps, 800 ms key coalescing), `panelLogic.ts` snapping, `useThumbs.ts` filmstrips/waveforms, `SequencePlayer` on `<video>` | Patterns lifted; not the same document |
| Mattes | `bgremove.run` (ONNX, CPU, `output: "mask"` gives an L-mode PNG); Redact is the video precedent: FFmpeg raw pipes, `ctx.check_cancelled()` per frame, run handlers never download, `<area>.prefetch` does | Same patterns for `matte.*` (§10) |
| Engine deps | torch 2.14.1 (CPU wheel; MPS on Mac via `pick_device()` in `upscale.py`), onnxruntime 1.31 (CPU), opencv, PyAV 18 | Robust Video Matting runs on the existing onnxruntime; SAM 2 needs a new package (§10.4) |
| Packs | `core/packs/catalog.go`: components with per-platform sizes; packs `media, music, image, speech, documents, chat`. Creator tools are in no pack | New pack `edit` (§10.6) |

### 0.2 Where this spec departs from the brief (all recorded in DECISIONS.md in Wave 0)

1. **No `clip` Visualizer layer.** Clips render in a new `EditEngine` (`viz/edit/`) that reuses the engine's GL core, posts, signals, transitions, text layer and output pass. A Show layer can't work: `LayerInstance.render` is synchronous and has no frame source, the Visualizer's Layers tab would list it, and Show limits (6 scenes × 12 layers) can't hold a multitrack edit. The VizLab check becomes an Edit Lab mode (§17.3).
2. **Adjustment tracks hold `adjust` clips** (time ranges with effects), not one track-wide effect string. Project-wide effects (including bloom/vignette/grain) are the project's **Look**.
3. **Mattes belong to clips, not sources**, and live in the project folder. A click-to-select matte depends on the clicks and the range, not just the file. Slices of a clip share its matte.
4. **`EditParam` adds keyframes; `EditMod` adds marker signals** `marker.<lane>` with `every` and `sections` filters. This replaces the brief's `stop.pulse` / `custom.pulse` / "kick every 2nd" signal ids. Visualizer types are untouched.
5. **`shake`, `zoompulse`, `glitch`, `chromatic` get a `trigger` param** (default = today's behaviour). There are five new passes: `flash`, `blurpulse`, `exposure`, `invert`, and `punch`, a strong zoom punch. `zoompulse` maxes at 6 %, too subtle for edits.
6. **Slow-motion interpolation uses FFmpeg `minterpolate`** (motion-compensated, no model, no download). It is opt-in and labelled. RIFE would need vendored model code plus weights to pin and a size decision, so it is a later option.
7. **Stem rows show stem level curves.** Stems aren't cached (0.1).
8. **Path masks have static points** (moved and scaled as a whole by params). Rect and ellipse masks are fully keyframable. Per-point bezier keyframes come later.
9. **Clip audio is heard only in exports** (and is mixed by Go). The preview plays the song.
10. **Edit sources are constant-frame-rate at the project fps**, so source ms → frame index is `round(ms·fps/1000)`. Changing the project fps prepares new sources.
11. **Caption edits store the whole edited line list**, not a diff.
12. Additions the brief implies but doesn't name:
    - `color` clips (backgrounds for cut-outs, "black" stops);
    - `FxTarget` (effects on the clip, the subject or the background);
    - `FlipX`;
    - an `Auto` flag (clips auto-fill may replace);
    - project `Sources` with tags;
    - a downbeat **bar offset**;
    - a markers/SRT text export job.
13. The analysis runs with **mood off** (Edit Studio doesn't use mood). An existing analysis with words is offered for reuse first.

### 0.3 Answers to the brief's open questions (recommendations; change them here if you disagree)

| Question | Answer in this spec |
|---|---|
| Roadmap place | **Phase 9.** Documents moves to 10 and LAN transfer to 11 (`docs/ROADMAP.md`, Wave 0). |
| Separate tool or a Video Editor mode? | **Separate tool**, `edit-studio`. The documents differ: a sequence vs tracks at absolute times. It also renders on the GPU engine, not FFmpeg filtergraphs. |
| Is the 60 fps grid tight enough? | **Yes for v1.** The output is 30 fps by default, and the cut offset (±3 frames), per-lane nudge and dragging markers cover the rest. `edit.refine` would need the drum stem, which isn't cached, so a refine pass means re-separating (~1 min). Deferred. |
| librosa beat tracking | **Kept.** Add the bar offset (fixes the most common error, wrong downbeat phase), tap-to-add and marker dragging. A stronger tracker is a later, separate decision (new model + `uv lock` + size). |
| Matting models: pack and size | A new **"Music edits"** pack: engine, FFmpeg, stems, Whisper small, people matte (RVM MobileNetV3, ~15 MB), subject select (SAM 2.1 tiny, ~156 MB + the `sam2` package). Sizes are measured in Wave 0. |
| Name | **Edit Studio** (ID `edit-studio`, icon `audio-waveform`). |

---

## 1. Goals

1. **Marker map from any song** (M1). Built from the existing analysis and shown as colour-coded lanes over the waveform. You can:
   - toggle, threshold, thin (every Nth, first of bar) and nudge each lane;
   - drag or hide single markers;
   - shift the downbeat phase;
   - tap or click your own markers.

   Markers export as JSON and CSV.
2. **A multitrack timeline** (M2): up to 8 tracks of video, photo, colour and adjustment clips at absolute times, with:
   - magnetic snapping to markers;
   - fill to the next marker on drop;
   - slicing at every marker of a lane, optionally cycling sources;
   - undo (200 steps).
3. **One renderer, frame-exact exports** (M2): the preview and the export draw the same frames with the same `EditEngine` (the preview may drop frames, the export never does). Video frames come from WebCodecs-decoded edit sources, never from `<video>` seeking.
4. **Auto-fill** (M3): five deterministic recipes draft a timeline (in a range or section, or the whole edit). Pinned and hand-edited clips survive a re-run.
5. **Edit-grade effects** (M4):
   - per-clip and adjustment-clip post chains whose strength follows marker signals (zoom punch on every kick);
   - new `flash`, `blurpulse`, `exposure`, `invert`, `punch` passes;
   - keyframed transforms, Ken Burns on markers;
   - speed ramps with frame blending, and opt-in labelled interpolation.
6. **Cut-outs and captions** (M5):
   - photo cut-outs, people video mattes, and click-to-select subject mattes with correction clicks;
   - background replace, outline and glow, subject-only or background-only effects;
   - captions from the analysis's words with an editable word list, captions behind the subject, and SRT export.
7. **Follows the repo:** module contract, jobs, sidecar handlers with pinned models, `/media` tokens, raw-message renders, no listeners, macOS first and Windows second.

## 2. Non-goals (Phase 9)

- Not a general NLE: no multicam, no colour-grading suite, no audio mixing beyond song gain/fades and clip volume, no audio effects, no reverse playback, no nested sequences.
- The Video Editor stays as it is (no shared document, no migration between the two).
- No generation. Models detect, separate, segment and transcribe. The only synthesis is the opt-in in-between frames for slow motion (FFmpeg `minterpolate`), off by default and labelled.
- No `edit.refine` (sample-exact hits), no new beat-tracking model, no odd meters (4/4 as today).
- No pipeline step (`NotAStep`), no Post Builder slide link (a later phase can add a `postSlide` handoff like the Video Editor's).
- No clip audio in the live preview; no per-point bezier mask keyframes; no RIFE.
- No HDR output; HDR sources are tone-mapped to SDR when FFmpeg can (§7.3).

## 3. Architecture

```
frontend
  tools/edit-studio/            UI: projects, setup, lanes, tracks, sources, inspector, captions, auto-fill
     │  zustand store (useEditStudio) · history · autosave
     │  EditCanvas (preview host) ──────────────┐
  viz/edit/  (NEW, no React)                     │  same code in the export worker
     types.ts schema.ts            frozen data contracts + parsing
     markers.ts markerSignals.ts params.ts       markers, marker signals, EditParam/EditMod evaluation
     compile.ts engine.ts clip.ts               CompiledEdit → EditEngine draws a frame
     worker.ts                     export render loop for plan kind "edit"
  viz/frames/ (NEW)               Annex-B index, FrameProvider (VideoDecoder), frame cache
  viz/post/  (+5 passes, trigger params)
  viz/worker/render.worker.ts     dispatches plan.kind === "edit" to viz/edit/worker.ts
     │ Wails bindings (EditStudioService)        │ vz1|… raw messages (unchanged transport)
modules/editstudio (NEW, Go)                      core/viz (additive: RenderPlan.Edit)
  document.go module.go service.go validate.go    RenderBroker · MuxOpaque · Analyzer
  sources.go index.go shots.go interp.go images.go   FFmpeg transcodes to Annex-B + index
  matte.go models.go                               matte jobs over the engine
  render.go audio.go                               export: plan, broker, audio mix, mux
  text.go                                          markers CSV/JSON and SRT files
     │ stdio JSON lines (core/sidecar.Manager)
sidecar/toolbox_sidecar/handlers/matte.py (NEW)   matte.people · matte.select · matte.prefetch
```

- **Frontend ↔ Go:** generated bindings and the jobs events, as for every module. Local files reach the webview only through `MediaService.URLFor` / `/media` tokens.
- **Renders:** the worker's `vz1|<token>|…` raw messages to `RenderBroker`. No socket, no listener. The broker gets one additive field (§12.2).
- **Go ↔ Python:** sidecar calls as jobs with progress and cancel.
- **Imports:**
  - `modules/editstudio` imports `core`, `core/viz`, `core/media`, `core/imaging`, `core/heic`, `core/projectdocs`, `core/lyrics`, `core/sidecar`, `modules/videoeditor` (exported probe, §16) and `modules/bgremove` (photo cut-out model spec, §10.3).
  - `core/**` never imports it.

## 4. Time model and units

- **Song ms** = time in the analysed song file (the analysis and the `TextDoc` use it).
- **Timeline ms** `t` = time in the edit, `0 ≤ t < D` with `D = song.endMs − song.startMs`, and `songMs = song.startMs + t`.
  - Clip positions (`StartMs`, `EndMs`), keyframe times (clip-relative) and the playhead use timeline ms.
  - The edit's length is the song range. Clips past `D` are not drawn and are flagged in the UI.
- **Source ms** = time in a clip's source file. `InMs` is the source time at the clip's start.
- Markers are **derived and identified in song ms** and **shown and used in timeline ms**:
  - derived ID `"<lane>:<songMs>"`;
  - custom markers stored in song ms;
  - all of it unaffected by range changes.
- **Frames:** output frame `k` is drawn at `t_k = k·1000/fps`; the export has `round(D/1000·fps)` frames (as `plannedFrames`).
  - Clip boundaries are resolved on this grid: a clip covers frame `k` when `StartMs' ≤ t_k < EndMs'`, where `X' = X + cutOffsetFrames·1000/fps`.
  - Effects and marker signals are not offset.
- **Signals** (viz and marker) are sampled at `songMs`. Post effects receive `FrameInput.tMs = songMs`, so `glitchStep` etc. stay deterministic.
- All integers on the wire are ms (`int64` in Go, `number` in TS). Wall-clock times are Unix ms.
- Limits:
  - `1,000 ≤ D ≤ 600,000` (10 min);
  - every clip ≥ 1 output frame long after the offset.

## 5. Markers (`viz/edit/markers.ts`, pure; WP-ES1)

Markers are derived in TypeScript from the cached analysis. No new analysis handler is needed. `deriveMarkers` is pure and runs in the UI and in the export worker, so marker signals in an export match the preview.

```ts
export function deriveMarkers(a: Analysis, state: MarkerState, range: { startMs: number; endMs: number }): Marker[];
```

- It returns **every lane's** markers inside `[startMs, endMs)` (song ms), sorted by `(ms, lane)`, with overrides applied.
- `ms` in the result is **timeline ms** (`songMs − range.startMs`); `id` keeps the song ms.
- It must take < 30 ms for a 4-minute song at 60 fps (Vitest benchmark on the fixture). The UI memoises it on `(analysis, markers state, range)`.

### 5.1 Types (frozen in Wave 0, `viz/edit/types.ts`)

```ts
export const MARKER_LANES = ["beat", "downbeat", "kick", "snare", "hats", "bass", "vocals", "other",
  "section", "drop", "lift", "break", "stop", "phrase", "word", "custom"] as const;
export type MarkerLane = (typeof MARKER_LANES)[number];

export interface Marker {
  id: string;          // "<lane>:<songMs>" (derived, before nudge/move) | custom marker's id
  lane: MarkerLane;
  ms: number;          // timeline ms, after nudge and overrides
  endMs?: number;      // timeline ms: section, stop, phrase, word
  strength: number;    // 0..1
  label?: string;      // section label (or renamed), word text, custom note
  beatIndex?: number;  // index into audio.beats (beat, downbeat)
  bar?: number;        // 0-based bar index (every marker; −1 before the first downbeat)
  moved?: boolean;     // an override moved it
}

export interface LaneSettings {   // mirrors Go LaneSettings
  visible: boolean;
  minStrength: number;  // 0..1
  every: number;        // 1..16 (keep every Nth after the other filters)
  firstOfBar: boolean;  // keep only the first marker in each bar
  nudgeMs: number;      // −200..200
}
```

### 5.2 Lanes

| Lane | Source | Strength | Default visible | Default minStrength |
|---|---|---|---|---|
| beat | `audio.beats` | 1 (0.6 off the bar) | yes | 0 |
| downbeat | beats at the bar phase + `barOffset` (§5.4) | 1 | yes | 0 |
| kick, snare, hats | `events.kick/snare/hats` ÷ 255; below 0.1 the lane re-picks from the curves (§5.3) | event | kick yes, snare yes, hats no | 0.25 |
| bass, vocals, other | `events.*` ÷ 255 | event | no | 0.3 |
| section | `audio.sections` (endMs; label = renamed label or `label`) | `energy` | yes (as bands) | 0 |
| drop, lift, break | `events.drop/lift/break` ÷ 255 | event | drop yes, lift yes, break no | 0 |
| stop | derived (§5.3) | `1 − level/ref` | yes | 0.5 |
| phrase | `text.lines` start..end; without text, `vocals.voiced` runs (§5.3) | 1 | no | 0 |
| word | `text.lines[].words` (start..end, text) | 1 (emphasis 1, else 0.7) | no | 0 |
| custom | `MarkerState.custom` | 1 | yes | 0 |

`bar` for any marker is the index of the last downbeat ≤ its song ms (−1 before the first).

### 5.3 Derived lanes (exact rules; table-tested on the fixture)

- **Sensitive drum lanes** apply when `minStrength < 0.1` and `audio.stems`. Peak-pick `drums.kick` / `drums.snare` / `drums.hats`:
  - a frame `i` is a peak when it is the maximum of `[i−2, i+2]`;
  - its value is ≥ `minStrength`;
  - it rose ≥ 0.05 over the 3 frames before it;
  - it is ≥ 80 ms after the previous kept peak (the stronger one wins inside 80 ms).
  - ms = `round(i·1000/fps)`. Without stems these lanes never go below the handler's 0.1.
- **stop** is derived from `L = mix.level` with `ref(i)` = median of `L` over the 2 s before frame `i`:
  - a stop starts at frame `i` when `ref(i) ≥ 0.15` and `L` stays `< 0.35·ref(i)` for ≥ 150 ms;
  - it ends where `L ≥ 0.5·ref(i)` again or after 2 s;
  - strength = `1 − min L/ref` (clamped 0..1);
  - not inside the first or last 500 ms of the song, at most one stop per beat.
- **phrase without text:** runs where `vocals.voiced > 0.5` for ≥ 1 s, merged across gaps < 300 ms.
- **Filters and overrides**, in this order, per lane:
  1. strength ≥ `minStrength`;
  2. `firstOfBar`: keep the first marker of each bar;
  3. `every`: keep index % every == 0 of what's left;
  4. `nudgeMs` added;
  5. overrides: ids in `hidden` are dropped; ids in `moved` take that song ms, with `moved: true` and no nudge;
  6. clip to the range;
  7. convert to timeline ms.
  - Section labels come from `labels[id]` when set.
  - Custom markers skip steps 1–4.
- Hidden or moved ids that no longer match a derived marker are kept in the state (they apply again if the threshold brings the marker back) but are not counted or shown.

### 5.4 Bar offset

`MarkerState.barOffset` (0..3) shifts the downbeat phase: downbeats = `beats[(p + barOffset) % 4 :: 4]` where `p` is the analysis's phase (index of the first `audio.downbeats` entry in `audio.beats`, mod 4). `bar` indices follow the shifted downbeats. The lanes header shows "Bar starts on beat 1/2/3/4" next to the downbeat lane.

### 5.5 Marker signals (`viz/edit/markerSignals.ts`; WP-ES1)

Marker signal ids are `marker.<lane>` (`MarkerSignalId`). For a marker list, a lane, an `every` (1..16) and an optional section filter, `MarkerSignals` builds a per-frame series on the analysis grid (song frames), cached by `(lane, every, sections)`:

- **impulses:** value `max(v·k, s·exp(−age/τ))` as `Signals.pulses`, with `s` = marker strength (1 for beat, downbeat and custom);
- **τ (ms):** beat 120, downbeat 300, kick 90, snare 110, hats 60, bass/vocals/other 120, section 600, drop 1200, break 800, phrase 400, word 150, custom 150;
- **lift:** the `lift.pulse` ramp (rises over the 2 bars before, then decays with τ 2000);
- **stop:** a gate, 1 inside `[ms, endMs)` and 0 elsewhere;
- **`every` and `sections` filters:** `every` keeps every Nth marker of the lane (after the lane's own filters); `sections` keeps markers inside sections with those labels;
- **envelope:** the attack/release envelope is `Signals.envelope`'s formula.

`value(id, filter, songMs, attackMs, releaseMs)` interpolates like `Signals.value`. A lane with no markers gives 0. Marker signals use every lane's markers after its filters, whether or not the lane is visible; visibility only affects drawing and snapping.

### 5.6 Editing markers (UI rules; WP-ES1)

- Drag a marker to move it (stored in `moved`; it snaps to the nearest beat within 40 ms unless Alt is held).
- Delete hides a derived marker or removes a custom one. "Reset lane" clears that lane's overrides.
- **Tap:** `T` during playback adds a custom marker at the audio clock minus 40 ms (fixed tap latency, `TAP_LATENCY_MS`). Two taps within 250 ms delete the nearest custom marker within 150 ms instead. `M` while paused adds one at the playhead. Custom markers are capped at 2,000.
- **Export markers** (header menu) writes `<library>/Edits/<project> markers.csv|json` through the `text` job (§11.7):
  - CSV columns `lane,timeline_ms,song_ms,end_ms,strength,label,bar,beat`;
  - JSON `{project, song, startMs, endMs, fps, markers: [...]}`;
  - both list visible lanes only.

---

## 6. Project document and data contracts

### 6.1 Go document (`modules/editstudio/document.go`, FROZEN after Wave 0; in the bindings)

Naming follows `VideoProject`. JSON-in-string fields hold the frontend's own shapes (§6.3). Go checks only that they are valid JSON within size limits; the frontend validates them with `viz/edit/schema.ts`. This is the same split as `ShowJSON`.

```go
package editstudio

type EditProject struct {
    Version         int         `json:"version"`         // 1
    Aspect          string      `json:"aspect"`          // "9:16" | "4:5" | "1:1" | "16:9"
    FPS             int         `json:"fps"`             // 30 | 60
    Song            *Song       `json:"song"`            // nil until picked
    AnalysisKey     string      `json:"analysisKey"`     // viz.AnalysisRef.Key; "" until analysed
    Markers         MarkerState `json:"markers"`
    Sources         []Source    `json:"sources"`         // the Sources panel, ≤ 300
    Tracks          []Track     `json:"tracks"`          // 1..8; index 0 = bottom
    Captions        *Captions   `json:"captions"`        // nil = off
    Look            string      `json:"look"`            // EditPost[] JSON: global chain incl. bloom/vignette/grain; "" = none
    Background      string      `json:"background"`      // "#rrggbb" under every track
    CutOffsetFrames int         `json:"cutOffsetFrames"` // −3..3
    Seed            int64       `json:"seed"`            // engine seed (rng keys, grain, glitch)
    Recipe          *RecipeRun  `json:"recipe"`          // last auto-fill
    ExportHeight    int         `json:"exportHeight"`    // short side: 720 | 1080 | 1440
}

type Song struct {
    Path      string  `json:"path"`
    StartMs   int64   `json:"startMs"`   // song ms
    EndMs     int64   `json:"endMs"`     // song ms; EndMs − StartMs = D (§4)
    GainDb    float64 `json:"gainDb"`    // −24..12
    FadeInMs  int64   `json:"fadeInMs"`  // 0..10,000
    FadeOutMs int64   `json:"fadeOutMs"` // 0..10,000
}

type MarkerState struct {
    Lanes     map[string]LaneSettings `json:"lanes"`     // missing lane = defaults (§5.2)
    BarOffset int                     `json:"barOffset"` // 0..3
    Hidden    []string                `json:"hidden"`    // derived marker ids, ≤ 5,000
    Moved     map[string]int64        `json:"moved"`     // id → song ms, ≤ 5,000
    Labels    map[string]string       `json:"labels"`    // section id → label (≤ 24 chars)
    Custom    []CustomMarker          `json:"custom"`    // ≤ 2,000
}

type LaneSettings struct {
    Visible     bool    `json:"visible"`
    MinStrength float64 `json:"minStrength"` // 0..1
    Every       int     `json:"every"`       // 1..16
    FirstOfBar  bool    `json:"firstOfBar"`
    NudgeMs     int64   `json:"nudgeMs"`     // −200..200
}

type CustomMarker struct {
    ID    string `json:"id"`
    Ms    int64  `json:"ms"`    // song ms
    Label string `json:"label"` // ≤ 40 chars
}

type Source struct {
    Path string   `json:"path"`
    Tags []string `json:"tags"` // ≤ 8, each 1..24 chars, lower-case; "hero" | "closeup" | "wide" | "broll" are offered first
}

type Track struct {
    ID     string `json:"id"`
    Kind   string `json:"kind"`   // "video" | "adjust"
    Name   string `json:"name"`   // ≤ 40 chars
    Muted  bool   `json:"muted"`  // not drawn (video) / not applied (adjust); its clips' audio is not mixed
    Locked bool   `json:"locked"` // no edits; auto-fill skips it
    Clips  []Clip `json:"clips"`  // sorted by StartMs, non-overlapping; ≤ 500 clips per project
}

type Clip struct {
    ID        string  `json:"id"`
    Kind      string  `json:"kind"`      // "video" | "image" | "color" (video tracks) | "adjust" (adjust tracks)
    Path      string  `json:"path"`      // video/image
    Color     string  `json:"color"`     // color: "#rrggbb"
    StartMs   int64   `json:"startMs"`   // timeline ms
    EndMs     int64   `json:"endMs"`     // timeline ms, > StartMs
    InMs      int64   `json:"inMs"`      // video: source ms at StartMs
    Speed     string  `json:"speed"`     // EditParam JSON, keys only (no mods), 0..4; "" = 1
    Slow      string  `json:"slow"`      // "blend" (default) | "none" | "interpolate"
    Volume    float64 `json:"volume"`    // 0..2; video only; heard in exports only
    Fit       string  `json:"fit"`       // "fill" | "fit" | "fit-blur" | "fit-color" (video/image)
    FitColor  string  `json:"fitColor"`  // "#rrggbb"
    FlipX     bool    `json:"flipX"`
    Blend     string  `json:"blend"`     // "normal" | "add" | "screen" | "multiply"
    Transform string  `json:"transform"` // ClipTransform JSON; "" = identity
    Matte     *Matte  `json:"matte"`     // nil = none
    FxTarget  string  `json:"fxTarget"`  // "clip" | "subject" | "background" (subject/background need a ready matte)
    Masks     string  `json:"masks"`     // Mask[] JSON; "" = none
    Effects   string  `json:"effects"`   // EditPost[] JSON; "" = none
    In        string  `json:"in"`        // EditTransition JSON into this clip; "" = cut
    Pinned    bool    `json:"pinned"`    // auto-fill never touches it
    Auto      bool    `json:"auto"`      // made by auto-fill and not edited since
}

type Matte struct {
    Mode    string       `json:"mode"`    // "people" | "select" | "image"
    ID      string       `json:"id"`      // set by the UI when it submits the matte job; files <project>/mattes/<ID>-{preview,export}.h264 + .idx.json (image: <ID>.png)
    FromMs  int64        `json:"fromMs"`  // source range the matte covers (video)
    ToMs    int64        `json:"toMs"`
    Clicks  []MatteClick `json:"clicks"`  // select: ≤ 64
    Cutout  bool         `json:"cutout"`  // the clip shows only the subject
    Invert  bool         `json:"invert"`
    Feather float64      `json:"feather"` // 0..1 (→ 0..1 % of the short side)
    Stroke  MatteStroke  `json:"stroke"`
    Glow    MatteGlow    `json:"glow"`
}

type MatteClick struct {
    Ms       int64   `json:"ms"`       // source ms (snapped to a frame)
    X        float64 `json:"x"`        // 0..1 of the upright source frame
    Y        float64 `json:"y"`
    Positive bool    `json:"positive"` // false = "not this"
}

type MatteStroke struct {
    Px    float64 `json:"px"`    // 0..40 at a 1080 short side (scaled to the output)
    Color string  `json:"color"` // "#rrggbb"
}

type MatteGlow struct {
    Amount float64 `json:"amount"` // 0..1
    Color  string  `json:"color"`
}

type Captions struct {
    Style         string `json:"style"`         // viz TextStyle JSON
    BehindSubject bool   `json:"behindSubject"`
    Lines         string `json:"lines"`         // TextLine[] JSON (song ms) replacing the analysis's words; "" = the analysis
}

type RecipeRun struct {
    RecipeID string `json:"recipeId"`
    Seed     int64  `json:"seed"`
    Run      int    `json:"run"`     // increments per apply; part of generated clip IDs
    Options  string `json:"options"` // AutofillOptions JSON (§13.2)
}
```

**Validation** (`validate.go`, `validateShape` on Save and `validateDoc` before render). Errors are `core.ValidationError` with `fields` keyed by JSON path (`tracks[2].clips[5].endMs`). Rules:

- aspect/fps enums; `1 ≤ len(Tracks) ≤ 8`; ≤ 500 clips in total.
- Track and clip IDs: unique, non-empty, ≤ 40 chars `[A-Za-z0-9_-]`.
- Clip kinds must match the track kind; clips sorted and non-overlapping per track; `EndMs > StartMs ≥ 0`; `InMs ≥ 0`.
- `Volume` 0..2; enums for `Fit`/`Slow`/`Blend`/`FxTarget`; colours `#rrggbb`.
- Each JSON field must be valid JSON ≤ 64 KiB (`Captions.Lines` ≤ 256 KiB).
- Song: `D` within 1 s..10 min (if set); marker limits as commented; `Sources` ≤ 300, tags as commented.
- Matte enums and limits; `CutOffsetFrames` −3..3; `ExportHeight` enum; total JSON ≤ `core.MaxProjectBytes`.
- Files don't have to exist to save; a project with a missing file still opens.
- `validateDoc` (render) also needs:
  - a song and an analysis (`Analyzer.Lookup`);
  - every non-muted clip's file to exist (fails naming the first missing file);
  - a ready matte for every clip whose `Matte` is set (§10.5);
  - at least one visible clip.

A new `core.ProjectKind`: `ProjectEdit ProjectKind = "edit"`. `Summarize` counts clips (items) and missing files (song + clip paths + sources).

### 6.2 New project defaults (`Create`)

- `Version 1`, the chosen aspect and fps, `Song nil`, `AnalysisKey ""`.
- Markers: lane defaults from §5.2 (written out in full, so old projects keep their look if defaults change).
- `Sources []`; one video track `{id "t1", kind "video", name "Video 1"}`.
- `Background "#000000"`, `Look ""`, `Captions nil`, `CutOffsetFrames 0`, `Seed` random (1..2³¹−1), `ExportHeight 1080`.

### 6.3 Frontend shapes (frozen in Wave 0, `viz/edit/types.ts`; parsed and validated by `viz/edit/schema.ts`)

```ts
import type { Mod, PostType, SectionLabel, SignalId, TransitionKind } from "../types";

export type MarkerSignalId = `marker.${MarkerLane}`;
export type EditSignalId = SignalId | MarkerSignalId;

export interface EditMod extends Omit<Mod, "signal"> {
  signal: EditSignalId;
  every?: number;              // 1..16, marker signals only
  sections?: SectionLabel[];   // gate: only inside these sections (any signal)
}

export interface Key { t: number; v: number; ease: "linear" | "ease" | "hold" } // t = clip-relative ms
export type EditParam = number | { base: number; keys?: Key[]; mods?: EditMod[] };   // keys ≤ 64, mods ≤ 4

export interface EditPost {          // PostConfig with EditParams
  id: string;
  type: PostType;                   // includes the new passes (§9)
  enabled: boolean;
  params: Record<string, EditParam | string | boolean>;
}

export interface ClipTransform {
  x: EditParam;         // offset, fraction of frame width  (−2..2), 0
  y: EditParam;         // offset, fraction of frame height (−2..2), 0
  scale: EditParam;     // × the fitted size (0.05..8), 1
  rotation: EditParam;  // degrees (−3600..3600), 0
  opacity: EditParam;   // 0..1, 1
}

export interface Mask {
  id: string;
  shape: "rect" | "ellipse" | "path";
  x: EditParam; y: EditParam;            // centre, 0..1 of the clip's drawn rect
  w: EditParam; h: EditParam;            // 0..2 of the drawn rect (rect/ellipse); path: scale x/y
  rotation: EditParam;                   // degrees
  points?: Array<[number, number]>;      // path: 3..32 points, 0..1 of the drawn rect, closed
  smooth?: boolean;                      // path: Catmull-Rom through the points
  feather: number;                       // 0..0.5 of the drawn rect's short side
  invert: boolean;
  op: "add" | "subtract" | "intersect";  // combined in list order from "nothing" if the first is add, else from "everything"
}

export interface EditTransition { kind: TransitionKind; ms: number } // 0..2000; "cut" ignores ms
```

**Evaluation of an `EditParam`** (`viz/edit/params.ts`, WP-ES1) at clip time `u` and song time `s`:

```
value = (keys ? interpolate(keys, u) : base) + Σ mod.amount · (max − min) · shape(env(mod, s)), clamped to [min, max]
```

- `interpolate`:
  - holds the first/last key outside the range;
  - `linear` and `ease` (smoothstep) segments;
  - `hold` = step at the next key.
- `env(mod, s)` is `Signals.value` for viz signals and `MarkerSignals.value` for `marker.*` (§5.5), times the section gate (1 inside a listed section, else 0, sampled at `s`).
- No mix-group gains and no reactivity factor (Edit Studio has no visual mix).
- `Speed` allows keys only. Keys and mods are not allowed on `Mask.feather`, colours, enums or booleans.

`schema.ts` exports:

- `parseTransform / parseMasks / parseEffects / parseTransition / parseSpeed / parseLook / parseCaptionLines / parseTextStyle`;
- the matching `serialize*`;
- `IDENTITY_TRANSFORM` and `DEFAULT_TEXT_STYLE`.

Each parser returns `{ok: true, value} | {ok: false, problem}`. "" parses to the default. Unknown post types and params are dropped with a problem string, never thrown.

---

## 7. Edit sources (Go, `modules/editstudio/sources.go`, `index.go`, `shots.go`, `interp.go`, `images.go`; WP-ES4)

The engine never reads a camera file. Every video it draws is an **edit stream**: an H.264 Annex-B file plus a frame index that Go made with FFmpeg. Every photo it draws is an **edit image**: upright, size-capped, HEIC converted. Both are cached outside the project, so several projects share them.

### 7.1 Streams and tiers

| Tier | Short side | Used by |
|---|---|---|
| preview | `min(source short side, 540)` | the live preview |
| export | `min(source short side, output long side)` (1920 for a 1080 × 1920 export) | the export worker, matte jobs |

- Frame rate = the project fps, **constant**: frame `n` shows source time `n·1000/fps`, so source ms → frame `round(ms·fps/1000)`.
- Files:
  - `<support>/cache/editstudio/src/<fileKey>/v<short>-<fps>.h264` + `.idx.json`, with `fileKey = viz.FileKey(path)` (path, size, mtime);
  - `shots.json`;
  - `img-<maxDim>.jpg|png` (edit images).
- FFmpeg (one process per stream, through `core/proc`, `-progress pipe:1` for progress):

```
ffmpeg -hide_banner -nostdin -y -i <src> -map 0:v:0 -an -sn -dn
  -vf "<tonemap?>scale=<w>:<h>:flags=bicubic,fps=<fps>,format=yuv420p"   (w,h even; autorotate on)
  -fps_mode cfr -c:v libx264 -preset veryfast -crf <20 preview | 16 export>
  -profile:v high -bf 0 -g 10 -keyint_min 10 -sc_threshold 0
  -x264-params aud=1:repeat-headers=1 -f h264 <out>.part
```

  Then `<out>.part` is renamed after the index is written. A per-file mutex (`sync.Map` of key → mutex) makes concurrent jobs wait for one transcode instead of racing.
- **HDR** (ffprobe `color_transfer` = `smpte2084` or `arib-std-b67`): if `ffmpeg -filters` lists `zscale` and `tonemap`, prefix `zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,`. Otherwise convert plainly and add the warning "HDR footage may look washed out". The filter check is cached per FFmpeg path.

### 7.2 Frame index (`index.go`)

`<stream>.idx.json`:

```json
{ "version": 1, "codec": "avc1.64001f", "width": 540, "height": 960, "fps": 30,
  "frames": 182, "offsets": [0, 31877, ...], "keys": [0, 10, 20, ...], "bytes": 2918842 }
```

- `offsets` has `frames + 1` entries; the last is the file size. Frame `n` is bytes `[offsets[n], offsets[n+1])`: one access unit, starting with its AUD NAL (type 9).
- `keys` lists the IDR frames (NAL type 5); every key AU also carries SPS/PPS (`repeat-headers`).
- `codec` is `avc1.` + hex of SPS bytes 1–3 (profile_idc, constraint flags, level_idc).
- The parser scans 3- and 4-byte start codes. A frame count that differs from `round(durationMs·fps/1000)` by more than 2 is logged, not fatal.
- Go types:

```go
type EditStream struct {
    Stream string `json:"stream"` // absolute paths (the UI asks MediaService.URLFor)
    Index  string `json:"index"`
    Width  int    `json:"width"`
    Height int    `json:"height"`
    FPS    int    `json:"fps"`
    Frames int    `json:"frames"`
}
```

### 7.3 Edit images (`images.go`)

- `imaging.ToReadable` (HEIC), then `imaging.Orient` (EXIF), then a long side ≤ 1920 (preview) or ≤ 4096 (export).
- Saved as JPEG q92, or PNG when the source has alpha.
- File `img-<maxDim>.jpg|png` in the file key folder.

### 7.4 Shots (`shots.go`)

```
ffmpeg -f h264 -framerate <fps> -i <preview stream> -vf "select='gt(scene,0.3)',metadata=print:file=-" -an -f null -
```

- Parse `pts_time`, convert to source ms, drop cuts closer than 500 ms to the previous one.
- Stored in `shots.json` (`[ms, …]`). Videos only, made with the preview tier.

### 7.5 Interpolated slow motion (`interp.go`, opt-in)

For a clip with `Slow: "interpolate"`, the UI submits `interp` for the clip's source range, rounded out to whole seconds:

```
ffmpeg -ss <from> -to <to> -f h264 -framerate <fps> -i <export stream>
  -vf "minterpolate=fps=<4·fps>:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1" <same encoder args>
```

- Writes `interp-<fromS>-<toS>-<4fps>.h264` + index (export tier), plus a preview copy scaled to 540.
- Frame `n` of an interp stream shows source time `fromS·1000 + n·1000/(4·fps)`.
- The UI labels it "Synthesized in-between frames (slow motion)". Until it exists, the clip renders with `blend` and a "Making slow motion…" badge.

### 7.6 Source state, jobs and cache

```go
type SourceState struct {
    Path      string               `json:"path"`
    Info      videoeditor.ClipInfo `json:"info"`      // kind, duration, size, fps, rotation, hasAudio, takenAt, error
    Preview   *EditStream          `json:"preview"`   // video, at the project fps
    Image     string               `json:"image"`     // photo: preview edit image
    Shots     []int64              `json:"shots"`     // video; nil = not made
    Preparing bool                 `json:"preparing"` // a prepare job for this path is queued/running
    Error     string               `json:"error"`
}
```

- `Prepare(projectId, paths, fps)` submits **one** `prepare` job for the paths (≤ 300). Sequentially, per path, it makes the preview stream and shots (video) or the preview edit image (photo).
  - Progress is split evenly. A file that fails is recorded in the result with its error, and the job continues.
- `Sources(paths, fps)` reports what exists without doing work.
- The export tier, export images and interp streams are made inside the render job (§12.1) when missing.
- Cache pruning at start (`modules/editstudio.PruneCache`, called from main.go like the others):
  - `cache/editstudio/` folders untouched for 30 days;
  - then the oldest until the total is ≤ 10 GB.
  - Files are re-made on demand; the UI shows "Preparing" again.

---

## 8. Rendering: the EditEngine (`viz/edit/`, `viz/frames/`; WP-ES3)

The rule from P7 holds: a frame is a function of (project, analysis, markers, size, seed, time).

- The preview (DOM canvas) and the export (worker `OffscreenCanvas`) run the same `EditEngine`. Only the stream tier differs, so preview and export show the same frames at different resolutions.
- Two exports of one project are byte-identical before encoding (checked by Edit Lab, §17.3).

### 8.1 Interfaces (frozen in Wave 0; Wave 0 ships a stub engine that draws each clip as a flat colour, so UI packages can run before ES3 lands)

```ts
// viz/frames/types.ts
export interface StreamIndex { version: 1; codec: string; width: number; height: number; fps: number;
  frames: number; offsets: number[]; keys: number[]; bytes: number }
export interface StreamRef { url: string; indexUrl: string }        // /media URLs
export type FrameImage = VideoFrame | ImageBitmap;                   // what may be uploaded (spike picks, §16.1)
export interface FrameKey { stream: string; frame: number }          // stream = a key of EditFiles.streams
export interface FrameProvider {
  /** Decodes what `keys` need. exact=false (preview) may resolve before every frame is ready. */
  prepare(keys: FrameKey[], exact: boolean, signal?: AbortSignal): Promise<void>;
  /** The frame, or (inexact) the nearest earlier decoded frame of that stream, or null. */
  frame(key: FrameKey): FrameImage | null;
  image(key: string): ImageBitmap | null;                            // edit images by EditFiles.images key
  /** Hints the play direction and position so it can decode ahead (preview). */
  hint(tMs: number, playing: boolean): void;
  dispose(): void;
}

// viz/edit/types.ts
export interface EditFiles {
  streams: Record<string, StreamRef>;  // "v:<path>" video, "m:<matteId>" matte, "i:<path>|<from>-<to>" interp
  images: Record<string, string>;      // "p:<path>" photo URL, "m:<matteId>" image-matte PNG URL
}
export interface EditInputs {
  project: EditProject;               // the generated binding type (Go document)
  analysis: Analysis;                 // the song's analysis (captions use analysis.withText when Lines is set)
  markers: Marker[];                  // deriveMarkers(...) for the project's range
  files: EditFiles;
}
export interface EditEngineOptions { width: number; height: number; fps: number; seed: number;
  quality: "full" | "draft"; inWorker: boolean }

// viz/edit/compile.ts
export function compileEdit(inputs: EditInputs, opts: { width: number; height: number; fps: number }): CompiledEdit; // pure

// viz/edit/engine.ts
export class EditEngine {
  constructor(canvas: AnyCanvas, opts: EditEngineOptions);
  setEdit(c: CompiledEdit): void;
  needs(tMs: number): FrameKey[];                  // timeline ms
  render(tMs: number, frames: FrameProvider): void; // synchronous; presents the frame
  readPixels(): Uint8Array;
  resize(width: number, height: number): void;
  dispose(): void;
}
```

### 8.2 Frame provider (`viz/frames/provider.ts`, `decoder.ts`, `cache.ts`)

- One `VideoDecoder` per stream: `configure({codec, codedWidth, codedHeight, optimizeForLatency: true})` with no `description`, so Annex-B. Chunks are sliced from bytes fetched by keyframe-aligned Range requests through `fetchAll`-style reads.
  - Groups of whole GOPs, ≤ 4 MiB per response.
  - A per-stream byte cache of 16 MiB.
- To get frame `n`:
  - decode from `keys` ≤ `n` (or continue from the decoder's last frame when `n` is ahead within the same GOP or the next two);
  - drop the outputs before `n`;
  - **close every `VideoFrame` as soon as it is converted or no longer needed.**
- Converted frames are kept in an LRU:
  - ≤ 24 per stream and ≤ 120 in total (preview);
  - ≤ 8 per stream (export: the worker renders forward).
  - Conversion is whatever the spike picks: `createImageBitmap(frame)` then close, or keeping the `VideoFrame` (§16.1).
- **Preview:** `hint` keeps up to 15 frames ahead of the playhead decoded for streams active now or within 1 s. On a seek, pending decodes for other positions are reset (`decoder.reset()` + reconfigure). `frame()` returns the nearest earlier frame while the exact one is pending; the engine never blocks the UI.
- **Export:** `prepare(keys, true)` resolves only when every key is resident. A decode error rejects with a `RenderError("A clip couldn't be decoded", detail)`.
- Edit images load with `fetchAll` + `createImageBitmap`. Image mattes (PNG) the same way.

### 8.3 Compile (`compile.ts`)

`compileEdit` parses every JSON field with `schema.ts`; anything invalid falls back to the default and is listed in `CompiledEdit.problems` for the UI. It precomputes:

- **Per track, per clip:** the frame span `[k0, k1)` after the cut offset; parsed transform, masks, effects (stateful post types dropped), transition; the matte reference and whether it is ready (its stream/image key exists in `files`).
- **Source frames** for video clips: for each covered output frame, the source position in frames (a float). Integrate `Speed` over clip time on the output frame grid:
  - `src(k) = InMs·fps/1000 + Σ speed(u_j)` for the frames before `k`;
  - capped at the stream's last frame (the clip holds its last frame past the source end; the timeline UI warns).
  - For `interpolate`, positions map into the interp stream when it covers them.
- **`needs(t)`:** the stream frames the frame at `t` uses: one per drawn video clip and matte, or two when `blend` mixes neighbours (fractional advance < 1 frame/frame and a non-integer position).
- **Marker signals:** a `MarkerSignals` over `inputs.markers` and the analysis.

### 8.4 Drawing one frame (`engine.ts`)

At timeline `t` (song `s = song.startMs + t`):

1. Clear the frame target to `Background`.
2. **Tracks bottom to top** (muted ones skipped):
   - **video track:** for the clip active at `t` (and the previous clip during an `In` transition, §8.6), draw the clip into a clip target (§8.5), run its effects (§8.5 FxTarget), then composite onto the frame with its `Blend` (premultiplied, the engine's `setBlend` rules);
   - **adjust track:** the active adjust clip runs its `Effects` on the frame so far and mixes the result by its transform opacity, restricted by its masks (mask alpha selects processed vs unprocessed).
3. **Captions** (if `Captions` is set): the text layer draws `TextStyle` onto the frame at song time `s`, from `analysis.withText(lines)` when `Captions.Lines` is set.
   - **Behind subject:** the topmost drawn video/image clip with a ready matte is drawn again above the captions, as its subject only, with its transform and effects.
4. **Look:** the project's pass effects run on the frame. Then the output pass applies bloom/vignette/grain from the Look's output-kind entries, the same as `Engine.outputParams`.
5. Present (opaque).

Effect params resolve with `evalEditParam` (§6.3). `FrameInput.tMs = s`, `dtMs = 1000/fps`, `motionSec = s/1000`, `palette` = a fixed neutral palette (`resolvePalette({mode:"fixed", ids:["mono"]})`; no edit effect reads it), `analysis` and `signals` = the song's.

### 8.5 Drawing a clip (`clip.ts`)

One shader draws a source texture into the clip target (transparent clear):

- **Fit** (source aspect vs output):
  - `fill` covers (centre crop);
  - `fit` contains (transparent bars);
  - `fit-color` contains over `FitColor`;
  - `fit-blur` contains over a cover-scaled copy of the same frame blurred (two-pass separable Gaussian, radius 3 % of the short side, at half resolution).
  - The fit background is not drawn when the clip is a cut-out.
- **Transform** (after fit, around the frame centre): scale, then rotation, then the offset `(x·W, y·H)`. `FlipX` mirrors the source. Opacity multiplies the output.
- **Color clips** fill the drawn rect (the whole frame before the transform) with `Color`.
- **Matte:** alpha `a = matte(src frame)` (the grey matte stream's red channel, or the image matte PNG's), sampled with the same source mapping.
  - `Feather` blurs the matte (radius `feather` % of the short side, 9-tap); `Invert` gives `1 − a`.
  - `Cutout` multiplies the clip's alpha by `a`.
  - **Stroke:** `max(dilate(a, px) − a, 0)` in `Stroke.Color`, under the subject. Dilation uses 16 taps on a circle of radius `px · outputShort / 1080`.
  - **Glow:** a 2-pass blur of `dilate(a, px + 6)` × `Glow.Amount` × colour, drawn under the stroke.
  - Stroke and glow appear only when the clip is a cut-out or `FxTarget` = `subject`.
- **Masks** (≤ 4, clip-local coords on the drawn rect): signed distance for rect and ellipse; for paths, a winding test and the distance to the polygon edges (≤ 32 points; `smooth` subdivides a Catmull-Rom path into ≤ 32 segments on the CPU).
  - `feather` smooths the edge; `invert`; ops combine in list order.
  - The result multiplies alpha.
- **FxTarget:**
  - `clip`: the effects run on the clip target;
  - `subject` / `background` (needs a ready matte): the clip is drawn twice, as subject (×a) and background (×(1−a)); the effects run on the chosen one, and the two are composited (background first).
  - Without a ready matte it behaves as `clip` and the Inspector says so.
- **Slow:**
  - `blend` mixes the two neighbouring frames by the fractional position;
  - `none` rounds;
  - `interpolate` reads the interp stream (rounded).

Targets are pooled by size (the engine keeps ≤ 6 full-size scratch targets plus 2 half-size ones; clips are drawn one at a time).

### 8.6 Transitions

- A clip's `In` (kind, ms) starts at the cut: during `[B.start', B.start' + ms)` the outgoing side A is:
  - the previous clip on the same track if it ends within one frame of B's start: A keeps playing past its end (source continues, or holds its last frame);
  - otherwise transparent.
- Output = `Transitions.render(kind, A, B, (t − B.start')/ms, out, s)`. The ms is capped at B's length and 2,000.
- `cut` (or "") draws B alone.
- A `flash` transition is brightest at the cut (`flashLevel`), so it lands on the beat.

### 8.7 Determinism and limits

- No `Math.random`, `Date` or `performance.now` in `viz/edit/` or `viz/frames/` (except the provider's scheduling, which never affects pixels).
- Rng keys: `makeRng(seed, "<clipId>/<postId>")`.
- Stateful post types (`feedback`) are not offered in Edit Studio and are dropped by `compileEdit`.
- Text uses the engine's atlas rules.
- Quality: `draft` in the preview (posts may halve internal targets, as today); `full` in the export.

### 8.8 Preview host (`viz/edit/EditCanvas.tsx`; WP-ES3)

```ts
export interface EditCanvasProps {
  inputs: EditInputs | null;          // null = "nothing to show" placeholder
  width: number; height: number;       // preview size (§14.3)
  timeMs: number;                      // timeline ms from the transport (audio clock)
  playing: boolean;
  quality: "full" | "draft";
  onStats?(s: { fps: number; dropped: number; waiting: number }): void;
  onCanvas?(c: HTMLCanvasElement | null): void;   // overlays and thumbnails
}
```

- Owns one `EditEngine` and one `FrameProvider` (main thread; preview tier URLs).
- On each `timeMs` change it calls `provider.hint`, `prepare(needs(t), false)`, and `render(t, provider)`.
- When frames arrive for the current time while paused, it renders again.
- It recompiles (memoised) when `inputs` changes.
- It never awaits in the render path.

**Performance targets (preview, measured in Wave 2 on this box and listed on the Mac checklist):** 540 × 960, 30 fps, a cuts-only edit cycling 4 video sources with 2 effects per clip; ≥ 28 fps average and < 5 % frames waiting for decode at steady playback. Audio never stalls; frames drop instead.

---

## 9. Effects (`viz/post/`; WP-ES5)

### 9.1 What Edit Studio offers

| Group | Effects | Where |
|---|---|---|
| Hits | `punch` (new), `zoompulse`, `shake`, `flash` (new), `chromatic`, `glitch`, `blurpulse` (new), `exposure` (new), `invert` (new) | clips, adjust clips, Look |
| Look | `grade`, `mirror` | clips, adjust clips, Look |
| Output | `bloom`, `vignette`, `grain` | Look only |

Not offered: `feedback` (stateful).

**Effect templates** (`tools/edit-studio/inspector/templates.ts`, WP-ES10) insert ready-made `EditPost`s:

- **Zoom punch on kicks:** `punch.amount = {base: 0, mods: [{signal: "marker.kick", amount: 1, shape: "exp", attackMs: 5, releaseMs: 160}]}`.
- **Flash on drops:** `flash.amount` ← `marker.drop`, amount 1, release 250.
- **Shake on snares:** `shake.trigger = "amount"`, amount ← `marker.snare`.
- **RGB split on hats:** `chromatic.source = "amount"`, amount ← `marker.hats`.
- **Glitch on the drop:** `glitch.trigger = "amount"`, amount ← `marker.drop`.
- **Blur pulse on beats.**
- **Exposure pulse on downbeats.**
- **Invert on stops:** `invert.amount` ← `marker.stop`, shape gate.

**Looks** (`grade` presets, Video Editor names): `none`, `vivid` (sat 1.35, gain 1.05), `warm` (warmth 0.5), `cool` (warmth −0.5), `mono` (sat 0), `fade` (lift 0.06, gain 0.9, sat 0.8), `noir` (sat 0, gamma 1.2, gain 1.15).

### 9.2 `trigger` params on existing passes (additive; defaults keep every saved Visualizer design unchanged)

| Pass | New param | Options (default first) | "amount" means |
|---|---|---|---|
| `shake` | `trigger` | `kick`, `amount` | the kick envelope is replaced by 1, so the strength is `amount` (with its reactions) |
| `zoompulse` | `trigger` | `beat`, `amount` | `beat.pulse` replaced by 1 |
| `glitch` | `trigger` | `drop`, `amount` | `drop.pulse` replaced by 1 |
| `chromatic` | `source` (existing) | adds `amount` | drive = 1, so the radius = amount |

`validate.ts` checks enum values against the post's `ParamSpec`, so adding the option to the def is enough. The Visualizer designer shows it as "Its Amount (use reactions)".

### 9.3 New passes (one file each, `simplePass`; pure math in `post/px2math.ts`, table-tested)

| Type | Label | Params (min..max, default) | Effect |
|---|---|---|---|
| `punch` | Zoom punch | amount 0..1 (0), zoom 0..0.6 (0.15), rotate −15..15° (0), blur 0..1 (0.3) | scale `1 + zoom·amount`, rotation `rotate·amount`, radial blur toward the centre `blur·amount·2 %` of the short side (8 taps); cover-scaled so no border shows |
| `flash` | Flash | amount 0..1 (0), color (#ffffff), mode enum add/screen (add) | adds (or screens) `color·amount·1.6`; alpha `max(a, amount)` |
| `blurpulse` | Blur pulse | amount 0..1 (0), radius 0..0.05 (0.02) | separable 2-pass Gaussian of `radius·amount` of the short side (one instance, two internal passes) |
| `exposure` | Exposure pulse | amount −1..1 (0), stops 0..3 (1.5) | `rgb · 2^(stops·amount)` |
| `invert` | Invert | amount 0..1 (0) | `mix(rgb, a − rgb, amount)` (premultiplied) |

The five ids are added to `POST_TYPES` in Wave 0 (an unregistered type is skipped by the engine), so ES5 only adds files and their imports in `post/index.ts`.

---

## 10. Cut-outs and masks (WP-ES7 unless noted)

### 10.1 Modes

| Mode | For | How | Model |
|---|---|---|---|
| `image` | photo clips | `bgremove.run` with `output: "mask"`; the PNG mask is the matte | Background Remover's `balanced` (BiRefNet tiny, 224 MB, already pinned) |
| `people` | video, people | `matte.people`: Robust Video Matting, ONNX, recurrent, on the export-tier stream | `rvm_mobilenetv3_fp32.onnx` (~15 MB) |
| `select` | video, any subject | `matte.select`: SAM 2.1 video propagation from clicks | `sam2.1_hiera_tiny.pt` (~156 MB) |

### 10.2 Matte files

- **Video mattes:**
  - `<support>/projects/<project id>/mattes/<matteId>-export.h264` + `.idx.json`: grey (Y = alpha, chroma 128), the export stream's size capped at a short side of 1080, project fps, frame `j` = source frame `round(FromMs·fps/1000) + j`;
  - `-preview.h264` (+ index), transcoded from it by Go at short side 540;
  - same encoder settings as §7.1 with `-pix_fmt yuv420p`.
- **Image mattes:** `<matteId>.png` (L mode).
- `Duplicate` copies them with the project (`projectdocs` copies the folder).
- Mattes not referenced by any clip are deleted on Save (`Service.Save` removes `mattes/*` whose ID isn't in the saved document and isn't being made by a running job).

### 10.3 Handlers (`sidecar/toolbox_sidecar/handlers/matte.py`, `toolbox_sidecar/matte/`)

Common params:

- `{ffmpeg, stream, index, fromFrame, toFrame, fps, width, height, outPath, model: {file, sha256}}`;
- `width`/`height` = the matte size.

Frames are read like Redact:

- Python reads the index and opens the stream at the keyframe ≤ `fromFrame`;
- pipes those bytes to `ffmpeg -f h264 -framerate fps -i pipe:0 -vf scale=w:h -pix_fmt rgb24 -f rawvideo pipe:1`;
- discards frames before `fromFrame`.

Masks go to an encoder pipe (`-f rawvideo -pix_fmt gray -s wxh -r fps -i pipe:0` + the §7.1 encoder args, `-pix_fmt yuv420p`) writing `outPath.part`, renamed at the end.

- Per frame: `ctx.check_cancelled()`; `ctx.progress((j+1)/n, "Frame j of n")` (throttled by the registry).
- Run handlers never download.

**`matte.people`** (RVM ONNX, `onnxruntime` CPU):

- `downsample_ratio = clamp(480 / long side, 0.125, 1)`;
- recurrent states `r1..r4` start at zeros, reset at `fromFrame`;
- output `pha` × 255.

**`matte.select`** (SAM 2.1 tiny via the `sam2` package; device `mps` when available, else `cpu`; if MPS raises an unsupported-op error, retry the chunk on CPU and log once):

- **Clicks:** `[{frame, x, y, positive}]` in matte pixels.
- **Chunks:** 96 frames, written as JPEG q95 (long side ≤ 1024) into the job's temp dir. `init_state(chunk_dir, offload_video_to_cpu=True, offload_state_to_cpu=True)`.
- **Order:**
  1. the anchor is the first clicked frame;
  2. propagate forward chunk by chunk from the anchor's chunk;
  3. then backward from it.
- Each next chunk is seeded with the boundary frame's mask (`add_new_mask` on its first frame), plus any clicks that fall in it (`add_new_points_or_box`).
- Masks: logits > 0, resized to matte size (bilinear on logits), × 255.
- Range ≤ 60 s.

**`matte.select_preview`:** clicks on one frame give a PNG mask of that frame only (`outPath`), so the user sees the selection before propagating. The model stays resident between calls (module global, freed by the next `matte.*` model load).

**`matte.prefetch`:** `{model: {file, url, sha256}, modelDir}` → `download.ensure_model`.

Params are validated with `HandlerError("validation", …)`. Pytest uses a synthetic clip (a moving white square on black, made with numpy and written through FFmpeg). `people` and `select` need models, so those are `slow` tests; the frame I/O and chunk plan are fast tests.

### 10.4 Dependencies

- **RVM:** no new package (onnxruntime, numpy, ffmpeg pipes).
- **SAM 2:** add `sam2` to `pyproject.toml`. In Wave 0 the architect runs `uv lock` and checks it installs on Windows and `macosx_14_0_arm64` without a compiler, in this order:
  1. a wheel from PyPI;
  2. the sdist with `SAM2_BUILD_CUDA=0` and `no-build-isolation-package = ["sam2"]`;
  3. vendoring the inference code (Apache-2.0) under `toolbox_sidecar/matte/sam2/` without the CUDA extension, with its config YAML.
- If none works on a platform, `select` is stubbed: the handler returns `HandlerError("unavailable", "Subject select isn't available on this computer")` and the UI hides the mode there. The decision and the size impact go in DECISIONS.md.
- **Licences:** RVM is GPL-3.0 and SAM 2 is Apache-2.0. Fine for a personal, never-distributed app (as upscayl-bin's AGPL), noted in DECISIONS.md.

### 10.5 Matte jobs (`modules/editstudio/matte.go`, `models.go`)

```go
type MatteRequest struct {
    ClipID  string       `json:"clipId"`
    MatteID string       `json:"matteId"` // made by the UI and stored in clip.matte.id at submit
    Mode    string       `json:"mode"`    // "people" | "select" | "image"
    Path    string       `json:"path"`
    FromMs  int64        `json:"fromMs"`  // the clip's source range (the UI computes it with the speed curve)
    ToMs    int64        `json:"toMs"`
    Clicks  []MatteClick `json:"clicks"`  // select
    Preview bool         `json:"preview"` // select: one-frame preview at Clicks[0].Ms
}

type MatteState struct {
    ID      string      `json:"id"`
    Ready   bool        `json:"ready"`
    Preview *EditStream `json:"preview"` // video
    Export  *EditStream `json:"export"`
    Image   string      `json:"image"`   // image mattes
}
```

The `matte` job:

1. `job.Tool(sidecar.DepID)`; the model present check (`CodeDependencyMissing`, hint "Install the Music edits tool pack in Settings").
2. Pads the range by 500 ms on both sides (clamped to the source) so small trims don't invalidate it.
3. Ensures the export stream.
4. Calls the handler (progress 5–90 %).
5. Indexes the result, makes and indexes the preview copy (90–100 %).
- A `preview` select job writes `<project>/mattes/<matteId>-try.png` and returns it in the result.
- `Service.Mattes(projectId, ids)` reports `MatteState`s.
- A clip's matte is **ready** when its files exist and `[clip source range] ⊆ [FromMs, ToMs]`. Otherwise the Inspector shows "Matte out of date: Rebuild" (it keeps the clicks), and the render refuses it with that hint.
- Only one matte job runs at a time: `matte` jobs take a module-level semaphore ("Waiting for another cut-out" while queued), so two models are never loaded at once. Other Edit Studio jobs aren't held up (§11.2).

### 10.6 Models and the tool pack

- `modules/editstudio/models.go` pins `{file, url, sha256, bytes}` for preset `people` (RVM MobileNetV3 fp32 ONNX, GitHub release v1.0.0) and preset `select` (SAM 2.1 hiera tiny, `dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_tiny.pt`).
  - The sha256 values and byte sizes are measured in Wave 0.
  - Files live in `<models>/matte/`.
- `Module` implements `core.ModelProvider` (`ModelPresent`, `FetchModel` → `matte.prefetch`, `RemoveModel`).
- `core/packs/catalog.go`:
  - components `matte-people` and `matte-select` (Module `edit-studio`, presets above, measured sizes; `matte-select` also counts the `sam2` package's installed size against the engine component's disk size);
  - a new pack `edit`, "Music edits", icon `audio-waveform`: components `engine, ffmpeg, stems-default, whisper-default, matte-people, matte-select`; unlocks `edit-studio` (needs `engine`, `ffmpeg`).
- `image` mattes use Background Remover's `balanced` model. Without it the Inspector offers "Install the Image tool pack".

### 10.7 Matte UI (WP-ES7, `tools/edit-studio/matte/`)

- Inspector → **Cut-out**: Mode (Photo / People / Select a subject), status (none, making n %, ready, out of date, failed + retry), Cut-out switch, Invert, Feather, Stroke (px + colour), Glow (amount + colour), Effects apply to (Clip / Subject / Background).
- **Select a subject** opens `MatteDialog`:
  - a frame picker over the clip's source range (scrub, uses `MediaService.Frame`);
  - click to add positive points (Alt-click negative), shown as dots;
  - **Try** runs a preview job and overlays the mask at 50 %;
  - **Make cut-out** runs the full job;
  - after a job, correction clicks on any other frame trigger **Rebuild**.
- **Split subject** (clip context menu, needs a ready matte): duplicates the clip onto a new video track directly above, with the same timing, `Cutout: true`, effects cleared on the copy. The lower clip stays as the background. One undo step.

---

## 11. Module, jobs and service (`modules/editstudio`)

### 11.1 Descriptor

```go
core.Descriptor{
    ID: "edit-studio", Name: "Edit Studio", Icon: "audio-waveform", Category: core.CategoryMedia,
    Tagline:     "Cut clips and photos to a song's beats, drops and words",
    Description: "Pick a song to get its beats, kicks, drops and words as snap markers, drop in clips and photos, auto-fill a draft, then add cut-outs, captions and hit effects.",
    Status:      core.StatusReady,
    Accepts:     core.Accepts{Extensions: slices.Concat(media.AudioExtensions(), media.VideoExtensions(), media.ImageExtensions())},
    Requires:    []string{"ffmpeg", "ffprobe", sidecar.DepID},
    OutputSubdir: "Edits", Order: 14, MaxConcurrent: 2, NotAStep: true,
}
```

Edit Studio sits with the creator tools in the sidebar (after Video Editor).

### 11.2 Actions

```go
type Action string

const (
    ActionAnalyze Action = "analyze" // song analysis (viz.Analyzer) for a project
    ActionPrepare Action = "prepare" // preview streams, shots, preview images for source paths
    ActionInterp  Action = "interp"  // interpolated slow-motion stream for a range
    ActionMatte   Action = "matte"   // a clip's matte
    ActionRender  Action = "render"  // the export into <library>/Edits
    ActionText    Action = "text"    // markers CSV/JSON or captions SRT into <library>/Edits
)

type Options struct {
    Action    Action          `json:"action"`
    ProjectID string          `json:"projectId"`
    Analyze   *AnalyzeRequest `json:"analyze"`
    Prepare   *PrepareRequest `json:"prepare"`
    Interp    *InterpRequest  `json:"interp"`
    Matte     *MatteRequest   `json:"matte"`
    Text      *TextRequest    `json:"text"`
}

type AnalyzeRequest struct {
    Song       string          `json:"song"`
    Words      viz.WordsSource `json:"words"`      // "none" | "detect" | "align"
    LyricsText string          `json:"lyricsText"` // align: ≤ viz.MaxLyricsChars
    Language   string          `json:"language"`   // "" = auto
}
type PrepareRequest struct { Paths []string `json:"paths"`; FPS int `json:"fps"` }               // 1..300 paths
type InterpRequest  struct { Path string `json:"path"`; FromMs int64 `json:"fromMs"`; ToMs int64 `json:"toMs"`; FPS int `json:"fps"` } // ≤ 30 s
type TextRequest struct {
    Kind    string        `json:"kind"`    // "markers-csv" | "markers-json" | "srt"
    Name    string        `json:"name"`    // file stem (cleaned like project names)
    Markers []MarkerRow   `json:"markers"` // ≤ 20,000
    Cues    []lyrics.Line `json:"cues"`    // srt: timeline ms, ≤ 20,000
    Meta    string        `json:"meta"`    // markers-json header {project, song, startMs, endMs, fps} as JSON
}
type MarkerRow struct {
    Lane string `json:"lane"`; TimelineMs int64 `json:"timelineMs"`; SongMs int64 `json:"songMs"`; EndMs int64 `json:"endMs"`
    Strength float64 `json:"strength"`; Label string `json:"label"`; Bar int `json:"bar"`; Beat int `json:"beat"`
}

type Result struct {
    Action   Action           `json:"action"`
    Analysis *viz.AnalysisRef `json:"analysis"` // analyze
    Sources  []SourceState    `json:"sources"`  // prepare
    Interp   *EditStream      `json:"interp"`   // interp
    Matte    *MatteState      `json:"matte"`    // matte
    TryPath  string           `json:"tryPath"`  // matte preview
    Outputs  []string         `json:"outputs"`  // render, text
    Encoder  string           `json:"encoder"`  // render
    Speed    float64          `json:"speed"`    // render: media seconds per wall second
}
```

- `Validate` checks the action's request shape (enums, counts, sizes) and that `ProjectID` exists. File existence is checked in `Run`; a missing file fails the job naming it.
- `Run` dispatches by action. Job titles:
  - "Analyzing — <song>";
  - "Preparing N clips";
  - "Slow motion — <file>";
  - "Cut-out — <file>";
  - "Exporting — <project>";
  - "Saving markers".
- **Concurrency:**
  - `MaxConcurrent: 2` (module), plus the render broker's one-render semaphore;
  - plus one matte at a time (§10.5);
  - plus one analysis at a time per song (the Analyzer's own cache lock).

### 11.3 Service (`EditStudioService`, `service.go`)

```go
func (s *Service) List() ([]core.ProjectInfo, error)
func (s *Service) Get(id string) (EditProject, error)
func (s *Service) Create(name, aspect string, fps int) (core.ProjectInfo, error)
func (s *Service) Save(id, name string, doc EditProject) (core.ProjectInfo, error)    // validateShape; prunes unused mattes (§10.2)
func (s *Service) Duplicate(id string) (core.ProjectInfo, error)
func (s *Service) Delete(id string) error
func (s *Service) SaveThumb(id, jpegDataURL string) error                              // ≤ 512 KiB, written to thumb.jpg

func (s *Service) Probe(paths []string) ([]videoeditor.ClipInfo, error)                // ≤ 300
func (s *Service) Analysis(key string) (viz.AnalysisRef, error)
func (s *Service) AnalysisFor(path string) (viz.AnalysisRef, bool)                     // newest with stems
func (s *Service) Analyze(projectID string, req AnalyzeRequest) (core.Job, error)
func (s *Service) Sources(paths []string, fps int) ([]SourceState, error)              // no work; Preparing from running jobs
func (s *Service) Prepare(projectID string, paths []string, fps int) (core.Job, error)
func (s *Service) Interpolate(projectID string, req InterpRequest) (core.Job, error)
func (s *Service) InterpFor(path string, fromMs, toMs int64, fps int) (*EditStream, error) // the preview stream if made
func (s *Service) Matte(projectID string, req MatteRequest) (core.Job, error)
func (s *Service) Mattes(projectID string, ids []string) ([]MatteState, error)
func (s *Service) MatteModels() MatteModels                                            // {people, select, image, selectAvailable bool}
func (s *Service) Render(projectID string) (core.Job, error)
func (s *Service) ExportText(projectID string, req TextRequest) (core.Job, error)
func (s *Service) Fonts() []string                                                     // media.Fonts()

// Bindings only:
func (s *Service) ResultShape() Result
```

### 11.4 Config and wiring (`main.go`, Wave 0)

```go
editMod := editstudio.New(editstudio.Config{
    Store: db, ProjectsDir: projectsDir, CacheDir: filepath.Join(paths.CacheDir, "editstudio"),
    ModelsDir: paths.ModelsDir, Engine: engine, Analyzer: vizAnalyzer, Broker: vizBroker,
    Resolve: depSvc.Resolve, Jobs: jobs, BgRemove: bgMod,   // bgMod: the Background Remover module (model spec + presence)
})
editstudio.Register(reg, editMod)
go editMod.PruneCache()
application.NewServiceWithOptions(editstudio.NewService(jobs, editMod), opts)
```

### 11.5 Analyze

```go
viz.AnalyzeOptions{Stems: true, Words: req.Words, LyricsText: req.LyricsText, Language: req.Language, Mood: false}
```

- The result's `Analysis` ref goes to the UI, which stores `analysisKey` and loads it with `loadAnalysis`.
- Before submitting, the setup screen calls `AnalysisFor(song)`. If a stems analysis exists, it offers **Use it**, which sets `analysisKey` with no job. The offer also says whether that analysis has words.
- Analysis failures map as in the Visualizer: no engine gives `CodeDependencyMissing` with the pack hint; a silent or short input gives the validation message.

### 11.6 Small changes elsewhere (Wave 0, additive)

- `modules/videoeditor`: export `ProbeFiles(ctx, ffprobe string, paths []string) []ClipInfo` (the existing `probeFile` loop).
- `modules/bgremove`: export `ModelSpec(preset string) (ModelSpec, bool)` and `ModelDir()` if missing, for the `image` matte call.
- `core.ProjectEdit`.
- `api/events.go`: nothing new. Jobs events cover progress; source and matte readiness are re-read when the job finishes.

### 11.7 Text files (`text.go` (WP-ES1) and `srt.go` (WP-ES9))

- The `text` job writes `<library>/Edits/<name> markers.csv|.json` or `<name>.srt` with `core.UniquePath` and registers it with `job.Output`.
- **CSV:** RFC 4180 with a header row (§5.6).
- **SRT:** `subtitles.FormatSRT` (exported in Wave 0 from the existing `formatSRT`) over `Cues`.

---

## 12. Export (WP-ES8 Go; the worker side is WP-ES3)

### 12.1 The render job (`render.go`)

1. Load the project, then `validateDoc` (§6.1).
2. Resolve the output size:
   - short side = `ExportHeight`, long side by aspect (9:16 → 1080 × 1920; 4:5 → 1080 × 1350; 1:1 → 1080 × 1080; 16:9 → 1920 × 1080; likewise for 720 and 1440; even sizes);
   - fps = project fps.
3. **Sources** (progress 0–25 %): for every video clip on a non-muted track, ensure the export stream (§7.1), plus the interp stream where `Slow: "interpolate"`. For every photo, ensure the export image. For every ready matte, take its `-export` stream or PNG.
4. **Plan:** `viz.RenderPlan` with:
   - `Analysis` (from `Lookup(AnalysisKey)`), `Width`, `Height`, `FPS`;
   - `StartMs = Song.StartMs`, `EndMs = Song.EndMs`;
   - `Mode = opaque`, `Seed = project Seed`;
   - `Edit = &viz.EditPlan{ProjectJSON, Streams, Images}` with the §8.1 keys.
5. **Render** (25–85 %): `broker.Render` reports frames as today.
6. **Audio** (85–92 %): `audio.go` writes `mix.wav` (§12.3) into TempDir.
7. **Mux** (92–100 %): `viz.MuxOpaque(ctx, ffmpeg, out, mixPath, 0, 0, fps, "", dst, …)`.
   - `dst = core.UniquePath(job.OutputDir, fileStem(name), ".mp4")`; `job.Output(dst)`.
   - Result `{outputs, encoder, speed}`.
- A cancel at any point removes partial files (the broker cleans its stream; `dst.part` is removed).
- Seams like the Visualizer's (`renderFn`, `muxFn`, `ensureStreamFn`, `mixFn`) so `run_test.go` covers the flow without FFmpeg or a webview.

### 12.2 `core/viz` additive contract (Wave 0, architect; recorded in DECISIONS.md)

```go
// RenderPlan gains:
    Edit *EditPlan `json:"edit"` // non-nil: an Edit Studio render (ShowJSON is "")

// EditPlan is everything an Edit Studio render needs besides the analysis.
type EditPlan struct {
    ProjectJSON string                    `json:"projectJson"` // the EditProject document (≤ 4 MiB)
    Streams     map[string]EditPlanStream `json:"streams"`     // §8.1 keys → files
    Images      map[string]string         `json:"images"`      // §8.1 keys → files
}
type EditPlanStream struct {
    Stream string `json:"stream"`
    Index  string `json:"index"`
}
```

- `buildWorkerPlan` turns every path into a `/media` URL.
- `PlanForWorker` gains `Kind string` (`"show"` | `"edit"`) and `Edit *workerEdit` (`projectJson`, `streams: {key: {url, indexUrl}}`, `images: {key: url}`).
- TS `PlanForWorker` gets the same optional fields.
- `plannedFrames` is unchanged: `StartMs..EndMs` is the song range, so frames = `round(D·fps/1000)`.
- **Worker:** `render.worker.ts` keeps the show path. Wave 0 moves its encode loop into `worker/loop.ts`:

  ```ts
  encodeFrames(canvas, plan, frames, renderFrame: (i) => Promise<void>, flow, post)
  ```

  It adds one line that sends `plan.kind === "edit"` plans to `viz/edit/worker.ts runEdit(plan, …)` (stubbed in Wave 0, built by ES3).
- **`runEdit`:**
  - loads the analysis and parses the project;
  - `deriveMarkers`, `compileEdit`, a worker `FrameProvider` on the export URLs;
  - per frame `i`: `t = i·1000/fps`, `await provider.prepare(engine.needs(t), true)`, `engine.render(t, provider)`.

### 12.3 Audio mix (`audio.go`)

One FFmpeg run with the graph in a file (`-/filter_complex graph.txt`, as the Video Editor does) → `mix.wav` (PCM s16, 48 kHz, stereo), length exactly `D`:

- **song:** `-ss StartMs -to EndMs -i song` → `volume=<GainDb>dB`, `afade=t=in:d=<FadeIn>`, `afade=t=out:st=<D−FadeOut>:d=<FadeOut>`.
- **Clip audio:** for each video clip on a non-muted track with `Volume > 0` whose source has audio:
  - `atrim` over its source range, `asetpts`;
  - constant speed only: `atempo` chain for 0.5..4 (speed 0 or keyed speed → the clip's audio is skipped, and the Inspector says "Audio is off while the speed changes");
  - `volume=<Volume>`, 10 ms `afade` in/out, `adelay=<StartMs'>|<StartMs'>`.
- `amix=inputs=N:normalize=0:duration=first` → `alimiter=limit=0.97` → `atrim=0:<D>`.

---

## 13. Auto-fill (`tools/edit-studio/autofill/`; WP-ES6)

### 13.1 Types (frozen in Wave 0, `autofill/types.ts`)

```ts
export interface RecipeRule {
  sections?: SectionLabel[];            // applies inside these sections; omitted = anywhere not taken by an earlier rule
  cutLane: MarkerLane;                  // cut points
  every?: number;                       // every Nth marker of that lane (after the lane's own filters), default 1
  minClipMs?: number;                   // merge cuts closer than this (drop the later cut), default 250
  sourceOrder: "sequential" | "shuffleNoRepeat" | "byTag";
  tags?: string[];                      // byTag (and a preference for the others)
  videoIn: "start" | "random" | "shotAligned";
  effects?: EditPost[];                 // added to every clip this rule makes
  transition?: EditTransition;          // into every clip this rule makes (default cut)
}
export interface Recipe {
  id: string; name: string; description: string;
  rules: RecipeRule[];                  // first matching rule wins per section
  onDrop?: { tag?: string; effects: EditPost[]; transition?: EditTransition };
  onStop?: "freeze" | "black" | "none";
}
export interface AutofillOptions {
  recipeId: string;
  seed: number;
  order: "recipe" | "sequential" | "shuffleNoRepeat" | "byTag";   // "recipe" = each rule's own
  sources: "all" | "selected" | string[];  // explicit paths (from the Sources panel selection)
  trackId: string | "new";              // target video track; "new" adds "Auto" on top
  range: { fromMs: number; toMs: number } | null;  // timeline ms; null = whole edit
}
export interface AutofillInput {
  project: EditProject; markers: Marker[]; analysis: Analysis;
  sources: Array<{ path: string; kind: "video" | "image"; durationMs: number; tags: string[]; shots: number[] | null }>;
  recipe: Recipe; options: AutofillOptions;
}
export interface AutofillResult { trackId: string; clips: Clip[]; removed: string[]; warnings: string[] }
export function autofill(input: AutofillInput): AutofillResult;   // pure, deterministic
```

### 13.2 Algorithm (deterministic; every step table-tested)

1. **Range** `[a, b)`: the option, or `[0, D)`. Sections are clipped to it. Each section takes the first rule whose `sections` include its label (or that has none). With no rule, the section is skipped (left empty).
2. **Cut points per section:**
   - the section's start and end, plus the `cutLane` markers inside (thinned by `every`);
   - with `onDrop`, also every `drop` marker;
   - merged when closer than `minClipMs` (keep the earlier, but never drop a section boundary or a drop);
   - snapped to the frame grid.
3. **Slices** between consecutive cut points.
4. **Pinned and kept clips:** on the target track, clips with `Pinned` or `!Auto` are kept. Slices overlapping them are cut around them (pieces < `minClipMs` are dropped). `Auto && !Pinned` clips inside the range are removed (listed in `removed`).
5. **Source per slice:**
   - `rng = makeRng(seed, "autofill/" + recipeId)`.
   - `sequential`: the next source in Sources-panel order.
   - `shuffleNoRepeat`: a seeded shuffle of the list, reshuffled when it runs out, never the same source twice in a row (if > 1).
   - `byTag`: sources with any of `tags`, sequential; all sources when none match.
   - A slice starting at a drop with `onDrop.tag` takes the next source with that tag.
6. **Video in-point:**
   - `start`: continue where that source was last used (first use 0), wrapping to 0 when the rest is shorter than the slice;
   - `random`: `rng()·(duration − slice)`, snapped to a frame;
   - `shotAligned`: the first shot ≥ the source's cursor that leaves room for the slice, else like `start`.
   - A video shorter than its slice is used whole, and the slice continues with the next source (another clip).
   - Photos fill the slice.
7. **Clip fields:**
   - `Kind` from the source; `Fit: "fill"`; `Auto: true`; `Pinned: false`;
   - `Effects` = rule effects (+ `onDrop.effects` for drop slices) with fresh ids; `In` = rule or drop transition.
   - IDs `a<run>-<n>` (`run` = `RecipeRun.Run + 1`).
8. **Stops** (`onStop`), for each `stop` marker in range:
   - `freeze`: the clip covering the stop gets speed keys `[1 until stop, 0 from stop to end, 1 after]` (`hold` eases);
   - `black`: a `color #000000` clip over `[ms, endMs)` on the target track, splitting the clip under it;
   - `none`: nothing.
9. The result goes into the project in **one undo step**. `RecipeRun` gets the recipe, seed, run+1 and options. Clips are re-sorted, and the shape is validated before commit (a failure shows a banner and changes nothing).

Performance: < 2 s for the fixture and for a 3-minute song with 300 sources (Vitest).

### 13.3 Presets (`autofill/recipes.ts`)

| ID | Name | Rules |
|---|---|---|
| `downbeat` | Downbeat cuts | `[{cutLane: "downbeat", sourceOrder: "sequential", videoIn: "start"}]` |
| `kick` | Kick cuts | `[{cutLane: "kick", minClipMs: 120, sourceOrder: "shuffleNoRepeat", videoIn: "random"}]` |
| `chorus-double` | Chorus double-time | `[{sections: ["chorus","drop"], cutLane: "beat", sourceOrder: "shuffleNoRepeat", videoIn: "random"}, {cutLane: "downbeat", sourceOrder: "sequential", videoIn: "start"}]` |
| `hold-verse` | Hold verse | `[{sections: ["verse","intro","bridge"], cutLane: "phrase", sourceOrder: "sequential", videoIn: "shotAligned"}, {sections: ["chorus","drop"], cutLane: "kick", minClipMs: 200, sourceOrder: "shuffleNoRepeat", videoIn: "random"}, {cutLane: "downbeat", sourceOrder: "sequential", videoIn: "start"}]` |
| `drop-slam` | Drop slam | `[{sections: ["drop"], cutLane: "kick", minClipMs: 150, sourceOrder: "shuffleNoRepeat", videoIn: "random", effects: [punch ← marker.kick]}, {cutLane: "downbeat", sourceOrder: "sequential", videoIn: "start"}]`, `onDrop: {tag: "hero", effects: [punch ← marker.drop, flash ← marker.drop], transition: {kind: "flash", ms: 300}}`, `onStop: "freeze"` |

When the phrase lane is empty (no words and no voiced runs), Hold verse falls back to downbeats in those sections and warns.

### 13.4 Auto-fill dialog (`autofill/AutofillDialog.tsx`)

- Opened from the header (**Auto-fill**), a section band's menu (**Auto-fill this section**) or a range selection.
- Fields: recipe cards (name, description, a mini cut-density strip computed with `autofill` on the current project), media order, sources (all / selected / by tag chips), target track, range (whole / selection / section, read-only label), seed (number + dice).
- Live summary: "≈ 42 cuts · 12 sources · 3 pinned clips kept".
- **Apply** commits.
- Re-running with the same seed and inputs gives the same clips.

---

## 14. UI (`frontend/src/tools/edit-studio/`)

One tool view. It reuses `components/` primitives, `components/media` (`Waveform`, `TimecodeInput`, `formatMs`), `songmap/draw.ts` (`drawLane`, `readTheme`, `View` helpers), the designer's `SignalMeter`, and the Video Editor's patterns (projects home, autosave, history, filmstrips). Colours come from tokens. Lane colours are new tokens `--lane-<lane>` in `styles/tokens.css` (Wave 0), with light and dark values.

### 14.1 Home and new edit (WP-ES2, `home/`)

- **ProjectsHome:** a card grid like the Video Editor's.
  - Thumb via `FilesService.ImageThumb(info.thumb, 240)`, name, clip count, missing badge, updated time.
  - Open, Duplicate, Rename (Get + Save), Delete (confirm).
  - Empty state with a `DropZone` ("Drop a song to start an edit").
  - The last open project is reopened through `SettingsService.SetModuleState(moduleId, {lastProjectId})`.
- **NewEditDialog:** name (default: the song's file name), song (file picker for audio/video; or prefilled by a drop or handoff), aspect (9:16 default, 4:5, 1:1, 16:9; shape icons), fps (30 default, 60). Create calls `Create`, sets `song = {path, startMs 0, endMs = duration (≤ 10 min), gainDb 0, fadeIn 0, fadeOut 500}`, saves, and opens Setup.

### 14.2 Setup: analysis and range (WP-ES1, `setup/`)

Shown in place of the lanes and tracks while the project has no analysis, and later from the song's Inspector ("Change range…", "Analyze again…").

- **Analysis panel:**
  - **Reuse:** "This song was analysed before (with lyrics / without lyrics). Use it" | "Analyze again".
  - **Words:** None / Detect (transcribe the vocals) / Use my lyrics (a TextArea, ≤ 20,000 chars), plus Language (auto default).
  - **Analyze** submits the job; progress and log tail come from the job; Cancel.
  - Failure shows the AppError with Retry.
- **Range picker:** after analysis, a full-song map (sections, beats, waveform) with a draggable range.
  - Edges snap to downbeats unless Alt is held.
  - Quick picks: "Whole song", "First chorus", "Last chorus", "Drop", "30 s from here", "15 s from here".
  - Start/end `TimecodeInput`s, duration readout, **Use this range**.
- **Changing an existing range:** with "Keep clips on the music" (default on), every clip moves by `−Δstart`. Clips that end up fully before 0 are removed and partly-before clips are trimmed (one undo step, with a toast saying how many were removed). With it off, clips keep their timeline times.

### 14.3 Editor layout (Wave 0 shell, panels by package)

```
┌ Header: ← Projects · name (inline rename) · save state · 9:16 · 30 fps · Undo Redo · Auto-fill · ⋯ (Export markers, Export SRT, Duplicate) · Export ┐
├ Sources (260 px, collapsible) │ Preview (flex; canvas letterboxed)        │ Inspector / Captions tabs (320 px)     ┤
├ Transport: ▶ · time / duration · active lane ▾ · snap ⦿ · cut offset · zoom − + fit · safe zones · fps/dropped readout                 ┤
├ Lanes (resizable, default 180 px): ruler · section bands · waveform · stems (collapsed) · marker lanes (one row each)                     ┤
├ Tracks (resizable): headers (name, kind icon, mute, lock, ⋯) | clips; "+ Track" ; song track locked at the bottom (waveform, fades)      ┤
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- The lanes and tracks share one horizontal scroll and zoom (`pps`, 6..800 px/s, Ctrl/Cmd+wheel around the pointer, plain wheel scrolls). The playhead line and section bands span both.
- Preview canvas size: short side 540 (9:16 → 540 × 960; 4:5 → 540 × 675; 1:1 → 540 × 540; 16:9 → 960 × 540), CSS-scaled to fit.
- **Safe zones** overlay (9:16 and 4:5): top 10 %, bottom 22 %, right 14 %, left 6 % shaded with labels.
- Minimum window 1180 × 720. Below 1400 px wide, Sources and the right panel become overlays toggled from the header.

### 14.4 Lanes (WP-ES1, `lanes/`)

- **Waveform row:** `MediaService.Waveform(song, 4000)` peaks of the whole song, drawn for the visible window (`musicPeaksWindow` from `video-editor/panelLogic.ts`).
- **Stems rows** (collapsed by default): `drawLane` lanes `drums`, `bass`, `vocals`, `other` (level curves; only when the analysis has stems).
- **One row per lane** (18 px; hidden lanes are listed in a "+ lanes" menu):
  - colour swatch, name, count, eye toggle;
  - **⋯** opens `LaneSettingsPopover`: strength threshold slider with a live count, every N stepper, first of bar switch, nudge slider (−200..200 ms), Reset lane;
  - the downbeat lane's popover also has **Bar starts on beat 1/2/3/4**.
- **Active lane** (the transport's ▾, or click a lane name): it drives snapping hints, fill-to-next, slice and `[`/`]`.
- **Markers** are drawn on one canvas per lane for the visible window only: ticks (height ∝ strength), ranges for section/stop/phrase/word, labels for words and custom markers when they fit. The playhead is a separate overlay element (no redraw per frame).
- **Interactions** (§5.6): click selects; drag moves; Delete hides or removes; double-click a custom marker renames it; hover shows `lane · time · strength`.
- **Section bands:** translucent bands with labels across lanes and tracks (`SectionBands` component, also used by WP-ES2 in the tracks area). Click selects the section as a range. The band menu has Rename section, Select range, Auto-fill this section.

### 14.5 Tracks and clips (WP-ES2, `timeline/`)

Pure edit operations live in `timeline/ops.ts` (table-tested). Each returns a new `EditProject` (or null when nothing changed), and all go through `store.edit(next, key)`.

| Op | Rule |
|---|---|
| `insertClip(doc, trackId, source, atMs, mode)` | `mode = "fill-next"`: spans to the next marker of the active lane after `atMs` (or 2 s / the source length if none, or to the next clip on the track); `"source"`: the source's length (photos 2 s). Never overlaps: shortened to the gap; a drop on an occupied point inserts after the clip under it. |
| `moveClips(doc, ids, deltaMs, toTrackId?)` | keeps relative timing; blocked (no change) if any clip would overlap; snaps the leading edge |
| `trimClip(doc, id, edge, toMs)` | start edge also moves `InMs` by the source-time delta (speed-aware); limits: ≥ 1 frame, ≤ source end |
| `splitAt(doc, ids, tMs)` | two clips; the right one gets a new ID, `InMs` advanced, keys re-based; a matte is shared |
| `sliceAtMarkers(doc, ids \| range, lane, cycleSources)` | splits at every marker of that lane inside; `cycleSources` replaces slice k ≥ 1 with the next source in the Sources order (for videos continuing from that source's cursor, as `start` in §13) |
| `deleteClips`, `duplicateClips` (to the right, or Alt-drag), `setTrack…` (add ≤ 8, remove, reorder, rename, mute, lock, kind on empty tracks) | |

- **Snapping:**
  - targets are markers of visible lanes, clip edges on all tracks, the playhead, and 0 / D;
  - threshold 8 px;
  - the hint chip names the target ("kick", "downbeat", "clip edge");
  - Alt bypasses; the transport toggle turns it off.
- **Clip view:**
  - filmstrip (`MediaService.Filmstrip(path, 10, 48)`) or photo thumb, colour swatch for color clips, name;
  - badges: effects count, matte state, speed keys, `auto` (dotted outline), pinned (pin icon), missing/preparing (hatched/stripes).
  - Selection: click; Shift adds; Cmd/Ctrl toggles; a marquee on empty space.
- **Edits mark ownership:** any edit to an `Auto` clip clears `Auto`. Pin/unpin is in the clip's context menu.
- **Song track:** waveform with the range, fades drawn as ramps (drag their handles), gain in the Inspector.
- **Context menus:** Split at playhead, Slice at markers (active lane), Slice and cycle sources, Split subject (needs a matte), Pin, Duplicate, Delete, Reveal source.

### 14.6 Sources (WP-ES2, `sources/`)

- Grid of tiles: thumb (filmstrip first frame / photo thumb), duration, kind icon, tag chips, status (Preparing n % / Ready / Error + retry / Missing). Used-count badge.
- **Adding** (buttons, drops, handoffs): `Probe`, then append to `Sources` (dedup), then `Prepare(projectId, newPaths, fps)`. A folder adds its media files (non-recursive; dot-files skipped).
- Statuses come from `Sources(paths, fps)` on load, after each prepare job update, and when the fps changes. A changed fps triggers `Prepare` for all sources.
- **Tags:** click a chip to toggle. Presets hero/closeup/wide/broll, plus "+ tag". Filter by tag. Select (for auto-fill "selected").
- **Drag** a tile to a track with a pointer-event drag (not HTML5 DnD; same approach as `post-builder/sourceDrag.ts`). The drop uses `insertClip(…, "fill-next")` (hold Shift for "source").
- Double-click inserts at the playhead on the selected (or first unlocked video) track.

### 14.7 Preview and transport (WP-ES2 transport; WP-ES3 `EditCanvas`)

- **Clock:** `MediaPlayer kind="audio"` (hidden UI) on the song's `useMediaSource` URL, `startMs = song.startMs`. Its `onTime` gives timeline ms; the store's `playheadMs` follows it.
  - Playback stops at D.
  - Volume = `min(1, 10^(gainDb/20))` with the fades applied per tick.
- **Keys:**
  - Space play/pause;
  - K pause; L play (again: 1.5× then 2×, `playbackRate`); J back 2 s and play;
  - ,/. previous/next frame;
  - [ / ] previous/next marker on the active lane;
  - Home/End.
- **Preview:** `EditCanvas` gets `EditInputs` built by the `useEditInputs()` store hook (project, analysis, markers, `EditFiles` from `SourceState` / `MatteState` / interp URLs via `MediaService.URLFor`, cached).
  - The readout shows fps, dropped and waiting frames.
  - **Thumbnails:** on save, at most every 30 s, the canvas at the playhead → JPEG 320 px → `SaveThumb`.
- **Clip audio** isn't played. A muted-speaker hint appears on clips with volume > 0 ("Heard in the export").

### 14.8 Inspector and overlays (WP-ES10, `inspector/`, `overlays/`)

The Inspector follows the selection:

- **Clip:**
  - **Source** (file, In point, speed: constant slider 0.1..4 or keyframes, Slow (blend / none / interpolate with the synthesis label and a Make button), volume, fit, fit colour, flip, blend);
  - **Transform** (x, y, scale, rotation, opacity);
  - **Effects** (stack; Add → templates (§9.1) or any offered type; reorder by drag; enable; remove; per param an `EditParamEditor`);
  - **Transition in** (kind + ms);
  - **Cut-out** (WP-ES7's `CutoutSection`);
  - **Masks** (add rect / ellipse / path; per mask: shape params, feather, invert, op);
  - **Tags/pin**.
- **Adjust clip:** effects, opacity, masks.
- **Track:** name, mute, lock.
- **Song:** range (opens Setup's range picker), gain, fade in/out, cut offset (−3..3 frames, "Cuts land N frames early/late").
- **Project** (nothing selected): aspect (changing it keeps clips; the preview re-fits), fps (30/60; re-prepares sources), background colour, **Look** (preset select §9.1 + the full effect stack incl. bloom/vignette/grain), export size (720/1080/1440), seed.

Shared editors:

- **`EditParamEditor({spec, value, onChange, clipTimeMs, allowKeys, allowMods})`:** a slider plus:
  - a **keyframe diamond**: add or remove a key at the playhead's clip time; ◀ ▶ jump between keys; ease menu;
  - a **reactions** toggle opening `EditModsEditor` (the designer's `ModsEditor` pattern) with `EditSignalSelect` (the viz signal groups plus a **Markers** group, one entry per lane with its colour), `every` (marker signals) and `sections` chips, and a live `SignalMeter`-style meter.
- **Ken Burns on markers** (clip menu): scale keys from 1.0 to 1.12 (alternating in/out) and x/y drift ±0.03, placed on each active-lane marker inside the clip.

**Overlays** on the preview (selected clip):

- **transform box:** drag moves x/y, corner handles scale uniformly, the top handle rotates; snapping to centre lines;
- **mask handles:** rect/ellipse bounds, path points (drag; double-click an edge to add, Alt-click to remove);
- **safe zones** (§14.3).

Overlay edits write keys when the param has keys (at the playhead), else the base. They coalesce into one undo step per drag.

### 14.9 Captions (WP-ES9, `captions/`)

The right panel's **Captions** tab:

- **Show captions** switch (sets `Captions` to defaults or nil).
- **Style:**
  - preset picker (the 8 `TextPreset`s, live-rendered names), font (`Fonts()`), size, colour, highlight, position, uppercase, outline, glow, emphasis;
  - built from a `TextStyleEditor` component that WP-ES9 extracts from the Visualizer's `LookTab` text section into `components/viz/TextStyleEditor.tsx`. LookTab then uses it, with no behaviour change.
- **Behind subject** (disabled with "Make a cut-out on a clip first" when no clip has a ready matte).
- **Words:**
  - the source line ("Detected from the vocals" / "Aligned to your lyrics" / "No words: analyse with words…" linking to Setup);
  - a word list in the `CueList` pattern (one row per line: start/end timecodes, text; expanding a row shows its words with their times, editable);
  - row actions split, merge, insert, delete, start/end at playhead;
  - Reset to the analysis.
  - Editing writes the full lines array into `Captions.Lines` (song ms); timecodes are shown in timeline ms.
- **Export SRT** (also in the header ⋯): the `text` job with `Cues` = lines inside the range, shifted to timeline ms.

### 14.10 Export (WP-ES8 frontend, `export/`)

- **ExportDialog:** size (720/1080/1440 short side, with the pixel size), fps (read-only, the project's), estimated duration, Export.
  - Checks before submit: unprepared sources (offers to wait), mattes not ready or out of date (offers Rebuild, or Remove the cut-out from those clips as one undo step), missing files (lists them).
- **Progress:** the job in the job tray and a banner in the header with Cancel.
- **When done:** a banner with Open, Reveal, Add to post… (opens the Library's Add to post dialog for the output).

### 14.11 Shortcuts and commands (WP-ES2 `transport/shortcuts.ts`, `commands.ts`)

| Key | Action |
|---|---|
| Space / J K L / , . / [ ] / Home End | transport (§14.7) |
| S | split selected clips (or the clip under the playhead on the selected track) at the playhead |
| Shift+S | slice selection at markers of the active lane |
| T (playing) / M (paused) | tap / add a custom marker |
| Delete / Backspace | delete selected clips or markers |
| Mod+D | duplicate |
| Mod+Z / Mod+Shift+Z, Mod+Y | undo / redo |
| Mod+A | select all clips on the selected track |
| Alt (held) | bypass snapping |
| 1..9 | set the active lane (order of visible lanes) |

Palette commands (`useCommands`, section "Edit Studio"): New edit, Auto-fill…, Export…, Export markers (CSV), Export markers (JSON), Export SRT, Slice at markers, Split subject, Toggle safe zones, Toggle snapping, Add track, Add adjustment track.

### 14.12 State (`store.ts`, Wave 0)

zustand `useEditStudio`:

- **State:**
  - `projectId`, `name`, `history: History<EditProject>`, `saveState`;
  - `selection: {kind: "clips", ids} | {kind: "track", id} | {kind: "song"} | {kind: "markers", ids} | {kind: "range", fromMs, toMs} | null`;
  - `playheadMs`, `playing`, `activeLane`, `snap`, `pps`, `scrollMs`;
  - `analysisRef`, `analysis`, `sources: Record<path, SourceState>`, `mattes: Record<id, MatteState>`, `jobs: {analyze?, prepare?, render?, mattes: Record<id, jobId>}`.
- **Actions:** `open(id)`, `close()`, `edit(next, key?)`, `undo()`, `redo()`, `select(…)`, `setPlayhead`, `setPlaying`, `setActiveLane`, `setSources`, `setMattes`, `setAnalysis`.
- **Hooks** (stable references; no arrays built inside selectors):
  - `useProject()`;
  - `useMarkers()`: memoised `deriveMarkers`;
  - `useEditInputs()`;
  - `useSelectedClips()`.
- `history` is the Video Editor's, moved to `lib/history.ts` (the old path re-exports it).
- `useEditAutosave` is the Composer's `useAutosave` pattern: 800 ms, one save in flight, flush on close, open, export, matte and render.

### 14.13 Handoffs and drops

- `takeHandoff("edit-studio")` and drops on the page:
  - **one audio file** opens NewEditDialog with it (or, with a project open, "Use as the song?" confirm, which re-runs Setup);
  - **videos and photos** are added to the open project's Sources; with no project open, NewEditDialog with no song and those files queued as sources.
  - Mixed drops do both.
- The Library's Send to lists Edit Studio for audio, video and images.

### 14.14 States and errors

- **Engine or FFmpeg missing:** `DepsGate` with the pack (Music edits).
- **Song missing:** a banner with "Find the song…" (file picker, which keeps the range if durations match within 1 s).
- **Analysis gone** (pruned cache): "This song's analysis isn't cached any more. Analyze again" (markers state is kept).
- **WebGL2 unavailable:** the Visualizer's banner.
- **No `VideoDecoder`:** "This system can't decode video for Edit Studio", with photos and colour clips still shown; export is blocked.
- **Missing source:** a hatched clip, a badge in Sources, and Reveal/Relink (relink = pick a new file for every clip and source with that path).
- **Field errors from Save** (`AppError.fields`) mark the matching clip and show the message in the header.

---

## 15. Storage, caches and limits (summary)

| What | Where | Lifetime |
|---|---|---|
| Project document | `projects` table, kind `edit` (≤ 4 MiB) | until deleted |
| Thumb, mattes | `<support>/projects/<id>/thumb.jpg`, `mattes/` | with the project; unused mattes removed on Save |
| Edit streams, edit images, shots, interp | `<support>/cache/editstudio/src/<fileKey>/` | pruned at start: 30 days unused, then oldest above 10 GB |
| Analysis | `<support>/cache/visualizer/<fileKey>/` (shared) | the Visualizer's pruning (30 days / 3 GB) |
| Matte models | `<models>/matte/` (people, select); `<models>/bg/` (image) | pack install/remove |
| Exports | `<library>/Edits/` | the user's |
| Temp (plans, mix.wav, SAM chunks) | job TempDir | deleted after the job |

Limits: tracks 8 · clips 500 · sources 300 · custom markers 2,000 · hidden/moved 5,000 each · edit length 1 s–10 min · effects per clip 8 · masks per clip 4 · keys per param 64 · mods per param 4 · JSON field 64 KiB (caption lines 256 KiB) · select matte 60 s · interp 30 s.

---

## 16. Foundation (Wave 0, architect, committed to main before builders start)

### 16.1 Research spike (`.dev/p9-research/decode/`; results in DECISIONS.md)

- **Streams:** an integration test (`go test -tags integration -run TestDecodeBenchStreams ./modules/editstudio/`, writing into `.dev/p9-research/decode/`, which git ignores) makes 4 × 1080 × 1920 and 4 × 540 × 960 Annex-B streams with the §7.1 arguments from `testsrc2` (10 s each) plus their indexes. This doubles as the first version of the index parser.
- **Decode bench:** `viz/lab/decodeBench.ts`, a VizLab mode `TOOLBOX_VIZLAB_DECODE=1` (dev only, behind the existing VizLab gate). In the worker and on the main thread it measures:
  1. decode fps for 1 and 4 simultaneous streams at both sizes, sequential and with random seeks;
  2. the upload cost of `texImage2D(VideoFrame)` vs `createImageBitmap(frame)` + upload;
  3. whether holding > 8 undecoded-closed frames stalls the decoder.
- Writes `decode.json` through the `vzlab|` sink.
- **Decision rule** for `FrameImage`: keep `VideoFrame` and upload directly if that works and is ≥ 20 % faster; else `ImageBitmap`. Run on this Windows box; the Mac run is a checklist item (§17.5). If WKWebView later fails direct upload, the provider switches to `ImageBitmap` at runtime (feature check at start).
- **The design isn't at risk:** the preview reads 540p streams, and the export isn't real-time. The spike sets the cache sizes and the upload path, and gives the export-speed estimate for the Mac checklist.

### 16.2 Go

1. `git mv` done (Phase 8 spec archived). `docs/ROADMAP.md`: Phase 9 Edit Studio, Documents → 10, LAN → 11.
2. `core/projects.go`: `ProjectEdit`.
3. `core/viz`: `EditPlan`, `EditPlanStream`, `RenderPlan.Edit`, worker plan `kind`/`edit` + `buildWorkerPlan` URLs (+ tests).
4. `modules/editstudio`:
   - `document.go` (frozen), `options.go` (all request/result types), `validate.go` (complete `validateShape`/`validateDoc` + table tests);
   - `module.go` (descriptor, Config, Register, Validate, Run dispatch; unbuilt actions return `core.Errorf(CodeInternal, "Not built yet")`);
   - `service.go` (CRUD, SaveThumb, Probe, Analysis, AnalysisFor working; the rest submit jobs);
   - stubs with exact signatures for `sources.go`, `index.go`, `shots.go`, `interp.go`, `images.go`, `matte.go`, `models.go` (pins with measured sha256/bytes), `render.go`, `audio.go`, `text.go`, `srt.go`, `cache.go`;
   - the module-level matte semaphore;
   - `Summarize`.
5. Exports: `videoeditor.ProbeFiles`, `bgremove.ModelSpec`/`ModelDir` (if missing), `subtitles.FormatSRT` (from `formatSRT`).
6. **SAM 2 decision** (§10.4): `pyproject.toml` + `uv lock` + wheel check on Windows here; the Mac wheel check by reading `uv.lock` markers. Measure the engine's disk-size change, update the `engine` component size and the new `matte-*` components, add the `edit` pack, keep `packs_test` green.
7. `main.go` wiring; `PruneCache` at start.
8. Bindings regenerated; `lib/api.ts` re-exports `EditStudioService` and the types.

### 16.3 Frontend

1. `viz/types.ts`: the five new `POST_TYPES`; `PlanForWorker.kind?`/`edit?`.
2. `viz/analysis.ts`: `Analysis.withText(text: TextDoc | null): Analysis` (shares bytes and caches).
3. `viz/edit/types.ts` (all §5.1, §6.3, §8.1 types), `schema.ts` (complete + tests), `fixture.ts`:
   - `buildEditFixture()`: a 120 bpm, 24 s analysis;
     - bars of 2 s;
     - kicks on beats 1 and 3, snares on 2 and 4, eighth-note hats;
     - sections intro 0–4 s, verse 4–8 s, chorus 8–16 s, drop 16–24 s;
     - `mix.level` ≈ 0.02 over 15.0–15.4 s (a stop in bar 8);
     - `events.drop` at 16,000 ms (bar 9);
     - two text lines in the verse and chorus;
   - `fixtureProject()`: 2 tracks, video + photo + color clips, an effect with a marker mod, a transition, captions.
4. `viz/edit/engine.ts` + `compile.ts` stubs (signatures; the stub draws each active clip's rect in a colour hashed from its ID, so UI work can proceed), `viz/frames/types.ts`, `viz/edit/EditCanvas.tsx` (stub on the stub engine).
5. `viz/worker/loop.ts` refactor (behaviour-neutral, existing tests green), the `edit` dispatch, `viz/edit/worker.ts` stub (posts an error "Not built yet").
6. `tools/edit-studio/`:
   - `EditStudioView.tsx` (layout, routing between Home / Setup / Editor, panel slots importing each package's stub component);
   - `store.ts`, `doc.ts` (emptyProject, `newId`, lookups, `withClip` (clears `Auto`), lane defaults);
   - `useEditAutosave.ts`;
   - `autofill/types.ts`;
   - `lib/history.ts` move;
   - registration in `tools/index.ts`;
   - lane colour tokens.
   - Stub components (each owned by a package): `home/ProjectsHome`, `home/NewEditDialog`, `setup/SetupPanel`, `lanes/LanesPanel`, `lanes/SectionBands`, `timeline/TracksPanel`, `sources/SourcesPanel`, `transport/Transport`, `inspector/InspectorPanel`, `matte/CutoutSection`, `captions/CaptionsPanel`, `autofill/AutofillDialog`, `export/ExportDialog`, `overlays/PreviewOverlays`.
7. CLAUDE.md "Edit Studio (Phase 9)" section (§20). DECISIONS.md entries for §0.2.
8. `go build ./... && go vet ./... && go test ./...`, `gofmt -l .`, `npm run check` all green, then commit.

---

## 17. Test plan

### 17.1 Go (stdlib `testing`, table tests, fakes)

- `validate`: every rule in §6.1 (valid fixture + one broken field per case; field paths).
- `index`: synthetic Annex-B byte streams (3/4-byte start codes, AUD per AU, IDR keys, SPS codec string, truncated tail).
- `sources`: FFmpeg argument builder (tiers, short-side math, even sizes, HDR prefix on/off), cache key, per-key mutex (two goroutines → one transcode via a fake runner), `.part` rename.
- `shots`: parse `metadata=print` output; 500 ms merge.
- `interp`: argument builder; range rounding; frame → source ms.
- `images`: orientation and caps via `core/imaging` fakes.
- `audio`: graph builder golden tests (song only; clips with speed 1/2/keyed/0; muted track; fades).
- `render`: flow with seams (sources ensured, plan keys and URLs, broker called once, mux args, output registered, cancel cleans up).
- `text`: CSV quoting, JSON shape, SRT through `FormatSRT`.
- `matte`: request validation, padding/clamping, fake caller (progress mapping, cancel), preview copy + index, the semaphore, readiness rule.
- `models`: pins well-formed; `ModelPresent`/`RemoveModel` on temp dirs.
- `cache`: prune by age and size.
- `service`: CRUD, Save prunes unused mattes but keeps ones with a running job, `Sources` reports Preparing.
- `core/viz`: EditPlan URLs, kind in the worker plan, unchanged show plans (golden).
- **Integration** (`-tags integration`, real FFmpeg):
  - transcode `testsrc2` at both tiers → frames = expected ±0, key every 10, codec string parses, every AU starts with AUD;
  - shots on a two-scene clip find the cut within 100 ms;
  - `mix.wav` length = D ±1 ms;
  - minterpolate stream has 4× frames.

### 17.2 Python (`cd sidecar && uv run --group dev pytest`)

- `matte` param validation.
- The frame reader from a keyframe offset gives the exact frames (synthetic numbered frames).
- The SAM chunk planner (anchor, forward/backward order, seeds).
- The encoder pipe round trip (decode the written stream, compare alpha ±2).
- Slow (`TOOLBOX_SLOW=1`):
  - `matte.people` on a synthetic clip gives a non-empty, temporally stable matte;
  - `matte.select` on a moving square tracks it (IoU > 0.8 across 120 frames);
  - `select_preview` returns a mask.

### 17.3 Frontend (Vitest, jsdom; GL-free unless noted)

- **`deriveMarkers` on `buildEditFixture`:**
  - kicks and snares within 20 ms of truth;
  - exactly one stop marker inside bar 8 (14–16 s), at 15,000 ± 20 ms;
  - a drop marker at 16,000 ± 20 ms;
  - thresholds, every N, first-of-bar, nudge;
  - bar offset;
  - overrides survive a threshold change and come back;
  - custom markers;
  - range clipping and timeline ms;
  - the 30 ms benchmark.
- **`markerSignals`:** pulse peaks at markers, decay τ, `every`, sections gate, stop gate, cache keys.
- **`params`:** key interpolation (linear/ease/hold, outside range), mods with viz and marker signals, clamping, the speed rule.
- **`schema`:** round trips, defaults for "", every bad input → problem, unknown post types dropped.
- **`compile`:** frame spans with each cut offset, speed integral (constant, ramp, freeze), last-frame hold, `needs()` (blend pairs, mattes, interp), transition windows and the outgoing clip, stateful posts dropped, problems list.
- **`frames`** (fake `VideoDecoder`/`fetch`):
  - GOP planning from `keys`;
  - Range requests ≤ 4 MiB and keyframe-aligned;
  - forward decode reuse, seek reset;
  - LRU caps;
  - **every VideoFrame closed exactly once**;
  - exact `prepare` waits; inexact returns the nearest earlier frame.
- **`px2math`:** each new pass's math.
- **Existing posts:** `trigger` defaults leave old designs unchanged (golden from `px1.test.ts`).
- **`autofill`:** every preset on the fixture (golden cut lists); same seed gives the same clips; another seed differs for shuffle presets; pinned/edited clips survive; range-only and section-only; onDrop tag; onStop freeze keys and black clips; byTag fallback; empty phrase fallback; < 2 s for 300 sources.
- **`timeline/ops`:** every op in §14.5, including snapping targets and no-overlap rules.
- **`store`/`doc`:** `withClip` clears `Auto`; history coalescing; `useMarkers` memo identity.
- **Components:**
  - lanes render the fixture and the popover changes thresholds;
  - tracks drag/trim/split with snapping hints;
  - Sources add → Probe/Prepare calls;
  - the Inspector edits a param, adds a key, adds a marker mod;
  - Captions edits a word and exports SRT;
  - the auto-fill dialog applies one undo step;
  - Export checks list missing items.
- **Edit Lab** (`viz/lab/editLab.ts`, `TOOLBOX_VIZLAB=1 TOOLBOX_VIZLAB_EDIT=1 TOOLBOX_VIEW=vizlab`, real webview, WP-ES3):
  - renders `fixtureProject()` (with generated streams) at five times into `<support>/tmp/vizlab/edit-*.png`;
  - renders the same frames twice with fresh engines and providers and writes `edit-hash.json` (must match);
  - measures preview-path fps into `edit-fps.json`.

### 17.4 End to end (architect, Wave 2; real engine, real webview)

A render needs the running app, so the end-to-end test has three steps:

1. **Prepare:** `TOOLBOX_EDIT_E2E=1 go test -tags integration -run TestEditE2EPrepare ./integration/` writes into `<dir>`:
   - a 120 bpm click track (48 kHz WAV, clicks on every beat, accented downbeats, a silent beat in bar 8, louder from bar 9);
   - three `testsrc2` clips with burnt-in frame numbers (`drawtext` with a bundled font);
   - one EXIF-rotated JPEG;
   - `projects.json`: two project documents built in Go:
     - **E2E cuts:** clips cut on the click track's known downbeats, a photo, a punch effect on `marker.kick`, captions off;
     - **E2E flash:** one black color clip with `flash.amount ← marker.beat` (gate, attack 1, release 1).
2. **Run:** the app with the sandbox env vars and `TOOLBOX_VIZLAB=1 TOOLBOX_VIZLAB_EDIT=e2e TOOLBOX_EDIT_E2E_DIR=<dir> TOOLBOX_VIEW=vizlab`. Edit Lab's e2e mode (WP-ES3) calls the real services:
   - `Create` + `Save` for each project, `Analyze` (stems, no words), `Prepare`;
   - `Render` twice for E2E flash and once for E2E cuts, at 1080 × 1920 / 30;
   - writes `e2e.json` (job results, output paths, timings) through the `vzlab|` sink.
3. **Verify:** `TOOLBOX_EDIT_E2E_DIR=<dir> go test -tags integration -run TestEditE2EVerify ./integration/` checks:
   - output durations = D ± 1 frame;
   - the audio is the click track (cross-correlation peak at 0 ± 5 ms);
   - the burnt-in frame numbers at three cut points match the plan;
   - the photo is upright;
   - **beat-flash sync:** in E2E flash's per-frame mean luma, every click has a bright frame within ±1 frame of it;
   - **determinism:** the two E2E flash exports decode to identical frames.

Auto-fill and the UI are covered by Vitest (§17.3); the e2e documents are built in Go so the test doesn't depend on the UI.

### 17.5 Checks and the Mac checklist

- **Checks:** `go build ./... && go vet ./... && go test ./...`, `gofmt -l .`, `npm run check`, sidecar pytest, the integration tags above.
- **`docs/MAC-CHECKLIST.md` § 10 "Edit Studio (Phase 9)":**
  - decode bench (`TOOLBOX_VIZLAB_DECODE=1`): record fps and whether direct `VideoFrame` upload works in WKWebView;
  - preview of the fixture edit at ≥ 28 fps;
  - export 1080 × 1920 / 30 and 60 (speed);
  - beat-flash sync;
  - people matte and subject select on MPS (time per frame);
  - HDR iPhone clip tone-mapping;
  - HEIC photo upright;
  - Music edits pack install sizes.

---

## 18. Work packages

File ownership is exclusive. Wave 0 creates every file listed as a stub; a package replaces its stubs' bodies, never their exported signatures. A package may add new files only under its own folders. Any change to a frozen contract goes to the architect.

### Wave 1 (all parallel after Wave 0)

| Package | Scope | Owns | Consumes |
|---|---|---|---|
| **ES1 Markers & lanes** | §5, §14.2, §14.4, markers export | `viz/edit/markers.ts`, `markerSignals.ts`, `params.ts` (+ tests); `tools/edit-studio/lanes/**`, `setup/**`; `modules/editstudio/text.go` (markers kinds) | Wave 0 types, fixture, store |
| **ES2 Timeline, sources, home, transport** | §14.1, §14.3 header, §14.5–14.7 (not the canvas), §14.11, §14.13 | `tools/edit-studio/home/**`, `timeline/**`, `sources/**`, `transport/**`, `commands.ts` | store, `EditCanvas` (stub until ES3), `SectionBands` (ES1) |
| **ES3 Engine, frames, worker, Edit Lab** | §8, §12.2 worker side, §17.3 Edit Lab, §17.4 step 2 (Edit Lab's e2e mode) | `viz/edit/compile.ts`, `engine.ts`, `clip.ts`, `shaders.ts`, `worker.ts`, `EditCanvas.tsx`; `viz/frames/**`; `viz/lab/editLab.ts` + its VizLab hook | types, schema, params (stub until ES1), posts (ES5 registers new ones) |
| **ES4 Edit sources** | §7 | `modules/editstudio/sources.go`, `index.go`, `shots.go`, `interp.go`, `images.go`, `cache.go` (+ tests); `prepare`/`interp` action bodies and `Sources`/`InterpFor` service bodies | Wave 0 stubs |
| **ES5 Post passes** | §9.2, §9.3 | `viz/post/punch.ts`, `flash.ts`, `blurpulse.ts`, `exposure.ts`, `invert.ts`, `px2math.ts` (+ tests); edits to `shake.ts`, `zoompulse.ts`, `glitch.ts`, `chromatic.ts`, `post/index.ts` | — |
| **ES6 Auto-fill** | §13 | `tools/edit-studio/autofill/**` except `types.ts` | markers (fixture data until ES1), timeline types |
| **ES7 Mattes** | §10 | `sidecar/toolbox_sidecar/handlers/matte.py`, `toolbox_sidecar/matte/**`, `sidecar/tests/test_matte*.py`; `modules/editstudio/matte.go`, `models.go` bodies; `tools/edit-studio/matte/**` | sources (ES4's `ensureStream`, a stub until merged) |
| **ES8 Export** | §12.1, §12.3, §14.10 | `modules/editstudio/render.go`, `audio.go` (+ tests); `tools/edit-studio/export/**` | broker, sources (stub) |
| **ES9 Captions** | §14.9, SRT | `tools/edit-studio/captions/**`; `components/viz/TextStyleEditor.tsx` + the `LookTab` change; `modules/editstudio/srt.go` | schema, store |
| **ES10 Inspector & overlays** | §9.1 templates/looks, §14.8 | `tools/edit-studio/inspector/**`, `overlays/**` | schema, params, `CutoutSection` (ES7) |

**Dependencies inside Wave 1:** every interface is frozen in Wave 0, and stubs keep each package buildable alone. Packages test against the fixture and fakes. Real cross-package behaviour (ES2 + ES3 preview, ES8 + ES3 + ES4 export, ES10 + ES7 cut-outs) is checked in Wave 2.

### Wave 2: integration (architect)

- Merge in the order ES5, ES1, ES4, ES3, ES6, ES2, ES10, ES7, ES9, ES8.
- Regenerate bindings, run every check, run Edit Lab and the end-to-end and sync tests (§17.4).
- Measure preview fps and export speed. Record everything in DECISIONS.md.
- Write the Mac checklist and update `docs/ROADMAP.md` (done).
- Large problems go back to the owning builder.

---

## 19. Milestones and acceptance criteria

Each milestone is usable on its own. All of them ship in this phase; the Wave 2 checks prove them.

### M1 Marker map

- [ ] Analyzing a song (or reusing a cached Visualizer analysis with stems) shows every lane over the waveform, with section bands.
- [ ] On the fixture: kicks and snares within 20 ms of truth, one stop marker in bar 8, a drop at bar 9.
- [ ] Threshold, every N, first of bar, nudge and bar offset apply instantly with no re-analysis; hidden/moved overrides survive re-deriving.
- [ ] Custom markers by tap (during playback) and click (paused), saved in the project.
- [ ] Markers export as CSV and JSON into the Library.

### M2 Timeline, clip rendering, export

- [ ] Sources import with preview streams and shots as background jobs; status per source; the export tier is made by the export.
- [ ] Snap (with the lane named), fill-to-next-marker and slice-at-markers (with cycle sources) work on several tracks; undo covers every edit.
- [ ] The preview plays a cuts-only edit of 4 video sources at 540 × 960, 30 fps (≥ 28 fps measured), the song as the clock.
- [ ] Export 1080 × 1920 through the render broker; the beat-flash sync test is within one frame.
- [ ] The same project renders identical frames twice (Edit Lab hash, and the e2e double export).

### M3 Auto-fill

- [ ] All five presets draft the fixture project in < 2 s; same seed → same draft; pinned and edited clips survive a re-run.
- [ ] Recipes apply to a selected range or section only.

### M4 Effects

- [ ] Per-clip and adjustment-clip effect chains, the Look (incl. bloom/vignette/grain); new `punch`, `flash`, `blurpulse`, `exposure`, `invert`; `trigger` on shake/zoompulse/glitch/chromatic with old designs unchanged.
- [ ] Effects driven by marker signals with every-Nth and section filters; keyframed transforms; Ken Burns on markers.
- [ ] Speed ramps (keys) with frame blending; opt-in interpolation, off by default and labelled as synthesized.

### M5 Cut-outs and captions

- [ ] Photo cut-outs, people video mattes, and click-to-select subject mattes with Try and correction clicks (or, if SAM 2 can't install on a platform, the mode is hidden there and logged).
- [ ] Background replace (a cut-out over another track), outline and glow, subject-only and background-only effects, Split subject, captions behind the subject.
- [ ] Captions from detected or aligned words, an editable word list, SRT export.

---

## 20. CLAUDE.md additions (Wave 0)

A new section, **"Edit Studio (Phase 9)"**:

- The engine never reads camera files. Video reaches it only as **edit streams**: Annex-B H.264 + `.idx.json`, CFR at the project fps, GOP 10, no B-frames, AUD per frame, made by `modules/editstudio` with FFmpeg. Frames are decoded with WebCodecs `VideoDecoder`. **Never use `<video>` seeking for rendered frames.**
- Close every `VideoFrame` exactly once, as soon as it is converted or dropped (decoders stall otherwise).
- A frame is a function of (project, analysis, markers, size, seed, time). `viz/edit/` and `viz/frames/` follow the engine's determinism rules. Preview and export run the same `EditEngine`; only the stream tier differs.
- Time units: song ms (analysis, markers' ids, custom markers, caption lines), timeline ms (clips, playhead), source ms (`InMs`, matte ranges). `songMs = song.startMs + timelineMs`.
- Effects use `EditParam`/`EditMod` (keys + marker signals `marker.<lane>`). Visualizer types stay unchanged; add new post passes to `POST_TYPES` + `post/index.ts`. Output effects (bloom/vignette/grain) are project-wide only.
- Mattes are per clip, in `<project>/mattes/`, made by `matte.*` engine handlers that never download. Models are pinned in `modules/editstudio/models.go` (`<models>/matte/`). One matte job at a time.
- Caches: `cache/editstudio/` (30 days, 10 GB) pruned at start.
- **How to add an auto-fill recipe:** a `Recipe` in `autofill/recipes.ts` with golden tests on the fixture.

## 21. Risks

| Risk | Mitigation |
|---|---|
| WKWebView (Mac) `VideoDecoder` speed or direct `VideoFrame` upload | Spike + runtime feature check; `ImageBitmap` fallback; 540p preview streams; Mac checklist |
| Decoder stalls from held frames | Close discipline, LRU caps, a Vitest test that counts closes |
| SAM 2 install or CPU speed (Windows has no GPU torch) | Install order with a clean stub path; 60 s cap; chunking; Try preview before propagation; one matte at a time |
| Matting memory (3 GiB engine recycle) | 96-frame chunks with CPU offload; the engine recycles after big results as today |
| Disk use of streams | Two tiers only; 10 GB prune; streams re-made on demand |
| HDR phone footage | Tone-map when FFmpeg has `zscale`, else a warning |
| Beat or downbeat errors | Bar offset, thresholds, nudge, drag, tap |
| Preview speed on weaker GPUs | Draft quality, frame dropping, readout, fewer decode-ahead frames |
| Long exports at 60 fps | Progress and speed in the job; the broker's existing timeouts tolerate decode stalls (< 30 s idle) |
| Project size (4 MiB) | Field caps; captions ≤ 256 KiB; effects ≤ 8 per clip |
| Spec scope (ten packages) | Frozen contracts and stubs in Wave 0; each milestone is usable alone |

---

## 22. Wave 0 notes: the contract as built (2026-11-03; these override the sections above)

1. **`FrameProvider.hint(ahead: FrameKey[], playing: boolean)`**: the host passes the frames the next ~0.5 s will need, collected with `EditEngine.needs`, instead of a time (§8.1). The provider can't compute needs itself.
2. **Parsers return `Parsed<T> = {ok, value, problems: string[]}`**: always a usable value (§6.3). `schema.ts` also exports `parseEditParam`, `baseOf`, `isEditSignal`, `isMarkerSignal`, `newMask`, `CLIP_POST_TYPES`, `LOOK_POST_TYPES`, `TRANSFORM_RULES`, `TRANSITION_KINDS`, `CUT` and the limits.
3. **ES1 signatures** (`viz/edit/`):
   - `params.ts`: `evalEditParam(p, min, max, clipMs, songMs, ctx: {signals, markers} | null)` and `interpolateKeys(keys, u)`;
   - `markerSignals.ts`: `new MarkerSignals(analysis, markers, songStartMs)` with `.value(lane, {every?, sections?}, songMs, attackMs?, releaseMs?)`;
   - `markers.ts`: `deriveMarkers(analysis, markerState, {startMs, endMs})` and `TAP_LATENCY_MS`.
4. **Shared helpers:**
   - `viz/edit/defaults.ts`: `LANE_DEFAULTS`, `laneSettings`, `emptyEditProject`, `normalizeProject` (non-null lists/maps; same object when already clean), `NormalProject`;
   - `viz/edit/types.ts`: `sizeFor`, `previewSize`, `editLength`;
   - `viz/edit/fixture.ts`: `buildEditFixture()` (sections intro 0–4 s, verse 4–8 s, chorus 8–16 s, drop 16–24 s; stop 15,000–15,400 ms; drop event 16,000 ms; lines every 4 s from 4 s), `fixtureKicks()`, `fixtureSnares()`, `fixtureProject()`;
   - `viz/fixture.ts` `buildFixture` gained `sections` and `silences` options (old output unchanged).
5. **Go:**
   - `Config` has no `BgRemove`: photo cut-outs use `bgremove.SpecFor("balanced")` and `bgremove.ModelDir(modelsDir)`;
   - `MatteState` also carries `FromMs`/`ToMs` (the padded range the files cover);
   - `runMatte(ctx, job, projectID, req)` holds the matte slot already;
   - `notBuilt()` lives in `sources.go`;
   - `Service` also has `StreamIndexShape()` (bindings);
   - `LaneDefaults()` and `NewProject()` are exported;
   - empty enum strings (`fit`, `slow`, `blend`, `fxTarget`) mean the default.
   - Test helpers in `fakes_test.go`: `memStore`, `newTestModule`, `validDoc`, `recorder`, `newJob`.
6. **Frontend state** (`tools/edit-studio/`):
   - `store.ts` (`useEditStudio`, `useProject`, `useMarkers`, `useSelectedClipIds`, `useEditInputs`, `interpKey`);
   - `doc.ts` (`newId`, `newClip`, `newTrack`, `findClip`, `allClips`, `withClip`, `withTrack`, `speedAt`, `clipSourceSpan`, `projectPaths`);
   - `useEditAutosave.ts` (`flushEdit`, `onEditSaved`, `markOpened`, `discardedEdits`);
   - `useEditData.ts` (`loadRef`, `refreshSources`, `refreshMattes`).
   - The view shell imports one stub per package (§16.3); keep their exported names and props.
7. **SAM 2** is the official `facebookresearch/sam2` code at commit `2b90b9f` as the `sam-2` package (a pinned archive URL in `[tool.uv.sources]`, built without isolation and without the CUDA extension). The PyPI `sam2` package was not published by Meta, so it isn't used.
   - **Measured on this box (CPU):** SAM 2.1 tiny propagates at ≈ 2 s/frame. `matte.select` therefore runs SAM on at most **15 frames per second of source** and blends logits linearly for the frames between. The 60 s cap stays; the dialog shows an estimate ("about N minutes").
   - **RVM** runs at ≈ 70 ms/frame at 720p on CPU.
   - The lock moves `omegaconf` 2.4.0 → 2.3.1 (hydra's pin). ES7 runs the OCR tests against it.
   - `sidecar/embed.go` now embeds `toolbox_sidecar/matte/*.py`.
8. **The decode spike moves to Wave 2.** ES3 builds both upload paths (`VideoFrame` directly, or `createImageBitmap`) behind a runtime feature check. Edit Lab measures decode fps and picks the default. The design never depended on it (§16.1).
9. **Packs:** the `edit` pack ("Music edits") unlocks `edit-studio` with `engine`, `ffmpeg`, `stems-default`. The `matte-people`/`matte-select` components are in the catalog with measured sizes.
10. **Shared timeline geometry** (`tools/edit-studio/geometry.ts`): `HEADER_PX` (168), `RULER_PX`, `LANE_ROW_PX`, `SNAP_PX`, `msToX`, `xToMs`, `visibleRange` and `useTimelineWheel(el, durationMs)`.
    - Lanes, bands and tracks all scroll and zoom through the store's `pps`/`scrollMs` (virtual horizontal scroll; no native horizontal scrollbar is needed).
    - Every row is a `HEADER_PX` header followed by the time area.
11. **Dialogs:** `useEditStudio().openDialog({kind: "autofill", range} | {kind: "export"} | null)`. Any package (section band menu, palette commands) can open the Auto-fill or Export dialog; the view renders them.
12. **`tools/edit-studio/matte/split.ts` `splitSubject(p, clipId)`** is a WP-ES7 stub. WP-ES2's clip menu calls it.
13. **Thumbnails:** the view saves the preview as `thumb.jpg` after saves, at most every 30 s. No package does it.

---

## 23. Part B: Edit Studio FX (2026-11-03)

The user asked for "as many cool video effect features as you can": text masked over video, images/videos as masks, and the looks of TikTok and anime edits (AMV / velocity / flow edits). The research (summarised in DECISIONS) found that these edits are mostly a beat- or kick-triggered envelope on some parameter. The engine already has that envelope (`EditParam` mods on `marker.<lane>`). What's missing is:
- the **effects themselves**;
- **compositing**: track mattes, more blend modes, text and generated layers;
- **transitions**;
- **one-click recipes**.

### 23.1 Goals

1. **Compositing:**
   - track mattes (alpha / luma / inverted: "this track shows through the track above");
   - text clips;
   - visual clips (Visualizer layers as clips: light rays, embers, shockwaves, tunnels…);
   - eight more blend modes;
   - mirror edges ("motion tile"), so shakes and zooms never show black.
2. **22 new effects** (§23.4). Each can be used on clips, adjustment clips and the Look, and markers modulate them like the existing ones.
3. **12 new transitions** (§23.5).
4. **Presets:**
   - one-click FX stacks ("Anime hit", "Velocity punch"…);
   - a searchable effect picker with categories;
   - velocity (speed-ramp) presets;
   - two auto-fill recipes ("Anime drop", "Velocity edit").

**Non-goals:**
- optical-flow slow motion beyond the existing interpolation;
- pixel sorting and datamosh (too costly for the gain);
- echo trails (they need past frames, so they can't be deterministic as a post effect);
- stutter (it needs source time to run backwards).

### 23.2 Contract changes (foundation, committed on main before the builders start)

- **Go document** (`modules/editstudio/document.go`):
  - `Track.Matte`: `"" | "alpha" | "alpha-inverted" | "luma" | "luma-inverted"`, video tracks only.
  - `Clip.Kind` adds `"text"` and `"visual"` (video tracks only).
  - `Clip.Text` holds `TextClip` JSON; `Clip.Visual` holds `VisualClip` JSON.
  - `Clip.Blend` adds `overlay, softlight, hardlight, difference, exclusion, lighten, darken, colordodge`.
  - Validation is updated to match and the bindings are regenerated.
- **TS** (`viz/edit/types.ts`, `schema.ts`):
  - types and lists: `BLEND_MODES`, `TRACK_MATTES`, `TextClip`, `VisualClip`, `ClipTransform.edges?: "clear" | "mirror"`;
  - parsers: `parseTextClip`/`serializeTextClip`/`defaultTextClip` and `parseVisualClip`/`serializeVisualClip`/`defaultVisualClip`;
  - `TRANSITION_KINDS` includes the new kinds;
  - `viz/types.ts`: `POST_TYPES` and `TransitionKind` list the new ids.
- **TextClip:**
  - `text`: 1..500 chars;
  - `style`: a `TextStyle` (the same as the captions'; its preset animates the words);
  - `reveal`: `"all"|"words"|"beats"`;
  - `wordMs`: 40..2000;
  - `lane`: a `MarkerLane`;
  - `every`: 1..16.
- **VisualClip:**
  - `layer`: a `LayerType`;
  - `params`: partial layer params (numbers may be EditParams);
  - `palette`: a `PaletteId`.
- **Compile** (`compile.ts`):
  - `CompiledClip.text` / `.visual`. Text clips that are only whitespace are skipped.
  - `CompiledTrack.matte` / `.isMatte`: the track directly above a matted track is its matte. A matte with no video track above it is dropped and reported as a problem.
  - `CompiledEditFull.markers`.
- **Engine** (`engine.ts`), implemented in the foundation:
  - **Generated sources** (`viz/edit/generated.ts`: `registerGenerator(kind, factory)` and `GeneratorInstance.render(target, frame)`). Each frame, a text or visual clip renders a frame-sized, premultiplied picture. That picture then goes through the normal clip path: transform, masks, effects, blend, transitions and track mattes. The clip shader takes `u_gen` (premultiplied, bottom-up) and `u_edges` (mirror).
  - **Track mattes:** `drawMatted` multiplies the track's picture by the alpha or luma of the matte track (`TRACKMATTE_FS`). The matte track isn't drawn on its own. Muting the matte track turns the matte off.
  - **Shader blend modes:** `BLEND_FS` handles the eight new modes; the old four keep GL blending.
- **Effects plumbing:**
  - `viz/post/fx1.ts` and `fx2.ts` are aggregators imported by `post/index.ts`.
  - Each effect is one file under `viz/post/` that calls `registerPost` (kind `"pass"`, never stateful), using `simplePass` (`post/pass.ts`) or its own programs.
- **UI** (foundation):
  - Track inspector: a "Track matte" select.
  - Clip blend select: all 12 modes.
  - Tracks toolbar: **Text** and **Visual** buttons.
  - Stubs `text/addText.ts` and `visual/addVisual.ts` place a clip at the playhead, on the topmost free video track or on a new track (`timeline/placeGenerated.ts`).
  - Clip view: icons and colours for the new kinds; `clipLabel` names them.
  - Clip inspector: shows `TextSection` / `VisualSection` (stubs) for those kinds.
  - `engine.ts` imports `./textClip` and `./visualClip` (stub files from the foundation) so the preview and the export worker both register them.

### 23.3 Work packages and file ownership

| WP | Owns (only these) |
|---|---|
| FX1 Motion, blur, glow, warps | `viz/post/{zoomblur,dirblur,glow,swing,twirl,wave,bulge,shockwave,kaleido,slice}.ts`, `viz/post/fx1.ts`, `viz/post/fx1.test.ts` |
| FX2 Stylize | `viz/post/{pixelate,halftone,posterize,duotone,mono,colorpop,vhs,letterbox,lightleak,speedlines,sharpen,outline}.ts`, `viz/post/fx2.ts`, `viz/post/fx2.test.ts` |
| FX3 Transitions | `viz/transitions.ts`, `viz/transitions.test.ts` |
| FX4 Text clips | `viz/edit/textClip.ts` (+ test), `tools/edit-studio/text/**` |
| FX5 Visual clips | `viz/edit/visualClip.ts` (+ test), `tools/edit-studio/visual/**` |
| FX6 Presets and picker | `tools/edit-studio/inspector/{EffectsStack.tsx,templates.ts,ClipInspector.tsx,FxStacks.ts,velocity.ts}` (+ tests), `tools/edit-studio/autofill/recipes.ts` (+ its golden tests), `tools/edit-studio/inspector/effectCatalog.ts` |

All six depend only on the foundation and run in parallel. FX6 uses the effect ids and param names from §23.4.

### 23.4 Effects

Notation: id "Label": param min..max default. Every number param is an `EditParam`.

Shaders work in premultiplied linear HDR (`PASS_HEAD`, `u_src`, `u_res`) and must be deterministic: no `Math.random`, no clocks. Time comes from `f.tMs`; randomness comes from `f.seed` and GLSL hashes (`GLSL_COMMON`). With every amount at its default, an effect must leave the image unchanged. The FX1/FX2 tests check that identity with a pure-math model, as `px1math.ts`/`px2math.ts` do for the existing effects.

**FX1**

- `zoomblur` "Zoom blur": amount 0..1 0; cx 0..1 0.5; cy 0..1 0.5. A radial blur towards the centre, 24 taps, length amount·0.35 of the distance.
- `dirblur` "Motion blur": amount 0..1 0; angle −180..180 0. A directional blur, 24 taps, length amount·0.12 of the short side.
- `glow` "Deep glow": amount 0..3 0; threshold 0..2 0.6; radius 0..1 0.5; tint colour "#ffffff". A bright pass, then a downsample/blur pyramid of 4–5 levels scaled by radius, added back × amount × tint. Uses its own programs and half-res or smaller targets.
- `swing` "3D swing": rotX −70..70 0; rotY −70..70 0; persp 0..1 0.5; mirror bool true. A perspective rotation around the centre. Samples outside the frame are mirrored when `mirror` is on, otherwise transparent.
- `twirl` "Twirl": amount −1..1 0; radius 0..1 0.5; cx, cy 0.5. Angle = amount·2π·(1 − r/R)².
- `wave` "Wave": amount 0..1 0; freq 1..40 8; speed 0..8 1; dir enum ["horizontal","vertical"] "horizontal". A sine offset of up to amount·0.05 of the frame.
- `bulge` "Bulge / pinch": amount −1..1 0 (negative pinches); radius 0..1 0.5; cx, cy 0.5.
- `shockwave` "Shockwave": amount 0..1 0; width 0.01..0.3 0.08; strength 0..1 0.5; cx, cy 0.5. A refracting ring with radius (1 − amount)·1.2 of the half-diagonal and strength amount·strength. Driven by a decaying marker mod, the ring expands as the pulse fades.
- `kaleido` "Kaleidoscope": amount 0..1 0 (mix); segments 2..16 6; rotation −180..180 0; zoom 0.5..2 1.
- `slice` "Slice shift": amount 0..1 0; bands 2..64 12; rgb 0..1 0.3. Horizontal bands, each shifted by a hashed amount, plus an RGB split. The shifts change every 2 frames (hash of `floor(tMs/66)` and the seed).

**FX2**

- `pixelate` "Pixelate": amount 0..1 0. Block size = 1 + amount·0.08·(short side) px.
- `halftone` "Halftone": amount 0..1 0 (mix); dots 20..240 90 (across the short side); angle −90..90 45; mode enum ["mono","color"] "mono".
- `posterize` "Posterize": amount 0..1 0 (mix); levels 2..16 5.
- `duotone` "Duotone": amount 0..1 0; shadows colour "#1b0436"; highlights colour "#ff4fd8". A luma gradient map.
- `mono` "Black and white": amount 0..1 0; contrast 0..3 1; hard bool false. `hard` thresholds at 50 %, for manga frames.
- `colorpop` "Colour pop": amount 0..1 0; hue 0..360 0; range 5..180 30. Desaturates everything outside the hue range.
- `vhs` "VHS": amount 0..1 0; scanlines 0..1 0.5; bleed 0..1 0.5; wobble 0..1 0.3; noise 0..1 0.3.
- `letterbox` "Letterbox": amount 0..1 0 (0 is none, 1 is bars for 2.39:1); color colour "#000000".
- `lightleak` "Light leak": amount 0..1 0; color colour "#ff8a3d"; speed 0..2 0.5. Soft procedural blobs that drift with tMs, screen-blended.
- `speedlines` "Speed lines": amount 0..1 0; density 20..240 90; inner 0..0.9 0.35 (clear radius); color colour "#ffffff"; cx, cy 0.5. Anime radial lines that change every 2 frames.
- `sharpen` "Sharpen": amount 0..2 0.
- `outline` "Ink outline": amount 0..1 0; thickness 0.5..4 1; color colour "#000000"; mode enum ["ink","neon"] "ink". Sobel edges drawn over the picture. `neon` draws additive glowing edges in the colour.

### 23.5 Transitions (FX3)

New `TransitionKind`s. Each is an `(a, b, mix, tMs)` shader in `viz/transitions.ts`, like the existing ones:
- `zoomout`: zoom out of a while b scales in, with radial blur;
- `spin`: rotate 180° with blur, cutting at mix 0.5;
- `whip`: a fast pan with directional blur;
- `slide`: push left;
- `blur`: blur out, then in;
- `rgbsplit`: channel offsets that peak at 0.5;
- `shake`: a shaking cut at 0.5;
- `warp`: a twirl into b;
- `luma`: b appears through a's luma, dark parts first;
- `iris`: a circle reveal;
- `stripes`: a diagonal-stripes reveal;
- `flashblack`: a dip to black.

Requirements:
- At mix 0 a transition shows exactly a; at mix 1, exactly b. The tests use a math model of the endpoints.
- Sampling past the edges is mirrored, so there are never black borders.

### 23.6 Text clips (FX4)

- **Generator** (`viz/edit/textClip.ts`, `registerGenerator("text", …)`):
  - It draws the clip's text with the existing text engine (`viz/text`, `createTextLayer`), from a `TextDoc` with one line, or several when the text has `\n`.
  - The word times implement `reveal`:
    - `all`: every word at the clip start;
    - `words`: word i at i·wordMs;
    - `beats`: word i at the i-th marker of `lane` inside the clip (taking every Nth); words left over go at the clip end.
  - The style's preset animates each word as it appears.
  - The picture is full-frame and premultiplied; the clip transform positions it.
  - It works in the export worker, using the same fonts as captions.
- **UI** (`tools/edit-studio/text/`):
  - `TextSection` edits:
    - the text: multi-line, with a 500-char counter;
    - the style: preset, font (the fonts captions offer), weight, size, colour, highlight, outline, glow, uppercase, position;
    - the reveal, plus wordMs / lane / every.
  - Quick styles (one click each):
    - "Big punch": pop, 900, uppercase, outline 0.08;
    - "Glow": glow 1;
    - "Typewriter";
    - "Subtitle";
    - "Outline only": outline, no fill.
  - **Text through video** button: makes this clip's track the matte of a new video track below it. That new track holds the clip that is under the playhead, so the text reveals that video.
  - **Text behind subject**: when the clip below has a cut-out, put the subject above the text by duplicating it with its subject-only cut-out, as Split subject does.
  - `addText.ts`, refined: on an empty spot the clip runs from the playhead to the next downbeat (at least 1 s).
- **Tests:**
  - word timing for each reveal mode (a pure function);
  - parse/serialize through the UI.

### 23.7 Visual clips (FX5)

- **Generator** (`viz/edit/visualClip.ts`, `registerGenerator("visual", …)`):
  - It creates the Visualizer layer with `layerDef(type).create(ctx)`. The `LayerContext` provides gl, fullscreen, size and seed, a deterministic `rng(key)`, no textures, and `previous()` returning null.
  - Each frame it renders the layer with a `FrameInput` whose params are the layer defaults merged with the clip's params. Those are evaluated with `evalEditParam`, so marker mods work.
  - The palette is the clip's: `resolvePalette({mode:"fixed", ids:[palette]}, …)`.
  - Stateful layers are not offered.
- **UI** (`tools/edit-studio/visual/`):
  - `VisualSection` has:
    - a grid of layers, grouped as in the Visualizer (background, shape, particles, accent);
    - the palette select;
    - every layer param: numbers through `EditParamEditor` (with keys and mods), enums, bools and colours through `Select` / `Switch` / `ColorSwatchPicker`.
  - A "Suggested" row: lightrays, embers, shockwave, bursts, starfield, tunnel, sweep, ripples, fireflies, frame.
  - `addVisual.ts`, refined: visual clips default to blend "screen" and run to the end of the section (at least 2 s).
- **Tests:**
  - a param-merge function;
  - a check that every non-stateful layer can be configured.

### 23.8 Presets and picker (FX6)

- **Effect picker:** "Add effect" opens a searchable list grouped as Camera & motion · Blur & glow · Distort · Stylize · Colour & light · Glitch. Each effect has a one-line description (`effectCatalog.ts`). The picker serves clip, adjustment and Look stacks.
- **FX stacks** (`inspector/FxStacks.ts`): one click adds several effects with their marker mods filled in. At least these:
  - "Anime hit": shake + punch + chromatic + flash, on kick;
  - "Drop impact": shockwave + zoomblur + flash, on drop;
  - "Velocity punch": punch + dirblur, on kick;
  - "Glow pump": glow amount, on kick;
  - "Strobe build": flash on every beat, gated to lift/build sections;
  - "Manga": mono hard + halftone + outline;
  - "VHS intro": vhs + letterbox;
  - "Speed lines on drop";
  - "3D swing on downbeats";
  - "Slice glitch on hats";
  - "Duotone pulse";
  - "Light leak".

  The existing single-effect templates stay.
- **Velocity presets** (`inspector/velocity.ts`), written as speed keys (0..4) on the clip:
  - "Ramp into the beat": 2× → 0.4× centred on the nearest kick/beat inside the clip → 1.5×;
  - "Slow on the drop";
  - "Fast to slow";
  - "Freeze on the beat": speed 0 held for one beat.
- **ClipInspector:**
  - a "Velocity" group in the clip actions menu;
  - an "Edges" switch in Transform ("Mirror past the edges").
- **Recipes** (`autofill/recipes.ts`, with golden tests on the fixture, like the existing ones):
  - "Anime drop":
    - downbeat cuts in verses;
    - kick cuts in drops, with the Anime hit stack;
    - shockwave + flash on the drop clip.
  - "Velocity edit": beat cuts, each clip ramped into its beat (speed keys), with punch + dirblur on kicks.

### 23.9 Acceptance

- `npm run check` passes, and so does `go build ./... && go vet ./... && go test ./...`.
- In the real app (Edit Studio):
  - Every new effect visibly changes the preview when its amount is raised. None changes the frame at its defaults.
  - Text clip on the top track, track 1 set to "alpha": video shows only inside the letters, over the clip on the bottom track.
  - The same works with a photo as the matte (luma).
  - A visual clip (embers, screen) reacts to the song.
  - Every new transition renders without black borders.
  - Each FX stack applies in one click.
- An export containing all of the above matches the preview (spot-checked frames).

---

## 24. Part C: Section styles and Moments (2026-11-03)

The user asked for two things:
- **Section styles:** each part of the song should react to a different aspect of the music, e.g. "a section that reacts to the hi-hats and is just quick cuts of the clips". The editor should help lay out, cut and distribute the footage there.
- **Moments:** detect stand-out events and automatically put a keyframe there, so the user can use it or not and put an effect on it.

### 24.1 Foundation (on main)

- **Accents marker lane** (`"accent"`):
  - These are the song's stand-out hits (`viz/edit/markers.ts` `deriveAccents`):
    - onset peaks clearly above the hits in the 4 s around them, whole mix and stems;
    - strong off-grid hits;
    - drops;
    - the return after a stop.
  - They are at least a beat apart, with about one every two bars at most.
  - The lane is offered everywhere lanes are: Hits on, Cut to beat, reactions, snapping, Auto-fill rules.
- **Footage moments:**
  - `EditStudioService.Moments(path, fps) → Moment[] {ms (source ms), strength 0..1, kind "cut"|"motion"}`.
  - It measures FFmpeg's per-frame scene score on the preview stream once, caches it in `motion.json`, and returns shot changes plus bursts of movement or light.
  - Videos only; it may take about a second the first time.
  - Type: `EditMoment` from `@/lib/api`.

### 24.2 WP-SC1: Section styles (`tools/edit-studio/sectionstyle/**`)

A **Section style** dialog, opened from:
- the section band chip menu ("Style this section…");
- the clip context menu, for a selected range or selected clips ("Style this part…");
- a **Style** button in the tracks toolbar (uses the selection, else the section under the playhead).

The dialog shows the range (from–to, editable, snapped to section edges and bars) and three groups.

1. **Cuts:**
   - "Switch clips on": Beats / Downbeats / Kicks / Snares / Hi-hats / Accents / Bass / Vocals, or "Keep the current clips";
   - how often (1, 2, 4, 8);
   - min clip length.
   - A live density strip shows the cuts over the range, as Auto-fill's strip does.
2. **Footage:**
   - which sources: all, selected in Sources, or by tag;
   - how to distribute them:
     - "Cycle through them evenly";
     - "Shuffle";
     - "One clip, many moments": uses one source and jumps between its moments/shots;
     - "Best moments": each cut starts on a footage moment of its source, from `Moments`, with a fallback to shot-aligned;
   - mirror edges on/off.
3. **Reacts to:**
   - an FX stack, or none;
   - which lane its hits follow (default: the cut lane);
   - strength;
   - a transition between cuts (cut, flash, whip, zoom, glitch…).

**Apply** does three things:
- replaces the non-pinned clips of the target video track inside the range with the new cuts (Cut to beat's logic in `beatsync/cutLogic.ts`, extended locally if needed; don't change `autofill.ts`);
- adds or replaces an adjustment clip spanning the range on an adjustment track named "Section styles" (created on top when missing). It holds the chosen effects with Hits on set to the chosen lane, so the reaction belongs to the section and survives later re-cuts;
- sets each new clip's transition.

It is one undoable edit, and pinned clips stay. The dialog remembers its last settings per project in local UI state. A toast summarises the result ("24 clips switching on hi-hats, Anime hit on accents").

Tests:
- the logic as pure functions on the fixture: density, distribution modes, the adjustment clip placement and replacement, pinned clips kept;
- dialog rendering and Apply.

### 24.3 WP-SC2: Moments (`tools/edit-studio/moments/**`)

1. **On the timeline:** when a video clip is selected, its footage moments (from `Moments`, cached per path in a small zustand store in this folder) and the song's accents inside the clip show as small ghost ticks on the clip block:
   - footage moments in one colour, song accents in another;
   - a tooltip on each tick with its kind and time.

   This is done through an overlay component the builder mounts from `timeline/` via a single import line in `TracksPanel.tsx` (allowed: one line plus one JSX element). If the clip moved in source time (in point / speed), map source ms to timeline ms with the clip's speed table (`doc.ts` / `clipSourceSpan`, or a small helper).
2. **In the Clip inspector:** a "Moments" section (rendered by `moments/MomentsSection.tsx`, mounted with one import line and one JSX line in `inspector/ClipInspector.tsx`). It lists the moments inside the clip:
   - time, kind (Song accent / Shot change / Motion burst), strength;
   - the Hits-style controls for each.

   Each row has a **Use** toggle and an effect choice: Punch, Flash, Shake, Zoom blur, RGB split, Glitch, Shockwave, Freeze (speed 0 for a beat). "Use" writes keyframes:
   - an attack/decay pulse on that effect's amount, at that clip time (keys at t−1 frame = 0, t = peak, t+decay = 0);
   - adding the effect if the clip doesn't have one of that type;
   - for Freeze, speed keys.

   Turning "Use" off removes those keys. A "Use all" button and a strength slider cover the whole list. The keys stay ordinary keyframes the user can then edit.
3. **Snapping:** footage moments of the selected clip join the snap targets while dragging trims/moves (if `timeline/snapping.ts` allows it through its existing inputs; otherwise skip and report).

Tests:
- source→timeline mapping;
- pulse key writing/removal (no duplicate or overlapping keys, ≤ 64 keys, clamped to the clip);
- Use all;
- the inspector section with a fake `Moments`.

### 24.4 Acceptance

- In the real app, a section styled "Hi-hats · Shuffle · Anime hit on accents" cuts quickly on the hats and pulses on accents.
- A selected clip shows its moments.
- Toggling "Use" on a motion burst adds a visible punch exactly there.
- `npm run check` and Go tests pass.
