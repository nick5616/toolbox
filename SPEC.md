# Toolbox — Phase 19 Spec: Paint+ and the Library browser

Status: **DRAFT 2026-11-06 (revised after your note on Procreate, brushes, design language and model ethics). Waiting for your review.** Edit it directly. When you say "approved", it's final, and I build it end to end without asking.

Phase 18 (Focus Lock + pipeline timing) is archived in `docs/specs/phase-18.md`. Every earlier rule still holds unless §0 below changes it:
- **every tool stands on its own** (CLAUDE.md, 2026-11-06);
- every sidebar tool is a pipeline step with a `StepUI`;
- every file row is a draggable `ResultRow` with Send to, Reveal, Open and Save a copy;
- accessibility (a tooltip on every control, `aria-disabled` with a reason, keyboard reachability) and the 960 × 600 minimum always apply.

---

## 0. Rule amendment (needs your OK)

**A tool may have its own design language.** Paint+ is the first. Today every screen follows one shared look: the polish rules, the shared components and the shared tokens. The amendment:
- **What a bespoke tool may do:**
  - define its own tokens, scoped to its root (`[data-design="paint"]` in `tools/paint/ui/tokens.css`);
  - use its own components (`tools/paint/ui/**`);
  - use its own layout and motion;
  - take over the whole window in **Studio mode** (§1.6), hiding the Toolbox sidebar and top bar.
- **What it still keeps:**
  - accessibility: tooltips, `aria-*`, keyboard, visible focus;
  - the 960 × 600 minimum, light/dark;
  - "colours come from tokens" (its own tokens);
  - the kit's file contract: `ResultRow`/`FileActions`/`LastExport`, restyled through its tokens, never replaced;
  - Toolbox's global affordances: the job tray, toasts, palette (Ctrl+K) and "Show in Library".
- **Recording it:** CLAUDE.md gets a "Bespoke tools" rule. A tool qualifies only when its spec says so.

---

## Overview

This phase adds one tool and rebuilds one screen.

1. **Paint+** (module `paint`) is for an artist who loves Procreate.
   - **The core** is a real painting app: layers, pen pressure, a deep brush engine and a brush library with character (leaves, grass, charcoal, gouache, ink). It has Procreate's directness, redesigned for a **desktop landscape (16:9) screen**, both full-screen and as a smaller window inside Toolbox. "Paint with layers, Procreate's feel, done well on a desktop" is the first deliverable on its own.
   - **Right next to the core sits the Lab:** tools that use modern technology as an artistic medium. Each new tool is a new constraint with its own qualities to learn. Every Lab tool carries a **predictability** rating:
     - **Exact:** same input, same result;
     - **Seeded:** random, but repeatable when you lock its seed;
     - **Wild:** you can't fully predict it.

     It also carries an **origin** card saying what it's built on.
   - **Ethics:** no image-*generating* model trained on scraped art. Lab tools are either algorithmic (no training data at all) or *perception* models (fill, select, cut out, sharpen) trained on photo and segmentation datasets, with the training data named in the tool's origin card (§1.4.3).

   **The inspiration** is `~/Toolbox/Erased/both (erased) (erased) … (erased).png`. It's Object Eraser run over its own output about 25 times: faces, hair and a figure dissolved into soft ghosts while the wall rebuilt itself around them. That loop is a medium, and Paint+ makes it a brush: **Dissolve**, with generations you can scroll back through.

2. **Library** (the existing special view, rebuilt) is one place that shows **everything Toolbox made**:
   - thumbnails, poster frames, waveforms and PDF pages;
   - grouping by tool and by folder, as the files sit on disk;
   - **lineage**: what each result was made from, and what was made from it. The 25-file erased series shows as one strip;
   - files the DB doesn't know about: unregistered files in library folders, project renders and saved masks.

   You asked for "an artifacts tool". This spec puts it in the **Library**, the screen that already exists for the job, rather than adding a second one (Q2).

### Goals
- **Standalone painting.** Paint+ is a complete standalone painting app. You can start blank or from a photo, paint with a pen or mouse, use layers, save, reopen and export, all without another tool.
- **Speed.** Inking at 120 Hz on a 4K canvas stays under 8 ms per frame, with no dropped coalesced points.
- **Brushes.** Paint+ ships **at least 60 brushes** of our own (§1.3.1), and it imports the brushes you already own: Procreate `.brushset`/`.brush`, MyPaint `.myb` and Photoshop `.abr` sampled tips.
- **The UI.** It feels like Procreate, on a desktop: canvas-first, gestures and keys, and panels that never cover the canvas on a wide screen. It works at 960 × 600 inside Toolbox and full-screen at 4K.
- **The Lab.** Every Lab tool shows its predictability and origin. A perception tool works like a brush:
  - when a stroke ends, the region shimmers and the result lands, typically in under 1.5 s (Fast) or under 4 s (Best) with a warm engine;
  - you keep painting meanwhile;
  - every result can be undone and is kept as a generation.
- **The Library.** It finds any file Toolbox made in at most two clicks: open Library, then click the tool or search. It shows the file and its folder.

### Non-goals (this phase)
- **Text-to-image or prompted generative fill.** See Q1 for the only candidates that would fit your ethics.
- **Animation, vector layers.**
- **PSD export.** OpenRaster instead (Q6).
- **Timelapse video.** Later.
- **A library file watcher.**
- **Bundling brushes whose licence doesn't allow redistribution.** You import those yourself (§1.3.2).

---

## 1. Paint+ — product

### 1.1 What a user can do (the standalone checklist)
1. **Start a canvas.**
   - **New canvas** (16:9 presets first):
     - **Screen 16:9:** 1920 × 1080, 2560 × 1440 or 3840 × 2160.
     - **Square 2048.**
     - **Portrait 9:16:** 2160 × 3840.
     - **A4 300 dpi:** 2480 × 3508.
     - **Custom:** up to 8192 per side and 40 MP.
     - **Background:** paper white, transparent or a colour.
     - **Paper texture** (optional): a grain baked into a locked bottom layer.
   - **Open** a photo (any `media.ImageExtensions()`; HEIC through the engine, like Composer), an `.ora` file, or a Paint+ project.
   - **Paste or drop** an image. It becomes a new layer, or a new canvas if none is open.
2. **Paint.**
   - Brushes (§1.3) respond to pressure, tilt and velocity.
   - Colour: a disc and value square, classic sliders, harmony, swatches, palettes, recent colours, and an eyedropper (hold Alt, or a long press).
   - **ColorDrop:** drag the colour onto the canvas to fill it, as in Procreate, with drag-to-threshold.
3. **Erase.** The normal eraser works with **any** brush (it uses that brush's tip and grain), as in Procreate. The Lab adds the content-aware **Fill eraser** and **Dissolve** (§1.4).
4. **Smudge** with any brush.
5. **Layers** (64 max, no groups this phase).
   - Add, duplicate, delete, reorder (drag), rename, hide and lock.
   - Opacity, the 16 blend modes, clipping mask, alpha lock, reference layer (fill sees it) and mask layer.
   - Merge down, flatten.
6. **Select and transform.**
   - **Selection:** rectangle, ellipse, lasso (freehand or polygon), magic wand (tolerance, contiguous), plus the Lab's Select object and Select subject. Invert, feather, grow/shrink, clear.
   - **Transform** the layer or the selection: free, uniform, distort, warp (a 4 × 4 mesh), flip and rotate 90°, with bilinear or bicubic resampling.
7. **Fill and shapes.**
   - Paint bucket (tolerance; sample all layers or the current one).
   - **QuickShape:** hold at the end of a stroke to snap it to a line, ellipse, rectangle or polygon, then edit it with handles.
   - Straight lines with Shift.
8. **Adjustments** on a layer or selection: Hue/Saturation/Brightness, Colour balance, Curves, Gradient map, Gaussian/Motion blur, Sharpen, Noise, Liquify (push, twirl, pinch, expand, crystals). Each is previewed live and can be drawn on with a brush ("Pencil" mode, as in Procreate).
9. **Canvas view.**
   - **Zoom:** pinch, Ctrl+wheel, or `+`/`-`.
   - **Pan:** Space-drag, middle-drag, or two fingers.
   - **Rotate the view:** R-drag or a two-finger twist.
   - **Fit, 100%** and **flip the view**.
10. **Canvas edits.** Canvas size, image size, crop to the selection, and **Extend canvas with fill** (Lab).
11. **Guides.** Symmetry (vertical, horizontal, quadrant, radial 2–16), a 2D grid, perspective (1, 2 or 3 points) with drawing assist, and isometric.
12. **Undo and history.**
    - Undo/redo has no step limit within a 1.5 GB memory budget, after which the oldest steps drop.
    - A History panel shows each step with a thumbnail.
    - The **History brush** paints back pixels from any earlier step.
13. **Save.** Autosave runs 2 s after the last change. You can also Save as, Duplicate, Rename or Delete. A start-screen gallery shows every project with its thumbnail.
14. **Export.**
    - **Formats:** PNG, JPG, WebP or `.ora` (layers kept), at 25–400%.
    - **Default location:** `<library>/Paintings/<name>.<ext>`, registered and shown with `LastExport` (Reveal, Open, Save a copy, Send to).
    - **Export as…** saves anywhere. **Copy image** puts the flattened canvas on the clipboard.
15. **Find past work.**
    - The gallery shows projects; Exports shows the Library filtered to `paint`.
    - "Open in Paint+" works from Library rows, Send to, and Object Eraser's result.
16. **Keys.**
    - **Tools:** B brush, E eraser, S smudge, G fill, V transform, L lasso, M rectangle select, W wand, I eyedropper.
    - **Size and opacity:** `[` `]` change size; Shift+`[` `]` change opacity.
    - **History:** Ctrl+Z undo, Ctrl+Shift+Z redo.
    - **Selection:** Ctrl+A select all, Ctrl+D deselect, Ctrl+Shift+I invert.
    - **Layers:** Ctrl+J duplicate, Ctrl+E merge down.
    - **View:** Tab hides the UI, F toggles Studio mode, `?` shows every shortcut.
    - **On a touch screen:** a two-finger tap undoes and a three-finger tap redoes.

### 1.2 Pen input
- **Events:**
  - `PointerEvent` with `getCoalescedEvents()` (every point) and `getPredictedEvents()` (a provisional tail, replaced on the next frame);
  - `pointerrawupdate` where it exists;
  - `touch-action: none` on the canvas.
- **What drives the brush dynamics:**
  - pressure;
  - tilt (`tiltX/tiltY` or `altitudeAngle/azimuthAngle`);
  - twist;
  - velocity.

  A mouse simulates pressure from velocity, which you can turn off. When a pen is detected, touch only navigates (palm rejection), and that can be turned off too.
- **Smoothing (per brush):**
  - **StreamLine** (0–100): a lagged spring;
  - **Stabilisation** (0–100): a pulled-string average;
  - **Motion filtering:** removes jitter at the extremes, as in Procreate.
- **Pressure curve:** a global curve editor, plus a per-brush curve.
- **Wave 0 spike:** confirm that pressure arrives in WebView2 from a Windows Ink or Wacom pen on this PC. If it doesn't, log it in DECISIONS and keep velocity pressure.

### 1.3 Brushes

#### 1.3.1 The engine and our own library
**Engine parameters** (in the **Brush Studio**, with a live drawing pad):
- **Tip:** shape (round, square, or a tip image), hardness, roundness, angle (fixed, follows the stroke, or follows tilt), and **tip rotation jitter**.
- **Stroke:** spacing (% of size), **scatter**, **count per dab**, taper in/out (by pressure or length), and **dual tip** (a second tip masks the first, as in Photoshop's dual brush).
- **Grain:** none or a texture, with scale, depth and contrast. *Moving* grain follows the stroke; *Texturised* grain stays fixed to the canvas.
- **Dynamics:** pressure, tilt, velocity and stroke-progress each map to size, opacity, flow, scatter and hue, every one through its own curve.
- **Colour dynamics:** hue/sat/brightness jitter per stroke or per dab, plus **secondary colour** mixing (foreground ↔ background by pressure).
- **Wet:** wet mix (dilution, charge, pull and grade), wet edges and **bleed** (water spreading after the stroke, settled over 600 ms).
- **Rendering:** light glaze, uniform glaze, intense blending, or **heavy paint** (impasto: per-dab height plus lighting).
- **Blend:** the per-dab blend mode.

Brushes are JSON (`paint/brushes/schema.ts`), and tips and grains are PNGs. Users can duplicate, edit, import, export and organise their own brushes into sets.

**Bundled library:** at least 60 brushes, all **made by us**. Tips and grains are generated procedurally in a build script (`frontend/scripts/brushgen.ts`, committed outputs), so the licence is clean. The sets:
- **Sketching:** HB, 6B, Mechanical, Charcoal stick, Willow charcoal, Conté, Chalk.
- **Inking:** Fine liner, Technical pen, Brush pen, Dry ink, Calligraphy (tilt), Marker, Felt tip.
- **Painting:** Soft round, Hard round, Gouache, Oil (wet mix), Acrylic flat, Impasto, Watercolour (wet edge + bleed), Wash, Glaze.
- **Airbrush:** Soft, Hard, Grainy, Spray can (with drips).
- **Nature:**
  - Leaf scatter (oak, maple, round and willow tip variants, rotating along the stroke with hue jitter);
  - Grass tufts, Fern, Pine needles, Branch, Bark, Moss, Petals;
  - Cloud billow, Foam, Rain, Snow.
- **Texture:** Stipple, Sponge, Splatter, Noise, Crosshatch, Halftone dots, Canvas weave, Paper fibre.
- **Elements:** Fire, Smoke, Light flare, Glow, Stars.
- **Pixel:** 1 px (aliased, nearest neighbour), Square, Dither.
- **Erasers:** Soft, Hard, Textured. Every brush also works as an eraser.
- **Smudge:** Soft blend, Rough blend, Bristle.

#### 1.3.2 Importing brushes you have
- **Free brushes online:** yes, there are lots. But most free Procreate and Photoshop packs are licensed *"free for personal use, don't redistribute"*. Paint+ therefore **imports** brushes you download and **never bundles** them.
  - Bundling: only brushes under a licence that allows redistribution (CC0, CC-BY with credit, or GPL-compatible), credited on each brush's info card.
  - Wave 0 checks the licence of each open set before anything is bundled (§7, item 7d).
  - The candidates are MyPaint's brush packs and Krita's default bundle. David Revoy's packs are a further candidate, and their licences vary by pack.
- **Importers** run in Go, in `modules/paint/brushimport/` (§2.4).
  - **Procreate `.brushset` / `.brush`:**
    - The file is a zip of `Brush.archive` (a binary-plist NSKeyedArchiver object), `Shape.png` and `Grain.png`.
    - The format is undocumented. We map the known keys and approximate the rest: spacing, jitter, taper, grain scale, pressure response and wet mix. Unknown keys are kept, so a later version can map more.
    - After an import, a **fidelity note** lists anything that was approximated.
  - **MyPaint `.myb`:** JSON, documented. Its settings and input curves are mapped onto our dynamics. MyPaint's "smudge" and "dabs per radius" map directly.
  - **Photoshop `.abr`:** v6+ *sampled* tips only, using the documented `samp` section. Tips become tip images with default dynamics. Computed brushes and presets aren't imported.
  - **Krita `.bundle`:** a zip; its `brushes/` (gbr/png tips) and `patterns/` become tips and grains.
- **How imported brushes are stored:** under `<support>/paint/brushes/<set>/`, as JSON plus PNGs. A set can be exported back as our own `.paintplus-brushes` zip (JSON + PNGs).

### 1.4 The Lab
The Lab sits **right next to the brushes**: its own tab in the brush library and a strip on the canvas edge (§1.6). Every Lab tool shows:
- **Predictability:** Exact, Seeded or Wild, as a small badge and in its tooltip. Seeded and Wild tools show a seed with **lock** and **re-roll**.
- **Origin:** a card. For algorithmic tools it shows the algorithm. For perception tools it shows the model, its licence, what it was trained on, and what it can't do.

Lab tools come in two kinds: algorithmic tools (§1.4.1), which use no training data, and perception tools (§1.4.2), which use models.

#### 1.4.0 Lab tools are devices (added 2026-11-06)
Each Lab tool presents as a **device**, like the devices in an Ableton Live device chain.
- **Header:** a title bar with an on/off toggle, the predictability badge and the origin card.
- **Controls:** a row of compact knobs and sliders, one per param, with value readouts, units and double-click to reset. Choices are small segmented switches and toggles are pill switches.
- **Rand:** the header's **Rand** button randomises every param not marked `rand: false` and not locked by the user (right-click a control → Lock from Rand), within its range.
  - Rand has its own seed, and Rand states have back/forward, so a lucky roll can be found again.
  - Rand sits beside the tool's **Seed** (lock and re-roll), which varies the tool's own randomness: the parameters stay the same, and the marks change.
- **Saved devices:** a device's current settings can be saved as a named variant, kept with the user's brushes.


These run on the GPU or CPU in the frontend, and are deterministic given a seed. The effects apply at dab rate with the brush's spacing, so stroke speed shapes the result.

| Tool | What it does | Predictability |
|---|---|---|
| **Flow field** | The brush follows a curl-noise field you can see as faint lines, so a straight stroke becomes a swirling bundle of hairs. Scale, turbulence and evolution are adjustable. | Seeded |
| **Growth** | An L-system grows branches, twigs and leaves from your stroke as a spine (leaf shapes from the Nature tips). Branching angle, depth, leaf density and season colours are adjustable. | Seeded |
| **Reaction–diffusion** | Paint "seed chemical". Gray-Scott patterns (coral, maze, spots, fingerprints) grow inside the painted area over a few seconds, and you stop them when you like. | Exact |
| **Ink bleed** | Wet ink spreads along the paper's grain (a capillary simulation over the paper texture), then dries. | Exact |
| **Particles** | Each dab emits particles with gravity, wind and lifetime, and they draw their trails (sparks, dust, rain streaks). | Seeded |
| **Pixel sort** | Sorts pixels along the stroke direction by a luminance threshold. | Exact |
| **Smear / Liquify brush** | Pushes pixels along the stroke; the displacement accumulates. | Exact |
| **Feedback** | Each dab zooms or rotates the pixels under it slightly into themselves (a tunnel or echo). | Exact |
| **Echo trail** | Repeats the stroke as fading offset copies. | Exact |
| **Voronoi crackle** | Breaks the painted area into cells (glaze cracks, stained glass, dry mud). | Seeded |
| **Kaleido, Mirror, Twirl, Bulge, Wave** | Distortions painted on, from `viz/post`. | Exact |
| **Glitch slice, Chromatic, VHS, Pixelate, Halftone, Posterize, Duotone** | Image effects painted on, from `viz/post`. | Exact (Glitch: Seeded) |

Effects that work on existing pixels render from a snapshot of the layer taken when the stroke starts, through the stroke's soft mask, so overlapping passes compound.

#### 1.4.2 Perception tools (models; need the AI engine)
Each control that needs a missing model shows `aria-disabled` with the reason, and one gate banner carries the pack button. The engine warms up when Paint+ opens if it's installed (`PaintService.Warm`).

| Tool | What it does | Predictability | Engine |
|---|---|---|---|
| **Fill eraser** | Paint a mask. When the stroke ends, the masked area of the current layer is filled in from its surroundings; with "sample all", the merged visible layers are used. | Exact | `paint.fill` (LaMa = Best, MI-GAN = Fast) |
| **Dissolve** | Fill fed back into itself; each pass inpaints the previous pass's result. Live: painting over a region you just dissolved dissolves it again on each stroke end. The inspiration image as a brush. Its settings are below the table. | Seeded | `paint.fill` with `passes`, `ghost`, `drift`, `seed` |
| **Melt** | Dissolve whose mask grows a few px each pass in a direction, so forms drip. | Seeded | `paint.fill` with `driftDir` |
| **Echo fill** | Fills the stroke from a shifted copy of its surroundings, so the model reconstructs stuttered repeats. | Exact | `paint.fill` with `offset` |
| **Edge erode** | Only the outer ring of the stroke is inpainted, so shapes lose their edges into the ground. | Exact | `paint.fill` (ring mask) |
| **History brush** | Paints back from any earlier step or generation. Dissolve everything, then paint back the eyes. | Exact | none |
| **Subject stamp** | Click a photo layer once to cut out its subject. The cut-out becomes a stamp tip, scattered along the stroke. | Exact | `paint.cutout` |
| **Select subject** | Makes a selection from background removal. Also "Cut subject to new layer". | Exact | `paint.cutout` |
| **Select object** | Click (positive) and Alt-click (negative) points; the mask previews live, and Enter makes it the selection. | Exact | `paint.segment` |
| **Enhance brush** | Upscales the stroke area ×2/×4 and resamples it back. It invents crisp detail, including in dissolved areas. | Exact | `paint.enhance` |
| **Extend canvas with fill** | Grows the canvas by N px on chosen sides and fills the new margins from the edges (512 px bands). | Exact | `paint.fill` |
| **Upscale canvas** | Upscales the whole canvas ×2/×4, as a new project or in place. | Exact | `paint.enhance` |

**Dissolve settings.**
- **Passes:** 1–12.
- **Ghost:** 0–100%, blends each pass over the last, so things fade instead of vanishing.
- **Drift:** 0–100, a seeded jitter of the mask's dilation and offset and of the crop origin, so each pass reconstructs from slightly different context.

**Generations.**
- Every perception result is a *generation* of its region. The floating **Generations strip** shows the original, then pass 1…N, plus re-rolls. Click one to swap it in.
- **Re-roll** changes the seed. The models themselves are deterministic, so only Drift and the crop origin vary; the UI says so when Drift is 0.
- The strip keeps the last 8 operations, and History keeps older ones.

**Async behaviour.**
- Requests queue, one engine call at a time.
- A pending region shimmers, with a cancel × on it.
- You keep painting. A result that lands is applied as an undo step that replaces only that region's tiles, and later strokes are replayed above it.
- Cancel goes through `$cancel`.

**Crops.**
- The frontend sends only the region: the mask bbox plus a margin of max(64 px, 50% of the bbox), squared and clamped, as source and mask PNGs.
- Above 1536 px, the context is downscaled for Fast and passed through for Best (the engine crops at 512 again).
- The result comes back at crop size and is composited under the mask with a 4 px feather.

#### 1.4.3 Model origins (shown in each tool's origin card)
Wave 0 confirms each row against the model's paper or model card and writes the confirmed text into `modules/paint/origins.go`, which feeds the card. Until then, the table is my understanding.

| Model | Used by | Trained on (to confirm) | Generates new imagery? |
|---|---|---|---|
| LaMa (big-lama) | Fill, Dissolve, Melt, Echo, Edge erode, Extend | Places2 scene photographs | Fills holes from the surrounding image; no prompts and no style of any artist |
| MI-GAN | the same tools (Fast) | Places2 (and CelebA-HQ for faces) | The same |
| BiRefNet / IS-Net | Subject stamp, Select subject | Segmentation datasets (DIS5K, HRSOD, …) of photographs | No; outputs a mask |
| SAM 2.1 tiny | Select object | SA-1B, which Meta describes as licensed images, plus SA-V video | No; outputs a mask |
| Real-ESRGAN | Enhance, Upscale | Photo datasets (DIV2K, Flickr2K, OST), degraded synthetically | Adds detail at the pixel level only |

None of these is a text-to-image model or a model trained on artworks to imitate styles. Prompted generation stays out unless Q1 says otherwise.

### 1.5 Design language (Paint+ only, per §0)
- **Canvas first.** The chrome is a quiet neutral, so the canvas's colours read true: a near-black UI in dark, warm grey in light.
  - The controls are **floating translucent islands** with a backdrop blur, a 14 px radius and soft shadows.
  - There are no hard dividers.
  - Motion is quick (120–180 ms) and springy on the panels, and never on the canvas.
- **Iconography.** A small custom icon set for painting (brush, smudge, eraser, layers, adjust, select, transform, colour puck, the Lab flask), drawn on our 24 px grid in `tools/paint/ui/icons/`. Lucide is still used for generic actions.
- **Typography.** The app font, smaller and lighter (11–12 px labels), with numbers tabular.
- **Every control has a tooltip and a keyboard path.** Gesture-only actions also have a key or a menu item.
- **Tokens** live in `tools/paint/ui/tokens.css` under `[data-design="paint"]`: surfaces, ink, accent (the current colour), glass, the radius scale and the motion curves, each with light and dark variants. No raw colours appear outside that file.

### 1.6 Layout (desktop, landscape 16:9 first)
- **Two modes:**
  - **In Toolbox:** the shell's sidebar is visible. Paint+ owns the main area, and its title bar shows through `ToolHeader`.
  - **Studio mode** (F, or the expand button): the window becomes Paint+ only, with the Toolbox chrome hidden and a thin hover strip at the top to return. **Full screen** (F11) works in both modes.
- **The canvas** is centred, edge to edge, and is never covered on wide windows.
  - **Left edge:** the Procreate-style vertical **size** and **opacity** sliders, the **modify** button (eyedropper), and undo/redo.
  - **Top-left island:** the gallery (back), the Actions menu (add image, canvas, share/export, guides, prefs), Adjustments, Select and Transform.
  - **Top-right island:** brush, smudge, eraser, layers and the colour puck, as in Procreate.
- **Panels**, opened from the top-right island:
  - **Brush library:** sets list + brushes with stroke previews, with a "Lab" tab.
  - **Layers:** big thumbnails and blend/opacity on tap.
  - **Colour:** disc, classic, harmony, value, palettes.

  **Above 1600 px** of window width they **dock** as columns on the right, so the canvas narrows and stays visible. Below that they're popovers anchored to their buttons. The choice is automatic and can be overridden.
- **The Lab strip** is a slim vertical strip on the right edge of the canvas. It holds the last 6 Lab tools used, each with its predictability badge, and it opens the full Lab panel. Below it sits the **Generations strip**, shown when there are generations.
- **The brush HUD** shows near the cursor while `[`/`]` are held: size, opacity and the brush name.
- **At 960 × 600:**
  - the islands compact to icons;
  - the sliders shorten;
  - panels are popovers, at most 360 px wide and 520 px tall, scrolling inside;
  - the Lab strip shows 3 tools.
- **At 4K full screen:** UI scale follows the OS scaling, and the panels dock.
- **The start screen (gallery)** has big tiles:
  - "New canvas" presets (16:9 first) and "Open image…";
  - project cards with thumbnails, in a grid that fills 16:9 nicely;
  - "Recent exports" `ResultRow`s, restyled;
  - a drop zone over the whole gallery.

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
  origins.go      model origin cards (§1.4.3), confirmed in Wave 0
  brushes.go      brush sets on disk (<support>/paint/brushes/), list/save/delete/export
  brushimport/    brushset.go (zip + NSKeyedArchiver bplist), myb.go, abr.go (samp tips), krita.go; fidelity notes
  pipeline.go     core.Chainable for the step (§2.7)
  *_test.go
sidecar/toolbox_sidecar/handlers/paint.py    paint.fill / paint.cutout / paint.segment / paint.enhance / paint.warm
sidecar/tests/test_paint.py
frontend/src/paint/               engine, no React, no tools/ imports (an architecture test enforces it)
  engine/types.ts                 frozen in Wave 0 (§2.3)
  engine/gl.ts compositor.ts tiles.ts layers.ts history.ts selection.ts transform.ts
  input/pointer.ts smoothing.ts   coalesced/predicted, streamline, stabiliser, palm rejection
  brushes/engine.ts dabs.ts dual.ts wet.ts bleed.ts impasto.ts schema.ts library/ (generated tips, grains, >= 60 presets)
  lab/adapter.ts pixelsort.ts smear.ts flowfield.ts growth.ts reaction.ts inkbleed.ts particles.ts voronoi.ts echo.ts
                                  (algorithmic Lab tools, §1.4.1; viz/post passes wrapped by adapter.ts)
  guides/ symmetry.ts perspective.ts grid.ts
  adjust/ hsb.ts curves.ts gradientmap.ts blur.ts liquify.ts noise.ts
  ai/queue.ts crops.ts generations.ts           (frontend side of §1.4)
  io/ora.ts                                     (OpenRaster read/write, also used by Go tests' fixtures)
frontend/scripts/brushgen.ts      generates the bundled tips/grains (committed PNGs in paint/brushes/library/)
frontend/src/tools/paint/         PaintView.tsx, Gallery.tsx, workspace.tsx, studio.ts (Studio mode), panels/*, islands/*, commands.ts
  ui/                             the bespoke design language (§0, §1.5): tokens.css, icons/, Island, Popover, Slider, Puck, Badge…
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
AIStatus() ([]AIModelInfo, error)                                               // per perception tool: ready? model sizes; drives the gates
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

### 2.4 Lab algorithmic tools and brush import
- **The `LabTool` interface.** Every algorithmic tool implements `LabTool` (frozen in Wave 0 as `paint/lab/types.ts`):
  - `{ id, label, predictability: "exact"|"seeded"|"wild", origin: {kind:"algorithm", text}, params, onStrokeBegin/Extend/End, step?(dt) }`;
  - `step` is for tools that keep evolving after the stroke: Reaction–diffusion, Ink bleed and Particles. They run on a GPU ping-pong target clipped to the stroke's tiles, and settle or stop by user action. Their frames come from a fixed tick count, never from wall time, so the result is deterministic.
- **Adapters and paint-only shaders:**
  - `paint/lab/adapter.ts` wraps any `viz/post` `PostDef`: the post pass renders from the stroke-start snapshot into a scratch target, then mixes through the dab mask. Params map from the PostDef's `params`.
  - Pixel sort, Smear, Flow field, Growth (L-system → dab paths), Reaction–diffusion (Gray-Scott), Ink bleed, Particles, Voronoi and Echo are paint-only.
- **Brush import (Go, `modules/paint/brushimport/`):**
  - `PaintService.ImportBrushes(paths []string) ([]BrushImportResult, error)`, where `BrushImportResult` is `{Set, Brushes []BrushInfo, Fidelity []string, Error}`.
  - It writes `<support>/paint/brushes/<set-id>/{set.json, <brush-id>.json, tips/*.png, grains/*.png}`.
  - It never executes or loads anything other than PNG and plist/JSON data. Zip entries are size-capped (64 MB total, 4096 px tips) and path-sanitised (no `..`, no absolute paths).
  - The binary-plist reader is `howett.net/plist` (BSD-2); the NSKeyedArchiver object graph is resolved by hand.
  - Golden tests use small **synthetic** fixtures made by our own test helpers, never third-party brush files committed to the repo.
- **Other brush methods:** `Brushes()`, `SaveBrush(set, json)`, `DeleteBrush`, `ExportBrushSet(set) (path)`, `BrushAsset(set, file) (dataURL)`.
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
Paint+ joins the **Image** pack with `Needs: []`. Drawing works with nothing installed, like `imagebatch`. The perception tools' needs are shown per tool:

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
  - **Brushes:** importer mapping (Go, synthetic fixtures, zip path sanitising, size caps); every bundled preset renders non-empty on the CPU backend.
  - **Lab:** each `LabTool` is deterministic for a fixed seed (CPU backend), and predictability labels match behaviour (Exact tools ignore the seed).
  - **Brush engine:** dab spacing, dynamics curves, a seeded jitter replay that is identical twice, streamline output.
  - **History:** undo/redo of tiles, budget drop.
  - **Selection math:** lasso fill, wand tolerance.
  - **AI queue:** ordering, cancel, replaying later strokes over a returned region.
  - **Crops:** bbox and margin, clamping.
  - **`ora.ts`:** round-trip.
  - **Gallery and Editor:** render, gates, Studio mode, docked vs popover panels at 1600 px, origin cards and predictability badges, the 960 × 600 layout via the media-query mocks.
  - **Library:** each view renders from fixtures, server filters, the detail panel lineage and chain, the trash flow with undo text, the deep links.
  - **The every-tool tests** include `paint`. The architecture test adds the `paint/**` rule.
- **GL.** jsdom has no WebGL, so engine GL code sits behind a `GLBackend` interface with a CPU reference backend used in tests. Golden comparisons run in the real app through a **PaintLab** (`TOOLBOX_PAINTLAB=1`, like VizLab): it replays recorded strokes per preset into `<support>/tmp/paintlab/*.png` + `hash.json`.

## 6. Acceptance (on the Windows PC, a real build, sandbox env)
1. A blank 4K canvas, with 2 minutes of continuous inking using a pen: pressure varies the width, there are no gaps, and the frame time stays under 8 ms (PaintLab's fps probe and the DevTools trace).
1b. **Core-only check:** with no AI engine installed, every non-Lab feature in §1.1 works, and the Lab's perception tools are greyed with a reason.
1c. **Brushes:**
   - the 60 bundled brushes render in PaintLab (one stroke sheet per set);
   - importing a Procreate `.brushset` you own lands as a set and shows a fidelity note;
   - a MyPaint `.myb` imports.
1d. **Layout:**
   - Studio mode at 3840 × 2160 docks the panels and never covers the canvas;
   - inside Toolbox at 960 × 600 every control is reachable;
   - light and dark both follow the Paint+ tokens.
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
1. The §0 rule in CLAUDE.md ("Bespoke tools"), plus sections "Paint+ (Phase 19)" and "Library (Phase 19)". DECISIONS entries for Q-defaults. A ROADMAP row.
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
6. Frontend frozen types: `frontend/src/paint/engine/types.ts`, `paint/brushes/schema.ts` (BrushPreset JSON schema), `paint/lab/types.ts` (`LabTool`), `paint/ai/types.ts`. The `tools/paint/ui/tokens.css` skeleton (names only).
7. **Spikes**, recorded in DECISIONS:
   - (a) pen pressure in WebView2 on this PC;
   - (b) a WebGL2 instanced dab throughput test, 10k dabs per frame;
   - (c) a warm MI-GAN 768² crop timing and a LaMa 512 crop timing on this PC.
   - (d) the licence of each candidate open brush set (MyPaint packs, Krita defaults, David Revoy packs). Bundle only those confirmed redistributable, with credits.
   - (e) the origin cards: confirm the training data of LaMa, MI-GAN, BiRefNet/IS-Net, SAM 2.1 and Real-ESRGAN against their papers and model cards, and write them into `origins.go`.
8. Regenerate bindings and re-export from `lib/api.ts`. All checks green. Builders branch from here.

### Wave 1 — parallel builders

| Package | Scope | Owns | Needs |
|---|---|---|---|
| **P1 Paint engine** | WebGL2 compositor, tiles, layers + 16 blend shaders, brush engine (dual tip, grain modes, wet mix, bleed, impasto), pen input/smoothing/palm rejection, history + budget, selection, transform/warp, fill bucket, QuickShape, guides (symmetry, perspective, grid), adjustments, CPU reference backend, PaintLab | `frontend/src/paint/{engine,input,brushes,io,guides,adjust}/**` except `brushes/library/**` | Wave 0 |
| **P2 Lab: algorithmic** | `LabTool`s of §1.4.1: adapter over `viz/post`, pixel sort, smear, flow field, growth, reaction–diffusion, ink bleed, particles, voronoi, echo | `frontend/src/paint/lab/**` | Wave 0 (engine + LabTool types) |
| **B1 Brushes** | `brushgen.ts` + the ≥ 60 bundled presets (tips, grains, JSON), Go brush storage + importers (brushset, myb, abr, krita) + synthetic-fixture tests, the confirmed open-licence sets if Wave 0 cleared any | `frontend/scripts/brushgen.ts`, `frontend/src/paint/brushes/library/**`, `modules/paint/brushes.go`, `modules/paint/brushimport/**` | Wave 0 (brush schema) |
| **P3 Paint backend** | `modules/paint/**` except the AI job (projects, tiles, export incl. ORA, Go compositor, pipeline step, service) | `modules/paint/**` (not `ai.go`) | Wave 0 |
| **P4 AI engine + job** | `handlers/paint.py` + tests, `modules/paint/ai.go` (+ test), the SAM 2 image predictor, model resolution via the existing providers | `sidecar/toolbox_sidecar/handlers/paint.py`, `sidecar/tests/test_paint.py`, `modules/paint/ai.go` | Wave 0 |
| **P5 Paint UI** | `tools/paint/**` in the bespoke design language (§0, §1.5, §1.6): `ui/` kit + tokens + icons, gallery, Studio mode, islands, docked/popover panels (Brush library + Lab tab, Brush Studio, Colour, Layers, History, Generations, origin cards), sliders, HUD, shortcuts, export/LastExport, gates, StepUI | `frontend/src/tools/paint/**`, `frontend/src/pipelines/steps/paint.tsx`, the Studio-mode hook in `shell/` (one `useUI` flag that hides sidebar + top bar) | Wave 0 (engine types; a fake engine until P1 merges) |
| **P6 Lab: perception (frontend)** | `paint/ai/**`: queue, crops, generations, Dissolve/Melt/Echo/Edge-erode mask building, History brush, Subject stamp tip, Select object live preview | `frontend/src/paint/ai/**` | Wave 0 |
| **L1 Library backend** | migration logic, lineage recording + backfill + `OutputFrom` in the listed modules, `LibraryService` methods, `core/trash` (Windows + macOS), chain building | `core/store/outputs*.go`, `core/jobs.go` (Output/OutputFrom only), `api/services.go` LibraryService, `api/library*.go`, `core/trash/**`, the `OutputFrom` lines in the listed modules | Wave 0 |
| **L2 Library UI** | `views/library/**`, previews, detail panel, Places, deep links, "Show in Library" in ToolHeader + toasts | `frontend/src/views/library/**`, `frontend/src/state/library.ts`, `frontend/src/lib/openLibrary.ts`, `components/ToolHeader.tsx` (More item only), `shell/useJobToasts.ts` (action only) | Wave 0 |

**Order of value.** The core (P1, P3, P5 and B1) is what makes "Paint with layers, Procreate's feel" real, and it's merged and checked first (acceptance 1–1d, 5). The Lab packages (P2, P4 and P6) run in parallel but integrate after it.

### Wave 2 — after Wave 1 merges
- **I1 Integration** (architect):
  - P5 + P1 + B1 on the real engine first, then P2/P6/P4;
  - PaintLab goldens;
  - the AI end-to-end on this PC;
  - the acceptance run §6;
  - QA shots at 960 × 600, 1180 × 720, 1920 × 1080 and 3840 × 2160 (Studio);
  - the CLAUDE.md final pass.

---

## 8. Open questions (defaults chosen; change them before approving)
- [ ] **Q1 Prompted generative fill.**
  - **Default: no**, not this phase, and never with a model trained on scraped art (no Stable Diffusion, no SDXL and none of their fine-tunes).
  - The only kind that fits your ethics is a model trained on public-domain or explicitly licensed and opt-in images. Candidates I know of:
    - **CommonCanvas** (trained on Creative-Commons-licensed photos);
    - **Mitsua Diffusion One** (public domain, CC0 and opt-in data).

    I'd check each one's data claims before considering it. They're weaker than mainstream models and 2–4 GB.
  - If you want one later, it becomes an optional "Generative (ethical data)" pack with its origin card front and centre.
- [ ] **Q2 Library vs a separate "Artifacts" tool.** **Default: rebuild the Library** (same sidebar entry, name "Library") rather than a second screen showing the same files. Rename it to "Artifacts" if you prefer the word.
- [ ] **Q3 Delete from the Library** sends files to the Recycle Bin / Trash. **Default: yes**, library files only, with a confirmation that names the count. Forget (DB only) stays.
- [ ] **Q4 Max canvas.** **Default: 8192 per side, 40 MP.** This covers A3 at 300 dpi. Memory: 64 layers × 40 MP isn't possible, so layers are capped by a VRAM estimate shown in the Layers panel.
- [ ] **Q5 Mouse pressure simulation** from velocity. **Default: on** for mouse, off when a pen was seen.
- [ ] **Q6 Layered export format.** **Default: OpenRaster (.ora)**, open, simple, and read by Krita/GIMP/MyPaint. PSD is Later.
- [ ] **Q7 Paint+ on macOS.** Same code, and Apple Pencil isn't a concern on Mac. **Default: Wacom pressure via WKWebView** is tested on the Mac at first use, with no extra work planned.
- [ ] **Q9 The bespoke design language (§0).** **Default: approved, for Paint+ only.** Other tools stay on the shared look unless their own spec says otherwise.
- [ ] **Q10 "16:9".** I read it as: the UI is designed for landscape desktop windows (16:9) rather than a tablet's 4:3, and the canvas presets lead with 16:9. **Default: both.** If you meant something else, for example the Paint+ window always holding 16:9, say so.
- [ ] **Q11 Brush importers.** **Default: all four** (Procreate, MyPaint, ABR sampled tips, Krita bundles). Procreate's format is reverse-engineered, so imports are best effort, with a fidelity note.
- [ ] **Q8 Open in Paint+ from Object Eraser.** **Default: yes**, an "Open in Paint+" action on its result (via Send to, plus a primary-looking button), because Paint+'s Dissolve is the evolved form of "Keep erasing on the result".

### Later
- Timelapse replay export (stroke log → MP4).
- Layer groups and adjustment layers.
- Exporting brushes back to Procreate's `.brushset`.
- Brush *capture* (make a tip from any canvas selection: draw a leaf, select it, make it a brush). A small step after this phase, and very Procreate.
- Reference window (an image pinned in a pop-out).
- An audio-reactive brush (Visualizer analysis drives brush params while you paint along to a track).
- Prompted fill (Q1).
- A file watcher for the Library.
