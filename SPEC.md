# Toolbox — Phase 22 Spec: Flipbook, a two-screen stop-motion studio

Status: **DRAFT 2026-11-20, waiting for your review.**

Phase 21 (Workspaces, editor parity, calm visuals, Color Grader and the demo) is archived in `docs/specs/phase-21.md`. Every earlier rule still holds unless §0 changes it:
- **every tool stands on its own** (CLAUDE.md, 2026-11-06);
- every sidebar tool is a pipeline step with a `StepUI`;
- every file row is a draggable `ResultRow` with Send to, Reveal, Open and Save a copy;
- accessibility (a tooltip on every control, `aria-disabled` with a reason, keyboard reachability), 960 × 600 and light/dark always apply;
- the performance rules (2026-11-17);
- workspaces: every piece of app data lives in the workspace (Phase 21 §A6b), and paths on screen follow "Hide personal details";
- **never start a real Focus session while developing.**

---

## 0. Rule amendments (need your OK)

**0.1 Flipbook is a bespoke tool.** Under the "Bespoke tools" rule (approved 2026-11-06, Paint+ only so far), Flipbook gets its own design language (§3):
- its own tokens under `[data-design="flipbook"]` in `tools/flipbook/ui/tokens.css`;
- its own components in `tools/flipbook/ui/**`;
- its own two-screen layout and motion;
- Studio mode, the same shell flag Paint+ uses.

It keeps everything that rule keeps: accessibility, 960 × 600, light/dark, colours from (its own) tokens, the kit's file contract (`ResultRow`/`FileActions`/`LastExport`, restyled), and the global affordances (job tray, toasts, palette, Show in Library).

**0.2 Camera and microphone.** Today Toolbox never uses either. Flipbook needs the camera for real stop-motion and the microphone for recording sounds. The new rule (it goes into CLAUDE.md's App rules):
- **Only Flipbook** turns them on, and **only while you're in Shoot mode (camera) or recording a sound (microphone).** Nothing starts them at launch, in the background, from a pipeline or in another window.
- **You can always see it.** While the stream is live, a red "Camera on" or "Mic on" badge shows on the hinge and in the tool header.
- **Automatic stop.** The stream stops when you leave Shoot mode or the tool, when the window is hidden or minimised, and after 5 minutes with no capture ("Camera paused — click to resume").
- **Nothing is kept unless you press.** Only the frames you capture and the sounds you record are saved, inside the flipbook's project folder. There's no recording to a buffer, no preview cache and nothing sent anywhere.
- **The browser permission** is granted to the main window only: Wails `Permissions{Camera: Allow, Microphone: Allow}`. Every other window keeps the default, and Flipbook's in-app button is the gate. The OS-level permission (Windows privacy settings, macOS TCC) still applies, and Flipbook explains how to turn it on when it's off (§9).
- **macOS:** `NSCameraUsageDescription` and `NSMicrophoneUsageDescription` go into `build/darwin/Info.plist` and `Info.dev.plist`. Without them macOS kills the app on first use.
- **While developing:** never open the real camera or microphone. Tests use a fake `MediaDevices`. Real-app QA uses Chromium's fake devices (a moving test pattern and a beep), which a sandboxed run turns on with `TOOLBOX_FAKE_MEDIA=1` (§7.4). The demo never enters Shoot mode, because it would film you.

**0.3 Originality.** You asked for a tool "based on" the DS-era flipbook app. Flipbook takes the *ideas* — two screens, frame-by-frame drawing with onion skin, a few inks, tone patterns, stamps, per-frame sound — and nothing else:
- **No names:** no Flipnote, Hatena, Nintendo, DS/DSi, Ugomemo, or anything that suggests a connection.
- **No look:** no copy of its layout, tab bars, colours, icons, fonts, frog mascot or other characters.
- **No sounds:** none of its sound effects or jingles. Our sound kit is synthesised by our own code (§5.5).
- **No file compatibility:** it doesn't read or write `.ppm`/`.kwz`.
- **An enforced check:** a test fails if any of those names appear in Flipbook's code or strings (§10).

---

## Overview

**Flipbook** (module `flipbook`) is a pocket animation studio with two screens:
- **the Stage** shows your animation exactly as people will see it: playing, or the current frame clean, with no onion skin and no tools;
- **the Desk** is where you draw: the current frame with onion skin, the pens and the tools around it.

**The hinge** between them holds the transport: play, frame flipping, the frame counter and the speed.

It does two kinds of animation, and mixes them freely:
1. **Drawn animation.** Draw a frame, add the next (blank or a copy to trace over), flip back and forth, play. The ink is **crisp pixels** in up to 16 inks on paper, with tone patterns and stamps, on three layers. That's the charm and the constraint: no blur, no opacity, no brush engine. It's fast to learn and every frame stays light.
2. **Stop-motion.** In **Shoot mode** the Desk shows your camera live, with the last frame laid over it as a ghost, so you can nudge the clay figure a little and press Enter. You can also build frames from photos you already have, or from a video (rotoscoping). Then you draw on top of the photos: sparkles, speech bubbles, a drawn character walking through a real room.

**Sound** is part of the flipbook:
- a **music** track;
- **four sound lanes** that pin sounds to frames, so when you move or retime frames, their sounds follow;
- sounds come from a synthesised **sound kit** (pops, boings, whooshes, drums), your **microphone** (record over the playback, Foley-style) or audio files.

**Out:** an MP4 with sound, a looping GIF, a PNG sequence, a sprite sheet, or a `.flipbook` file you can send to another Toolbox (Local File Transfer works). It is also a **pipeline step**: "Make a stop-motion" turns a folder of photos into an animation, optionally with a drawn flipbook laid over them.

**The two screens are real.** The Stage can **pop out into its own window**: put it on a second monitor, or turn it towards someone while you draw on the Desk.

### Goals
- **Standalone.** You can start blank, from the camera, from photos or from a video, then draw, time, add sound, save, reopen and export, all without another tool and without anything installed (only MP4, GIFs with photos and video import need FFmpeg).
- **The feel.** Flipping frames is instant, drawing has no lag, and playback never stutters:
  - flipping a frame takes ≤ 16 ms;
  - ink appears on screen within one frame of the pointer at 1920 × 1080;
  - playback holds 30 fps at 1920 × 1080 with photos and three layers.
- **Two screens that matter.** The Stage is always the truth: what it shows is what the export contains. It works stacked, side by side, alone, or in its own window.
- **Real stop-motion.** Shoot with onion skin over the live camera, an interval timer for time-lapse, and capture straight into the timeline.
- **Sound tied to frames.** Sounds stay on their frame through every edit, and the preview's sound matches the export's within one frame.
- **Original and safe.** It's original (§0.3), and the camera and microphone follow §0.2.

### Non-goals (this phase)
- Anti-aliased or pressure-opacity brushes, blend modes, layer opacity: that's Paint+'s job (a Later bridge could send a frame to Paint+).
- Vector drawing, tweening, automatic in-betweening (AI interpolation smears flat ink; see Later).
- Text tool with fonts (Later: a built-in pixel font).
- Reading or writing the DS app's file formats (§0.3).
- Changing a flipbook's canvas size after creation (Later: "Resize flipbook").
- Camera controls the browser can't reach: manual exposure, focus or white-balance lock. Shoot mode says to lock them on the camera itself or with its own app.
- Online sharing. A `.flipbook` file plus Local File Transfer is the sharing story.

---

## 1. Product — what a user can do (the standalone checklist)

### 1.1 Start
The **shelf** (start screen) shows your flipbooks as cards:
- each card shows its cover and **plays on hover** from a small sprite strip (no autoplay under `prefers-reduced-motion`);
- with its name, frame count, length ("48 frames · 6.0 s") and when it was last changed;
- with Rename, Duplicate, Delete (confirmed) and Export on a menu.

Ways to start, as big tiles:
- **New flipbook:** a size (§2.1), a speed, a paper colour. Defaults: Pocket 320 × 240, 8 fps, Cream.
- **Shoot stop-motion:** a new HD flipbook that opens straight into Shoot mode.
- **From photos…:** pick files or **From Library**; one frame per photo (§4.6).
- **From a video…:** pick a range and a rate; the frames arrive as photos or as a tracing guide (§4.6).
- **Open a .flipbook file…**

The whole shelf is a drop zone: dropped pictures start "From photos", a video starts "From a video", a `.flipbook` file imports. The shelf also shows **Recent exports** as `ResultRow`s.

### 1.2 Draw
- **Pen** (P): 10 sizes (1, 2, 3, 4, 6, 8, 12, 16, 24, 32 px), round or square tip, any ink, any tone pattern (§2.4). Optional **pressure sizes** (a pen's pressure scales the size between 1 px and the chosen size). **Steady** 0–10 smooths a shaky hand (Paint+'s streamline).
- **Eraser** (E): the same sizes and patterns (a patterned eraser makes tones by removal).
- **Line** (L): straight lines; Shift snaps to 15° steps.
- **Fill** (G): fills an area with the ink and pattern. **Sees:** "all layers" (default: lines on the top layer stop a fill on the bottom one, so you can colour under your lines) or "this layer".
- **Select** (S): lasso or rectangle. A selection can be moved, copied (Alt-drag), scaled (pixel-crisp), rotated (90° steps, or free), flipped, deleted, **copied to the next frame**, or **pasted onto a range of frames**. Enter or a tool switch commits; Esc cancels.
- **Stamp** (T): 32 built-in pixel stamps (stars, hearts, arrows, speech bubbles, sparkles, music notes, drops, puffs and more, drawn by us) in the current ink and pattern, plus **your stamps**: turn any selection into a stamp ("Make stamp"), kept across flipbooks.
- **Eyedropper** (I, or Alt while drawing): picks the ink under the cursor.
- **Hand** (hold H or the middle button) pans. Ctrl+wheel zooms; the zoom steps are Fit, 1×, 2×, 3×, 4×, 6×, 8×, 12× and 16×, always pixel-crisp.
- **Undo/redo** (Ctrl+Z / Ctrl+Y or Ctrl+Shift+Z): 200 steps, covering drawing and frame edits.

### 1.3 Inks, paper, layers
- **Inks:** 16 slots; 8 show by default and "More inks" shows all 16. Click a slot to use it, double-click to change its colour. **Changing an ink recolours it on every frame**: inks are references, so you can try a new colour scheme on the whole animation in one click.
  - Palette presets: **Pencil box** (default), **Two-tone**, **Night** (light inks for dark paper), **Riso**, **Mono**. A preset replaces the slots after a confirm, and can be undone.
- **Paper:** each flipbook has a paper colour (Cream, White, Kraft, Slate, Black, Mint, Blush, Sky, or any colour). Each frame can override it with its own colour, or a **photo**.
- **Layers:** three ink layers per frame, **Top**, **Middle** and **Bottom** (you can rename them). Each layer can be shown or hidden and locked, and these settings hold for the whole flipbook. A typical use: lines on Top, colour fills on Middle, a background on Bottom. "Clear layer on this frame" and "Clear layer on all frames" (confirmed) are on the layer's menu.

### 1.4 Frames and timing
- **The reel** is a strip of frame thumbnails under the screens. Click to go to a frame; Shift-click selects a range; drag moves frames; the context menu offers Cut/Copy/Paste/Duplicate/Delete/Reverse/Ping-pong/Set hold.
- **New frame** (N) inserts after the current frame. "New frames start as": **Blank**, **Copy of this frame** (trace and change), or **Copy of the Top layer only**. Also **Duplicate** (D) and **Delete** (Delete, when nothing is selected on the Desk).
- **Flip:** ← / → (Shift: 10 frames), Home / End. Holding → plays forward at the flipbook's speed (a "thumb flip").
- **Speed:** 1, 2, 3, 4, 6, 8, 12, 15, 24 or 30 frames per second (one "tick" is one step at that speed).
- **Hold:** each frame lasts 1–60 ticks (+ / −), so you can animate "on twos" or pause on a pose. The reel shows holds as wider tiles with "×2".
- **Loop** on or off. **Ping-pong** appends the selected frames in reverse.
- **Onion skin** (O): up to 3 frames before and 2 after, tinted (before warm, after cool), with opacity. It can include photos or not. It's shown only on the Desk.
- **Light table:** while you hold Q, the Desk shows the previous frame at full strength so you can compare.

### 1.5 Shoot (stop-motion)
- **Shoot mode** (the camera button on the hinge, or C) replaces the Desk with the live camera, cover-fitted to the canvas. The previous frame lies over it as a ghost: its photo at 40% (adjustable), and optionally its ink.
- **Capture:** Enter or the big button. A frame is inserted after the current one with the captured photo as its paper and the chosen hold (default 1). The shutter flashes on the Desk, and a shutter sound plays only if UI sounds are on (§3).
- **Options:** camera picker, mirror, a thirds grid, ghost opacity, "Ghost shows ink", and the **interval timer**: every 1–60 s, stop after N frames (≤ 999), with a countdown ring and a Stop button.
- **Draw between shots:** leaving Shoot mode (Esc or the camera button) returns to the Desk on the last captured frame, so you can draw on it and come back.
- **Privacy:** the rules in §0.2 apply (badge, automatic stops, nothing kept unless captured).

### 1.6 Sound
- **The Sound drawer** (the note button on the hinge, or M) opens above the reel. It has a **Music** lane and **four sound lanes**, laid out on the same frame columns as the reel.
- **Adding a sound:**
  - drag a sound from the **bin** (this flipbook's sounds) onto a lane at a frame;
  - or select a frame and a lane and press a kit sound.

  A cue starts at its frame's start time, and it plays to its end or until the next cue on the same lane (lanes are monophonic, like a drum pad). Each cue has a gain, from −24 to +12 dB.
- **Sound kit:** 24 synthesised sounds (§5.5). They're generated in the app, and placing one copies it into the flipbook.
- **Record:** the mic button records into the bin, up to 60 s each, with an optional 3-2-1 count-in. **Record over playback** plays from the current frame while you record, then places the recording as a cue at that frame on the lane you choose.
- **Import sound:** files or From Library (≤ 60 s; longer files offer "Use as music").
- **Music:** one audio file per flipbook (≤ 10 min), with an offset (start the song at 0:12) and a gain. It plays from frame 1 for the length of the animation, and continues across loops in the preview.
- **Mute** per lane and a master **Sound on/off** for the preview.

### 1.7 Play and present
- **Play** (Space) plays on the Stage from the current frame, with sound, looping if Loop is on. The Desk keeps showing your current frame, so you can watch and draw.
- **Stage layouts** (§3.2): **Side by side**, **Stacked**, **Desk only** (the Stage hides; hold `\`` to peek), **Stage in a window** (a pop-out you can make full screen on another monitor; F11 in it).
- **Swap screens** (W) swaps the screens' places (the order in Stacked, the sides in Side by side).

### 1.8 Keep and send
- **Autosave:** 1.5 s after the last change, on every frame flip and on Ctrl+S. The header shows "Saved", "Saving…" or "Not saved — retrying".
- **Export** (the primary button, or Ctrl+E) opens the Export sheet (§6): **Video (MP4)**, **GIF**, **PNG frames (zip)**, **Sprite sheet**, or **Flipbook file**, with the frame range, the scale, loops and sound.
- **Results** use `LastExport` and `ResultRow`s, restyled: name on screen, path on hover, Reveal, Open, Save a copy…, Send to (for example to the Video Editor or Compress to Size), and "Show in Library".
- **Finished jobs** get the completion toast with Reveal, even while the tool is on screen (`announceWhenDone`).

---

## 2. The flipbook model (frozen in Wave 0)

### 2.1 Sizes and speeds
| Preset | Size | Notes |
|---|---|---|
| `pocket` | 320 × 240 | 4:3, the default for drawing |
| `classic` | 640 × 480 | 4:3 |
| `wide` | 640 × 360 | 16:9 |
| `square` | 480 × 480 | |
| `tall` | 360 × 640 | 9:16 |
| `hd` | 1280 × 720 | the default for Shoot |
| `fhd` | 1920 × 1080 | photos at full HD |
| custom | even W, H in 64…1920, W × H ≤ 2 073 600 | |

- **Speeds:** `SpeedSteps = [1, 2, 3, 4, 6, 8, 12, 15, 24, 30]` fps; the default is 8.
- **Holds:** 1–60 ticks; the default is 1.
- **Limits:** a flipbook has 1–999 frames, and its size is fixed at creation.

### 2.2 Go document (`modules/flipbook/document.go`, bindings-visible)
```go
const DocVersion = 1

type FlipDoc struct {
    Version int         `json:"version"` // 1
    Width   int         `json:"width"`
    Height  int         `json:"height"`
    FPS     int         `json:"fps"`    // one of SpeedSteps
    Loop    bool        `json:"loop"`
    Paper   string      `json:"paper"`  // "#rrggbb"
    Inks    [16]string  `json:"inks"`   // "#rrggbb"; ink index i+1 in .ink files (0 = clear)
    Shown   int         `json:"shown"`  // 8 or 16 visible slots (UI only)
    Layers  [3]FlipLayer `json:"layers"` // bottom → top; IDs fixed "c","b","a"
    Frames  []FlipFrame `json:"frames"` // 1..999
    Sounds  []FlipSound `json:"sounds"` // the bin, ≤ 32
    Cues    []FlipCue   `json:"cues"`   // ≤ 2000
    Music   *FlipMusic  `json:"music,omitempty"`
    Cover   string      `json:"cover"`  // frame ID for thumb.jpg ("" = first frame)
    View    string      `json:"view"`   // JSON (frontend schema: onion, layout, trace mode, active layer/ink/tool); opaque to Go
}

type FlipLayer struct {
    ID     string `json:"id"`   // "a" | "b" | "c"
    Name   string `json:"name"` // ≤ 40 chars
    Hidden bool   `json:"hidden"`
    Locked bool   `json:"locked"`
}

type FlipFrame struct {
    ID     string   `json:"id"`              // 8 chars [a-z0-9], unique in the flipbook
    Hold   int      `json:"hold"`            // 1..60 ticks
    Paper  string   `json:"paper,omitempty"` // "" = doc paper, else "#rrggbb"
    Photo  string   `json:"photo,omitempty"` // photo ID (photos/<id>.jpg): the frame's backdrop, exported
    Guide  string   `json:"guide,omitempty"` // photo ID shown on the Desk only (tracing), never exported
    Inked  []string `json:"inked"`           // layer IDs that have a .ink file for this frame
    Rev    int      `json:"rev"`             // bumps on every ink save (thumbnail/cache key)
}

type FlipSound struct {
    ID         string `json:"id"`     // 8 chars
    Name       string `json:"name"`   // ≤ 60 chars
    Kind       string `json:"kind"`   // "kit" | "recorded" | "imported"
    KitID      string `json:"kitId,omitempty"`
    Source     string `json:"source,omitempty"` // imported-from path (lineage only; never modified)
    DurationMs int    `json:"durationMs"`       // ≤ 60000
}

type FlipCue struct {
    ID    string  `json:"id"`
    Lane  int     `json:"lane"`  // 0..3
    Frame string  `json:"frame"` // frame ID: the cue moves with its frame
    Sound string  `json:"sound"` // sound ID
    Gain  float64 `json:"gain"`  // dB, -24..12
}

type FlipMusic struct {
    File       string  `json:"file"`   // "music/<sanitised name>.<ext>" inside the project
    Name       string  `json:"name"`
    Source     string  `json:"source"` // lineage only
    OffsetMs   int     `json:"offsetMs"` // 0..duration
    Gain       float64 `json:"gain"`   // dB, -24..12
    DurationMs int     `json:"durationMs"` // ≤ 600000
}
```
- **Validation** (`Validate(doc) error`, a `core.ValidationError` naming the field) enforces every limit above:
  - the size rule;
  - `FPS ∈ SpeedSteps`;
  - unique IDs;
  - the layer IDs and order;
  - `Inked ⊆ {a, b, c}`;
  - every cue's frame and sound exist;
  - the hex colours.
- **Defaults:** `NewDoc(preset, fps, paper)`. Inks = Pencil box (§3.4 lists the colours); layers = Bottom/Middle/Top; one blank frame.

### 2.3 On disk (`<support>/projects/<id>/`)
```
frames/<frameId>/<layerId>.ink   indexed ink (§2.4); absent = empty
photos/<photoId>.jpg             exactly Width × Height, JPEG q92, sRGB, no metadata
sounds/<soundId>.wav             PCM s16le, 48 kHz, mono or stereo
music/<name>.<ext>               a copy of the chosen audio file
thumb.jpg                        cover, ≤ 512 px (Library, Smart search, shelf)
reel.jpg                         sprite: up to 16 evenly spaced frames, 160 px wide, one row (shelf hover)
```
- **The project row:** a `projectdocs` document of the new kind **`flipbook`**. Migration `0012_flipbook.sql` rebuilds `projects` with the kind added to the CHECK, as 0009 did; `core.ProjectFlipbook = "flipbook"`.
- **Saving:**
  - each `.ink` is written atomically (temp file + rename);
  - inks are saved before the document, so a document never references a missing file. An `Inked` layer whose file is absent loads as empty and is logged.
- **Clean-up:**
  - `SaveDoc` never deletes files, so undo can bring back a deleted frame;
  - `Compact(id)` runs when the flipbook closes and at `Load`. It deletes frame folders, photos (not a frame's `Photo` or `Guide`) and sounds that the saved document no longer references.
- **User stamps:** `<support>/flipbook/stamps.json` (≤ 200 stamps, each ≤ 256 × 256, indexes 0–16 RLE-encoded as base64). A user stamp keeps its ink indexes, so it takes the current flipbook's colours.

### 2.4 The `.ink` format and the compositor (frozen; Go and TS share the vectors)
- **`.ink` bytes:**
  - `"INK1"` (4 bytes);
  - width (uint16 LE), height (uint16 LE);
  - flags (1 byte, 0);
  - then a **zlib** (RFC 1950) stream of `width × height` bytes, row-major, each 0–16 (0 = clear, n = ink slot n).

  TS encodes with `CompressionStream("deflate")` (zlib format) and Go with `compress/zlib`. Shared vectors: `core/testdata/flipbook-ink.json`, with bitmaps and their expected decoded hashes; encoder output isn't compared byte for byte.
- **Composite rule (exact, no blending):**
  - start from the backdrop: the frame's `Photo` pixel if set, else `Paper || doc.Paper`;
  - then, for each layer bottom → top that isn't hidden, a non-zero index replaces the pixel with `Inks[index−1]`.

  The Stage, thumbnails, every export and the pipeline step use this rule. Onion skin and guides are Desk-only and never part of it. Shared vectors: `core/testdata/flipbook-composite.json` (ink-only cases; photo decoding may differ between JPEG decoders, so photo cases compare with a ±2 per-channel tolerance).
- **Tone patterns** (TS only; the rasteriser writes plain indexes, so Go never needs them) are frozen 8 × 8 bit masks anchored to canvas coordinates (`x & 7`, `y & 7`), so tones line up from frame to frame and don't shimmer:
  - `solid`, `tone12`, `tone25`, `tone50`, `tone75`;
  - `hlines`, `vlines`, `diag`, `diag2`;
  - `dots`, `grid`, `brick`.

  "Off" bits leave the pixel untouched (pen) or not erased (eraser).
- **Rasterising (TS, `flipbook/ink/raster.ts`, integer and deterministic):**
  - **Tips:** a round tip of size d covers the pixel offsets (i, j) in 0…d−1 with `(i + 0.5 − d/2)² + (j + 0.5 − d/2)² ≤ (d/2)²`; a square tip covers all of them. The tip is centred at `floor(x − d/2 + 0.5)`.
  - **Segments:** stamped at every step of a DDA over `max(|dx|, |dy|)` integer steps.
  - **Fill:** 4-connected, over the "sees" boundary map.
  - **Free rotate and scale:** nearest neighbour, with inverse mapping.

  Pinned vectors live in `flipbook/ink/raster.test.ts`.

### 2.5 Time (frozen; `flipbook/timing.ts` and `modules/flipbook/timing.go` share `core/testdata/flipbook-timing.json`)
- **One tick** = `1000 / FPS` ms. Frame `i` starts at `Σ hold[0..i−1]` ticks, and the animation is `Σ hold` ticks long.
- **Cue time** = its frame's start; music plays from 0 with `OffsetMs` into the file.
- **MP4 output rate** = the smallest multiple of FPS that's ≥ 24 (1 → 24, 3 → 24, 8 → 24, 12 → 24, 15 → 30, 24 → 24, 30 → 30). Every frame lasts a whole number of output frames, so the timing is exact.
- **GIF delays** are centiseconds, assigned with cumulative rounding: delay_i = round(end_i) − round(start_i) in cs. The total drift is under 10 ms, and a delay under 2 cs is raised to 2 (browsers clamp smaller ones), so 30 fps GIFs are honest about it (the export sheet says "GIF plays at most 50 fps").
- **Loops (MP4):** repeat the frames N times. Cues repeat on every loop; music continues and is cut at the end.

---

## 3. Design language and layout (bespoke, §0.1)

### 3.1 The look: a sketchbook on a desk
- **Surfaces:**
  - **light:** warm paper (cream-white panels, a faint paper grain from an inline SVG noise in the tokens) on a soft kraft-grey desk;
  - **dark:** deep blue-graphite, with the panels like a lightbox.

  The screens are inset slightly, with a thick rounded bezel (16 px radius) in a single solid colour. No device art, no buttons drawn as hardware.
- **Controls:** chunky and friendly. 36 px hit targets on the trays (28 px compact), a 2 px "ink" outline, and a press that drops 1 px. The accent is the **current ink** (the selected tool glows in it).
- **Icons:** our own small set on a 24 px grid with 2 px rounded strokes, drawn to look hand-inked: pen, eraser, line, bucket, lasso, rectangle select, stamp, eyedropper, onion, reel, hinge layouts, camera, mic, note, loop, hold, ping-pong, light table. They live in `tools/flipbook/ui/icons/`; lucide is used for generic actions.
- **Type:** the app font. Counters and times use tabular numbers, set a little larger (the frame counter is the hero of the hinge).
- **Motion:**
  - the reel tiles flip with a 120 ms page turn when you add, delete or move frames;
  - panels spring open in 150 ms;
  - **never anything on the Stage or Desk canvases**;
  - all of it is off under `prefers-reduced-motion`.
- **UI sounds:** off by default. "Tool sounds" in the flipbook's settings plays kit clicks for pen down, flips and capture, at a low volume.
- **Tokens:** `tools/flipbook/ui/tokens.css` under `[data-design="flipbook"]`, in light and dark: surfaces, bezel, ink outline, accent, onion before/after tints, the hinge, the badge red, the radius scale and the motion curves. No raw colours appear outside it. **Ink and paper colours are document data, not UI colours**, so they're exempt, as Paint+'s canvas colours are.

### 3.2 Layouts
```
Side by side (landscape, default when the area is ≥ 1.3:1)
┌──────────────┬──┬────────────────────────────────┐
│              │  │ tools │                 │ inks │
│    STAGE     │H │ tray  │      DESK       │ size │
│  (≈ 40 %)    │I │       │  (onion skin)   │ tone │
│              │N │       │                 │      │
│              │G │       │                 │      │
├──────────────┴──┴───────┴─────────────────┴──────┤
│ [sound drawer: music + 4 lanes, when open]       │
│ REEL ▢▢▢▣▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢ │
└──────────────────────────────────────────────────┘

Stacked (portrait windows, or chosen)
┌────────────────────────┐
│         STAGE          │
├─HINGE: ⏮ ◀ ▶ ▶ ⏭ 12/48 ─┤
│tools│    DESK    │inks │
├─────┴────────────┴─────┤
│ REEL ▢▢▢▣▢▢▢▢▢▢▢▢▢▢▢▢▢ │
└────────────────────────┘
```
- **The hinge** holds:
  - the transport: ⏮ ◀ ▶/■ ▶ ⏭;
  - the frame counter (click it to type a number);
  - the hold (×n), the speed and loop;
  - toggles for onion, sound drawer and Shoot;
  - the layout switch;
  - the Camera on / Mic on badge.

  In Side by side the hinge is a vertical bar between the screens.
- **Screen sizes:** both screens keep the flipbook's aspect ratio and are centred in their area with the bezel. The Desk scales by whole-pixel steps when it can (Fit picks the largest integer zoom that fits, else the largest fit).
- **Desk only:** the Stage hides and the hinge becomes a slim bar over the reel.
- **Stage in a window:** the `flipbook.stage` part, opened with `popOutPart`. The window shows the Stage edge to edge with a minimal overlay (frame, time, speed) that fades after 2 s; F11 makes it full screen. The main window switches to Desk only, and closing the pop-out restores the previous layout.
- **At 960 × 600 inside Toolbox:**
  - trays compact to icons, and the size/tone/ink pickers become popovers;
  - the Sound drawer overlays the reel instead of pushing it;
  - the shell suggests **Studio mode** (F) with a one-time hint.

  Every control stays reachable.
- **Studio mode** hides the shell's sidebar and top bar (the shared `useUI.studio` flag from Phase 19), with a thin hover strip at the top to return.
- **Rails never scroll.** Bars that run out of room overflow to "More…".

### 3.3 Accessibility
- **The canvases:**
  - the Desk is a focusable element with `aria-label` "Desk, frame 12 of 48, layer Top";
  - the Stage is labelled "Stage, playing" or "Stage, frame 12";
  - frame changes are announced politely, at most every 500 ms.
- **Keys and focus:** every tool, frame action and toggle has a key or a menu item, a tooltip naming its key, and a visible focus ring. The reel is a `listbox` (arrows move, Shift+arrows extend, Enter goes to the frame). Sound cues are focusable buttons (Delete removes, ←/→ move by a frame).
- **Shoot mode** announces captures ("Frame 13 captured").

### 3.4 Built-in palettes and papers (our own)
- **Pencil box:**
  - Graphite `#2a2a2e`, Tomato `#e5533d`, Cobalt `#2f5fd0`, Moss `#4c9a52`;
  - Marigold `#f2b233`, Plum `#8a4fa3`, Sky `#59b7e6`, Chalk `#ffffff`;
  - slots 9–16 hold tints and shades of those (computed once and frozen in `palettes.ts`).
- **The other palettes:**
  - **Two-tone:** Graphite + Tomato, with the rest greyed;
  - **Night:** light inks for dark paper;
  - **Riso:** fluorescent pink `#ff48b0`, blue `#0078bf`, yellow `#ffe800`, teal `#00a95c`, …;
  - **Mono:** greys.
- **Papers:**
  - Cream `#f6f1e3`, White `#ffffff`, Kraft `#c9a878`, Slate `#2b2f36`;
  - Black `#111111`, Mint `#dff3e4`, Blush `#f9e0e0`, Sky `#dcecf8`.

---

## 4. Architecture

### 4.1 Files
```
modules/flipbook/
  module.go       Module, ModuleID "flipbook", Descriptor (Name "Flipbook", icon "book-open",
                  CategoryMedia, OutputSubdir "Flipbooks", Requires none, Recommends deps.FFmpeg)
  document.go     FlipDoc & co, NewDoc, Validate, SpeedSteps, presets
  options.go      JobOptions, ExportOptions, ImportPhotoOptions, ImportVideoOptions, StepOptions (+ defaults)
  service.go      FlipbookService (Wails)
  projects.go     CRUD over core/projectdocs, inks/photos/sounds/music files, Compact, thumbs
  ink.go          .ink codec + the compositor (pure Go)
  timing.go       ticks, cue times, MP4 rate, GIF delays
  export.go       mp4 / gif / png-zip / sheet / package writers; FFmpeg graph builders (pure functions)
  imports.go      photos, video (FFmpeg), package import (zip caps, sanitising)
  stamps.go       <support>/flipbook/stamps.json
  pipeline.go     core.Chainable (§8)
  *_test.go
core/store/migrations/0012_flipbook.sql
core/testdata/flipbook-{ink,composite,timing}.json
frontend/src/flipbook/            engine, no React, no tools/ imports (an architecture test enforces it)
  types.ts                        frozen in Wave 0 (§4.3)
  ink/codec.ts raster.ts patterns.ts fill.ts select.ts stamps.ts
  composite/cpu.ts gl.ts onion.ts         CPU reference (exact) + WebGL2 (R8 index textures + palette LUT)
  frames/cache.ts saver.ts                compressed bytes in memory, decoded LRU, dirty set, save queue
  history.ts                              ink rect patches + structural ops, 200 steps / 256 MB
  timing.ts                               mirror of timing.go
  playback.ts                             AudioContext clock, decode-ahead, frame scheduler
  sound/kit.ts synth.ts wav.ts mixer.ts recorder.ts
  camera/camera.ts capture.ts             getUserMedia lifecycle, privacy timers, cover-fit capture → JPEG
  stamps/builtin.ts                       32 pixel stamps as text art
  palettes.ts papers.ts
frontend/src/tools/flipbook/
  FlipbookView.tsx Shelf.tsx Studio.tsx workspace.ts store.ts commands.ts
  layout/ Stage.tsx Desk.tsx Hinge.tsx Reel.tsx Layouts.tsx
  desk/ tools, trays, selection overlay, zoom/pan, light table
  panels/ Inks.tsx Paper.tsx Layers.tsx Onion.tsx Settings.tsx ExportSheet.tsx Stamps.tsx
  sound/ SoundDrawer.tsx Bin.tsx Lanes.tsx Record.tsx
  shoot/ ShootMode.tsx CameraPicker.tsx Interval.tsx PermissionHelp.tsx
  ui/ tokens.css icons/ Button.tsx Tray.tsx Popover.tsx Badge.tsx Slider.tsx Swatch.tsx …
frontend/src/pipelines/steps/flipbook.tsx   StepUI (+ paramDefs lines)
```

### 4.2 `FlipbookService` (all bound; errors are `*core.AppError`)
```go
Projects() ([]core.ProjectInfo, error)
Create(name string, preset string, w, h, fps int, paper string) (string, error) // preset "custom" uses w, h
Load(id string) (FlipDoc, error)                                    // runs Compact first
Inks(id string, keys []string) (map[string]string, error)           // "<frame>/<layer>" → base64 .ink (≤ 256 keys per call)
SaveInks(id string, inks map[string]string) error                   // "" deletes; ≤ 8 MiB per call
SaveDoc(id, name string, doc FlipDoc) error                         // validates; never deletes files
Close(id string) error                                              // Compact
SaveThumbs(id, thumbJPEG, reelJPEG string) error                    // data URLs
PhotoURL(id, photoID string) (string, error)                        // media URL via MediaService
SavePhoto(id, jpegDataURL string) (string, error)                   // a camera capture, already W×H; returns photo ID; ≤ 8 MiB
ImportPhotos(id string, paths []string, o ImportPhotoOptions) (core.Job, error)
ImportVideo(id string, path string, o ImportVideoOptions) (core.Job, error)
ImportResult(jobID string) (ImportResult, error)
SaveSound(id, name, kind, kitID, source, wavBase64 string) (FlipSound, error) // ≤ 16 MiB, ≤ 60 s, validated WAV header
SoundURL(id, soundID string) (string, error)
SetMusic(id, path string) (FlipMusic, error)                        // copies the file (≤ 200 MB, ≤ 10 min via ffprobe if present, else a header read)
MusicURL(id string) (string, error)
Rename(id, name string) error; Duplicate(id string) (string, error); Delete(id string) error
Export(id string, o ExportOptions) (core.Job, error)
ImportPackage(path string) (core.Job, error)                        // result: the new project ID
Stamps() ([]UserStamp, error); SaveStamp(s UserStamp) (UserStamp, error); DeleteStamp(id string) error
OpenPrivacySettings(kind string) error                              // "camera" | "microphone" → fixed OS settings URI only
```
- **`ImportPhotoOptions`:** `{Fit "cover"|"contain", Sort "name"|"taken"|"given", As "photo"|"guide", Hold int, After string (frame ID)}`.
- **`ImportVideoOptions`:** `{StartMs, EndMs int, Every int (take 1 of N ticks; default 1), As "photo"|"guide", After string}`. The extraction rate is the flipbook's FPS ÷ Every.
- **`ImportResult`:** `{Frames []ImportedFrame{PhotoID, Source string, TakenMs int64}, Skipped []SkippedFile{Path, Reason}}`. When the job is done, the frontend inserts the frames (one undo step).
- **The `flipbook` job module** runs every slow action as one job type, `JobOptions{Action "export"|"import-photos"|"import-video"|"import-package"|"step", Project, Export, Photos, Video, Package, Step}`:
  - all of them are cancellable;
  - imports set `Descriptor.Interactive` (the user is waiting), exports don't;
  - outputs are registered with `OutputFrom(path, sources…)`, where the sources are the imported photo, video, music and sound files that still exist.
- **Photos** are read with `imaging.ToReadable` (HEIC) and `imaging.Orient`, cover- or contain-fitted (padded with the paper colour) to W × H in pure Go (`x/image/draw` CatmullRom), and written as JPEG q92 with no metadata. **Inputs are never modified.**
- **Video** goes through FFmpeg with cwd = TempDir: `-ss/-to`, `fps=<rate>`, `scale=W:H:force_original_aspect_ratio=increase,crop=W:H` (or `decrease,pad`) to `f%05d.png`, then each frame becomes a JPEG photo. A video longer than 999 frames at that rate is refused at validation, naming the longest range that fits.
- **`OpenPrivacySettings`** opens only `ms-settings:privacy-webcam` / `ms-settings:privacy-microphone` on Windows and `x-apple.systempreferences:com.apple.preference.security?Privacy_Camera|Privacy_Microphone` on macOS, through the same opener `FilesService.Open` uses. Any other value is a validation error.

### 4.3 Frontend contracts (frozen in Wave 0: `frontend/src/flipbook/types.ts`)
```ts
export type InkIndex = number;                 // 0..16
export type LayerId = "a" | "b" | "c";
export type PatternId = "solid"|"tone12"|"tone25"|"tone50"|"tone75"|"hlines"|"vlines"|"diag"|"diag2"|"dots"|"grid"|"brick";
export type ToolId = "pen"|"eraser"|"line"|"fill"|"select"|"stamp"|"eyedropper"|"hand";
export interface InkBitmap { w: number; h: number; data: Uint8Array }      // row-major indexes
export interface Tip { size: number; shape: "round"|"square"; pattern: PatternId; pressure: boolean }
export interface InkPatch { frame: string; layer: LayerId; x: number; y: number; w: number; h: number; before: Uint8Array; after: Uint8Array }
export type HistoryOp =
  | { kind: "ink"; patches: InkPatch[] }
  | { kind: "frames"; before: FrameSnapshot; after: FrameSnapshot }   // order, holds, papers, photos, cues
  | { kind: "doc"; before: DocSnapshot; after: DocSnapshot };         // inks, layers, fps, loop, music, sounds
export interface FlipView {                     // FlipDoc.view (JSON)
  layout: "side"|"stacked"|"desk"|"popout"; swapped: boolean;
  onion: { before: 0|1|2|3; after: 0|1|2; opacity: number; tint: boolean; photos: boolean };
  newFrame: "blank"|"copy"|"copy-top"; layer: LayerId; ink: InkIndex; tool: ToolId; tip: Tip;
  fillSees: "all"|"layer"; steady: number; guideOpacity: number; shoot: ShootPrefs; mutedLanes: boolean[];
}
export interface ShootPrefs { deviceId: string; mirror: boolean; grid: boolean; ghost: number; ghostInk: boolean; hold: number; intervalS: number; intervalMax: number }
export interface Compositor {                   // composite/cpu.ts and composite/gl.ts both implement it
  setPalette(paper: string, inks: readonly string[]): void;
  drawFrame(target: "stage"|"desk", f: ComposeFrame, onion?: OnionFrames): void;
  uploadRect(frame: string, layer: LayerId, bmp: InkBitmap, x: number, y: number, w: number, h: number): void;
  readThumb(f: ComposeFrame, width: number): Promise<ImageBitmap>;
  dispose(): void;
}
export interface Camera {                       // camera/camera.ts; a fake implements it in tests
  devices(): Promise<MediaDeviceInfo[]>;
  start(deviceId: string, w: number, h: number): Promise<MediaStream>;  // throws CameraError {code: "denied"|"notFound"|"inUse"|"failed"}
  capture(w: number, h: number, mirror: boolean): Promise<Blob>;       // cover-fit JPEG q0.92
  stop(): void; readonly live: boolean;
}
```
- **The workspace:** `tools/flipbook/workspace.ts` calls `defineWorkspace` with the part `flipbook.stage`. The bridge mirrors `{docRev, frameIndex, playing, playFrom, layout}`. A replica (the popped-out Stage) loads inks and photos itself through `FlipbookService` (by frame ID and `rev`) and never saves.
- **Before a pop-out or an export**, the host flushes pending saves (`useBeforePopOut`).
- **Memory:** the decoded cache budget is 384 MB, with photos counted as decoded `ImageBitmap`s. Playback decodes 30 frames ahead. Thumbnails are cached by `(frameId, rev)`.
- **Rendering:** the GL compositor uploads only the dirty rectangle of a stroke (`texSubImage2D` on an R8 texture) and composites in one pass with a 17-entry palette texture. Without WebGL2 it falls back to the CPU compositor and shows a note when the size is above HD.

---

## 5. Engine details

### 5.1 Drawing input
- **Pointer handling** reuses Paint+'s `attachPointer` (coalesced events, pressure, tilt ignored, palm rejection) and its streamline smoothing for Steady.
- **Pressure:** a mouse always draws at full size; a pen uses pressure when "Pressure sizes" is on.
- **Stroke lifecycle:** a stroke rasterises into the active layer's bitmap as it goes. Its bounding box becomes one `InkPatch` at pointer-up, and the dirty frame/layer is queued for saving.
- **Locked or hidden layers** refuse drawing, with a tooltip-style hint on the Desk ("Top is locked").

### 5.2 Frame cache and saving
- **The cache** keeps every frame's `.ink` bytes compressed in memory (a 999-frame Pocket flipbook is a few MB) and decodes on demand into an LRU.
- **The saver** batches dirty inks (≤ 8 MiB per `SaveInks` call), then calls `SaveDoc`. A failed save keeps everything in memory, retries every 10 s and shows "Not saved — retrying".
- **Thumbnails:** `thumb.jpg` and `reel.jpg` are re-rendered at most once a minute and on close.

### 5.3 Playback
- **The clock** runs on `AudioContext` time (as in the Video Editor). The scheduler maps time to a frame index through `timing.ts`.
- **Sound scheduling:** cues and music are scheduled 200 ms ahead and re-scheduled on seek or loop.
- **The picture** is drawn on `requestAnimationFrame` from the decode-ahead window. A frame that isn't ready yet keeps the previous one (never a blank) and is counted in a dev-only stats overlay.

### 5.4 Shoot mode
- **Starting the stream:** `getUserMedia({video: {deviceId, width: {ideal: W}, height: {ideal: H}}})`, falling back to `{video: true}` on `OverconstrainedError`.
- **Capture:** the current video frame is drawn cover-fitted (mirrored if chosen) to an offscreen canvas of W × H, encoded as JPEG q0.92, sent to `SavePhoto`, and a frame is inserted.
- **The interval timer** captures on a wall-clock schedule (`setTimeout` chained from the target time, so it doesn't drift) and pauses while the window is hidden.
- **The privacy timers** are those of §0.2. The stop is `track.stop()` on every track; the badge reads `camera.live`.
- **Microphone:** `getUserMedia({audio: {echoCancellation: false, noiseSuppression: false, autoGainControl: false}})` → `MediaRecorder` (Opus) → `decodeAudioData` → `wav.ts` (s16le 48 kHz) → `SaveSound`.

### 5.5 The sound kit (`flipbook/sound/synth.ts`, our own)
- **The 24 sounds:**
  - **cartoon:** pop, blip, boing, whoosh, zap, thud, click, ding, buzz, swish, splash, tick;
  - **voices of things:** chirp, rise, fall, wobble, sparkle, bonk, slide;
  - **drums:** kick, snare, hat, clap, shaker.
- **Synthesis:** pure math into a `Float32Array` at 48 kHz (oscillators, pitch and amplitude envelopes, filtered seeded noise), with no WebAudio, so vitest can hash them. Each sound is a frozen recipe in `kit.ts`, and a golden test pins every sound's hash.
- **Placing a kit sound** writes its WAV into the flipbook (`SaveSound` kind `kit`), so exports only ever mix files.

---

## 6. Export (`flipbook` job, `OutputSubdir: "Flipbooks"`)
```go
type ExportOptions struct {
    Format   string // "mp4" | "gif" | "png-zip" | "sheet" | "flipbook"
    From, To int    // frame indexes, inclusive; To -1 = last
    Scale    int    // 1..8; 0 = auto (mp4: the largest integer that fits 1920×1080; gif: the largest ≤ 640 px long side, min 1)
    Pad      string // mp4 only: "" | "16:9" | "9:16" | "1:1" — pad to that shape with the paper colour
    Loops    int    // mp4: 1..20
    Sound    bool   // mp4: default true
    Name     string // base name; default the flipbook's name; templates allowed in the step
}
```
- **Rendering:** every export first composites each frame in range once, in Go, to `TempDir/f%04d.png` at 1×. Scaling is always nearest-neighbour.
- **MP4:**
  - **The picture:** an `ffconcat` file with per-frame durations (from `timing.go`), `-fps_mode cfr -r <MP4 rate>`, `scale=iw*S:ih*S:flags=neighbor[,pad=…:color=<paper>]`, `format=yuv420p`, libx264 CRF 18, `-tune animation` when the frames have no photos.
  - **The sound:** one input per used sound file plus the music. A sound with k cues is split with `asplit=k`, each cue gets `adelay=<ms>:all=1` and `volume=<dB>dB`, then everything is mixed with `amix=normalize=0` and `alimiter=limit=0.95`, as AAC 192k. A cue cut off by the next cue on its lane gets `atrim`.
  - **How FFmpeg runs:** the graph goes in a file run with `-/filter_complex`, and FFmpeg runs with cwd = TempDir (the CLAUDE.md rule).
  - The graph builders are pure functions with table tests.
- **GIF:**
  - **Ink-only** flipbooks are written in **pure Go** (`image/gif`) with the exact palette (paper + used inks ≤ 17 colours) and the §2.5 delays. No FFmpeg is needed and the colours are exact.
  - **With photos:** FFmpeg `palettegen=stats_mode=diff` → `paletteuse=dither=bayer:bayer_scale=3`, with the same delays via `ffconcat`.
  - Loop forever when Loop is on, else play once.
- **PNG frames:** a zip of `0001.png…` at the chosen scale, plus `timing.json` (`{fps, frames: [{file, holdTicks, startMs}]}`).
- **Sprite sheet:** one PNG grid, `cols = ceil(sqrt(n))`, plus `<name>.json` (`{frameW, frameH, cols, frames: [{x, y, durationMs}]}`); both are registered.
- **Flipbook file (`.flipbook`):**
  - a zip of `flipbook.json` (`{"format": "toolbox-flipbook/1", "name", "doc"}`), `frames/**`, `photos/**`, `sounds/**`, `music/**` and `thumb.jpg`;
  - **importing** checks: ≤ 2 GB uncompressed, ≤ 20 000 entries, only those prefixes, sanitised names (no `..`, no absolute paths, no links), the doc validates, and each `.ink`'s size matches. It always creates a new project.
- **Naming:** outputs are `<library>/Flipbooks/<name>.<ext>`, never overwriting (` (2)`). The export sheet shows the predicted size in pixels and the length.

---

## 7. Integration

### 7.1 Packs, shell, library, search
- **Pack:** Media, `{Module: "flipbook", Needs: []string{}}`. Drawing, PNG, sprite, ink-only GIF and `.flipbook` need nothing.
- **Per-feature gates:** MP4, GIF with photos, video import and music length probing show "Needs FFmpeg (Media pack)" with the install button (one `DepsGate`-style banner inside the Export sheet or import dialog, not over the tool).
- **Shell:** the sidebar entry is under Media; `shell/keywords.ts` adds animation, stop motion, flipbook, frame by frame, onion skin, rotoscope, gif, doodle, cartoon. Mod+O adds photos as frames (the `tool.addFiles` command).
- **Palette commands:** New flipbook, Shoot stop-motion, Export flipbook, Play/Stop, New frame, Toggle onion skin, Pop out the Stage.
- **Handoffs** (`useToolHandoff("flipbook", …)`): images become frames (a new flipbook if none is open, after a "Add 12 photos as frames?" confirm), a video opens "From a video", and a `.flipbook` file imports. Send to → Flipbook appears for images, videos and `.flipbook` files.
- **Library and Smart search:** exports show under Flipbooks. Project thumbnails (`thumb.jpg`) are indexed by Smart search like other projects' thumbnails. The Library's project preview plays `reel.jpg` on hover.

### 7.2 Workspaces and privacy
- **Workspace:** everything lives under the workspace's support dir (projects, `flipbook/stamps.json`) and Library. `workspace_isolation_test.go` covers `modules/flipbook`.
- **Hide personal details:** imported `Source` paths are shown through `displayPath`.
- **Exported files carry no metadata** (no location, no device).

### 7.3 Windows and processes
- **Wails options:** the main window's `WebviewWindowOptions.Permissions = {Camera: Allow, Microphone: Allow}`. Pop-outs and the popup keep the defaults.
- **The Stage window** is a normal pop-out (`DesktopService.PopOut`), so the one-process and relay rules hold.

### 7.4 Dev and QA
- **Fake media:** `TOOLBOX_FAKE_MEDIA=1`, only when the run is sandboxed (as `TOOLBOX_DEVTOOLS_PORT`), adds `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream` to `browserArgs`. Chromium then supplies a synthetic camera (a moving test pattern) and microphone (a beep). Real-app checks of Shoot mode and recording use only this.
- **FlipLab is not needed:** the CPU compositor is exact, and goldens come from vitest. A dev-only stats overlay (`?fbstats=1`) shows decode-ahead depth, dropped frames and the last stroke's latency.

---

## 8. Pipeline step (required: every tool is a step)
- **The step:** `flipbook` implements `core.Chainable`, labelled **"Make a stop-motion"**. It accepts images and video (a video is taken as frames, as in "From a video").
- **`StepOptions`:**
  ```
  {Size "pocket"|"classic"|"wide"|"square"|"tall"|"hd"|"fhd"|"source", Fit "cover"|"contain",
   FPS, Hold, Format "mp4"|"gif", Scale, Pad, Loops, PingPong bool, Sort "name"|"taken"|"input",
   Overlay string (a flipbook project ID, "" none), Paper, Name}
  ```
  - `source` takes the first image's size, made even and capped to 1920 × 1080.
  - The defaults are hd, cover, 12 fps, hold 1, mp4.
- **What it does:**
  - `PrepareStep` makes **one job over all the run's images** (merged, as the Video Editor's Assemble does), with no webview needed;
  - frames are fitted in Go;
  - if `Overlay` is set, frame i gets the overlay flipbook's frame `i mod n` ink layers, scaled nearest-neighbour to cover the size;
  - then the §6 exporter runs.
- **Produces:** role `video` (mp4) or `image` (gif). Vars: `{frames}`, `{seconds}`. `Templates: ["/name"]`, defaulting to `Stop-motion {date}`.
- **The `StepUI`:** `pipelines/steps/flipbook.tsx`, with a project picker for Overlay; the `paramDefs` give every option a label.
- **New template "Photo stop-motion"** (Just cool): photos → Make a stop-motion (12 fps, hold 2, loops 3) → Compress to Size (Discord). It uses the next free template number.

---

## 9. Errors and limits
- **Camera errors:**
  - **`denied`:** "Toolbox isn't allowed to use the camera." On Windows the hint is "Turn on *Let desktop apps access your camera* in Windows Settings", with an **Open camera settings** button (`OpenPrivacySettings("camera")`); on macOS "Allow Toolbox in System Settings → Privacy & Security → Camera".
  - **`notFound`:** "No camera found" with Try again.
  - **`inUse`:** "The camera is being used by another app."
  - **`failed`:** the browser's message, plus Try again.

  All of these show inside Shoot mode and never crash the tool. The microphone has the same four, with "Open microphone settings".
- **Storage errors:**
  - **A corrupt `.ink`:** that layer loads empty, the reel tile gets a red corner, and a banner says "Some drawings couldn't be read (N)", with "Clear them". The bad files are renamed to `.ink.bad`, never deleted silently.
  - **A missing photo:** the frame shows its paper with a dashed outline, and the banner offers "Remove missing photos".
- **Limits and what happens at them:**
  - 999 frames: New frame, Capture and imports are disabled with the reason, and an import is cut at the limit (Skipped says why).
  - Sounds: 32, each ≤ 60 s. Cues: 2000. Music: ≤ 10 min and ≤ 200 MB.
  - Size: as §2.1. User stamps: 200.
  - At 1.5 GB a flipbook project warns "This flipbook is large (1.6 GB) — photos take most of it" (no hard cap).
- **Export failures:** an FFmpeg error shows the last 20 log lines in the job log, and the job error names the step ("Mixing the sound failed").
- **Package import errors:**
  - "This isn't a flipbook file";
  - "This flipbook was made by a newer Toolbox" (format version > 1);
  - "Part of this flipbook is missing (frames/…)", which imports what's valid and lists the rest.
- **Missing features:**
  - **No WebGL2:** the CPU compositor is used, with a note at HD and above.
  - **No `MediaRecorder` or `getUserMedia`:** the Shoot and Record buttons are `aria-disabled`, with the reason.

---

## 10. Tests
- **Go:**
  - **`modules/flipbook`:**
    - document validation (every limit, table);
    - `NewDoc` presets;
    - `.ink` codec against the shared vectors;
    - compositor goldens (shared vectors);
    - timing vectors (MP4 rate, GIF cumulative delays, loops);
    - `Compact` (keeps referenced files, deletes the rest, never a file outside the project);
    - atomic saves;
    - the FFmpeg concat file and audio graph builders (table: asplit counts, adelay values, atrim on cut-off, loops, no Windows paths in the graph);
    - pure-Go GIF exact colours and delays;
    - PNG zip and sprite JSON;
    - `.flipbook` round-trip;
    - package import refusals (zip slip, absolute names, links, oversize, unknown prefixes, bad doc, newer format);
    - photo import fit, orientation and HEIC through a fake converter;
    - video import with the fake-FFmpeg re-exec helper (args, cwd, refusal over 999 frames);
    - `OpenPrivacySettings` accepting only the two kinds;
    - `Chainable` (describe, prepare merges into one job, overlay cycling, outputs, vars);
    - **inputs never modified** (hash before and after).
  - **`core/store`:** migration 0012 upgrades a 0011 DB fixture with every existing kind kept.
  - **Root tests:** `TestEveryToolIsAPipelineStep`, the packs test, `workspace_isolation_test.go` and `pipeline_proof_test.go` include `flipbook`.
  - **`main.go` tests:**
    - `browserArgs` adds fake-media flags only when sandboxed with `TOOLBOX_FAKE_MEDIA=1`;
    - the main window options carry the camera/mic permissions, and pop-outs don't.
- **Frontend (vitest):**
  - **The ink engine:**
    - codec against the shared vectors;
    - raster vectors (tips at every size, DDA segments, patterns anchored across frames);
    - fill (sees all / layer, patterns);
    - selection transforms (nearest scale and rotate, flips, paste onto a range);
    - stamps (built-ins in bounds, user stamp round-trip).
  - **The CPU compositor** against the shared composite vectors, with the GL compositor behind an interface tested through a fake GL that records uploads (dirty rect only).
  - **History:** ink patches, structural ops, 200-step and budget drops, undoing a frame delete brings back its inks.
  - **`timing.ts`** against the shared vectors.
  - **Playback scheduler** with a fake clock: frame at time, cue scheduling, loop and seek re-schedule, held frame on a late decode.
  - **Sound:** each of the 24 kit sounds has a pinned hash, is non-silent, peaks ≤ −1 dBFS and lasts ≤ 2 s; the `wav.ts` header round-trips.
  - **Camera and recorder** with a fake `MediaDevices`:
    - start, capture (cover-fit size, mirror);
    - **stops on leaving Shoot mode, on unmount, on `visibilitychange` hidden and after 5 idle minutes**;
    - the badge follows `live`;
    - error mapping to the four codes;
    - the interval timer doesn't drift (fake timers) and pauses when hidden.
  - **UI:**
    - the shelf (cards, hover play off under reduced motion, start tiles, drop routing);
    - layouts (side, stacked, desk, pop-out; auto choice at 1.3:1; 960 × 600 compact trays through the media-query mocks);
    - the hinge counter typing;
    - reel listbox keys;
    - the Sound drawer (drag a cue, lanes monophonic, mute);
    - the Export sheet (FFmpeg gate only on the formats that need it, predicted size);
    - Shoot mode states (denied/notFound/inUse panels with the settings button);
    - `LastExport` actions;
    - the `StepUI` and paramDefs labels.
  - **Architecture:** `src/flipbook/**` never imports `src/tools/**`.
  - **Originality:** `flipbook/originality.test.ts` scans `src/flipbook/**`, `src/tools/flipbook/**` and (via a Go test) `modules/flipbook/**` for `/flipnote|hatena|nintendo|ugomemo|\bdsi?\b/i` in code and strings and fails on any hit.
  - **The every-tool tests** include `flipbook`.

---

## 11. Acceptance (on the Windows PC, a real build, sandbox env)
1. **Drawing core, with nothing installed:**
   - make a Pocket flipbook, draw a 12-frame bouncing ball with "Copy of this frame" and onion skin, set holds, play with Loop, use a pattern fill and a stamp;
   - save, quit, reopen: the pixel hashes of every frame are identical;
   - export a GIF (pure Go, exact colours) and PNG frames, and the sprite sheet.
2. **Feel:** at 1920 × 1080 with a photo on every frame and three inked layers:
   - a 2-minute ink session with a pen shows no gaps, and stroke latency is ≤ 16 ms (stats overlay);
   - flipping is ≤ 16 ms cached;
   - a 300-frame playback at 30 fps drops 0 frames.
3. **Two screens:** each layout at 1180 × 720 and 960 × 600; the Stage popped out onto a second window plays in sync (within one frame) while drawing continues on the Desk; closing it restores the layout.
4. **Shoot with fake media** (`TOOLBOX_FAKE_MEDIA=1`):
   - capture 10 frames by hand and 20 with the interval timer (2 s), and the ghost shows the previous frame;
   - the badge shows while live;
   - the stream stops on leaving Shoot mode, minimising the window and after the idle timeout (checked with a shortened timeout in a dev flag);
   - the captured frames export.
5. **Sound:**
   - place kit sounds on two lanes, record over playback (fake mic), add music with an offset, move a frame with a cue (the cue follows), change the FPS (the cues follow their frames);
   - export an MP4: its audio onsets are within one frame of the cue times (checked by an ffprobe/astats test script on the output).
6. **Photos and video:**
   - "From photos" with 24 demo photos (HEIC included, oriented, cover fit) and drawn sparkles on top;
   - "From a video" as a tracing guide: the guide is visible on the Desk and absent on the Stage and in the export.
7. **Exports:**
   - MP4 auto-scaled to 1920 × 1080 with 16:9 padding, the scaling pixel-crisp;
   - a GIF with photos;
   - a `.flipbook` exported and imported back, identical (doc + every file hash).
8. **Pipeline:** "Make a stop-motion" over a folder of 12 photos with an overlay flipbook gives one MP4 and one GIF; the "Photo stop-motion" template runs end to end.
9. **Standalone checklist** (CLAUDE.md, with no other tool open): result name, path on hover, Reveal/Open/Save a copy, the Library filter, toasts.
10. **Isolation and privacy:**
    - the fs diff after a session shows writes only inside the workspace;
    - no camera or microphone stream is ever live outside Shoot or recording (checked with `navigator.mediaDevices` instrumentation in the dev build);
    - the originality test passes.
11. **QA shots** at 960 × 600, 1180 × 720, 1920 × 1080 and Studio mode, in light and dark (`.dev/p22-qa/`).

---

## 12. Work packages

### Wave 0 — foundation (architect, sequential, on main)
1. **Docs:**
   - **CLAUDE.md:**
     - the camera/microphone rule (§0.2) in App rules;
     - "never open the real camera or microphone while developing" in Safety rules;
     - Flipbook added to "Bespoke tools";
     - a new section "Flipbook (Phase 22)".
   - **The rest:** DECISIONS for the Q defaults; the ROADMAP row; the MAC-CHECKLIST camera/mic items.
2. **Store and plists:**
   - migration `0012_flipbook.sql` and `core.ProjectFlipbook`;
   - the Info.plist usage strings (both plists).
3. **Go contracts:**
   - `modules/flipbook` skeleton: Descriptor; `FlipDoc` & co with real `Validate`/`NewDoc`; options; `FlipbookService` with every method stubbed `NotImplemented`, except `Projects`/`Create`/`Load`/`SaveDoc`;
   - **real** `ink.go` codec and compositor, and `timing.go`;
   - the shared testdata vectors;
   - `Chainable` with real `StepDefaults`/`DescribeStep` and a stub `PrepareStep`.
4. **Wiring:**
   - `main.go`: service, module, the main window `Permissions`, `TOOLBOX_FAKE_MEDIA` in `browserArgs`;
   - packs (Media), `pipeline_proof_test.go`, `packs_test.go`, `catalogFixture.ts`, `shell/keywords.ts`;
   - `tools/index.ts` (a stub `FlipbookView` shelf), `parts/` (the `flipbook.stage` part stub);
   - icons: `book-open` and `mic` exist; register `camera`, `music`, `repeat` and `layers` in `components/Icon.tsx`;
   - the stub `StepUI` and `paramDefs`.
5. **Frontend contracts:**
   - `flipbook/types.ts`;
   - **real** `ink/codec.ts`, `ink/patterns.ts`, `timing.ts` and `composite/cpu.ts` (small, and they pin the shared vectors from both sides);
   - `palettes.ts`/`papers.ts`;
   - the `tools/flipbook/ui/tokens.css` skeleton (names only) and the `ui/` primitives' signatures, so W1 packages can use them.
6. **Spikes** (results in DECISIONS):
   - (a) `getUserMedia` at the app origin in WebView2 with `Permissions: Allow`, using only fake media;
   - (b) `CompressionStream("deflate")` ↔ Go `compress/zlib` round trip;
   - (c) `texSubImage2D` R8 throughput and the compositor pass at 1920 × 1080;
   - (d) `ffconcat` durations + `-fps_mode cfr` giving exact frame timing at 8 and 15 fps;
   - (e) WebView2's `MediaRecorder` mime types (`audio/webm;codecs=opus` expected).
7. **Finish:** regenerate bindings and re-export from `lib/api.ts`. All checks green. Builders branch from here.

### Wave 1 — parallel builders

| Package | Scope | Owns | Needs |
|---|---|---|---|
| **F1 Ink engine** | §2.4 rasteriser, patterns use, fill, selection + transforms, stamps (built-ins + user stamp encoding), GL compositor + onion + guides, frame cache + saver, history, thumbnails, stats overlay | `frontend/src/flipbook/{ink,composite,frames,stamps}/**`, `flipbook/history.ts` | Wave 0 |
| **F2 Time, sound, camera** | §5.3 playback scheduler, §5.4 Shoot + recorder + privacy timers, §5.5 synth + kit + WAV, mixer | `frontend/src/flipbook/{playback.ts,sound/**,camera/**}` | Wave 0 |
| **F3 Backend** | §4.2 service, projects, Compact, imports (photos, video, package), §6 export (all formats, graphs), stamps, §8 step, privacy-settings opener, tests | `modules/flipbook/**` (beyond Wave 0's files), `core/store` migration test | Wave 0 |
| **F4 Studio UI** | §1, §3: the `ui/` kit + tokens + icons, shelf, layouts, Stage, Hinge, Reel, Desk tools and trays, panels (Inks, Paper, Layers, Onion, Settings, Stamps), workspace + Stage pop-out, commands, handoffs, LastExport | `frontend/src/tools/flipbook/**` except `sound/`, `shoot/`, `panels/ExportSheet.tsx` | Wave 0 (fakes until F1/F2 merge) |
| **F5 Sound, Shoot and Export UI** | Sound drawer, bin, lanes, record UI; Shoot mode UI + permission help; Export sheet with gates and predicted size; the `StepUI` | `frontend/src/tools/flipbook/{sound,shoot}/**`, `tools/flipbook/panels/ExportSheet.tsx`, `frontend/src/pipelines/steps/flipbook.tsx` + its `paramDefs` lines | Wave 0 (F4's `ui/` signatures from Wave 0) |

**Order of value:** F1 + F4 + F3 make drawn animation real (acceptance 1–3, 7), and they're merged and checked first. F2 + F5 (Shoot and sound) integrate right after.

### Wave 2 — after Wave 1 merges
- **I1 Integration** (architect):
  - merge, bindings;
  - the real engine in the UI;
  - acceptance §11 1–10 (Shoot and recording with fake media only);
  - the "Photo stop-motion" template;
  - QA shots;
  - the CLAUDE.md final pass.

### Wave 3 — the demo (in the Demo workspace, as you asked)
- **Scene `47-flipbook.mjs`** (A-roll):
  - a new Pocket flipbook;
  - a scripted 8-frame bouncing ball with onion skin and "Copy of this frame";
  - a kit "boing" on the bounce frame;
  - play on the Stage;
  - then "From photos" with 12 demo photos, sparkles stamped across them, and an MP4 export.
- **B-roll `66-broll-flipbook.mjs`:** the Stage popped out and playing full window while the Desk draws.
- **Never Shoot mode or the microphone** (they'd film or record you; §0.2).
- **Leave in `workspaces/demo`:** the two flipbooks (as projects) and their exports in `Library/Flipbooks/`. The footage goes in `Demo Footage/` with the shot list updated, and the rough cut gets the new clip.
- **Privacy:** an OCR and contact-sheet scan of the new clips, as in Phase 21.

### Later
- A pixel-font Text tool.
- Resize or crop a flipbook.
- Send a frame to Paint+ and back.
- In-betweening help: a "half-way ghost" of the frames on either side (no AI). Possibly an optical-flow guide for photos.
- Export as APNG / animated WebP.
- Cut-out stop-motion: put drawn layers *behind* a subject cut out of each photo (Background Remover masks).
- Camera controls through a native capture path (exposure and focus lock).
- Reading the DS app's files: deliberately not planned (§0.3).

---

## 13. Open questions (defaults chosen; change them before approving)
- [ ] **Q1 Name.** **Default: "Flipbook"** (module `flipbook`). It's a plain word for the thing, it isn't anyone's brand, and it's searchable in the palette. Alternatives: "Flip Studio" (too close to the original's name, so I'd avoid it), "Frame by Frame", "Doodle Reel", "Stop-Motion Studio" (also the name of an existing app).
- [ ] **Q2 The ink model.** **Default: crisp indexed pixels, 16 ink slots, 3 layers, no opacity.** It's the DS-era charm and keeps frames tiny and flipping instant. If you want soft brushes in animation, that's a different tool (Paint+ with frames) and a bigger phase.
- [ ] **Q3 Camera and microphone** (§0.2). **Default: allowed in Flipbook only**, under the rules there.
- [ ] **Q4 The bespoke design** (§0.1, §3). **Default: yes**, the "sketchbook on a desk" look.
- [ ] **Q5 Default layout.** **Default: automatic**: Side by side on landscape areas, Stacked on portrait ones. You can pick Stacked to always have the pocket feel.
- [ ] **Q6 Limits.** **Default: 999 frames, up to 1920 × 1080, sounds ≤ 60 s, music ≤ 10 min.**
- [ ] **Q7 Tool sounds** (clicks for pen, flip and capture). **Default: off**, with a toggle.
- [ ] **Q8 Video import default.** **Default: as a tracing guide** (Desk only, not exported), because rotoscoping is the main reason to bring a video into a flipbook. "As photos" is one click away.
- [ ] **Q9 The pipeline step** works on photos only, plus an optional drawn overlay. **Default: yes**; a step can't draw.
