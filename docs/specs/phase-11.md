# Toolbox — Phase 11 Spec: Composable everything

Status: **BUILT 2026-11-04, uncommitted for review**. Written and executed without a review stop because the user asked to keep going ("i love it. keep going for the whole app and all the tools in it") right after testing Phase 10. Like Phase 10, the result is left **uncommitted on `main`** for the user to test (see DECISIONS 2026-11-04).
Author: architect session (Opus). Phase 10 (composable tools) is archived in `docs/specs/phase-10.md`; every Phase 10 contract still holds unless changed here.

## 0. The brief

Phase 10 took the video/edit path all the way: the Video Editor as a baseline, Edit Studio composed on it through slots, a minimal top level with every constituent in a click-in that pops out, live store-backed pop-outs, a poppable preview, and a node-graph pipeline builder. The other tools only got the light sweep (an Advanced click-in, a tidier header, CompositionBar chips that *navigate* to a constituent).

Phase 11 gives **every tool** the depth the editor got:

1. **Tools inside tools.** A composite opens a constituent *inside itself*: the constituent's own view in a click-in drawer, preloaded with the host's files, poppable into its own window, and its results come back with **Use** (an erased photo replaces the layer, a cleaned clip replaces the clip, a stem becomes the music). The CompositionBar's "Uses" chips open constituents this way instead of navigating away. This is "hide the constituent tools in click-in menus that can pop out", applied to every composition in the app, and "outputs feed inputs" inside the UI.
2. **Workspaces.** Every tool that is a workspace (Photo Composer, Post Builder, Subtitles, Lyric Video, Visualizer, Pipelines, Dev Utilities) gets the editor's shape: a store, panels that take no props (inline click-in or popped out, live), a poppable preview, a rail, one-line bars and one primary action. The step wizards (Subtitles, Lyric Video, Visualizer) become workspaces.
3. **Real composition in code.** Building blocks shared by several tools live in `blocks/` and never import a tool; tools never import each other (a variant may import its base). A test enforces it for the whole app, as Phase 10's test did for the editor.
4. **Send to everywhere.** Every result row in every file tool can be sent to any tool that accepts it (or that tool in its own window).

## 1. Goals

1. `<ToolClickIn>` works for every constituent listed in §6, from a drawer and from its own window, with Use returning results.
2. CompositionBar "Uses" chips open the constituent in a drawer over the current tool with the host's files (Shift+click: its own window; the chip's menu still offers "Go to <tool>").
3. Every file-tool view renders well embedded (compact, click-ins expand inline, Use buttons on results).
4. Every result row offers **Send to** (tools that accept the file, each also "in its own window").
5. Photo Composer, Post Builder, Subtitles, Lyric Video, Visualizer, Pipelines and Dev Utilities are workspaces: their panels pop out and stay live, their previews pop out.
6. Subtitles, Lyric Video and the Visualizer lose their steppers: once a source is chosen the tool is one workspace screen.
7. Subtitles is built on Transcribe in code: one transcription block (`blocks/speech`) used by both.
8. `src/architecture.test.ts` passes with no allowlist beyond the documented composition roots.
9. Everything works at 960 × 600; nothing is lost (move, don't delete).

## 2. Non-goals

- No new tools, models, Go services or dependencies. No network listeners. Go changes are descriptor metadata only (`Parts`), done in the foundation.
- The Sequence Editor stays (Post Builder's video slides); no project migration.
- No cross-window drag and drop. Window bounds still persist for the session only.
- Chat conversations don't become a part (the whole Local Chat tool can already pop out).
- No change to engines (viz, edit, FFmpeg plans), job semantics or outputs.

## 3. Foundation (done by the architect, committed before the builders start)

### 3.1 `blocks/`: shared building blocks

| Block | From | Used by |
|---|---|---|
| `blocks/visuals/designer/` (VisualDesigner, model, history, presets) | `tools/visualizer/designer/` | Visualizer, Lyric Video, Subtitles |
| `blocks/visuals/songmap/` (SongMap + draw/model) | `tools/visualizer/SongMap*`, `songmap/` | Visualizer, the designer, Edit Studio lanes |
| `blocks/sources/` (SourceGrid, sourceDrag, sourceThumbs, selection) | `tools/post-builder/` | Post Builder, Photo Composer, Sequence Editor, the editor |
| `blocks/media/useThumbs.ts` | `tools/video-editor/useThumbs.ts` | the editor, Sequence Editor |
| `tools/_kit/image/` (ResultCards, RadioCards) | `tools/image/` | the image file tools |

`VisualDesigner` no longer reads the Visualizer's store: hosts pass `selection`/`onSelect`, `onPlayhead`, `previewPart`, `windowPlayheadMs` (all optional; without them it keeps its own selection and has no pop-out). A block never imports a tool.

### 3.2 The workspace kit (`src/workspace/`)

`defineWorkspace(spec)` (types in `workspace/types.ts`) is the editor's pattern extracted:

```ts
const ws = defineWorkspace({
  moduleId: "photo-composer",
  store: useComposer,                    // the tool's zustand store
  bridge: { pick, apply, actions },      // JSON-serialisable values; channel "ws:<moduleId>"
  isOpen: (s) => s.doc !== null,         // host bridges only while a document is open
  panels: [{ id: "layers", title: "Layers", icon: "layers", tip: "…", component: LayersPanel }],
  preview: { component: ComposerPreview, width: 900, height: 900 },
  useReplica() { /* part windows: load images locally, forward keys */ },
});
// in the view:  ws.useHost();  <WorkspacePanel ws={ws} panel="layers" summary="3 layers" />
```

- Registers parts `<moduleId>.panel` (`?panel=<id>`, one window per panel) and `<moduleId>.preview`; part windows connect a replica and render once it's live and `isOpen`.
- Chrome (`workspace/components.tsx`): `WorkspacePanel` (a panel's click-in launcher; Pop out unless `poppable: false`), `WorkspaceRail` (icon launchers with captions; never scrolls, overflow → More), `OneLineBar` (never wraps: items that don't fit go to a More menu; `fitBar` is pure), `StudioLayout` (header / rail | stage | side / bottom), `Spacer`, `WorkspacePreviewFrame` (wraps the preview in a `PartFrame` when the workspace has a preview), `panelDrawerId(id)` for `useClickIn().open`.
- Define a tool's workspace in `tools/<id>/workspace.ts(x)` at module load; `parts/index.ts` discovers `tools/*/parts.ts` and `tools/*/workspace.ts(x)` by glob (no edit needed).
- Panels take **no props**; replicas never save, submit jobs or open documents (`ws.isReplica()`); heavy data (bitmaps, analyses) is loaded locally in `useReplica`, never bridged. The editor keeps its own (identical) implementation from Phase 10.

### 3.3 Tools inside tools: contract (`lib/embed.ts`, `components/ToolClickIn.tsx`)

- `EmbedContext` `{host, hostName, placement: "drawer"|"window", handoff, useLabel, onUse?}`; `useEmbed()`, `useIsEmbedded()`.
- **`useToolHandoff(moduleId, cb)` replaces every `useUI().takeHandoff` call in tool views**: embedded it delivers the embed's handoff once per handoff object and leaves the global handoff alone; standalone it behaves exactly as before. `useFileInputs` (kit) must use it.
- `Handoff` gains `text?: TextSeed` (`{title, body, prompts?}`: Local Chat starts a conversation about it; Dev Utilities opens it in the matching utility) and `embed?: EmbedLink` (`{token, host, hostName, hostWindow, useLabel}`).
- `sendEmbedUse(link, paths)` / `onEmbedUse(token, cb)` on relay channel `embed`; `newEmbedLink(...)`.
- `<ToolClickIn host module inputs extra onUse useLabel title icon summary tip variant width id disabledReason />`: a `ClickIn` whose drawer renders `getToolView(module)` inside an `EmbedContext` (placement `drawer`); its Pop out opens `popOutTool(module, {handoff: {...handoff, embed: link}})` and listens for that link's results. Disabled (with the reason) when the module isn't ready.
- `ClickIn` gained `onPopOut` (custom pop-out) and `disabledReason`.

### 3.4 Dependency rules and wiring (`src/architecture.test.ts`, `lib/toolActions.ts`)

1. A tool imports no other tool, except `tools/_kit`, the index types (`@/tools`) and, for a variant, its base (`edit-studio → video-studio`, `subtitles → transcribe`).
2. Shared code (`blocks/ components/ editor/ lib/ state/ viz/ workspace/ parts/`) imports no tool (the editor may use `@/tools/_kit` and `@/tools/_kit/accepts`).
3. Composition roots may: `tools/index.ts`, `parts/index.ts`, `shell/`, `views/`, `pipelines/`, `App.tsx`, `main.tsx`.

`tools/index.ts` registers the tool views and cross-tool actions (`registerToolViews`, `registerToolActions({ addToPost })`, dynamic imports); shared code calls `getToolView(id)` / `toolAction("addToPost")(path)`. To add a cross-tool action: a key in `ToolActions`, its registration in `tools/index.ts`.

### 3.5 Composition inputs (`state/composition.ts`)

`useCompositionInputs(host, { stems: [song], "bpm-key": [song] })` — a host tool reports what each constituent would be opened with; `useCompositionInputsFor(host, part)` / `compositionInputs(host, part)` read it (the CompositionBar's drawer uses it).

### 3.6 Descriptor `Parts` (Go, done)

| Tool | Base | Parts (Phase 11 additions in bold) |
|---|---|---|
| Video Editor `video-studio` | — | bg-remover, **upscaler, audio-cleanup, stems** |
| Edit Studio | video-studio | visualizer, stems, transcribe, bg-remover |
| Photo Composer | — | bg-remover, **object-eraser, upscaler** |
| Post Builder | — | photo-composer, video-editor, bg-remover, **upscaler** |
| Subtitles | transcribe | trimmer, **visualizer** |
| Lyric Video | — | stems, transcribe, visualizer |
| Visualizer | — | stems, bpm-key |
| Transcribe | — | **llm-chat** |
| OCR | — | **llm-chat** |
| PDF Toolkit | — | **ocr** |
| Audio → MIDI | — | **stems** |
| Clipboard History | — | **dev-utils** |

## 4. Tools inside tools (WP-K1)

### 4.1 Embedded rendering
- `ClickInHost` gains `mode?: "drawer" | "inline"`. Under an inline host, `ClickIn`s render as an in-place disclosure (launcher row + content below it when open, no portal, no Pop out of the inner ones unless they are parts) so an embedded tool never opens a drawer inside a drawer. Esc closes only the innermost open click-in (fix the shared-document listener order: the innermost handles it and stops propagation).
- `ToolClickIn` wraps the embedded view in `<ClickInHost mode="inline">`.
- `FileToolLayout` embedded (`useEmbed()`): no tagline; compact paddings; the drop zone is replaced by the file list with "Add files…" when inputs were handed over; Mod+Enter fires only when focus is inside the embed; the Active jobs list shows only jobs submitted from this embed session (track the job ids `submitJobs` returns: extend `submitJobs` to return them), and the results list puts those first.
- Every `useUI().takeHandoff` call site in tool views moves to `useToolHandoff` (K1 converts the kit and every tool it doesn't otherwise own today: downloader, vault, eraser, trimmer, redact, and any other file tool; tools owned by another wave-1 package are converted by that package).
- Every tool view must render embedded. Workspace tools (the editors, Photo Composer, Post Builder) are never embedded by §6; they open in their own windows instead.

### 4.2 Use and Send to (kit)
- `FileActions` (every result row) gains: **Use** (primary small button, label `embed.useLabel`) when `useEmbed()?.onUse` — calls it with `[path]` and toasts "Sent to <host>"; and a **Send to** menu button (icon `send`): every ready, visible module whose `accepts` matches the file (`_kit/accepts.ts`), excluding the current tool, as `openToolItems` (normal + "(new window)"), plus "Add to post…" for images/videos (`toolAction("addToPost")`). Multi-file results (stems) put Use per row.
- In a tool window opened with `handoff.embed`, `ToolWindowShell` provides `EmbedContext` (placement `window`, `onUse` = `sendEmbedUse(link, paths)` then a toast "Sent to <host>"); the window title bar shows "for <host>".

### 4.3 Constituent drawer in the shell
- `shell/ConstituentDrawer.tsx`: a drawer over the main tool area (the Shell wraps the tool area in a `ClickInHost`), opened by the CompositionBar. It renders `<ToolClickIn>`-equivalent content for `{host: current view, module}` with `useCompositionInputsFor(host, module)` and no `onUse` unless the host registered one (`useCompositionInputs` carries files only; Use goes through tool-specific click-ins).
- CompositionBar "Uses" chips: click = open the constituent drawer; Shift+click = its own window with the same inputs; the chip's hover menu: "Open here", "Open in its own window", "Go to <tool>". "Built on" / "Variants" chips keep navigating (they're the same work, another lens).
- In a tool window, Uses chips open the drawer inside that window.

### 4.4 Families
- The Phase 10 "family" placeholder (popping out Edit Studio also shows the placeholder for the Video Editor) applies only to tools that **share a store**: add `sharedStoreFamilies` (a set of module ids registered by tools: `video-studio`, `edit-studio`) in `state/windows.ts`; Transcribe/Subtitles are independent windows.

## 5. Workspaces

Every workspace follows one shape (the editor's):

- `StudioLayout` header (one line): back/source chip · name · quiet state | spacer | undo · redo · ⋯ · **one primary action**.
- `WorkspaceRail` of panels (left), the preview in `WorkspacePreviewFrame` (centre), an optional side list (the main editing surface), an optional bottom bar (`OneLineBar`).
- A **selection bar** (`OneLineBar`) when something is selected: its name, two or three quick controls, then click-ins for its constituents.
- Panels via `defineWorkspace`; launchers carry summaries; nothing appears twice; empty states stay as today (drop zone first).

### 5.1 Photo Composer (WP-PC)
- Lift `Editor.tsx`'s state (composition, selection, zoom, pending jobs, name) into `tools/photo-composer/store.ts` with undo/redo (`lib/history`). Images (`ImageBitmap`s) stay local, loaded per window (`useReplica`).
- Panels: **Layers**, **Layer** (properties of the selection: position/size/rotation, outline, shadow, opacity; text style for text layers), **Background**, **Layouts**, **Sources**, **Canvas** (aspect, export size). Preview part: the live canvas render (read-only in its window, with the current selection outline).
- Header: ← · name · save state | undo · redo · ⋯ · **Export**. Rail: Sources, Layers, Layouts, Background, Canvas. Add photo / Add text move into a `+` menu in the header (or the Layers panel's header).
- Selection bar for a photo layer: name · opacity · Delete | click-ins **Layer**, **Crop**, **Remove background** (the existing one-click job stays, as a button), `ToolClickIn` **Erase object** (`object-eraser`, Use "Use as this layer" → replace the layer's source, keep its transform) and **Upscale** (`upscaler`, same Use). Text layer: Layer, Text style.
- `useCompositionInputs("photo-composer", { "bg-remover": [selected photo], "object-eraser": [...], upscaler: [...] })`.

### 5.2 Post Builder (WP-PB, wave 2)
- Lift `usePostEditor` state (post doc, selection, saving) into a store; panels **Format**, **Sources**, **Framing**, **Alt text**, **Caption**, **Checks** (the existing bottom click-ins become panels); preview part: the phone preview.
- Layout: header (posts strip chip → a **Posts** panel; name; save state | ⋯ · **Export**); rail: Sources, Format, Caption, Checks; stage: slide stage; side: slide strip + phone preview stay as today if they fit, else the phone preview moves to its part.
- Slide selection bar: slide n · kind | Framing, Alt text, **Edit** (Composer/Sequence Editor, existing, with "in its own window"), `ToolClickIn` **Remove background** (`bg-remover`) and **Upscale** (`upscaler`) for photo slides (Use "Use for this slide" → replace the slide's photo, keep framing).

### 5.3 Subtitles on Transcribe (WP-SP)
- `blocks/speech/`: the transcription options block (model, spoken language, task) and its helpers, used by Transcribe's view and by Subtitles (which today duplicates them). Transcribe's view keeps its file-tool shape, using the block.
- Subtitles becomes a workspace once a source is chosen: header: source chip (file name; opens the **Source** panel: change file, use a subtitle file, `ToolClickIn` **Trim first** (`trimmer`, Use "Use this cut" → the cut becomes the source)) · language chip | undo · redo · ⋯ · **Export**. Rail: **Transcription** (the speech block + Generate/Regenerate + status), **Translate**, **Style** (burn-in look and the visuals designer from `blocks/visuals`), **Export** (formats, add as track, burn in). Stage: the video with the current cue (preview part `subtitles.preview`). Side: the **cue list** (the main surface; also a poppable panel `cues`). Before any cues exist the stage shows the video and a centred primary **Generate subtitles** with the Transcription summary ("Small · Auto-detect") and "Use a subtitle file…".
- The stepper is removed; every capability of the four steps is reachable from the workspace.
- `useCompositionInputs("subtitles", { trimmer: [source], visualizer: [source] })`.

### 5.4 Lyric Video (WP-LV, wave 2)
- Workspace once a song is chosen: header: song chip ("Title — Artist"; opens **Song**) | undo · redo · ⋯ · **Render**. Rail: **Song** (title/artist, original/instrumental audio), **Lyrics** (detect from vocals / paste / file; timing), **Visuals** (classic or the visuals designer), **Look** (font, colours, karaoke, position). Stage: the preview (part `lyric-video.preview`). Side: the lyric sheet (timed lines; panel `lines`). The stepper is removed.
- `useCompositionInputs("lyric-video", { stems: [song], transcribe: [song], visualizer: [song] })`.

### 5.5 Visualizer (WP-VZ)
- Workspace once a source is chosen: header: source chip (opens **Source**) · design name | undo · redo · ⋯ · **Export** (opens the **Export** panel: size, quality, range — the "quality row" lives there, merged with the player row issue from Phase 10). Rail: **Analysis** (words, instruments, mood, re-analyse; summary "Words · 4 stems · mood"), then the designer's own panels. Stage: the designer (preview + Song Map). Analysis runs automatically as today; while it runs the stage shows its progress.
- Port the Visualizer's bridge (`tools/visualizer/bridge.ts`) and preview part onto `defineWorkspace` (keep channel name compatibility not required).
- `useCompositionInputs("visualizer", { stems: [input], "bpm-key": [input] })`.

### 5.6 Pipelines (WP-N2)
- The pipeline draft moves into a store (`tools/pipelines/draftStore.ts`) with undo/redo (graph and list edits, Mod+Z / Mod+Shift+Z); `defineWorkspace("pipelines")` with panels **Step** (options of the selected node, today's side drawer), **Triggers**, **Runs**, **About** (name, description: editable in Graph mode now); no preview part.
- The Pipelines tool can pop out (`useBeforePopOut` saves a valid draft; the window reopens it). The architect removes `pipelines` from the shell's pop-out exclusion at merge.

### 5.7 Dev Utilities and Local Chat (WP-SW, wave 2)
- Dev Utilities: a workspace whose panels are the utilities (each utility's input/output state in the devutils store), so any utility pops out into a small window; honours `handoff.text` (detects JSON / JWT / Base64 / URL / timestamp / colour and opens that utility with the text).
- Local Chat: honours `handoff.text`: starts a new conversation, shows the text as an attached context card ("Transcript of interview.mp3 · 12 k characters", expandable), offers `prompts` as one-click chips above the composer, and sends the text with the first message (trimmed to the model's context with the existing notice).

## 6. Constituent wiring (who embeds whom)

| Host | Where | Constituent | Inputs | Use |
|---|---|---|---|---|
| Photo Composer | photo layer selection bar | object-eraser, upscaler | the layer's source | replace the layer's source |
| Post Builder | photo slide selection bar | bg-remover, upscaler | the slide's photo | replace the slide's photo |
| Video Editor / Edit Studio (WP-ED) | image clip selection bar | upscaler | the clip's source | replace the clip's source (all clips using it ask) |
| Video Editor / Edit Studio | video/audio clip selection bar | audio-cleanup | the clip's source | replace the clip's source |
| Video Editor | Music panel | stems | the music bed's file | set the bed to the chosen stem (instrumental) |
| Subtitles | Source panel | trimmer | the source | the cut becomes the source |
| Transcribe (WP-SW) | each result | llm-chat | `text`: the transcript (`FilesService.ReadText` of the .txt, ≤ 200 k chars), prompts Summarise / Key points / Action items | — |
| OCR (WP-SW) | each result | llm-chat | `text`: the recognised text, prompts Summarise / Extract a table / Fix typos | — |
| PDF Toolkit (WP-SW) | rail action **Make searchable** | ocr | the chosen PDFs | — (results stay) |
| Audio → MIDI (WP-SW) | primary row "Split into stems first" | stems | the inputs | the chosen stem becomes the input |
| Clipboard History (WP-SW) | a text item's actions | dev-utils | `text`: the item | — |
| Visualizer, Lyric Video, Subtitles, Edit Studio | CompositionBar Uses chips | their parts | via `useCompositionInputs` | — |

The Phase 10 context-menu entries ("Open in Background Remover / Trimmer") stay as navigation shortcuts; nothing else duplicates a click-in.

## 7. UX rules (Phase 10 §7b/§13 still hold), plus

1. A constituent opens **inside** its host first; its own window second; navigating away last.
2. Use buttons name the destination ("Use as this layer", "Use for this slide", "Use as music").
3. An embedded tool is the same tool: same options (shared module state), same jobs, same outputs in the Library.
4. Wizards become workspaces: the stepper's steps become rail panels; the last step's action becomes the header's primary action.
5. Every result can go somewhere: Send to on every row.

## 8. Error handling

- A constituent that isn't installed: the launcher is disabled with "<Tool> needs setup first: open it from the sidebar".
- Use with a missing file (deleted meanwhile): toast "That file is gone" and do nothing.
- A popped-out embed whose host closed: Use toasts "<Host> isn't open any more" (no listener answered: the relay is fire-and-forget, so the host replies `{t:"ack"}`; no ack in 1 s → the toast).
- Part windows of a workspace without an open document show "Open a project in <tool> first" with Show main window.

## 9. Tests

- Foundation: architecture test (done), `fitBar`/`railFit` tables, `defineWorkspace` host/replica with a fake transport (panel renders on replica, action forwards), `useToolHandoff` (embedded vs global), `ToolClickIn` (renders the registered view with the embed handoff; disabled when not ready; pop-out passes `embed`).
- K1: inline host mode, Esc innermost, FileToolLayout embedded, FileActions Use/Send to, ToolWindowShell embed relay (fake relay), CompositionBar chip → drawer, family placeholder only for shared-store families.
- Each workspace package: store + bridge round trip, panels render with no props, the stepper's capabilities reachable (one test per old step), the selection bar fits (one line), ToolClickIn Use updates the document.
- `go build/vet/test`, gofmt, `npm run check` (typecheck, ≈2.6 k tests, check:any).

## 10. Work packages

| WP | Wave | Owns | Depends on |
|---|---|---|---|
| **K1** tools inside tools, Send to, constituent drawer | 1 | `lib/embed.ts` (additive), `components/ToolClickIn*`, `components/ClickIn*`, `tools/_kit/**`, `shell/ToolWindowShell*`, `shell/Shell.tsx`, `shell/ConstituentDrawer*`, `shell/CompositionBar*`, `state/windows.ts`, `state/composition.ts` (additive), `lib/openTool.ts`, and the `useToolHandoff` conversion in `tools/{downloader,vault,eraser,trimmer,redact,bgremove,upscale,stems,bpmkey,midi,converter,exif,ocr,audiocleanup,pdf}/**` (handoff code only) | foundation |
| **PC** Photo Composer workspace | 1 | `tools/photo-composer/**` | foundation |
| **SP** speech block + Subtitles workspace | 1 | `blocks/speech/**`, `tools/transcribe/**`, `tools/subtitles/**` | foundation |
| **VZ** Visualizer workspace | 1 | `tools/visualizer/**`, `blocks/visuals/**` | foundation |
| **N2** Pipelines workspace | 1 | `tools/pipelines/**`, `pipelines/**` | foundation |
| **PB** Post Builder workspace | 2 | `tools/post-builder/**` | K1 |
| **LV** Lyric Video workspace | 2 | `tools/lyricvideo/**` | K1, VZ (blocks/visuals) |
| **ED** editor constituents | 2 | `editor/selection/**`, `editor/panelDefs.tsx`, `editor/timeline/musicBed*`/music panel files, `tools/video-studio/**`, `tools/edit-studio/profile.tsx` (composition inputs only) | K1 |
| **SW** constituents sweep (chat, dev utils, transcribe/ocr/pdf/midi/clipboard) | 2 | `tools/{chat,devutils,clipboard,midi,ocr,pdf}/**`, `tools/transcribe/**` (results only) | K1, SP |

## 11. Acceptance

1. Photo Composer: select a photo layer → Erase object opens Object Eraser in a drawer with the photo → erase → Use → the layer shows the erased photo; the same from the popped-out Object Eraser window.
2. Visualizer with a song: the "Uses: Stem Splitter" chip opens the Stem Splitter in a drawer with the song loaded.
3. Any file tool result: Send to → Stem Splitter (new window) opens that window with the file.
4. Transcribe result → Ask Local Chat → a conversation with the transcript attached and Summarise as a chip.
5. Subtitles and Lyric Video and Visualizer: no stepper; every former step's controls reachable; preview pops out and stays in sync.
6. Photo Composer, Post Builder, Pipelines, Dev Utilities: a panel pops out, edits in it reach the main window (undo picks them up).
7. `src/architecture.test.ts` passes; `go build/vet/test`, gofmt and `npm run check` pass.

## 12. Follow-ups (2026-11-04, second night; uncommitted)

The user asked to keep going in parallel, with all Phase 10 + 11 work kept on one branch (`phase-10-11`, the old `compose/phase11`) and **nothing committed**. Builders work in worktrees without committing; their diffs land on `main`'s working tree **unstaged**, so `git diff` shows the follow-ups and `git diff --cached` shows Phases 10 + 11.

| Package | Scope | Owns |
|---|---|---|
| P1 | The Video Editor and Edit Studio run on `src/workspace/` (`defineWorkspace`), retiring the editor's parallel Phase 10 panel/rail/part/bridge code; behaviour, ids and the family bridge unchanged. | `editor/**`, `workspace/**`, `tools/video-studio/**`, `tools/edit-studio/{panels,parts,profile,workspace}` |
| P2 | Subtitles reopens the last session after a restart; its bridge stops mirroring the undo history. | `tools/subtitles/**` |
| P3 | Visualizer and Lyric Video reopen the last source/session after a restart (cached analysis only; never auto-analyse). | `tools/visualizer/**`, `tools/lyricvideo/**` |
| P4 | Photo Composer layer names follow Use; pop-outs follow drags live; Post Builder undo survives reloads. | `tools/photo-composer/**`, `tools/post-builder/**` |
| P5 | File names not paths in the kit and the remaining tools; Send to / Use on every output row (custom result lists, Pipelines runs, Library). | `tools/_kit/**`, the other tool folders, `pipelines/**`, `views/**` |

Restores in P2/P3: a handoff always wins; a missing file drops the record; replicas never restore or save; once per page (StrictMode-safe).
