# Mac verification checklist

Everything from Phases 3–6 that can only be checked on the Mac (Apple Silicon). Work top to bottom; each step says what you should see. If a step fails, note its number and send the log (see the end).

## 0. Build and start

1. In the repo: `cd frontend && npm install && cd .. && wails3 task common:generate:icons && wails3 build`.
   Expect: `bin/Toolbox.app` builds with no errors.
2. Open `bin/Toolbox.app`.
   Expect: the window opens; on a fresh Mac the **setup screen** ("Which tool packs do you want?") shows first.

## 1. Tool packs (Phase 5)

3. On the setup screen, check the cards: Media, Music, Image, Speech, Documents, Local Chat.
   Expect: sizes in GB/MB on every card; if Homebrew FFmpeg is installed, the Media card says "found on this PC" for FFmpeg.
4. Select **Media** only and click **Install**.
   Expect: the card's meter fills; it finishes "Ready" with no Gatekeeper prompt.
5. Terminal: `~/Library/Application\ Support/Toolbox/bin/ffmpeg/ffmpeg -version` and `…/bin/deno/deno --version` (skip ffmpeg if step 3 found a system copy and it was skipped).
   Expect: `ffmpeg version 9.0.2 …` and `deno 2.9.8`.
6. Convert a short video to MP3 in **Converter**, and download a YouTube link in **Downloader**.
   Expect: both jobs finish.
7. Record the real on-disk sizes: `du -sk ~/Library/Application\ Support/Toolbox/bin/*` and send them (the catalog has estimates for yt-dlp, ExifTool, the upscaler and llama.cpp on Mac).
8. Settings → Tool packs → **Move…** the tools folder to an external drive. Restart when asked.
   Expect: the app restarts; a **Stem Splitter** job on a song works afterwards (this checks the engine still runs after its folder moved).
9. Quit, unplug that drive, start the app.
   Expect: a warning banner "Your tools folder … isn't available" with **Choose folder…**. Plug the drive back in and restart.

## 2. Local Chat (Phase 5)

10. Install the **Local Chat** pack (or Settings → Dependencies → Chat engine, then download Qwen3 4B in Local Chat).
    Expect: no Gatekeeper prompt for `llama-server`.
11. Ask "What is 17 × 23?".
    Expect: an answer streams; the footer shows tokens/s and **GPU** (Metal).
12. Memory guidance: with 8 GB of RAM use Qwen3.5 2B; with 16 GB or more any model works. Note how much free memory Activity Monitor shows while it answers.
13. Terminal while it's answering: `lsof -iTCP -sTCP:LISTEN -P | grep -i llama`.
    Expect: exactly one line, bound to `127.0.0.1`. After quitting the app the line is gone.

## 3. OCR (Phase 5)

14. OCR a scanned PDF with "Searchable PDF".
    Expect: open the output in Preview; text can be selected and searched, and it lines up with the words on the page.

## 4. Clipboard, hotkeys, tray, login (Phase 3)

15. Menu bar: the Toolbox tray icon is a monochrome template icon that adapts to light/dark menu bars.
16. Settings → Clipboard: turn on recording. Copy some text in another app, then press **⌘⌥V**.
    Expect: the clipboard popup appears with the copied text at the top.
17. Settings → General: turn on **Start at login**, log out and back in.
    Expect: Toolbox starts in the menu bar.
18. Install ExifTool (Image pack or Settings → Dependencies), then read metadata of a photo in **EXIF**.
    Expect: it works with the system Perl.

## 5. Auto-paste, upscaler, background removal, icons (Phase 4)

19. Settings → Clipboard: turn on **Auto-paste**. Follow the Accessibility prompt and allow Toolbox.
    Expect: picking an item in the popup pastes it into the previously focused app.
20. Rebuild the app (`wails3 build`) and repeat step 19.
    Expect: macOS may require removing and re-adding Toolbox in System Settings → Privacy & Security → Accessibility. Note whether it did.
21. Upscale a photo 4× in **Upscaler**.
    Expect: it uses the GPU (MoltenVK). Note how long the first run takes (shader compilation) and the second.
22. Remove the background of a portrait with **Best**.
    Expect: it finishes; note peak memory in Activity Monitor (expected 6–7 GB).
23. Check the app icon in the Dock and Finder.
    Expect: the Toolbox icon, not a generic one. If generic: `wails3 task common:generate:icons` on the Mac, rebuild.

## 6. Media playback and the Phase 6 tools

24. Open a 1080p MP4 in **Video Trimmer** and press Space, then drag the playhead to the middle.
    Expect: it plays and seeks within about a second. **This is the most important Phase 6 check**: if the player stays black or never starts, note it (WKWebView refusing media from the app's own URL scheme) and continue; exports still work.
25. Open an MKV or HEVC file in the Trimmer.
    Expect: HEVC MP4/MOV plays directly; MKV shows "Preparing a preview copy…" and then plays.
26. Trim 10 s in **Fast** and in **Precise** mode.
    Expect: both outputs play in QuickTime; Precise starts on the exact frame.
27. **Subtitles**: generate subtitles for a short Japanese or Chinese clip, then **Burn into the video**.
    Expect: the characters render (font fallback through CoreText), not boxes.
28. **Audio Cleanup**: Preview 10 s with Voice isolation on a noisy recording, switch Original/Cleaned while playing.
    Expect: the switch keeps the position; the cleaned side is clearly quieter between words.
29. **Lyric Video**: render a 9:16 preview with the karaoke fill.
    Expect: the highlighted words sweep in time with the singing.
30. **Redact** a group photo and a 1-minute 1080p video (faces and plates on), and **Object Eraser** a small object on a large photo with **Best**, twice.
    Expect: all finish. Note the video's "Finding faces and plates" time (Windows: 78 s, target ≤ 90 s) and both erase times (Windows: the first includes a 20–45 s model load; the second ≈ 4 s for 12 MP, target < 10 s).

## Logs to send back

- `~/Library/Application Support/Toolbox/logs/toolbox.log` (and `toolbox.log.1` if present).
- The numbers from steps 7, 12, 21, 22 and 30, and what step 24 showed.
- For any failed step: its number, what you saw, and a screenshot if it's visual.
