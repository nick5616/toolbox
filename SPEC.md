# Toolbox — Phase 10 Spec: Composable tools

Status: **BUILT 2026-11-04, uncommitted for review** — written and executed overnight on the user's request ("use your best judgement and don't commit any of it, I will test it in the morning"). Nothing is committed to `main`; the result is left as uncommitted changes in `main`'s working tree.
Author: architect session (Opus). Phase 9 (Edit Studio) is archived in `docs/specs/phase-9.md`; every earlier contract still holds unless changed here.

## 0. The brief, in the user's words, and what it means here

> "Composable building blocks that achieve greater outcomes and are all easy to understand. Each tool should be its baseline self, and have an additional composition on top of it in a different variant. Like edit maker and video editor should be one tool composed on top of the other and as its own tool. That will make the UI a whole lot cleaner. Cleaner engineering, cleaner UX, maintainable code, separation of concerns in the UI and the code. In the UI you click into the video to edit it more in-depth, or it pops out. We should support pop outs for each constituent tool."

A follow-up message the same night sharpened it:

> "Go all the way through the video and edit path decoupling these things, expressing the top-level controls of that top-level tool and only that, and hide the rest of the constituent tools in click-in menus that can pop out. Keep the tools really, really clean and minimal. Test it for yourself, take the overall learnings (UX and engineering) and bring them into the entire app. Also make sure each and every tool, even the glue/pipes/junctions, is available in a custom pipeline generator with a UI like ComfyUI: a little tool store you drag and drop tools from and wire them up."

So, on top of the three ideas below: **(4) minimal top-level surfaces**: a tool shows only its own top-level controls; everything that belongs to a constituent lives behind a *click-in* (a launcher that opens a drawer in place, which can pop out into a window); **(5) a node-graph pipeline builder** (§12); **(6) an app-wide sweep** applying the same rules to every tool (§13).

Three ideas, made concrete:

1. **Baselines and variants.** A *baseline* tool is a core that stands on its own. A *variant* is the same core with a composition layered on top, and is still its own tool. The flagship case: **Edit Studio = Video Editor + the music layer.** Both edit the same document; the Video Editor's code never imports the music layer; the music layer plugs into named slots (an `EditorProfile`).
2. **Parts.** Composed tools are built from other tools (*parts*, "constituents"). The UI shows what a tool is built from and lets you open any part — inline, in depth ("click into the video"), or **popped out into its own window**.
3. **Pop-outs.** Any tool can pop out into its own window. Panels of a composed tool (the editor's preview, its inspector) can pop out too and stay live, because the host's state is mirrored into the pop-out through a store bridge.

## 1. Goals

1. One multitrack editor (`frontend/src/editor/`) with two tools on it: **Video Editor** (`video-studio`, baseline) and **Edit Studio** (`edit-studio`, variant). An Edit Studio project opens in the Video Editor and vice versa; a Video Editor project becomes a music edit by picking and analysing a song.
2. The Video Editor works **without a song**: the edit's length comes from its clips; music is an optional bed. It exports through the same GPU render path.
3. **Composition is data**: `Descriptor.Base` and `Descriptor.Parts`. The sidebar nests variants under their base; the top bar shows "Built on" and "Uses" chips; every chip can open or pop out that tool.
4. **Pop-outs everywhere**: every tool view has a Pop out button; the main window shows a placeholder while it's out ("Bring back"). Handoffs (inputs, seeds) work across windows. Files dropped on a pop-out go to that window's tool.
5. **Live panel pop-outs** in the editor: the preview and the inspector can live in their own windows (second monitor) and stay in sync with the editor.
6. **Click into the video**: Edit Studio has a *Music* focus (lanes, sections, recipes) and a *Video* focus (the Video Editor in depth: tracks and inspector big, lanes as one thin strip). Double-clicking a clip or the preview goes to Video focus.
7. **Constituent pop-outs with inputs**: composed tools open their parts with inputs in a window (Post Builder slides in Photo Composer / Sequence Editor; an editor clip in Background Remover or Trimmer).

## 2. Non-goals

- No document migration from the old sequence editor (`video-editor`, kind `video`) to edit projects. The old editor stays (renamed **Sequence Editor**, hidden from the sidebar) because Post Builder's video slides and Quick vlog depend on its FFmpeg pipeline. The Video Editor's home links to it.
- No new tools, models or dependencies. No network listeners (pop-outs are Wails windows and Go events).
- No cross-window drag and drop of clips. No persisted window positions across launches (this session only).
- No change to the Visualizer/Lyric Video/Subtitles engines; their composition is metadata + chips + pop-outs.

## 3. Composition model (FOUNDATION, done)

`core.Descriptor` gains:

```go
Base  string   `json:"base"`  // the baseline this tool is a variant of ("" = baseline)
Parts []string `json:"parts"` // constituent tools, display order; never includes Base; never nil on the wire
```

| Tool | Base | Parts |
|---|---|---|
| Video Editor `video-studio` (new) | — | bg-remover |
| Edit Studio `edit-studio` | **video-studio** | visualizer, stems, transcribe, bg-remover |
| Subtitles `subtitles` | **transcribe** | trimmer |
| Post Builder `post-builder` | — | photo-composer, video-editor (Sequence Editor), bg-remover |
| Photo Composer `photo-composer` | — | bg-remover |
| Visualizer `visualizer` | — | stems, bpm-key |
| Lyric Video `lyric-video` | — | stems, transcribe, visualizer |

- `video-studio` is registered by `editstudio.Register` as `VideoModule`, a wrapper that runs Edit Studio's jobs (same `Validate`/`Run`). It's in the **Media** pack (needs FFmpeg only).
- The old `video-editor` module is now **"Sequence Editor"**, `Hidden: true`, Order 16. Its view still opens by id (Post Builder handoffs, the Video Editor home).
- `core.ProjectInfo.Flags []string`: edit projects report `"music"` (has a song) and `"music-edit"` (song + analysis). `projectdocs.Docs.Flags` fills it.

## 4. Windows, parts and the store bridge

### 4.1 Go (FOUNDATION, done: `core/windows.go`, `desktop/windows.go`, `api/desktop.go`)

`DesktopService` methods (bindings generated):

| Method | Does |
|---|---|
| `PopOut(req PopOutRequest)` | Opens a framed, resizable window loading `/?<query>&key=<key>`, or shows/focuses it if open. A non-empty `Handoff` is kept for `TakeHandoff`; for an open window `windows:handoff {key}` is emitted. ≤ 12 pop-outs. |
| `CloseWindow(key)` / `FocusWindow(key)` | `FocusWindow("main")` shows the main window. |
| `OpenWindows() []string` | Open pop-out keys (also pushed as `windows:changed {open}`). |
| `TakeHandoff(key) string` | The waiting handoff JSON, once. |
| `Relay(WindowRelay)` | Fans `{channel, from, to, payload}` out as `windows:relay` to every window. Payload ≤ 8 MiB, opaque to Go. |

Keys: `tool:<moduleId>` or `part:<partId>[@<instance>]` (`[a-z0-9._-]`). Query must start with `window=tool&` or `window=part&` and may not contain `key=`. Files dropped on a pop-out arrive as `app:files-dropped` with `window: <key>` (main = `""`). Window bounds are remembered per key for the session.

### 4.2 Frontend contract (FOUNDATION, done: `lib/windows.ts`)

`currentWindow()` → `{kind: "main"|"tool"|"part"|"popup"|"vizlab", key, view, part, params}`; `popOutTool(moduleId, opts)`, `popOutPart(partId, opts)`, `closeWindow`, `focusWindow`, `takeWindowHandoff()`, `relaySend(channel, payload, to?)`, `relayOn(channel, cb)` (ignores its own messages and ones addressed elsewhere).

### 4.3 Tool windows (WP-W1)

- **`App.tsx`** routes by `currentWindow().kind`: `main` → today's MainWindow; `tool` → `ToolWindowShell`; `part` → `PartWindowShell`; `popup`/`vizlab` unchanged.
- **Bootstrap per window kind** (`state/bootstrap.ts`): tool and part windows run the full data bootstrap (jobs, library, deps, settings, modules) but:
  - only the main window handles `app:navigate` and `app:hidden-to-tray`;
  - `app:files-dropped` is routed only by the window whose key equals `drop.window` (main ⇔ `""`); in a tool window a drop hands off to that tool;
  - only the main window shows job toasts (`useJobToasts`) and mounts `RenderHost` (the export worker) — the render broker must see exactly one host.
- **`useUI` persistence** (`toolbox.ui` in localStorage, shared by all windows of the origin) is written only by the main window. A tool window's initial view is its `view` parameter.
- **`ToolWindowShell`**: a slim top bar (tool icon + name, `<CompositionBar>`, and a **Bring back** button = `DesktopService.ShowMain(view)` then `closeWindow(myKey)`), the tool view (ErrorBoundary + Suspense, same `toolViews`), `JobTray`, `Toaster`, `TooltipLayer`, `DropOverlay`. No sidebar and no command palette. On start it calls `takeWindowHandoff()` and, if it's a Handoff for this tool, `useUI.getState().handOff(h)`; it does the same on `windows:handoff` for its key.
- **Main window — Pop out button**: the top bar shows an `IconButton` (icon `picture-in-picture-2`, label "Pop out", tip "Open this tool in its own window") for module views (not library/settings/pipelines/gallery). It awaits `runBeforePopOut(view)` (below), then `popOutTool(view, {title: "<Name> — Toolbox"})`.
- **`runBeforePopOut` / `useBeforePopOut(moduleId, fn)`** (`lib/popout.ts`): tools register async flushers (the editor registers `flushEdit`). The shell awaits them (max 3 s) before popping out.
- **Placeholder**: while `tool:<id>` is open — or the tool of the same **family** (base + its variants: `video-studio` ⇔ `edit-studio`, because they share one document store) — the main window renders `PoppedOutPlaceholder` instead of the tool: EmptyState "<Name> is open in its own window" with **Show window** (`focusWindow`) and **Bring back** (`closeWindow`; the tool mounts again when `windows:changed` drops the key).
- **`state/windows.ts`**: a zustand store `{open: string[]}` loaded from `OpenWindows()` and kept by `windows:changed`; hooks `useWindowOpen(key)`, `useToolPoppedOut(moduleId)` (family-aware, via `useModules` descriptors' `base`).
- **Sequence**: pop out → main unmounts the tool (placeholder) → new window bootstraps and opens the tool, which reopens its last project from module state (the flusher saved it). Bring back → reverse.

### 4.4 Parts (WP-W1 implements; any package defines parts)

Types are in `parts/types.ts` (FOUNDATION). WP-W1 adds:

- `parts/registry.ts`: `definePart(spec)`, `getPart(id)`, `listParts()`.
- `parts/index.ts`: imports each tool's `parts.ts` for side effects (`tools/<tool>/parts.ts` or `editor/parts.ts`). W1 ships it with no imports but the comment; E3 adds the editor's.
- `parts/PartFrame.tsx`: `<PartFrame part="<id>" instance? params? chrome="overlay"|"header">{children}</PartFrame>`. Inline it renders children plus a pop-out IconButton (overlay: top-right, visible on hover/focus; header: a 28 px header with title + button). Clicking pops the part out (`popOutPart`, size from the spec, `params` added to the URL, plus `view=<current tool>`). While that part window is open it renders a compact placeholder (icon, "Open in its own window", **Show**, **Bring back**) instead of children.
- `shell/PartWindowShell.tsx`: full bootstrap, then `spec.connect?.(params)` (await), then renders `spec.component` with `placement="window"` (ErrorBoundary, Suspense, Toaster, TooltipLayer), with a slim title bar (part title + "Bring back" = `closeWindow(myKey)`). Unknown part → EmptyState. When the bridge reports `lost` (host gone), show a Banner "The <host> window closed this panel's project" and stop rendering the part.

### 4.5 Store bridge (WP-W1: `state/bridge.ts`)

Generic mirroring of a zustand store from a host window into replicas in other windows.

```ts
export interface BridgeSpec<S, V extends Record<string, unknown>> {
  name: string;                         // channel "bridge:<name>"
  pick(state: S): V;                    // host: the shared values (each key compared by reference)
  apply(store: StoreApi<S>, values: Partial<V>): void; // replica: write received values
  actions: readonly (keyof S & string)[]; // replica calls these → run on the host
}
export interface BridgeTransport { send(payload: unknown, to?: string): void; on(cb: (payload: unknown, from: string) => void): () => void; }
export function hostBridge<S, V>(store: StoreApi<S>, spec: BridgeSpec<S, V>, transport?: BridgeTransport): () => void;
export function replicaBridge<S, V>(store: StoreApi<S>, spec: BridgeSpec<S, V>, opts?: { transport?: BridgeTransport; onStatus?(s: BridgeStatus): void }): () => void;
export type BridgeStatus = "connecting" | "live" | "lost";
export function useBridgeStatus(name: string): BridgeStatus | "none";
```

Protocol on `bridge:<name>` (default transport = `relaySend`/`relayOn`):
- replica → host `{t:"hello"}` on start and every 2 s until a snapshot arrives;
- host → that replica `{t:"snap", seq, values}` (all of `pick`);
- host → all `{t:"patch", seq, values}` with only changed keys, coalesced to at most one per 16 ms; nothing is sent while no replica has said hello (replicas are dropped when their window closes, from `windows:changed`);
- replica → host `{t:"call", action, args}` — the replica's listed actions are replaced by forwarders; the host runs `store.getState()[action](...args)` only for listed actions;
- host → all `{t:"bye"}` on dispose (replica status `lost`).
Values and args must be JSON-serialisable (no Maps, typed arrays, functions). Tests use a fake in-memory transport (two stores, one host, two replicas, patch coalescing with fake timers, action forwarding, bye).

## 5. The editor: Video Editor as the base, Edit Studio on top

### 5.1 Layout (FOUNDATION: the move is done)

```
frontend/src/editor/          the Video Editor core (moved from tools/edit-studio/)
  store.ts doc.ts geometry.ts useEditAutosave.ts useEditData.ts profile.ts (contract)
  timeline/ sources/ inspector/ overlays/ matte/ text/ visual/ export/ transport/ home/
  EditorShell.tsx (+ .module.css)   WP-E1
  focus.ts                           WP-E1
frontend/src/tools/video-studio/    VideoEditorView.tsx + profile.ts (WP-E1)
frontend/src/tools/edit-studio/     the music layer only: EditStudioView.tsx, profile.tsx,
                                    lanes/ setup/ beatsync/ autofill/ sectionstyle/ moments/ captions/
                                    (+ song/ for the moved SongInspector/SongTrack if E1 moves them)
```

**Rule (enforced by a test, WP-E1):** nothing under `src/editor/` imports from `src/tools/edit-studio/` (or any `src/tools/`). The music layer reaches the editor only through `EditorProfile` (`editor/profile.ts`). The store keeps the analysis and the derived markers as *render inputs* (an Edit Studio project opened in the Video Editor must render identically), but no editor UI reads markers except through profile slots.

### 5.2 Shared store, two lenses

`useEditStudio` (editor/store.ts) is one store per window. Both tools render it: navigating Edit Studio → Video Editor keeps the open project open; "back to all" closes it for both. Each tool still remembers its own `lastProjectId` (module state) for cold starts.

### 5.3 EditorShell (WP-E1)

`EditorShell({ moduleId, profile })` is today's `EditStudioView` + `Editor` generalised:

- Routes projects home ↔ editor (open, reopen last, handoff) exactly as today, passing `profile` to `ProjectsHome`.
- Header: back, name, save state, `profile.HeaderStart`, spacer, undo/redo, `profile.HeaderEnd`, More (profile items + "Open in <other tool>"), Export.
- Panels: Sources | Preview | right panel (Inspector + `profile.rightTabs`). Bottom: Transport + timeline (`profile.TimelineTop` above the tracks, then tracks). Setup replaces the bottom only for `song: "analyzed"` profiles when `!project.song || analysisState !== "ready" || setupOpen`.
- **Focus** (`editor/focus.ts`, its own small zustand store `{focus: EditorFocus, setFocus}`): profiles with a `TimelineTop` show a header SegmentedControl **Music | Video** (tips: "Song, markers and recipes" / "The video in depth: tracks, clips and effects"). *Video* focus: the timeline area gives the tracks the room (lanes render compact: `TimelineTop` receives `focus`), the right panel switches to the Inspector, and a breadcrumb "Edit Studio › Video" with a back arrow appears left of the name. **Double-click on a clip or on the preview** enters Video focus; **Esc** (when no dialog, menu or text input has focus) returns to Music. The Video Editor profile is always in video focus (no control).
- **Open in the other tool** (More menu): `flushEdit()`, write the other tool's `lastProjectId` module state, `navigate(otherModuleId)`. Labels: "Open in Video Editor" / "Open in Edit Studio" (the latter tip: "Add the song layer: markers, beat sync and recipes").
- Registers `useBeforePopOut(moduleId, flushEdit)` once W1's `lib/popout.ts` exists — W1 and E1 run in parallel, so E1 **creates `lib/popout.ts` only if absent at merge**; to avoid conflict, **W1 owns `lib/popout.ts`** and E1 calls it after Wave 1 integration (the architect wires the one call).
- Music bed (Video Editor): a song row in the timeline with **Add music** (file picker for audio; the song's duration from `EditStudioService.Probe`), and a music inspector (range start/end within the song, gain, fade in/out, Remove music). Adding music sets `song = {path, startMs: 0, endMs: min(duration, max(clipsEnd, 1000), 600000)}` (if no clips: `min(duration, 600000)`). Edit Studio's profile replaces the song inspector with its own (`profile.inspector.Song`).
- **Timeline length without a song**: the tracks show `max(editLength + 30 s, 60 s)` of room so clips can be dropped past the end; the end marker follows the last clip.
- Profile slots replace today's direct imports: TracksPanel → `ClipOverlay` (moments), clip menu items (CutButton/section style), `useSnapTargets` (markers); inspector → `ClipExtras` (HitOn, VelocityControl, MomentsSection), `Song`, `Markers`; transport/commands → profile `useCommands` / `moreItems` (export markers/SRT); EditSignalSelect offers `marker.*` signals only when `profile.markerSignals`.

### 5.4 Song-optional data, engine and export (WP-E2)

- `editLength(p)` (viz/edit/types.ts): song ? `song.endMs − song.startMs` : `max(1000, last clip end over all tracks)` (0 clips → 1000). Go mirrors it (`editLen(doc)`); both are tested with the same cases (a table in each).
- **Empty analysis**: `emptyAnalysis()` (viz/edit, new) returns an `Analysis` whose curves read 0 at any time and which has no events, beats, sections, chords or words. `useEditInputs` returns inputs whenever the project is open and its sources resolve: `analysis ?? emptyAnalysis()`, markers `[]` without an analysis. A song without an analysis is just audio.
- `useEditData`: loads the analysis only when `analysisKey` is set; otherwise `analysisState = "none"` and no Setup is forced (the shell decides by profile).
- Timeline ops (`timeline/ops.ts`): never clamp clip placement to `editLength` when there's no song (the length follows the clips).
- **Go** (`modules/editstudio`):
  - `validateDoc`: a song is optional; if present its file must exist. The analysis is required only when `AnalysisKey != ""` (then it must be cached, as today). Visible-clip check uses `editLen`.
  - Render plan: `StartMs/EndMs` = song range, or `0..editLen` without a song. Without an analysis the plan's `Analysis` is the zero `AnalysisRef` and the edit worker uses `emptyAnalysis()` (`viz/edit/worker.ts`). Check `core/viz` plan validation accepts it (change it additively if not).
  - Audio mix: without a song, the base is silence (`anullsrc=r=48000:cl=stereo`, length D) plus clip audio; with a song, as today.
  - **Job attribution**: `Service.submit` files a job under `video-studio` when the project has no `AnalysisKey` and the action isn't `analyze`/`text`; otherwise under `edit-studio`. (The job tray then says "Video Editor — Export" for plain videos.)
- **Home** (`editor/home/`, `ProjectsHome` with `profile`):
  - Video Editor: all edit projects, newest first; a **Music edit** badge for `music-edit` projects; **New video** opens a dialog (name, aspect, fps 30/60, optional files to add as clips one after another on track 1 — images 3 s each; audio files become the music bed) — no song required. Below the grid, an **"Older sequence projects"** section listing `VideoEditorService.List()` (kind `video`) with Open (sets the Sequence Editor's last project the way that view expects and navigates to `video-editor`) and a **Quick vlog…** button that opens the Sequence Editor's Quick vlog dialog (via a handoff or module state — whatever that view already supports; add the smallest hook needed in `tools/video-editor/` if none exists).
  - Edit Studio: `music-edit` projects first; other edit projects in a collapsed "Videos without a song analysis" section whose Open opens them in Edit Studio (Setup then asks for the song). New edit = today's NewEditDialog.
  - Handoffs (`home/handoff.ts`): Edit Studio unchanged; Video Editor: files → new video with those files (as above).

### 5.5 Minimal surfaces, click-ins and panel pop-outs (Wave 2: WP-E3 layout, WP-E4 windows)

Checked in the real app after Wave 1: both tools work on the same project, but each screen still shows everything at once (Sources grid with tag chips, a permanent inspector, transport with lane/cut-offset controls, a toolbar of add buttons), and the Video Editor still shows music controls (Lane, Cut offset, Visual). The user's rule: **the top level shows only the top-level tool's controls; constituents live in click-ins that can pop out; really clean and minimal.**

**Panels** (`editor/panels.ts`, contract): every constituent surface is an `EditorPanel` (id, title, icon, tip, component). A panel reads only the store/profile (no props), so it renders the same in a drawer and in its own window. Inline: `<ClickIn part={panelPartId(moduleId)} params={{ panel: id }} …>`. Popped out: part `<moduleId>.panel` with `?panel=<id>` (WP-E4).

**Video Editor (baseline) — top level only:**
- Header: ← · name · quiet save state | spacer | undo · redo · ⋯ · **Export**. Nothing else.
- Centre: the **preview**, as large as the space allows, wrapped in `<PartFrame part={previewPartId(moduleId)} chrome="overlay">` (pop out to a second screen).
- Left: a slim **rail** of icon click-in launchers (`variant="icon"`, label under the icon, ≤ 56 px wide): **Media** (the sources panel; badge = count), **Text** (add a title/text clip; styles), **Music** (music bed: Add music / range / gain / fades), **Project** (aspect, fps, background, look, export size). Profiles add rail items.
- Bottom: a minimal transport (play/pause, time, zoom −/+, Fit, Snap) and the tracks. Track adding collapses into one **+** menu (Track, Adjustment track, Text; Visual only with `markerSignals`).
- **Selection bar**: when clips are selected, a compact bar (above the tracks or under the preview) with the clip's name and its few top-level controls (volume for video, a speed preset 0.5×/1×/2×, Fit, Delete) plus click-in launchers (`variant="row"` compact chips with summaries) for its constituents: **Transform**, **Effects** (n), **Masks** (n), **Cut-out** (status), **Speed** (ramp/velocity), **Transition**, **Text style** (text clips), **Visual** (visual clips), and profile extras. No permanent inspector column; the old InspectorPanel sections become these panels.
- Nothing music-related at all in the Video Editor profile: no Lane select, no Cut offset, no marker signals, no Visual layers.

**Edit Studio — Music focus top level:**
- Header: ← · name · save | **Music | Video** · song chip (file name → Song click-in) · undo · redo · **Auto-fill** · ⋯ · **Export**.
- Centre preview (same PartFrame). Rail: Media, **Song** (range, analysis, re-analyse), **Markers** (lanes visibility/threshold/nudge, active lane, cut offset — all that left the transport), **Captions**, **Style** (section styles), Project.
- Bottom: transport + the song lanes and section bands shown prominently, tracks compact (thin rows).
- **Video focus** = exactly the Video Editor surface (+ a one-line marker strip), with Edit Studio's clip extras (Hit on, Velocity, Moments) as extra click-ins in the selection bar.

**WP-E4 (windows):** `editor/bridge.ts` (BridgeSpec per §4.5: pick = projectId, name, project = history.present, undo/redo depths, saveState, selection, playheadMs, playing, activeLane, snap, pps, scrollMs, rightPanel, safeZones, analysisRef, analysisState, sources, mattes, interps, urls, dialog, + focus store; apply builds history {past: [], present, future: []}; actions edit, undo, redo, select, setPlayhead, setPlaying, setActiveLane, setSnap, zoom/scroll setters, openDialog, setSafeZones, setName), the host started by EditorShell while a project is open, replica mode for `useEditData` (loads analysis/sources locally from the replicated refs, never submits jobs), and the part factory `editor/editorParts.tsx` `makeEditorParts(moduleId, profile)` registering `<moduleId>.preview` (EditCanvas + overlays + mini transport, 960×600) and `<moduleId>.panel` (renders `getEditorPanel(params.panel)` inside `EditorProfileProvider`, 380×720 or the panel's size), called from `tools/video-studio/parts.ts` and `tools/edit-studio/parts.ts` (imported by `parts/index.ts`). In part windows space/arrow keys forward to the host (play/pause, frame step); undo/redo shortcuts forward too.

### 5.6 Job attribution and outputs

Both tools write exports to `<library>/Edits`. Analysis and text exports stay Edit Studio's.

## 6. Composition in the shell (WP-C1)

- **Sidebar** (`shell/Sidebar.tsx`, `shell/nav.ts`): a ready, visible module whose `base` is a ready, visible module is listed directly under its base, indented with a thin connector, slightly smaller label. Rail mode: variants follow their base with a small corner badge. Mod+1..9 follow the visual order. `NavItem` gains `variantOf?: string`.
- **CompositionBar** (`shell/CompositionBar.tsx`, rendered by Shell and ToolWindowShell next to the title): for module views:
  - "Built on" chip for `base` (icon + name);
  - "Variants" chips for visible modules whose base is this one (e.g. the Video Editor shows "Edit Studio");
  - "Uses" chips for `parts` (hidden parts like the Sequence Editor show too).
  - Click = navigate (in a tool window: `DesktopService.ShowMain(id)`); each chip has a pop-out affordance (Shift+click, and a small icon button on hover) = `popOutTool(id)`. Tooltips say what happens. Below `NARROW_QUERY` chips are icon-only with the name in the tooltip; the bar never wraps the title.
- **Command palette** (`shell/useBuiltinCommands.ts`): for every visible tool, "Open <Name> in its own window".
- Composition helpers in `state/composition.ts`: `variantsOf(id)`, `familyOf(id)` (base + variants), `partsOf(id)`, used by Sidebar, CompositionBar and W1's placeholder (W1 may import it after merge; until then W1 computes the family inline from descriptors).

## 7. Constituent pop-outs with inputs (WP-P1, Wave 2)

- `lib/openTool.ts`: `openTool(moduleId, handoff?, { window?: boolean })` — in the main window without `window`: `useUI.handOff` / `navigate`; with `window: true` (or from a tool window): `popOutTool(moduleId, {handoff})`.
- **Post Builder**: a slide's Edit action gets "Edit in its own window" (Photo Composer / Sequence Editor with the `postSlide` handoff). Post Builder refreshes the slide's visual when that window closes (`windows:changed`) and on window focus.
- **Editor clip context menu**: "Open in Background Remover" (image clips), "Open in Trimmer" (video clips), each with an "…in its own window" variant.
- **Library**: the Send to menu gets "in its own window" variants (or a modifier) for tools.
- Photo Composer, Visualizer, Lyric Video, Subtitles: their CompositionBar chips cover it; add a pop-out variant wherever a tool already hands off to another (`handOff(` call sites) when cheap.

## 7b. Click-ins (WP-W1 builds the primitive; E3 and the sweep use it)

`components/ClickIn.tsx` (exported from `components/index.ts`):

```tsx
<ClickIn icon="sparkles" title="Effects" summary="2 on this clip" tip="Effects on the selected clips" part="editor.effects" params={{}}>
  {content}
</ClickIn>
<ClickInHost>{tool layout}</ClickInHost>   // the area drawers slide over (a tool's root); default: the nearest host
const { open, close, isOpen } = useClickIn(); // open(id) programmatically; a ClickIn's id defaults to its part or title
```

- Closed, it renders a compact launcher: a row (`variant="row"`, default: icon, title, muted summary, chevron) or an icon button (`variant="icon"`, title in tooltip). A `badge` prop shows a count.
- Open, the content renders in a **drawer** over the right side of the nearest `ClickInHost` (width 360 px default, `width` prop; full height of the host; slides in 120 ms; respects `prefers-reduced-motion`), with a header: icon, title, **Pop out** (only when `part` is set and registered; pops the part via `popOutPart` with `params`, then closes the drawer) and Close. Esc, the close button or a click in the host outside the drawer closes it. One drawer open per host. Focus moves into the drawer and back to the launcher on close.
- While the part's window is open, the launcher shows a window glyph and clicking it focuses that window.
- Works at 960 × 600 (the drawer caps at 90 % of the host width).

**UX rules for every tool (the learnings applied app-wide, §13):**
1. The top level shows the tool's job: its input, its one or two primary settings, its preview/result and its primary action.
2. Everything else is a click-in, grouped by the constituent it belongs to ("Effects", "Cut-out", "Speed", "Advanced"), with a one-line summary of its current state so nothing is hidden silently.
3. A click-in that edits live state can pop out (it's a part, bridged); a click-in with a few fields doesn't need to.
4. Composite tools link to their parts (CompositionBar) instead of duplicating their UI.
5. No control appears twice on one screen.

## 8. Error handling

- PopOut failures (too many windows, invalid key) toast the AppError message.
- A part window whose host isn't there (no hello answer in 6 s) shows "Open <tool> in the main window first" with a button that focuses main.
- A tool window bootstrap failure shows BootError as the main window does.

## 9. Tests

- Go: `core/windows_test.go` (done), `modules/editstudio/base_test.go` (done); E2 adds `editLen`, no-song validate/plan/mix-graph tests.
- Frontend: bridge (fake transport), windows identity parsing, popout placeholder + family, ToolWindowShell drop/handoff routing, Sidebar nesting, CompositionBar chips, editor architecture test (no imports from tools/), EditorShell with both profiles (Video Editor without song shows the editor, not Setup; Edit Studio without analysis shows Setup), focus switching, emptyAnalysis, editLength cases, home per profile.
- `go build ./... && go vet ./... && go test ./...`, `gofmt -l .` (repo files), `cd frontend && npm run check`.

## 12. Node-graph pipeline builder (WP-N1)

A ComfyUI-style canvas over the existing pipeline model; no runner changes required.

- **Mapping.** A node per step plus one **Input** node (the files a run starts with). Each step node has one input port and one output port per `StepProduct` (role) from its `StepCheck.info.produces`, plus an "all files" port. A wire from a role port into a step sets `from` = that step and `filter.roles = [role]`; from the "all" port clears roles; from Input sets `from: "input"`; an unwired `NoFiles` step has `from: "none"`. Every step has at most one incoming wire (the model's rule); an output port may fan out to many steps (branches). Steps are saved in topological order (`from` must reference an earlier step).
- **Layout** is saved in `Pipeline.layout` (FOUNDATION, done; ≤ 32 KiB). Nodes without a position get an automatic layered layout (left to right by depth).
- **Tool store**: a left panel listing every step type in the catalog (modules + built-ins rename, chat, table, zip, copy, check: the glue), grouped by category, searchable, icon + one line. Drag onto the canvas to add, or double-click the canvas for a quick-add search. Tools that aren't steps (creator tools, clipboard, vault, …) are listed in a "Not available as steps" group, disabled, with the reason, unless the runner can support them cleanly as manual steps (decide by reading `core/pipeline`; record the decision).
- **Canvas**: pan (drag empty space, middle button, wheel), zoom (Ctrl+wheel, buttons, fit), select (click, Shift-drag box), move, Delete, Mod+D duplicate, bezier wires coloured by file kind. Invalid connections (a step that can't accept that kind, per `pipelines/compat.ts`) are refused with a tooltip. Node body: icon, label, summary, problems in red, and an options button opening the existing step options UI (`frontend/src/pipelines/steps/*`) in a side drawer.
- **Integration**: PipelineEditor gets a **List | Graph** switch (Graph default; remembered). Both edit the same `Pipeline`; save, run, watch folder and templates work unchanged. While a run of the pipeline is active, nodes show live status counts.
- Pure logic (`graphModel.ts`: pipeline ⇄ graph, topo sort, connect validation, auto layout) is table-tested; the canvas gets interaction tests. No new dependency: SVG wires + positioned DOM nodes, CSS Modules + tokens.

## 13. App-wide sweep (Wave 3)

### 13.1 What the editor path taught (checked in the real app, 2026-11-04)

UX:
1. **One job per screen.** The top level is: the tool's input, its one or two primary settings, the preview/result, and the primary action. The Video Editor went from five dense regions to header + rail + preview + one-line bar + tracks, and nothing was lost — everything moved into panels.
2. **Click-ins carry a summary.** A launcher says what's inside right now ("2 effects", "Cut-out ready", "Watching Inbox", "no runs yet"), so hiding a control never hides its state.
3. **Bars never wrap.** A toolbar/selection bar is one line; measure its width (`useElementSize`) and send what doesn't fit to a "More…" menu. Wrapping chips pushed the timeline off screen in testing.
4. **Rails never scroll.** Icon rails use compact items (≈44 px, small label) and an overflow "⋯".
5. **Names, not paths.** Show a file's name (ellipsized); the full path goes in the tooltip.
6. **No duplicate headers.** A page title plus an inner editor title with the same words (Pipelines) is noise; keep one.
7. **Big canvases get the room.** When a tool is a canvas (pipeline graph, editor preview), side lists collapse to a switcher.
8. **Composites link to parts.** Use the CompositionBar and `openTool(moduleId, inputs, extra, {window})` (`lib/openTool.ts`, or `openToolItems` for menus) instead of re-implementing a constituent's UI; every hand-off can also open in its own window.

Engineering:
1. **Composition by slots and registries**, not imports: profiles (`EditorProfile`), panel registries (`registerEditorPanel`), part registries (`definePart`). A test enforces the dependency direction (`editor/architecture.test.ts`).
2. **Panels take no props**: they read their state from a store, which makes them render the same inline, in a drawer and in a pop-out window over the store bridge.
3. **Pop-out-able state lives in a zustand store** with serialisable values; component-local state can't be bridged (the pipeline editor's draft couldn't be popped out for this reason).
4. **WebGL in React**: never `loseContext()` on dispose when the canvas element can be reused (StrictMode remounts painted a canvas white).

### 13.2 Rules for each tool in the sweep

- Apply §7b and 13.1. Keep every capability — move, don't delete. Each builder reports, per tool, a short before → after list ("Advanced options → Advanced click-in (summary: 'MP3 · 320k')").
- File tools (`_kit/FileToolLayout`): the kit gets an `advanced` slot rendered as one **Advanced** ClickIn row with a summary (`summary` prop) and a `primary` slot for the 1–2 options shown at the top level; tools move their secondary options into it.
- Where a tool hands files to another tool, use `openTool`/`openToolItems` so "…in its own window" is offered.
- Tools that are workspaces register their side panels as parts only when their state is already in a store (don't refactor state just for pop-outs in this wave).
- Screens must work at 960×600; check by reasoning about widths; screenshots of today's state are in `.dev/p10-qa/shots/all-<moduleId>.png`.

## 10. Work packages

| WP | Wave | Owns | Depends on |
|---|---|---|---|
| **W1** windows + parts + bridge + ClickIn | 1 | `components/ClickIn.*` (+ its export in `components/index.ts`), `App.tsx`, `shell/Shell.tsx`, `shell/ToolWindowShell*`, `shell/PartWindowShell*`, `shell/PoppedOutPlaceholder*`, `shell/dropRouting.ts`, `state/bootstrap.ts`, `state/ui.ts`, `state/windows.ts`, `state/bridge.ts`, `lib/popout.ts`, `lib/windows.ts` (additive), `parts/**` (not types.ts semantics), their tests | foundation |
| **C1** composition in the shell | 1 | `shell/Sidebar.*`, `shell/nav.ts`, `shell/CompositionBar.*`, `shell/useBuiltinCommands.ts`, `state/composition.ts`, their tests | foundation |
| **E1** editor shell + profiles | 1 | `editor/EditorShell*`, `editor/focus.ts`, `editor/profile.ts` (additive), `editor/timeline/**` except `ops.ts`, `editor/inspector/**`, `editor/transport/**`, `editor/overlays/**`, `editor/sources/**`, `editor/matte/**`, `editor/text/**`, `editor/visual/**`, `tools/edit-studio/**`, `tools/video-studio/**`, the architecture test | foundation |
| **E2** song-optional data, engine, Go, homes | 1 | `viz/edit/**`, `editor/store.ts`, `editor/useEditData.ts`, `editor/useEditAutosave.ts`, `editor/doc.ts`, `editor/home/**`, `editor/export/**`, `editor/timeline/ops.ts`, `modules/editstudio/**`, `core/viz/**` (additive), `tools/video-editor/**` (only the smallest hook for Quick vlog/open), `viz/worker/**` if needed | foundation |
| **N1** node-graph pipeline builder | 1 | `tools/pipelines/**`, `frontend/src/pipelines/**`, `core/pipeline/**` (additive, only if needed), their tests | foundation |
| **E3** minimal editor surfaces + click-ins (layout) | 2 | `editor/**` UI except E4's files, `tools/edit-studio/**` except `parts.ts`, `tools/video-studio/**` except `parts.ts` | W1, E1, E2 |
| **E4** editor pop-out windows (bridge, parts, replica data) | 2 | `editor/bridge.ts`, `editor/editorParts.tsx`, `editor/useEditData.ts`, `tools/*/parts.ts`, `parts/index.ts`, the bridge start/stop hook in EditorShell (one line) | W1, E1, E2 |
| **P1** constituent pop-outs with inputs | 2 | `lib/openTool.ts`, `tools/post-builder/**`, editor clip context menu, `views/LibraryView.tsx`, small handoff call-site edits | W1, C1, E1 |

## 11. Acceptance

1. Sidebar: "Video Editor" with "Edit Studio" nested under it; "Transcribe" with "Subtitles" under it; no "Sequence Editor".
2. Video Editor: New video → add clips and photos → play → export an MP4 without any song or AI engine.
3. Video Editor: add music → the length follows the music range; export has the music.
4. Edit Studio: an existing edit works exactly as before (setup, lanes, auto-fill, export).
5. Edit Studio ⇄ Video Editor: "Open in Video Editor" shows the same project; "Open in Edit Studio" on a plain video asks for the song (Setup).
6. Music | Video focus; double-click a clip → Video focus; Esc → Music.
7. Any tool: Pop out → own window, main shows the placeholder; Bring back works both ways; a drop on the pop-out goes to its tool.
8. Editor preview and inspector pop out and stay in sync (play, scrub, edit, undo).
9. Post Builder: edit a slide in its own window; the slide updates after saving/closing.
10. `go build/vet/test`, gofmt, `npm run check` all pass.
