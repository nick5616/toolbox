# Toolbox — Phase 15 Spec: Workflows worth having (new tools + a pipeline for each)

Status: **BUILT 2026-11-04** (archived; superseded by Phase 13 in SPEC.md). Approval: the user asked for exactly this sequence, so there is no separate review stop: "make a local file transfer tool and have it greyed out… then ideate possible pipelines… then create new tools that would enable the imagination in the previous step, then make all the pipelines i can switch between and the new tools required too". The work is left uncommitted on `main`, like Phases 10–14. Phase 14 is archived in `docs/specs/phase-14.md`. Every Phase 14 rule still holds:
- every tool is an automatic pipeline step with a `StepUI`, with no exemptions;
- every file row is draggable and has Send to;
- the polish rules apply.

## 0. Local File Transfer: shown, greyed out, not built
`modules/placeholders` adds `lan-share`, "Local File Transfer", as a "coming soon" tool. Its description covers:
- LocalSend-compatible transfer to phones and computers on the same Wi-Fi;
- listening only while the Share panel is open, pairing codes, and an OK for every transfer;
- received files landing in the library.

It ends: "It isn't built because it needs Toolbox to listen on your network, which it never does today. Want this? Message Nicole." The "no network listeners" rule is unchanged.

## 1. Ideation: workflows people would actually run

Each idea names the tools it chains. ★ marks a tool that doesn't exist yet.

### Practical
1. **Read it to me.** A reading list of links → Web Archiver → Document Converter (plain text) → ★Text to Speech → Audio Cleanup (loudness) = one MP3 per article for the commute.
2. **Audiobook from a document.** EPUB/DOCX → Document Converter (Markdown) → ★Text to Speech (one chapter per heading) → Zip.
3. **Tight lecture.** A recorded talk → ★Silence Cutter (drop dead air) → Subtitles (burned in) → Converter (smaller MP4).
4. **Podcast polish and show notes.** Raw episode → Audio Cleanup → ★Silence Cutter → Transcribe → Ask Local Chat (show notes, chapters, title ideas) → Zip.
5. **Camera-roll tidy.** A dump of phone photos → ★Organizer (folders by date taken, exact and near duplicates set aside) → ★Image Batch (2048 px, strip location) → Vault.
6. **Shop-ready product shots.** Photos → Background Remover → ★Image Batch (square, white, watermark) → Photo Composer template.
7. **Storyboard a video.** A video → ★Scene Splitter (one still per shot) → ★GIF & Contact Sheet (a contact sheet) → PDF Toolkit (images to PDF).
8. **Meeting recording to minutes.** Recording → Transcribe → Ask Local Chat (decisions and actions) → Document Converter (DOCX).
9. **Clipboard link to notes.** Copy a video link (clipboard trigger) → Downloader (audio) → Transcribe → Ask Local Chat (summary) → Copy to clipboard.

### Cool
10. **Highlight reel to the beat.** Long footage + a song → ★Scene Splitter (best shots) → Edit Studio "Cut to the beat".
11. **Reaction GIF.** A clip → Subtitles (burned in) → ★GIF & Contact Sheet (a looping GIF).
12. **Narrated slideshow.** Photos + a script → ★Text to Speech (voice-over) → Video Editor "Assemble a video" with the voice as the music bed.
13. **Song to everything.** A song → Stem Splitter + BPM & Key + Audio → MIDI + Visualizer (a video) → Zip.
14. **Vertical cut for social.** A landscape video → ★Silence Cutter → Video Editor "Assemble" (9:16, title) → Post Builder "Make a post".

## 2. New tools

Each tool is a Go job module (`core.Chainable`), a kit UI in `tools/<id>/` and a step editor in `pipelines/steps/<id>.tsx`. They take files by drop, paste or Send to, and their results are `ResultRow`s. They follow CLAUDE.md "How to add a module".

| Tool | id | Engine | Does | Options (main) | Produces (roles) |
|---|---|---|---|---|---|
| **Text to Speech** | `tts` | AI engine handler `tts.speak`, Kokoro (ONNX, pinned and sha-verified voices and model through `core.ModelProvider`, `<models>/tts/`) | Text, Markdown, HTML, SRT or DOCX-converted text becomes speech. Long text is split by headings or paragraphs (one file per chapter, or one joined file). | voice, speed, split (none / headings), format (mp3 / wav / m4a) | `speech` (+ `chapter`) |
| **Scene Splitter** | `scenes` | FFmpeg `select='gt(scene,t)'` | Finds shot changes, then cuts the video into one clip per scene (stream copy when keyframes allow, re-encode otherwise) and/or one still per scene. Can keep the N longest or most active scenes. | threshold, min scene length, output (clips / stills / both), keep (all / top N) | `scene`, `still` |
| **Silence Cutter** | `silence` | FFmpeg `silencedetect` + trim/concat | Removes silent stretches from audio or video, keeping a little padding so cuts don't feel abrupt. | threshold dB, min silence, padding | `cut` (+ a cut list `.csv`) |
| **Image Batch** | `imagebatch` | Go (`core/imaging`) + FFmpeg for format and text | Resize (long side, or exact), crop to an aspect, pad to a colour, convert format and quality, text or logo watermark, strip metadata, rename with a pattern. | size, aspect + crop/pad, background, format, watermark, strip, name | `image` |
| **Organizer** | `organize` | Go + ExifTool (dates) | **Copies** files (never moves originals) into folders by date taken, type or a pattern. It finds exact duplicates (hash) and near-duplicate photos (perceptual hash) and puts them aside in a "Duplicates" folder, with a CSV report. | group by, folder pattern, duplicates (off / exact / similar), similarity | `file` (+ `duplicate`, `report`) |
| **GIF & Contact Sheet** | `gif` | FFmpeg (palettegen/paletteuse, tile) | Video becomes a looping GIF or animated WebP (range, fps, width, loop), or a contact sheet (a grid of frames with timecodes). | mode, start/length, fps, width, columns/rows | `gif`, `sheet` |

Packs:
- Text to Speech belongs to the **Speech** pack (AI engine + a "Kokoro voices" model component, size measured).
- Scene Splitter, Silence Cutter and GIF & Contact Sheet belong to the **Media** pack (FFmpeg).
- Image Batch belongs to the **Image** pack.
- Organizer belongs to the **Image** pack (ExifTool).

The packs test enforces exactly one pack per tool.

## 3. Templates: one per workflow in §1
Every workflow in §1 becomes a built-in pipeline template (`modules/pipelines/templates*.go`), so it can be picked from the gallery and switched between like any pipeline. Each template:
- validates and describes cleanly with the default options;
- lists the packs it needs;
- keeps its final outputs.

Where a workflow needs a choice the user must make, the template flags that step for the user to finish in its step editor:
- the song for the highlight reel;
- the template composition for shop shots;
- the prompt is pre-filled.

The gallery groups templates into **Practical** and **Just cool**.

## 4. Work packages

The **architect** does: the placeholder, this spec, and the wiring:
- `main.go`;
- packs;
- the root tests' module lists;
- `tools/index.ts`;
- `pipelines/steps/index.ts`;
- `catalogFixture.ts`;
- bindings;
- CLAUDE.md.

Builders return main.go lines, pack membership and new service methods in their reports.

| Wave | WP | Owns |
|---|---|---|
| 1 | T1 Text to Speech | `modules/tts/**`, `sidecar/**` (new handler, deps, `uv lock`), `tools/tts/**`, `pipelines/steps/tts.tsx` |
| 1 | T2 Scene Splitter + GIF & Contact Sheet | `modules/{scenes,gif}/**`, `tools/{scenes,gif}/**`, `pipelines/steps/{scenes,gif}.tsx` |
| 1 | T3 Silence Cutter + Image Batch | `modules/{silence,imagebatch}/**`, `tools/{silence,imagebatch}/**`, `pipelines/steps/{silence,imagebatch}.tsx` |
| 1 | T4 Organizer | `modules/organize/**`, `tools/organize/**`, `pipelines/steps/organize.tsx` |
| 2 | T5 Templates | `modules/pipelines/templates*.go` (+ tests), the gallery grouping in `tools/pipelines/**`, `docs/ROADMAP.md` template list |

## 5. Acceptance
- `go build/vet/test`, `npm run check` and the production build pass. `TestEveryToolIsAPipelineStep` and `everyTool.test.tsx` pass with the six new tools and no exemptions.
- Each new tool works in the sandbox app on a real file.
- Every §1 workflow is a template.
- One practical and one cool template run end to end in the sandbox.
- Every new screen fits at 1180×720 and 960×600.
- Local File Transfer shows greyed out with its description.
