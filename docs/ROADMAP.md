# Roadmap

Agreed on 2026-10-28; the Visualizer was cut in line as Phase 7 on 2026-10-29. Each phase still gets its own spec and approval; this is only the order and the intent.

| Phase | Scope |
|---|---|
| 5 (done) | Local Chat, OCR, Vault, **tool packs + first-run setup** (managed FFmpeg/Deno, measured sizes, movable tools folder), FLAC stems by default. See `docs/specs/phase-5.md`. |
| 6 (done) | New tools: Video Trimmer, Subtitles (generate, translate, burn in), Audio Cleanup (denoise + loudness), Lyric Video, Redact (face and number-plate blur), Object Eraser (inpainting), Dev Utilities. See `docs/specs/phase-6.md`. |
| 7 (done) | **Visualizer**: reactive visuals for songs, lyrics and subtitled videos, built from the `song-visualizer` repo's ideas on a GPU engine; reacts to separated instruments, beat and sections, chords, words and their mood. See `SPEC.md`. |
| 8 | **Pipelines** page: user-defined chains of tools, plus the built-in templates below. |
| 9 | Documents: Pandoc conversion (+ Typst for PDF), maybe Calibre ebook conversion; the Web Archiver placeholder. |
| 10 (last) | LAN file transfer, LocalSend-protocol compatible. Opt-in, listens only while the Share panel is open, pairing + accept prompt. Needs an explicit amendment to the "no network listeners" app rule. |

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

## Not planned

- Photo-library features (indexing, semantic photo search, duplicate finder). The user has a separate photo app for that.
