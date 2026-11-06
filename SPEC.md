# Toolbox — Phase 19 Spec: Paint+ and the Library browser

Status: **DRAFT 2026-11-06. Waiting for your review.** Edit it directly. When you say "approved", it is final and I build it end to end without asking.

Phase 18 (Focus Lock + pipeline timing) is archived in `docs/specs/phase-18.md`. Every earlier rule still holds. In particular:
- **every tool stands on its own** (CLAUDE.md, 2026-11-06);
- every sidebar tool is a pipeline step with a `StepUI`;
- every file row is a draggable `ResultRow` with Send to, Reveal, Open and Save a copy;
- the polish rules apply: 960 × 600, tokens only, a tooltip on every control, and `aria-disabled` with a reason.

---

## Overview

This phase adds one tool and replaces one screen.

1. **Paint+** (module `paint`). A drawing and painting program meant to rival Procreate and be a far better MS Paint:
   - layers, pen pressure and tilt, real brushes and a normal eraser;
   - modern image models used **as an artistic medium**: a content-aware fill eraser, and a set of "AI brushes" built on the engine models Toolbox already ships (LaMa / MI-GAN inpainting, background removal, SAM 2.1 segmentation, Real-ESRGAN);
   - GPU effect brushes built on the Visualizer's shaders.

   **The inspiration** is `~/Toolbox/Erased/both (erased) (erased) … (erased).png`. It came from running Object Eraser over its own output about 25 times. Faces, hair and a figure dissolved into soft ghosts while the wall rebuilt itself around them. That loop (erase, then erase the erased) is a medium, and Paint+ makes it a brush: **Dissolve**, with generations you can scroll back through.

2. **Library** (the existing special view, rebuilt). One place that shows **everything Toolbox made**:
   - **Previews:** thumbnails, poster frames, waveforms, PDF pages.
   - **Grouping:** by tool and by folder, exactly as the files sit on disk.
   - **Lineage:** what each result was made from and what was made from it. The 25-file erased series appears as one strip.
   - **Files the DB doesn't know:** unregistered files in library folders, project renders and saved masks.

   You asked for "an artifacts tool". This spec puts it in the **Library**, the screen that already exists for this job, rather than adding a second one (open question Q2).

### Goals
- Paint+ is a complete standalone painting app. You can start a blank canvas or open a photo, paint with a pen or a mouse, save, reopen and export, without touching another tool.
- Paint+ smoothness: inking at 120 Hz on a 4K canvas stays under 8 ms per frame, with no dropped coalesced points.
- AI brushes feel like brushes. A stroke ends, the region shimmers, and the result lands in place:
  - typically in under 1.5 s (Fast) or under 4 s (Best) on this PC with a warm engine;
  - you can keep painting meanwhile;
  - every result is undoable and kept as a generation.
- The Library finds any file Toolbox made in at most two clicks: open Library, then click the tool or search. It shows the file and opens its folder.

### Non-goals (this phase)
- **Prompted generative fill** ("paint in a cat"). It needs a multi-GB diffusion model (Q1).
- Animation or frame-by-frame.
- Vector layers.
- PSD export (OpenRaster instead, Q6).
- Timelapse video (Later).
- A file watcher for the library.
- Editing files the user dropped from outside the library in place (never; inputs are copied or imported).

---

## 1. Paint+ — product

### 1.1 What a user can do (the standalone checklist)
1. **Start.**
   - **New canvas:**
     - presets: Screen (window size), Square 2048, A4 300 dpi (2480 × 3508), 4K (3840 × 2160), Custom (max 8192 per side, max 40 MP);
     - background: white, transparent or a colour.
   - **Open:** a photo (any `media.ImageExtensions()`, HEIC through the engine like Composer), an `.ora`, or a Paint+ project.
   - **Paste or drop** an image: it becomes a new layer, or a new canvas if none is open.
2. **Paint.**
   - Brushes (§1.3) with pressure, tilt and velocity.
   - Colour wheel, harmony swatches, recent colours, palettes, and an eyedropper (Alt-hold or a long-press).
3. **Erase.**
   - The **normal eraser** uses any brush tip.
   - **Fill eraser** (content-aware) and **Dissolve** (§1.4).
4. **Layers.**
   - Add, duplicate, delete, reorder (drag), rename, hide, lock;
   - opacity, blend mode, clipping mask, alpha lock;
   - merge down, flatten.
   - Up to 64 layers. No groups in this phase.
5. **Select and transform.**
   - **Selection tools:** rectangle, ellipse, lasso, magic wand (tolerance, contiguous), **Select object** (AI, §1.4) and **Select subject** (AI).
   - **Selection actions:** invert, feather, grow/shrink, clear.
   - **Transform:** move, scale, rotate, flip. Applies to the layer or the selection, with a handles overlay and bilinear resampling on commit.
6. **Fill and shapes.**
   - Paint bucket (tolerance, sample all layers or the current layer).
   - **Quick shape:** hold at the end of a stroke and it snaps to a line, ellipse, rectangle or polygon, as in Procreate.
   - Straight line with Shift.
7. **Canvas.**
   - Zoom (pinch, Ctrl+wheel, `+`/`-`), pan (Space-drag, middle-drag, two-finger), rotate the view (R-drag, two-finger twist), fit, 100%, flip view horizontally.
   - Canvas size, image size (resample), crop to selection.
   - **Extend canvas with fill** (AI outpaint, §1.4).
8. **Symmetry guides:** vertical, horizontal, quadrant, radial (2–16 segments).
9. **Undo and redo**, unlimited within a 1.5 GB memory budget, then the oldest steps drop (shown in the History panel). A **History brush** paints back from any earlier step (§1.5).
10. **Save.** Autosave runs 2 s after the last change. There is also explicit Save, Save as, Duplicate, Rename and Delete. Projects are listed in the start screen with thumbnails.
11. **Export.**
    - PNG, JPG (quality), WebP, or OpenRaster `.ora` (layers kept), at 25–400% scale.
    - The default goes to `<library>/Paintings/<name>.<ext>`, registered as an output and shown with `LastExport` (Reveal, Open, Save a copy, Send to). **Export as…** picks any location.
    - **Copy image** puts the flattened canvas on the clipboard.
12. **Find past work:**
    - the start screen lists projects;
    - "Exports" shows past exports (Library filtered to `paint`);
    - "Open in Paint+" is offered from Library rows, result rows (Send to) and Object Eraser.
13. **Keyboard.**
    - **Tools:** B brush, E eraser, G fill, V move/transform, L lasso, M rect select, W wand, I eyedropper, S smudge.
    - **Brush size:** `[` `]` change size, Shift+`[` `]` change opacity.
    - **Undo/redo:** Ctrl+Z / Ctrl+Shift+Z.
    - **Selection:** Ctrl+D deselect, Ctrl+Shift+I invert, Ctrl+A select all.
    - **Layers and view:** Ctrl+J duplicate layer, Ctrl+E merge down, Tab hides the UI, `?` shows the overlay.

    Two-finger tap = undo and three-finger tap = redo, on touch screens.

### 1.2 Pen input
- Uses `PointerEvent` with `getCoalescedEvents()` (all points) and `getPredictedEvents()` (drawn as a provisional tail, replaced next frame).
- **Pressure, tilt (`tiltX/tiltY` or `altitudeAngle/azimuthAngle`), twist and velocity** feed the brush dynamics.
- A mouse gets simulated pressure from velocity (fast = thin), and it can be turned off.
- **Pen and touch.** When a pen is detected, touch only navigates and never paints. This is the palm rejection, and it can be turned off.
- **Streamline** (0–100) smooths with a lagged spring. **Stabiliser** (0–100) uses a pulled-string average. Both are per brush.
- Windows Ink: set `touch-action: none` on the canvas and handle `pointerrawupdate` where it exists. **Wave 0 spike:** confirm pressure arrives in WebView2 from a Wacom/Windows Ink pen on this PC. If it doesn't, log it in DECISIONS and fall back to velocity pressure.

### 1.3 Brushes
Brush engine parameters, editable in the Brush Studio panel, saved as user presets, import/exportable as JSON:
- **Tip:** shape (round, square, or one of 16 built-in grayscale tips), hardness, roundness, angle (fixed, follow stroke, or tilt).
- **Stroke:** spacing (% of size), jitter (size, angle, position, opacity), count per dab, taper in/out.
- **Grain:** none or one of 12 built-in textures, with scale and moving/fixed.
- **Dynamics:** pressure → size / opacity / flow (each with a curve), tilt → size/angle, velocity → size.
- **Colour dynamics:** hue/sat/brightness jitter per stroke or per dab.
- **Wet:**
  - **wet mix:** dilution, charge and pull, which picks up colour from the canvas (oil/watercolour);
  - **wet edge:** darkened rim (watercolour).
- **Blend:** the dab blend mode (normal, multiply, screen, add, erase).

**Built-in presets** (`frontend/src/paint/brushes/presets.ts`, at least 24):
- *Sketch:* HB Pencil, 6B Pencil, Charcoal, Chalk.
- *Ink:* Fine Liner, Brush Pen, Calligraphy (tilt angle), Marker.
- *Paint:* Soft Round, Hard Round, Airbrush, Gouache, Oil (wet mix), Watercolour (wet edge + dilution), Wash.
- *Texture:* Spray, Stipple, Grass, Cloud.
- *Pixel:* Pixel 1 px (aliased, nearest neighbour), Pixel Square.
- *Tools:* Smudge, Blur, Eraser (Soft), Eraser (Hard).

### 1.4 AI brushes and commands (the medium)
These need the AI engine. Each control that needs a missing model shows `aria-disabled` with the reason, and one `DepsGate` banner carries the pack button. The engine and model warm up when Paint+ opens if they're installed (`PaintService.Warm`).

| Brush / command | What it does | Engine |
|---|---|---|
| **Fill eraser** | Paint a mask. When the stroke ends, the masked area of the current layer (or of the merged visible layers with "sample all") is filled in from its surroundings. | `paint.fill` (LaMa = Best, MI-GAN = Fast) |
| **Dissolve** | Fill eraser fed back into itself. Each pass inpaints the previous pass's result. **Passes** 1–12. **Ghost** 0–100% blends each pass over the last, so things fade instead of vanishing. **Drift** 0–100 jitters the mask (dilation ±, offset ±, a seeded per-pass random crop origin), so each pass reconstructs from slightly different context. **Live:** while you keep painting over a region that was just dissolved, it dissolves again on each stroke end. This is the inspiration image as a brush. | `paint.fill` with `passes`, `ghost`, `drift`, `seed` |
| **Melt** | Dissolve whose mask grows downward a few px each pass (direction settable), so forms drip and smear. | `paint.fill` with `drift.dir` |
| **Echo** | Fills the stroke from a *shifted* copy of its surroundings (offset X/Y). LaMa then reconstructs stuttered repeats. Good with low Ghost. | `paint.fill` with `sourceOffset` |
| **Edge erode** | Only the outer ring of the stroke (width settable) is inpainted, so shapes lose their edges and blur into the ground. | `paint.fill` (ring mask made in the frontend) |
| **History brush** | Paints back pixels from any earlier history step or generation. Pairs with Dissolve: dissolve everything, then paint back the eyes. | none (frontend) |
| **Subject stamp** | Click a photo layer once to cut out its subject (bg removal). The cut-out becomes a stamp brush tip, placed along the stroke with size/angle/scatter dynamics. | `paint.cutout` |
| **Select subject** | Selection from background removal on the current layer. Also "Cut subject to new layer". | `paint.cutout` |
| **Select object** | Click (positive) and Alt-click (negative) points on the canvas. SAM 2.1 returns a mask live as a preview, and Enter makes it the selection. | `paint.segment` |
| **Enhance brush** | The stroke area is upscaled ×2 or ×4 with Real-ESRGAN and resampled back. This hallucinates crisp detail into soft areas, or into dissolved ones, which is fun. | `paint.enhance` |
| **Extend canvas with fill** | Grow the canvas by N px on chosen sides and fill the new margins from the edge content (outpainting with LaMa, tiled in 512 px bands). | `paint.fill` |
| **Upscale canvas** | Whole canvas ×2/×4 (Real-ESRGAN), as a new project or in place. | `paint.enhance` |

**Generations.**
- Every AI result is a *generation* of that region. The floating **Generations strip** shows the last result's variants: the original, then pass 1…N for Dissolve, plus re-rolls.
- Click one to swap it in. **Re-roll** runs again with a new seed. LaMa is deterministic, so variation comes only from `seed`-driven Drift and crop origin, and with Drift 0 a re-roll is identical. The UI says so.
- The strip remembers the last 8 AI operations, and older ones are still in History.

**Async behaviour.**
- AI strokes queue, one engine call at a time.
- A pending region shows an animated shimmer over its bounds, with a small cancel ×.
- Painting continues. If the user paints over a pending region, the result still lands, and the later strokes are re-applied on top. Each AI result is applied as an undo step that replaces only that region's tiles, and later non-AI steps are replayed above it in order.
- Cancel uses `$cancel` through the job, as everywhere.

**Crops.**
- The frontend sends only the bounding region (mask bbox + context margin of max(64 px, 50% of bbox), squared, clamped to the canvas), as two PNGs (source + mask).
- Context above 1536 px is downscaled for Fast and passed through for Best (the engine crops again at 512). The result comes back at crop size and is composited under the mask with a 4 px feather.

### 1.5 Effect brushes (GPU, deterministic)
Paint where an effect applies. The effect renders from the layer *under the stroke at stroke start* (a snapshot), through the stroke's soft mask, so overlapping passes compound like Dissolve.

Each one is a `viz/post` pass driven through a new `paint/effects/` adapter (§2.4), with the effect's params exposed in the brush panel:
- **Pixel sort:** sort along the stroke direction by luminance threshold. This is a new shader, not in `viz/post`.
- **Smear / Liquify:** push pixels along the stroke (displacement accumulates per dab).
- **Twirl, Bulge, Wave, Kaleido, Mirror.**
- **Glitch slice, Chromatic, VHS.**
- **Pixelate, Halftone, Posterize, Duotone.**
- **Feedback:** each dab zooms or rotates the current pixels slightly into themselves.
- **Blur, Sharpen, Glow, Outline.**

The effects apply at dab rate with the brush's spacing, so stroke speed shapes the result.

### 1.6 Screens and layout
- **Start screen** (no project open):
  - big "New canvas" presets, "Open image…", and a drop zone;
  - a projects grid with thumbnails (name, size, edited time; right-click Rename / Duplicate / Delete / Reveal render);
  - a "Recent exports" row (`ResultRow`s).
- **Editor.** It's a workspace (`defineWorkspace`) laid out with `StudioLayout`:
  - **Header (`ToolHeader`):** project name (editable), save state, undo/redo, **Export** as the primary action, and More (Export as…, Copy image, Canvas size, Image size, Extend canvas…, Upscale canvas…, Duplicate project, Show exports in Library, Close).
  - **Stage:** canvas edge to edge, with two floating toolbars:
    - **left:** tool picker (brush, eraser, smudge, fill, select ▾, transform, eyedropper, AI ▾, Effects ▾);
    - **top:** the current tool's one-line options (size, opacity, and for AI brushes Passes/Ghost/Drift/Fast-Best).

    Size and opacity also sit as **vertical sliders on the left edge** (Procreate-style). Bottom-right shows zoom %, the rotation reset and the symmetry toggle.
  - **Rail panels (`WorkspaceRail`):**
    - **Brushes:** library by category, plus a Brush Studio click-in;
    - **Colour:** wheel, swatches, palettes;
    - **Layers:** thumbnails, blend, opacity, the per-layer menu;
    - **History:** steps with thumbnails, the History brush source picker and the memory meter;
    - **Generations:** the AI strip, also floating near the region.
  - **Pop-outs.** The Layers and Colour panels are poppable (`ToolPanel.poppable: true`), over the bridge. Brush Studio is not.
- At **960 × 600**: the rail collapses to icons, panels open as drawers, and the size/opacity sliders shrink. Tab hides all UI.

---

## 2. Paint+ — architecture

### 2.1 Files
```
modules/paint/
  module.go       Module, ModuleID "paint", Descriptor (Name "Paint+", icon "brush", CategoryImage,
                  OutputSubdir "Paintings", Requires none, Recommends sidecar.DepID)
  options.go      ExportOptions, AIOptions, StepOptions (+ DefaultOptions)
  document.go     PaintDoc (bindings-visible)
  service.go      PaintService (Wails)
  projects.go     project CRUD over core/projectdocs, tile files, thumbnails
  export.go       flatten (pure Go compositor for normal/multiply/screen/add/overlay + opacity), PNG/JPG/WebP(FFmpeg)/ORA
  ai.go           the hidden "paint-ai" job module: runs engine calls on crop files
  pipeline.go     core.Chainable for the step (§2.7)
  *_test.go
sidecar/toolbox_sidecar/handlers/paint.py    paint.fill / paint.cutout / paint.segment / paint.enhance / paint.warm
sidecar/tests/test_paint.py
frontend/src/paint/               engine, no React, no tools/ imports (an architecture test enforces it)
  engine/types.ts                 frozen in Wave 0 (§2.3)
  engine/gl.ts compositor.ts tiles.ts layers.ts history.ts selection.ts transform.ts
  input/pointer.ts smoothing.ts   coalesced/predicted, streamline, stabiliser, palm rejection
  brushes/engine.ts dabs.ts wet.ts tips/ grains/ presets.ts schema.ts
  effects/adapter.ts pixelsort.ts smear.ts      (wraps viz/post passes)
  ai/queue.ts crops.ts generations.ts           (frontend side of §1.4)
  io/ora.ts                                     (OpenRaster read/write, also used by Go tests' fixtures)
frontend/src/tools/paint/         PaintView.tsx, StartScreen.tsx, workspace.tsx, panels/*, toolbar/*, commands.ts
frontend/src/pipelines/steps/paint.tsx          StepUI
```

### 2.2 Document and storage
A Paint+ project is a `projectdocs` document of a **new kind `paint`**:
- migration `0009_paint_library.sql` adds the kind to the `projects` CHECK (copy the table, as 0007 did);
- `core.ProjectPaint = "paint"`.

```go
// modules/paint/document.go
type PaintDoc struct {
    Version    int          `json:"version"`    // 1
    Width      int          `json:"width"`      // ≤ 8192
    Height     int          `json:"height"`     // ≤ 8192, Width*Height ≤ 40e6
    Background string       `json:"background"` // "#rrggbb" | "transparent"
    Layers     []PaintLayer `json:"layers"`     // bottom → top, ≤ 64
    Active     string       `json:"active"`     // layer id
    Palette    []string     `json:"palette"`    // ≤ 64 "#rrggbb"
    Symmetry   string       `json:"symmetry"`   // JSON (frontend schema), "" = off
    TileSize   int          `json:"tileSize"`   // 512
    Source     string       `json:"source"`     // original file opened from ("" for blank); never modified
}
type PaintLayer struct {
    ID, Name  string
    Hidden, Locked, AlphaLock, Clip bool
    Opacity   float64 // 0..1
    Blend     string  // normal|multiply|screen|overlay|add|darken|lighten|color-dodge|color-burn|soft-light|hard-light|difference|hue|saturation|color|luminosity
    Tiles     []string // "tx_ty" keys that exist on disk (empty tiles are absent = transparent)
    Rev       int      // bumps on every pixel save (cache key)
}
```

**Pixels are tiles.**
- Each layer is a grid of 512 × 512 RGBA tiles, stored as PNGs at `<support>/projects/<id>/layers/<layerId>/<tx>_<ty>.png`. Empty tiles are not stored.
- `thumb.jpg` (≤ 512 px) and `render.png` (flattened, ≤ 4096 px long side, used by the Library and the step) sit next to them.
- Autosave sends **dirty tiles only**. A brush stroke typically touches 1–6 tiles, so each binding call stays small: base64, 2 MiB cap per tile.
- A save is atomic per tile (temp file + rename). The document JSON is saved last, so a crash never references a missing tile: tiles listed but absent load as transparent and are logged.

`PaintService` (all bound; errors are `*core.AppError`):
```go
Projects() ([]core.ProjectInfo, error)
Create(name string, w, h int, background string) (string, error)              // id
CreateFromImage(path string, name string) (string, error)                       // imports the image as layer 1 (oriented, HEIC via engine), never touches path
Load(id string) (PaintDoc, error)
Tiles(id, layerID string, keys []string) (map[string]string, error)             // key → PNG data URL (≤ 64 per call)
SaveTiles(id, layerID string, tiles map[string]string, removed []string) error   // data URLs; "" removes
SaveDoc(id, name string, doc PaintDoc) error                                    // validates; garbage-collects tiles of deleted layers
SaveThumb(id, jpegDataURL, renderPNGDataURL string) error                       // render ≤ 40 MiB
Rename(id, name string) error; Duplicate(id string) (string, error); Delete(id string) error
Export(id string, opts ExportOptions) (core.Job, error)                          // job: flatten in Go → <library>/Paintings, registered output
ExportAs(id string, opts ExportOptions) (string, error)                         // save dialog, writes directly, returns path ("" cancelled)
ImportLayer(id, path string) (PaintLayer, error)                                // image file → new layer tiles (scaled to fit if larger)
AI(id string, req AIRequest) (core.Job, error)                                  // §2.5
AIResult(jobID string) (string, error)                                          // result PNG data URL (crop size)
AIStatus() ([]AIModelInfo, error)                                               // per AI brush: ready? model sizes; drives the gates
Warm() error                                                                    // starts the engine + loads the fast inpaint model if installed (no download)
```
Projects open from `CreateFromImage` remember `Source`. **Never write to `Source`.**

### 2.3 Frontend engine contract (frozen in Wave 0: `frontend/src/paint/engine/types.ts`)
```ts
export interface PaintEngine {
  readonly doc: Readonly<EngineDoc>;            // mirrors PaintDoc + live GPU state
  attach(canvas: HTMLCanvasElement): void;      // WebGL2; throws PaintGLError if unavailable
  detach(): void;
  load(doc: PaintDocJSON, tiles: TileSource): Promise<void>;
  // input
  beginStroke(tool: ToolState, p: InputPoint): void;
  extendStroke(points: InputPoint[], predicted: InputPoint[]): void;
  endStroke(): StrokeResult;                    // dirty tiles + history entry id
  cancelStroke(): void;
  // layers
  addLayer(opts?: Partial<LayerProps>): string; removeLayer(id: string): void;
  moveLayer(id: string, toIndex: number): void; setLayer(id: string, p: Partial<LayerProps>): void;
  mergeDown(id: string): void; flatten(): void; setActive(id: string): void;
  // selection & transform
  selection: SelectionAPI; transform: TransformAPI;
  // pixels in/out (AI, effects, export)
  readRegion(r: Rect, src: "layer" | "merged"): Promise<ImageData>;
  writeRegion(layerId: string, r: Rect, img: ImageBitmap | ImageData, mask?: ImageData, feather?: number): HistoryId;
  // history
  undo(): boolean; redo(): boolean; history(): HistoryEntry[]; jumpTo(id: HistoryId): void;
  snapshotAt(id: HistoryId, r: Rect): Promise<ImageData>;     // History brush / generations
  // view
  view: ViewAPI;                                 // zoom/pan/rotate/flip, screen↔canvas
  render(): void;                                // compositor, called on rAF when dirty
  dirtyTiles(): Map<string, Set<string>>;        // layerId → tile keys since last save
  markSaved(layerId: string, keys: string[]): void;
  flattenToBitmap(scale: number): Promise<ImageBitmap>;
  on(ev: "change" | "history" | "layers" | "selection" | "view", cb: () => void): () => void;
}
export interface InputPoint { x: number; y: number; pressure: number; tiltX: number; tiltY: number; twist: number; t: number; pointer: "pen" | "mouse" | "touch" }
```
Rules:
- **WebGL2 throughout.** Each layer tile is a texture; the compositor draws visible tiles with the layer blend shaders. Dabs are instanced quads (`QuadBatch`-style), written into a per-stroke scratch target that is merged into the layer at the stroke's opacity on end (so in-stroke overlap never exceeds opacity, as in Procreate).
- **Undo** stores the *before* tiles that a step touched, as GPU textures, demoted to compressed `ImageBitmap`s in RAM when over budget. Budget 1.5 GB, oldest dropped.
- **Determinism.** A stroke replayed with the same points, brush and seed gives the same pixels. Jitter uses a seeded RNG per stroke (`stroke.seed`). Tests rely on this.
- **No `Math.random`, `Date` or `performance.now` inside brush/effect math.** Timestamps come in via `InputPoint.t`.
- `frontend/src/paint/**` never imports `src/tools/**`. `src/architecture.test.ts` gets the rule.

### 2.4 Effect brushes
- `paint/effects/adapter.ts` wraps any `viz/post` `PostDef` as an effect brush: render the post pass from the stroke-start snapshot into a scratch target, then mix through the dab mask. Params map from the PostDef's `params`.
- **Pixel sort and Smear** are paint-only shaders in `paint/effects/`.
- `viz/` stays unchanged: Paint+ imports from it and never the reverse.

### 2.5 AI path (Go and engine)
- **Not job spam, still jobs.** Each AI operation is a job of a **hidden module `paint-ai`**: progress, cancel and persistence come for free.
- **New `Descriptor.Quiet bool`** (Wave 0) keeps a module's jobs out of:
  - the completion toasts;
  - the job tray's "recent" list (they still show while running);
  - the Library (they register no outputs).
- `MaxConcurrent: 1`.

```go
type AIRequest struct {
    Op       string  // "fill" | "cutout" | "segment" | "enhance"
    Source   string  // PNG data URL of the crop (≤ 24 MiB)
    Mask     string  // PNG data URL (fill), "" otherwise
    Points   []AIPoint // segment: {x,y,positive} in crop px, ≤ 64
    Model    string  // fill: "best"|"fast"; enhance: preset id; cutout: "fast"|"balanced"|"best"
    Passes   int     // fill: 1..12
    Ghost    float64 // 0..1
    Drift    float64 // 0..1
    DriftDir string  // ""|"down"|"up"|"left"|"right" (Melt)
    Offset   [2]int  // Echo source offset in crop px
    Seed     int64
    Scale    int     // enhance: 2|4
}
```
- `Run` writes the crop and mask into `<support>/tmp/paint/<jobID>/` (pruned at start and when the job ends).
- It resolves models through the **existing** providers:
  - inpaint: `modules/eraser` models (`<models>/eraser`);
  - cut-out: `modules/bgremove` presets;
  - segment: `modules/editstudio` `matte-select` (SAM 2.1 tiny, `<models>/matte`);
  - enhance: the CPU upscaler presets in `modules/upscale`, or `upscayl-bin` when present.
- It calls the engine, keeps the result PNG as the job result (`AIResult` reads it back once and then deletes it), and never downloads inside the handler.
- **Fetching models.** A missing model is fetched only by the user clicking the gate's "Get" button. That runs the existing `ModelProvider.FetchModel` through the packs job, as elsewhere.

**Engine handlers** (`handlers/paint.py`). They reuse `eraser.py`'s `inpaint_region`/session cache, `bgremove.py`'s session, and `upscale.py`'s tiler:
- `paint.fill {src, mask, out, model, modelPath, passes, ghost, drift, driftDir, offset, seed}` → `{output, passes}`.
  - Each pass: build the pass mask (dilate by a seeded ±drift amount, shift by `driftDir`), take the context from the previous pass's output (shifted by `offset` for Echo), inpaint, then `out = lerp(prev, pass, 1 − ghost)` inside the mask.
  - `ctx.progress` per pass. **Intermediate passes are emitted as `output` events** (`pass-<n>.png`) so the Generations strip fills as it runs.
- `paint.cutout {src, out, model…}` → `{output (RGBA), coverage}`.
- `paint.segment {src, points, out, modelPath}` → `{output (mask PNG), score}`.
  - Uses SAM 2.1's **image** predictor (`SAM2ImagePredictor`) from the pinned official repo already in `[tool.uv.sources]`.
  - Embeddings are cached per `src` hash (LRU 4), so extra clicks only run the decoder (target < 150 ms).
- `paint.enhance {src, out, model, modelDir, scale}` → `{output}`. Paint+ resamples back.
- `paint.warm {modelPath}` loads the MI-GAN session (and LaMa if present).

No new Python dependencies. Pin checks: `uv.lock` unchanged.

### 2.6 Export
- `Export` is a `paint` job. It flattens the tiles in Go (pure Go compositor), so a large export never goes through the webview.
  - Blend modes beyond normal/multiply/screen/add/overlay/darken/lighten are flattened by the frontend instead: the job is submitted with `ExportOptions.Flattened` = a render PNG the frontend made with the same compositor. Go-side blend math is table-tested against the frontend's golden pixels.
- **Formats:**
  - PNG (default);
  - JPG (quality 60–100, background required);
  - WebP (FFmpeg, as `imagebatch`);
  - `.ora`: zip of `mimetype`, `stack.xml`, `data/<layer>.png`, `Thumbnails/thumbnail.png` and `mergedimage.png`. Opacity, visibility and composite-op map to OpenRaster names. Krita and GIMP open it.
- Output: `<library>/Paintings/<project name>.<ext>`, never overwriting (` (2)` suffix as elsewhere). It's registered with lineage inputs = `[Source]` when set (§3.3).

### 2.7 Pipeline step (required: every tool is a step)
`paint` implements `core.Chainable` with `StepOptions{Action, Project, Layer, Fit, Passes, Ghost, Drift, Seed, Model}`. There are two actions, both render-free (no webview):
- **`overlay`** ("Draw a painting over"): for each input image, composite a saved Paint+ project's visible layers (flattened `render.png` at full res via tiles) over it. `Fit` is `contain|cover|stretch`, placed centred, and the output goes to `Paintings/`. Use cases: watermark, frame, signature, hand-drawn annotations on a batch.
- **`dissolve`** ("Dissolve with a mask"): for each input image, use a mask from a saved Paint+ project's named layer (alpha > 0 = mask) or a saved Object Eraser mask, then run `paint.fill` with Passes/Ghost/Drift/Seed. This is the inspiration effect in batch, on a folder of photos.

`Produces` role `image`; `Templates` none; `Vars`: `{passes}` echoed. The `StepUI` lives in `frontend/src/pipelines/steps/paint.tsx`, with `paramDefs` entries (project picker, layer picker).

### 2.8 Packs
Paint+ joins the **Image** pack with `Needs: []`. Drawing works with nothing installed, like `imagebatch`. The AI brushes' needs are shown per brush:

| Brush | Needs |
|---|---|
| Fill eraser / Dissolve / Melt / Echo / Edge erode / Extend canvas | `engine`, `inpaint` |
| Subject stamp / Select subject | `engine`, `bg-default` |
| Select object | `engine`, `matte-select` |
| Enhance brush / Upscale canvas | `upscaler` or `engine` |

The Image pack's components gain `matte-select`. Wave 0 confirms that a component can be listed by two packs: `core/packs` status counts it installed once. If it can't, Select object's gate points to the Music edits pack and DECISIONS records it.

---

## 3. Library — product and architecture

### 3.1 What a user can do
- **Open it** from the sidebar ("Library", Mod+L), the palette, any tool's More → "Show in Library" (filtered to that tool), any toast's "Show in Library", and Paint+ → "Exports".
- **Browse** in one of four views (remembered):
  - **Grid** (default): thumbnail cards, sized S/M/L.
  - **List:** today's dense rows, kept.
  - **Folders:** the library folder tree as on disk. The left pane is a tree with item counts; the right pane shows that folder's contents as a grid. **Unregistered files appear too**, marked with a dim "not from a job" dot.
  - **By tool:** one section per tool, newest first. Each section has a header with the tool icon and name, the folder name (full path on hover), "Open folder" and "Open tool", and shows its first 12 items with "Show all".
- **Filter and sort:**
  - search by name across everything (server-side);
  - type chips (image, video, audio, document, other) moved to the server query;
  - tool filter, a date range (Today, This week, This month, All);
  - sort: newest, oldest, name, size.
- **Previews:**

  | File type | Preview |
  |---|---|
  | Images | `FilesService.ImageThumb` |
  | Video | poster frame (`MediaService.Frame` at 10%), hover-scrub filmstrip (`Filmstrip`, 8 frames), duration badge |
  | Audio | mini waveform (`Waveform`, 64 buckets), inline play |
  | PDF | first page (`pdf.Service.Thumbnail`), page count badge |
  | Text, srt, lrc, csv, json, md | first lines (`ReadText`, 2 KB) |
  | Folders (Folders view) | a mosaic of up to 4 children |
  | Missing files | greyed, with "Forget" |

- **Detail panel.** Click a card to open it on the right (Enter or double-click = Open in the default app). It shows:
  - a big preview: zoomable image (`wholeImageUrl`), video/audio player, PDF pages (scroll), or text (scroll, `TextActions`);
  - name (rename), folder (click = Reveal), size, dimensions/duration, created, tool;
  - the job's settings summary (from `jobs.options` through the module's `summarize`, or raw key/values);
  - **Made from:** input thumbnails, clickable when they're library files, otherwise "Reveal input";
  - **Made into:** outputs whose lineage includes this file;
  - **Generations:** when a chain exists (A → A (erased) → A (erased) (erased) → …, i.e. single-input lineage repeated through the same tool), a horizontal strip with a scrubber across the whole chain. "Export strip as GIF/contact sheet" uses the `gif` module's job, and "Open in Paint+" is offered.
  - **actions:** Open, Reveal, Save a copy, Copy path, Send to…, Open in <tool that made it>, Rename, Forget (DB only), **Delete** (to the Recycle Bin / Trash, undoable from the OS; Q3).
- **Other places.** A section at the bottom of the tree/tool views for things the user made that live outside the library:
  - **Projects** (posts, compositions, edits, video projects, paintings) with their thumbs. Clicking one opens it in its tool.
  - **Saved masks** (Object Eraser). Open in Object Eraser.
  - **Received** (Local File Transfer), which is in the library already but grouped by device.

  Vault exports already live in the library. Clipboard images stay in Clipboard History (privacy: never surfaced elsewhere).
- **Multi-select** (kept): bulk Send to, Reveal, Save copies to a folder…, Forget, Delete.
- **Live.** `library:added` and `library:removed` update open views. A refresh button rescans the Folders view.

### 3.2 Backend
New `LibraryService` methods (Wave 0 signatures):
```go
Query(q core.LibraryQuery) (core.OutputPage, error)            // supersedes Recent: + Kinds []Kind, Since/Until ms, Sort, Folder (rel)
Folders() ([]core.LibraryFolder, error)                        // tree of <library> dirs (depth ≤ 6), counts (registered + all files), newest mtime
ListDir(rel string, limit int) ([]core.LibraryEntry, error)     // one folder's files+subdirs (≤ 5000), joined with outputs by path; rel must stay inside the library
Detail(outputIDOrPath string) (core.OutputDetail, error)       // output + job options/title + MadeFrom + MadeInto + Chain
Places() (core.LibraryPlaces, error)                           // projects (all kinds) + saved masks
Rename(outputID, newName string) (core.Output, error)          // same folder, sanitized, never overwrites; MoveOutput
Trash(outputIDs []string, paths []string) (core.TrashResult, error) // OS trash; library files only; removes rows
SaveCopies(outputIDs []string) (string, error)                 // folder dialog, copies all (non-overwriting names)
```
- `ListDir`, `Rename` and `Trash` refuse anything outside `<library>` (`core.IsWithin`), and symlinks/junctions are not followed. `Trash` never touches the support dir.
- **Trash backends:**
  - Windows: `IFileOperation` with `FOFX_RECYCLEONDELETE`, or `SHFileOperationW` with `FOF_ALLOWUNDO|FOF_NOCONFIRMATION|FOF_SILENT`, via `golang.org/x/sys/windows` (no cgo).
  - macOS: `NSFileManager trashItemAtURL` (cgo, `desktop/`-style file in `core/trash/trash_darwin.go`; a cgo-less build falls back to "not available on this build", and the button is disabled with that reason).
- `core/trash` is a tiny package with a fake for tests.

### 3.3 Lineage
Migration `0009_paint_library.sql` (shared with §2.2) adds:
```sql
CREATE TABLE output_inputs (
  output_id TEXT NOT NULL REFERENCES outputs(id) ON DELETE CASCADE,
  input_path TEXT NOT NULL,
  PRIMARY KEY (output_id, input_path)
);
CREATE INDEX output_inputs_path ON output_inputs(input_path);
```
- **Filling:**
  - `JobContext.Output(path)` records the job's inputs for that output.
  - With exactly one input, that's it.
  - With several inputs, `JobContext.OutputFrom(path string, inputs ...string)` (new, additive) lets a module be precise. Without it, the default is the inputs whose file stem is a prefix of the output's stem, or else all inputs.
  - Wave 1 updates the multi-input modules that matter: `imagebatch`, `converter`, `bgremove`, `upscale`, `compress`, `stems` (folder → stem files), `pdf` merge/split. Any module not updated keeps the default.
  - Pipelines: built-in steps record their step inputs the same way.
- **Backfill.** At first start after the migration, a one-time job-less pass inserts `(output.id, input)` for every output whose `job_id` is still set, from `jobs.inputs`. Outputs with no job (old chat exports) have no lineage. That's shown as "Origin unknown".
- **Chains:** `Detail` follows single-input lineage backwards and forwards within the same `module_id` (≤ 200 steps) to build `Chain`. The erased series becomes one chain.

### 3.4 Frontend
- `frontend/src/views/library/` replaces `LibraryView.tsx`, split as `LibraryView.tsx` (shell + toolbar), `GridView.tsx`, `ListView.tsx`, `FolderView.tsx`, `ByToolView.tsx`, `DetailPanel.tsx`, `previews/*.tsx`, `Places.tsx`, and `state/library.ts` (extended).
- Every card and row uses `useResultBehaviour` (draggable, double-click opens) and `FileActions`.
- **Thumbnails** load lazily (IntersectionObserver), at most 6 concurrent, cached by `path+mtime` in memory (LRU 500).
- **Deep links:** `openLibrary({ moduleId?, path?, outputId? })` in `lib/openLibrary.ts` sets the view, filter and selection.
- `ToolHeader`'s More menu gets a standard "Show in Library" item for every tool, through `ToolHeader` itself, with the module id from context. The completion toast gains "Show in Library" next to Reveal.
- The 960 × 600 layout: the detail panel becomes a drawer, and the tree in Folders view collapses to a breadcrumb.

---

## 4. Errors and limits
- **Paint+ errors:**
  - WebGL2 unavailable: "Paint+ needs WebGL 2, which this window doesn't have". This shows in the tool, with no crash.
  - Tile load failure: the layer shows a red outline, plus a banner "Some of this layer couldn't be read (N tiles)" with "Clear those tiles".
  - The engine crashes mid-AI: the region's shimmer turns red and says "That fill failed — try again". The canvas stays untouched.
- **Size limits:**
  - Canvas over 40 MP: refused at creation with the max shown. An image over 40 MP opened as a new canvas is offered "Scale down to fit" or "Cancel".
  - AI crop: the context is clamped to 1536 px (Fast) or 3072 px (Best). Bigger strokes are split into overlapping tiles, run in sequence, and blended. **Extend canvas** max 2048 px per side per run.
- **Library limits:** `ListDir` over 5000 entries shows the first 5000 and says so. `Trash` on a file in use reports which one and continues with the rest.

## 5. Tests
- **Go:**
  - `modules/paint`:
    - document validation;
    - tile save/load/GC;
    - atomic saves;
    - flatten golden pixels per blend mode;
    - ORA round-trip;
    - export naming;
    - the AI job with a fake `Caller` (crop files written, cleaned up, result read once);
    - `Chainable` (describe, prepare overlay/dissolve, outputs);
    - `Source` never written (hash before/after).
  - `core/store`: migration 0009 upgrade from a 0008 DB fixture, `output_inputs` insert/cascade, backfill.
  - `api`: `ListDir`/`Rename`/`Trash` refuse outside the library (table), with the fake trash.
  - `core`: `OutputFrom`, the default stem rule, and chain building.
  - The root tests `TestEveryToolIsAPipelineStep` and the packs test include `paint`.
- **Python:**
  - `paint.fill` on generated images: pass count, ghost = 1 keeps the source, determinism for the same seed, drift changes the output, offset shifts.
  - `paint.segment` with a fake predictor (the real one runs under `TOOLBOX_SLOW=1`).
  - `paint.cutout` and `paint.enhance` wiring.
- **Frontend (vitest):**
  - **Brush engine:** dab spacing, dynamics curves, a seeded jitter replay that is identical twice, streamline output.
  - **History:** undo/redo of tiles, budget drop.
  - **Selection math:** lasso fill, wand tolerance.
  - **AI queue:** ordering, cancel, replaying later strokes over a returned region.
  - **Crops:** bbox and margin, clamping.
  - **`ora.ts`:** round-trip.
  - **StartScreen and Editor:** render, gates, the 960 × 600 layout via the media-query mocks.
  - **Library:** each view renders from fixtures, server filters, the detail panel lineage and chain, the trash flow with undo text, the deep links.
  - **The every-tool tests** include `paint`. The architecture test adds the `paint/**` rule.
- **GL.** jsdom has no WebGL, so engine GL code sits behind a `GLBackend` interface with a CPU reference backend used in tests. Golden comparisons run in the real app through a **PaintLab** (`TOOLBOX_PAINTLAB=1`, like VizLab): it replays recorded strokes per preset into `<support>/tmp/paintlab/*.png` + `hash.json`.

## 6. Acceptance (on the Windows PC, a real build, sandbox env)
1. A blank 4K canvas, with 2 minutes of continuous inking using a pen: pressure varies the width, there are no gaps, and the frame time stays under 8 ms (PaintLab's fps probe and the DevTools trace).
2. Open the reference photo (the erased series' original `both.png` if still present, else any photo). Dissolve with Passes 6, Ghost 30%, Drift 50 over a face reproduces the look of `both (erased) … (erased).png`. The Generations strip shows passes 1–6, and the History brush paints back an eye.
3. Select object with 2 clicks isolates a person, then copy to a new layer.
4. Extend the canvas by 512 px right with fill. The seam isn't visible at 100%.
5. Save, quit the app, reopen: the project is identical (pixel hash). Export PNG and ORA. The ORA opens in Krita/GIMP if installed (else validated by our reader).
6. The pipeline: `dissolve` over a folder of 5 photos with a painted mask layer gives 5 outputs.
7. Library:
   - Folders view shows `Erased/` with all 27 files, and the detail panel shows the chain as one strip.
   - "Show in Library" from Object Eraser lands filtered with the newest selected.
   - Delete sends a file to the Recycle Bin, where it can be restored.
8. Every screen is checked at 1180 × 720 and 960 × 600 (survey shots in `.dev/p19-qa/`).

---

## 7. Work packages

### Wave 0 — foundation (architect, sequential, on main)
1. CLAUDE.md sections "Paint+ (Phase 19)" and "Library (Phase 19)". DECISIONS entries for Q-defaults. A ROADMAP row.
2. Migration `0009_paint_library.sql` (projects kind `paint` + `output_inputs`) and `core.ProjectPaint`. Store method stubs: `AddOutputInputs`, `OutputInputs`, `OutputsFromInput`, `BackfillLineage`.
3. Frozen Go contracts:
   - `Descriptor.Quiet` (+ toast/tray/library honouring it, done here, small);
   - `JobContext.OutputFrom`;
   - `core.LibraryQuery/LibraryFolder/LibraryEntry/OutputDetail/LibraryPlaces/TrashResult`;
   - `LibraryService` method stubs;
   - `core/trash` interface + fake;
   - `modules/paint` skeleton (Descriptor, `PaintDoc`, `AIRequest`, `ExportOptions`, `StepOptions`, `PaintService` with every method stubbed `NotImplemented`, `Chainable` with real `StepDefaults`/`DescribeStep` + stub `PrepareStep`);
   - the `paint-ai` hidden Quiet module.
4. The `handlers/paint.py` stub (methods registered, `HandlerError("not_implemented")`), embedded.
5. Wiring: `main.go`, packs (Image pack + `matte-select` check), `pipeline_proof_test.go`, `packs_test.go`, `catalogFixture.ts`, `shell/keywords.ts`, `tools/index.ts` (stub `PaintView` start screen), icons (`brush`, `palette`, `layers`, `eraser` exists, `sparkles`, `wand-sparkles` exists, `folder-tree`, `grid-3x3`), the stub `StepUI` + `paramDefs`, `lib/openLibrary.ts` stub.
6. Frontend frozen types: `frontend/src/paint/engine/types.ts`, `paint/brushes/schema.ts` (BrushPreset JSON schema), `paint/ai/types.ts`.
7. **Spikes**, recorded in DECISIONS:
   - (a) pen pressure in WebView2 on this PC;
   - (b) a WebGL2 instanced dab throughput test, 10k dabs per frame;
   - (c) a warm MI-GAN 768² crop timing and a LaMa 512 crop timing on this PC.
8. Regenerate bindings and re-export from `lib/api.ts`. All checks green. Builders branch from here.

### Wave 1 — parallel builders

| Package | Scope | Owns | Needs |
|---|---|---|---|
| **P1 Paint engine** | WebGL2 compositor, tiles, layers, blend shaders, brush engine + 24 presets, pen input/smoothing/palm rejection, history + budget, selection, transform, fill bucket, quick shape, symmetry, CPU reference backend, PaintLab | `frontend/src/paint/{engine,input,brushes,io}/**` | Wave 0 |
| **P2 Effect brushes** | adapter over `viz/post`, pixel sort, smear, the effect-brush presets | `frontend/src/paint/effects/**` | Wave 0 (engine types) |
| **P3 Paint backend** | `modules/paint/**` except the AI job (projects, tiles, export incl. ORA, Go compositor, pipeline step, service) | `modules/paint/**` (not `ai.go`) | Wave 0 |
| **P4 AI engine + job** | `handlers/paint.py` + tests, `modules/paint/ai.go` (+ test), the SAM 2 image predictor, model resolution via the existing providers | `sidecar/toolbox_sidecar/handlers/paint.py`, `sidecar/tests/test_paint.py`, `modules/paint/ai.go` | Wave 0 |
| **P5 Paint UI** | `tools/paint/**`: start screen, workspace, panels (Brushes, Brush Studio, Colour, Layers, History, Generations), toolbars, shortcuts, export/LastExport, the gates, StepUI (`pipelines/steps/paint.tsx`) | `frontend/src/tools/paint/**`, `frontend/src/pipelines/steps/paint.tsx` | Wave 0 (engine types; uses P1 through the interface with a fake engine until P1 merges) |
| **P6 AI brushes (frontend)** | `paint/ai/**`: queue, crops, generations, Dissolve/Melt/Echo/Edge-erode mask building, History brush, Subject stamp tip, Select object live preview | `frontend/src/paint/ai/**` | Wave 0 |
| **L1 Library backend** | migration logic, lineage recording + backfill + `OutputFrom` in the listed modules, `LibraryService` methods, `core/trash` (Windows + macOS), chain building | `core/store/outputs*.go`, `core/jobs.go` (Output/OutputFrom only), `api/services.go` LibraryService, `api/library*.go`, `core/trash/**`, the `OutputFrom` lines in the listed modules | Wave 0 |
| **L2 Library UI** | `views/library/**`, previews, detail panel, Places, deep links, "Show in Library" in ToolHeader + toasts | `frontend/src/views/library/**`, `frontend/src/state/library.ts`, `frontend/src/lib/openLibrary.ts`, `components/ToolHeader.tsx` (More item only), `shell/useJobToasts.ts` (action only) | Wave 0 |

### Wave 2 — after Wave 1 merges
- **I1 Integration** (architect): P5 + P1 + P6 wiring on the real engine, PaintLab goldens, the AI end-to-end on this PC, the acceptance run §6, QA shots at both sizes, the CLAUDE.md final pass.

---

## 8. Open questions (defaults chosen; change them before approving)
- [ ] **Q1 Prompted generative fill** (Stable Diffusion 1.5/2 inpainting or SDXL-Turbo, 2–7 GB, slow on CPU, with a GPU/torch-CUDA question on Windows). **Default: not in this phase.** Revisit as an optional "Generative" pack once Paint+ exists. Everything above works without it.
- [ ] **Q2 Library vs a separate "Artifacts" tool.** **Default: rebuild the Library** (same sidebar entry, name "Library") rather than a second screen showing the same files. Rename it to "Artifacts" if you prefer the word.
- [ ] **Q3 Delete from the Library** sends files to the Recycle Bin / Trash. **Default: yes**, library files only, with a confirmation that names the count. Forget (DB only) stays.
- [ ] **Q4 Max canvas.** **Default: 8192 per side, 40 MP.** This covers A3 at 300 dpi. Memory: 64 layers × 40 MP isn't possible, so layers are capped by a VRAM estimate shown in the Layers panel.
- [ ] **Q5 Mouse pressure simulation** from velocity. **Default: on** for mouse, off when a pen was seen.
- [ ] **Q6 Layered export format.** **Default: OpenRaster (.ora)**, open, simple, and read by Krita/GIMP/MyPaint. PSD is Later.
- [ ] **Q7 Paint+ on macOS.** Same code, and Apple Pencil isn't a concern on Mac. **Default: Wacom pressure via WKWebView** is tested on the Mac at first use, with no extra work planned.
- [ ] **Q8 Open in Paint+ from Object Eraser.** **Default: yes**, an "Open in Paint+" action on its result (via Send to, plus a primary-looking button), because Paint+'s Dissolve is the evolved form of "Keep erasing on the result".

### Later
- Timelapse replay export (stroke log → MP4).
- Layer groups and adjustment layers.
- Brush import from `.brushset`/`.abr` (formats are proprietary or partly documented).
- Reference window (an image pinned in a pop-out).
- An audio-reactive brush (Visualizer analysis drives brush params while you paint along to a track).
- Prompted fill (Q1).
- A file watcher for the Library.
