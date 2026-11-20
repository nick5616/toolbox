# Demo capture harness (Phase 21, SPEC Part D)

Films the app's own UI into 1920 x 1080, 30 fps CFR H.264 clips, by driving the production binary over the
DevTools protocol. Node 22+ only (built-in `WebSocket` and `fetch`), no npm dependencies. Everything runs
sandboxed: nothing touches your Personal workspace, your clipboard or your other windows.

```sh
export PATH="$APPDATA/fnm/node-versions/v24.22.1/installation:$LOCALAPPDATA/Programs/go1.27.3/go/bin:$HOME/go/bin:$PATH"
wails3 build                                   # the production binary, bin/toolbox.exe
node demo/make-assets.mjs                      # once: the generated roles (see "Assets")
node demo/run.mjs --list                       # scenes, roles, which assets exist
node demo/run.mjs --fresh --only 00            # film scene 00 from a fresh capture workspace
node demo/run.mjs                              # every scene whose roles exist (scratch capture workspace)
node demo/run.mjs --final                      # the real run: films inside workspaces/demo, footage into its Library/Demo Footage
node --test demo/test/*.test.mjs               # unit tests of the pure parts
node demo/cuts.mjs                             # shorts (9:16), teasers, GIFs, sizzle and showcase reels into Demo Footage/Cuts
```

`run.mjs` options: `--only 00,12` (numbers or ids), `--fresh`, `--no-record` (run the scene, film nothing:
for debugging), `--port 9230`, `--out <dir>` (default `<repo>/.dev/demo-out/`), `--bin <exe>`, `--tools <dir>`,
`--keep-frames`, `--legacy-env` / `--workspace-env` (force the capture mode).

Output: `<out>/A-roll/NN Title.mp4`, `<out>/B-roll/<name>.mp4`, `<out>/Stills/NN Title.png`,
`<out>/shotlist.md` + `shotlist.json` (merged across partial runs), `<out>/failed/*.png` for a scene that threw.

## How it runs

- **Capture env** (`capture/app.mjs`): `TOOLBOX_WORKSPACE=<repo>/.dev/workspaces/demo-capture`, `..._KIND=demo`,
  `..._NAME=Demo`, `..._BASELINE=<repo>/demoAssets`, `TOOLBOX_TOOLS_DIR=<repo>/.dev/support`,
  `TOOLBOX_DEVTOOLS_PORT`, `TOOLBOX_FOCUS_DRYRUN=1`, `TOOLBOX_NO_HOTKEYS=1`. In a git worktree, `demoAssets/` and
  `.dev/support` are looked up in the main checkout too (override the tools folder with `--tools`).
- **Legacy mode.** While `workspace.Resolve` ignores `TOOLBOX_WORKSPACE` (Wave 0's stub; detected by reading
  `core/workspace`), the harness uses `TOOLBOX_SUPPORT_DIR=.dev/demo-capture-support` and
  `TOOLBOX_LIBRARY_DIR=.dev/demo-capture-library` and copies `demoAssets/` (minus the privacy excludes) in. GPS is
  NOT stripped in this mode, so don't film photo metadata. After the app starts the harness reads its
  "starting Toolbox support=..." log line and stops it if that isn't a capture folder.
- **Stopping the app** walks the process tree from the PID the harness started (`Get-CimInstance Win32_Process`).
  It never kills by name or command line and never touches `msedge.exe` or any other process outside that tree.
- **`--fresh`** deletes only `<repo>/.dev/workspaces/demo-capture` (or the two legacy capture dirs), checked
  against an allow-list inside `.dev/`.
- **First-run page** ("Which tool packs do you want?") is skipped silently before any scene.
- **Recording** (`capture/record.mjs`): `Page.startScreencast` (JPEG q 92, every frame acknowledged); frames go
  to `.dev/demo-frames/`, are placed by `metadata.timestamp`, and encoded once by FFmpeg (concat demuxer with
  per-frame durations, `fps=30`, libx264 CRF 16 preset slow, yuv420p limited-range BT.709, `+faststart`). Only
  the page is recorded, so it works while the window is covered. FFmpeg comes from PATH or the managed copy.
- **Cursor** (`capture/cursor.js`, injected by the harness only): arrow with a soft shadow, eased moves of
  350-700 ms, click ripples, key-chip captions for chords. It lives in the top layer so menus and dialogs never
  hide it. The real mouse is moved along the same path, so hover states and tooltips are genuine.
- **No dev handles.** The production build has no `window.__ui`. Navigation clicks the sidebar
  (`[data-testid="nav-<id>"]`) or falls back to the palette (Ctrl+K); hand-offs are synthetic in-app drops
  (`application/x-toolbox-paths` on `#tool-drop:<id>`), exactly what dragging a Library row onto a tool does; jobs
  are read through the Wails runtime's own transport (`toolbox/api.JobsService.List`). Native dialogs are never opened.

## Scenes

`scenes/NN-<id>.mjs` exports `default { id, title, tool, roles, kind: "a"|"b"|"still", restart?, run(t) }`.
`roles` are checked before the scene runs (a scene with a missing role is skipped, and `--list` says so).
Between scenes the harness closes dialogs and returns to the Library; set `restart: true` to get a fresh app.

```js
export default {
  id: "stems", title: "Stems", tool: "Stem Splitter", kind: "a", roles: ["song.main"],
  async run(t) {
    await t.rec.start();                        // starts, then holds the 1.5 s start handle
    t.note("Four stems from one song", "Split any song into stems.");
    await t.open("stems");                      // sidebar click (or palette)
    await t.handOff("stems", "song.main");      // a drop on the tool, with the cursor gliding there
    await t.click("Split");                     // CSS selector, else visible text
    await t.waitJob({ compress: true });        // pauses recording after 2.5 s, dissolves back in
    await t.still("Stems");                     // 1920 x 1080 PNG
    await t.rec.stop();                         // holds the end handle, encodes
  },
};
```

| Call | What it does |
|---|---|
| `t.rec.start({name?, handle?})` / `stop({handle?})` / `pause()` / `resume()` | Clip control. Handles (1.5 s stills) are automatic; pass `handle:false` and call `t.handles()` yourself to place them. `name` names a B-roll file. |
| `t.hold(ms)`, `t.handles()` | Wait / a still handle. |
| `t.open(id, {name?})`, `t.openLibrary(folder?)` | Navigate. `name` is the palette title when the sidebar entry is hidden. |
| `t.click(target, {double?, right?})`, `t.move`, `t.hover(target, ms)` | `target` is a CSS selector, visible text, or `{css, text, textRe, within, nth, exact}`. |
| `t.drag(from, to)` | Pointer drag (sliders, timelines). HTML5 file drags aren't synthesised by CDP: use `handOff`. |
| `t.type(target\|null, text)` | 12-18 characters per second, seeded jitter. `null` types where focus is. |
| `t.key("Mod+K")`, `t.scroll(target, dy, ms)` | Chords with Ctrl/Alt/Cmd show a caption chip. `Mod` is Ctrl (Cmd on macOS). |
| `t.handOff(id\|null, ...roles)` | Deliver files like a drop. `null` drops on the window (the "suggested tools" chooser). |
| `t.pickFromLibrary(role)` | Inside an open "From Library" picker: search, pick, confirm. Open it yourself first. Needs the files to be listed in the Library (workspace mode registers them). |
| `t.waitJob({compress, moduleId, allowFail, timeoutMs})` | Waits for jobs created since the last call. Failed jobs throw unless `allowFail`. |
| `t.still(name)`, `t.note(shown, vo?)` | PNG into `Stills/`; shot-list text. |
| `t.role(name)`, `t.roles(name)` | Absolute paths of a role in the capture Library. |
| `t.svc(service, method, ...args)`, `t.eval(js)`, `t.exists(spec)`, `t.waitFor(spec)` | Escape hatches. |
| `t.requireNoOtherToolbox()` | Throws when a Toolbox the harness didn't start is running. |

## Roles and assets

`roles.json` maps role names (`song.main`, `stems.paramore.bass`, `photo.rain`, ...) to files relative to the
workspace Library, as `files`, `glob` or `of`. `exclude` lists the privacy-excluded files (selfie, floor plan, a
personal note, `*.asd`). Generated roles live under `Extras/`.

`node demo/make-assets.mjs` writes them to `.dev/demo-generated/` and the harness copies them into
`Library/Extras/` at start:

1. **Offline:** the article (`demo/assets/ten-basic-drum-beats.md`), `stems.mix` (FFmpeg `amix` of the four
   Paramore stems) and `video.broll` (six 12 s Ken Burns clips; HEIC is read by the AI engine's Pillow through
   `demo/tools/heic2jpg.py`, which drops GPS).
2. **Through the app** (`--app`): Text to Speech (`am_michael`, one clip per paragraph, 1.2-3 s gaps for the
   Silence Cutter scene) -> `video.talk` and `audio.noisy` (pink noise -28 dB + 60 Hz hum); Document Converter ->
   `doc.pdf`. Needs the Speech and Documents packs in the tools folder.

Links (`links` in roles.json): a public-domain Wikimedia Commons video (`Urmia_lake_drought.webm`, marked Public
domain, 1.6 MB) and the Wikipedia article "Drum kit" (text CC BY-SA 4.0). The Downloader and Web Archiver scenes
are the only ones that use the network, and only these URLs.

## Safety notes for scene authors

- **Clipboard scene:** write only your own test strings, read the previous text first and restore it in a
  `finally`; call `t.requireNoOtherToolbox()` first (the real app's recorder would see the copies).
- **File Transfer:** film with receiving **off** (the send screen and the pairing explanation only).
- **Focus Lock:** always a dry run here (`TOOLBOX_FOCUS_DRYRUN=1`); never start a real session.
- **Never open native dialogs** (Pick, Save): use the Library picker or `handOff`.
- Nothing personal on screen: no home paths, user names or host names (the Demo workspace shows paths as
  `Demo/...`; legacy mode does not, so avoid path-showing screens there). The first-run packs page shows the
  tools folder path, which is why the harness skips it before recording.
- `demoAssets/` is read-only; the harness only copies from it.

## Where artifacts go

Every demo artifact stays inside the Demo workspace (`<repo>/workspaces/demo`): the generated roles in `Library/Extras/`, the footage, stills and shot list in `Library/Demo Footage/`, and the tools' own results (stems, grades, renders) wherever each tool saves in that Library. `--final` films there; plain runs use a scratch capture workspace under `.dev/` that is deleted afterwards.
