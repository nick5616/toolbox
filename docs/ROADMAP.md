# Roadmap

Agreed on 2026-10-28; the Visualizer was cut in line as Phase 7 on 2026-10-29 and Edit Studio as Phase 9 on 2026-11-03. Each phase still gets its own spec and approval; this is only the order and the intent.

| Phase | Scope |
|---|---|
| 5 (done) | Local Chat, OCR, Vault, **tool packs + first-run setup** (managed FFmpeg/Deno, measured sizes, movable tools folder), FLAC stems by default. See `docs/specs/phase-5.md`. |
| 6 (done) | New tools: Video Trimmer, Subtitles (generate, translate, burn in), Audio Cleanup (denoise + loudness), Lyric Video, Redact (face and number-plate blur), Object Eraser (inpainting), Dev Utilities. See `docs/specs/phase-6.md`. |
| 7 (done) | **Visualizer**: reactive visuals for songs, lyrics and subtitled videos, built from the `song-visualizer` repo's ideas on a GPU engine; reacts to separated instruments, beat and sections, chords, words and their mood. See `docs/specs/phase-7.md`. |
| 8 (done) | **Pipelines** page: user-defined chains of tools, plus the built-in templates below (SPEC.md Part A). **Creator tools** (Part B): Post Builder, Photo Composer, Video Editor for Instagram-ready post folders. |
| 9 | **Edit Studio**: beat-synced music edits. A song's beats, kicks, drops and words as snap markers, a multitrack timeline on the Visualizer's GPU engine, auto-fill recipes, marker-driven effects, people/subject cut-outs and captions. Cut in on 2026-11-03. See `SPEC.md`. |
| 10 | **Composable tools** (2026-11-04): baselines and variants (Edit Studio composed on a new multitrack Video Editor), parts and pop-out windows for every tool and panel, minimal surfaces with click-ins across the app, and a node-graph pipeline builder. See `SPEC.md`. |
| 11 | **Composable everything** (2026-11-04): every constituent opens inside its host (and pops out), results come back with Use; every workspace tool gets store-backed poppable panels and previews; the step wizards become workspaces; shared building blocks in `blocks/`; Send to on every result. See `SPEC.md`. |
| 12 | **Documents** (2026-11-04): Document Converter (Pandoc + Typst for PDF) and Web Archiver (monolith, optional headless Edge/Chrome render). Calibre left out. See `SPEC.md`. |
| 14 | **Every tool composes** (2026-11-04): every tool is a pipeline step (proved by tests, no exemptions), in-app drag and drop everywhere, one result row with Send to incl. pipelines, and the usability audit's fixes. See `SPEC.md`. |
| 13 | **Built 2026-11-04.** Local File Transfer: LocalSend v2 (HTTPS) compatible, pairing with a 6-digit code, auto-accept from paired Toolboxes, receive Off / While open / Always, "Send to a device" step. The listener rule was amended for it. |
| 16 | **Built 2026-11-04.** Parameters as inputs: every step option is a coloured port that variables and run parameters wire into; the value colour system. |
| 17 | **Built 2026-11-05.** Compress to Size: any file under a byte limit, with frozen targets (Discord, Gmail, …). `docs/specs/phase-17.md`. |
| 18 | **Built 2026-11-05.** Focus Lock (stop everything but the chosen apps for a set time, Windows and macOS) and pipeline timing (wait-until, Wait step, schedules, runs without files, Open in app). `docs/specs/phase-18.md`. |
| 19 | **Built 2026-11-06.** Paint+ (a Procreate-grade painting app with its own design language, a 60+ brush library and importers, and the Lab: algorithmic and perception tools with predictability and origin cards) and the Library browser (previews, folders, lineage, "Other places", delete to trash). `docs/specs/phase-19.md`. |
| 20 | **Built 2026-11-18, accepted 2026-11-19.** Smart search in the Library (SigLIP 2 labels and concept search, OCR, document text and speech transcripts, Things view, Find similar, "Keep files that show…" step) and Caption Writer (alt text, captions, hashtags, keywords and names from a local vision model, written into copies or used to rename them). See `SPEC.md`. |
| 21 | **Approved 2026-11-19.** Workspaces (Personal / Demo / Dev, one shared tools folder, baselines, hide personal details), the Video Editor at practical parity (preview audio and audio tracks, ruler, razor/ripple/roll/slip, keyframes on the timeline, chroma key), a calmer Visualizer (rate integrals, motion grammar, a motion metric), Color Grader (AI colour grading from film to bonkers, depth and subject regions), and the demo footage harness. See `SPEC.md`. |

## Pipelines (Phase 8) — intended model

- A pipeline is an ordered list of steps; each step is a tool plus its options (the tool's own option panels).
- Steps only offer tools that accept what the earlier step produced (modules already declare accepted inputs and output kinds).
- A step that produces several files fans out (the next step runs per file) or is filtered ("bass stem only"); a collect step fans in (e.g. merge pages into one PDF).
- A step can take its input from **any earlier step**, not just the previous one — that gives branching without a node-graph editor.
- Data results (BPM, key, transcript) can be used later: `{bpm}`/`{key}` in file names, `{transcript}` in a Local Chat prompt.
- "Stop and let me check" steps pause the run, open that tool with the file loaded, and continue on Continue (trim points, checking a blur).
- Triggers: drop files on it, Library → Send to → pipeline, command palette, optional watch folder.
- Every step is an ordinary job (cancel, retry, logs, Library outputs).

### Built-in templates

1. Clip for social: link → download → trim → subtitles → 9:16 under 50 MB.
2. Podcast: recording → audio cleanup → transcribe → chat summary, show notes, chapters → Markdown.
3. Sampling: link → download audio → stems → BPM & key in file names → bass stem to MIDI.
4. Karaoke: song → instrumental stem + vocals transcribed to timed lyrics → lyric video.
5. Product photos: remove background → upscale 2× → strip metadata → web-sized WebP.
6. Paper to archive: photos of documents → OCR → one searchable PDF → compress → Vault.
7. Foreign-language video: link → transcribe + translate to English → English subtitles.
8. Receipts: photos → OCR → chat extracts date, merchant, total → CSV.
9. Lecture: recording → transcript → chat study notes and flashcards → PDF.
10. Before sharing: strip location and metadata → blur faces and plates → zip.
11. Music video: song → Visualizer analysis → preset render at 9:16 (added with Phase 7).
12. Archive a reading list: a .txt of links → Web Archiver (one page each) → Document Converter to EPUB (Phase 12).
13. Paper to Word: photos or scans of paper → OCR text → an editable .docx (Phase 12).

Phase 15 adds one template for each workflow in its SPEC §1. The gallery shows the templates in two sections, **Practical** and **Just cool** (the older templates are sorted into them too). Where a template needs a choice only the user can make, that step is left empty and the step editor flags it.

Practical:

14. Read it to me: a .txt of links → Web Archiver → Document Converter (text) → Text to Speech → Audio Cleanup (loudness) = one MP3 per article. (New, because it adds speech to "Archive a reading list".)
15. Audiobook from a document: EPUB/DOCX → Markdown → Text to Speech (one file per chapter) → zip.
16. Tight lecture: recorded talk → Silence Cutter → Subtitles (burned in) → Converter (720p MP4).
17. Podcast polish: episode → Audio Cleanup → Silence Cutter → Transcribe → Local Chat show notes. (Extends "Podcast" with the Silence Cutter.)
18. Camera-roll tidy: photos → Organizer (folders by date, look-alikes aside) → Image Batch (2048 px, no location) → Vault.
19. Shop-ready product shots: photos → Background Remover → Image Batch (square on white) → Photo Composer template (you pick it).
20. Storyboard a video: video → Scene Splitter (a still per shot) → PDF, plus a GIF & Contact Sheet.
21. Meeting recording to minutes: recording → Transcribe → Local Chat (decisions and actions) → Word document.
22. Clipboard link to notes: copy a link (clipboard trigger on) → Downloader (audio) → Transcribe → Local Chat summary → Copy to clipboard.

Just cool:

23. Highlight reel to the beat: footage → Scene Splitter (the 12 most active shots) → Edit Studio "Cut to the beat" (you pick the song).
24. Reaction GIF: clip → Subtitles (burned in) → looping GIF.
25. Narrated slideshow: script → Text to Speech (voice-over), photos → Video Editor "Assemble a video" (a dropped audio file is the voice bed; see DECISIONS).
26. Song to everything: song → stems, tempo and key in the names, melody MIDI, a music video → zip of the stems.
27. Vertical cut for social: landscape video → Silence Cutter → Video Editor "Assemble" (9:16, title) → Post Builder reel.

## Not planned

- Photo-library features (indexing, semantic photo search, duplicate finder). The user has a separate photo app for that.
