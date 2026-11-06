# Toolbox — Phase 18 Spec: Focus Lock + Pipeline Timing

Status: **APPROVED 2026-11-05.** This phase changes an app rule (§0, approved): for the first time Toolbox stops programs it didn't start.

Approval answers (2026-11-05):
- the rule amendment: yes;
- **Windows is the primary machine, but the tool is cross-platform**: build both, and where something can't be done on one OS, say so in the UI and do it on the other anyway (§1.7);
- apps opened from Toolbox count as Toolbox's: yes;
- open apps are asked to close at start (`close`, the default): yes.

Source: Nicole's spec "Toolbox Focus Lock + Pipeline Timing Spec" (2026-11-05), reconciled with the code the same day. **§R lists every place the draft didn't match the repo and what this spec does instead.** Everything else is the draft's intent, made concrete enough for builders.

Phase 13 (Local File Transfer) is archived in `docs/specs/phase-13.md`; Phases 16 and 17 are in `docs/specs/`. Every earlier rule still holds:
- every tool is an automatic pipeline step with a `StepUI`, no exemptions;
- every file row is draggable and has Send to;
- the polish rules apply (960 × 600, tokens only, a tooltip on every control, `aria-disabled` with a reason).

---

## Overview

**Focus Lock** (module `focus`) stops, for a set time, every program from running except Windows itself, Toolbox, and the apps in a chosen profile (for example Discord, Claude, VS Code, Terminal and Ableton), plus anything those apps start.

A focus session lasts minutes to hours, so Focus is the first step whose value is *time*. The phase therefore also gives pipelines a timing model:
- a durable wait-until primitive;
- a Wait step;
- a schedule trigger;
- runs that start without files;
- a `{weekday}` variable.

### Goals
1. **One click to focus.** Pick a profile and a length, press Start. New launches of anything else are stopped within half a second, with a quiet toast saying what was stopped.
2. **Never break the machine or the work.** These keep running:
   - Windows' own processes;
   - Toolbox and its jobs;
   - anything an allowed app starts (shells, language servers, plugin scanners, Electron helpers).

   Nothing that could hold unsaved work is force-closed unless the user says so.
3. **Friction, not a prison.** Ending early costs a deliberate effort sized by the session's lock strength. There is always an emergency way out.
4. **It composes.** Focus is a pipeline step with three actions: start a session, wait for it to end, end it. Pipelines can run *around* and *during* focus time.
5. **Pipelines learn time.**
   - Any step can wait until a moment without polling.
   - A Wait step pauses for a duration or until a clock time.
   - A pipeline can start on a schedule, and a pipeline that reads no files can be run with one click.
   - All of it survives an app restart and a sleeping PC.
6. **Background apps.** A new built-in step, **Open in app**, launches a program (optionally with the run's files) and can close it when the session or run ends. Apps Toolbox opens are allowed during focus automatically.

### Non-goals
- **A security boundary.** An administrator can always stop this (Task Manager, signing out, a reboot). It adds friction for the person who set it up.
- **An elevated helper or Windows service.** Toolbox stays an ordinary user process. Programs running as administrator can't be stopped; they're reported.
- **Full parity on macOS** where the OS doesn't allow it without cgo or extra entitlements. §1.7 lists what the Mac backend does differently, and the UI names each gap.
- Blocking websites inside an allowed browser, or blocking by window title.
- **Waking a sleeping PC for a schedule.** Schedules fire only while Toolbox runs (it lives in the tray and can start at login).
- Loops or conditions in pipelines. Repetition (a Pomodoro) is written out as steps.

---

## R. Reconciliation with the repo (2026-11-05)

Each item: what the draft assumed → what's true → what this spec does. On approval these go into `docs/DECISIONS.md` as one entry.

| # | Draft | Repo | This spec |
|---|---|---|---|
| R1 | Scheduled runs start "with no inputs"; the Music session, Pomodoro and Morning templates read no files | `StartRun` refuses a run without inputs ("Add at least one file"), and items are made one per input | **Runs without files** (§3.5): a pipeline where no step reads `From: "input"` starts with one item that has no input. The pipeline list shows a **Run** button for it instead of "drop files" |
| R2 | New time variables `{date}`, `{time}`, `{weekday}` with vectors in `core/testdata/vars.json` | `{date}` (`2006-01-02`) and `{time}` (`15-04`) already exist in exactly those formats (`core/pipeline/state.go builtinVars`, mirrored in `modules/pipelines/adapter.go` and `frontend/src/pipelines/vars.ts`). `vars.json` holds template-expansion vectors, not built-ins | Keep both. Add only `{weekday}` (`Mon`…`Sun`, English, local time). No new `vars.json` vectors; a Go table test covers it |
| R3 | "If the runner can't finish a cell with zero jobs, Wait submits a no-op job" | The runner already completes a cell whose `PrepareStep` returns zero jobs, passing its inputs on (`sched.go submit`) | Wait and Focus *wait* return zero jobs. Focus *start* and *end* submit one short `focus` job, because they set variables and leave a log line |
| R4 | Wait is "runner-owned like Check" | Check is special-cased all through the runner. Waiting needs only `ErrWaitingUntil` | Wait is an ordinary built-in adapter (`modules/pipelines/wait.go`). To keep a "for 25 minutes" deadline fixed, `StepRequest` gains `Until` (the cell's stored deadline). The only runner change is time waits |
| R5 | `ErrWaitingUntil(msg, until)` | `ErrWaiting(message, hint string)` returns an `*AppError` with `CodeWaiting` | `ErrWaitingUntil(message, hint string, until time.Time) *AppError`: same code, plus a new `AppError.Until` field (`json:"-"`). `core.WaitingUntil(err)` reads it back |
| R6 | Error codes `focusUnsupported`, `launchFailed`, `scheduleInvalid`… in `core/errors.go` | `core/errors.go` keeps a few general codes. Feature codes are lowercase snake case in the feature package (`core/lan/types.go`: `lan_offline`…) | Focus codes `focus_*` go in `core/focus/types.go`; `launch_failed` in `modules/pipelines` (`core/proc` imports nothing from `core`). A bad schedule is a `validation` error on field `schedule`, like the clipboard trigger |
| R7 | "Next free migration" | Last is `0007_project_kind_edit.sql` | `0008_focus_schedule.sql` |
| R8 | Engine persists sessions in the DB | `core/**` may not import `core/store`; the runner uses `core.PipelineStore` | `core/focus` defines a `focus.Store` interface, implemented by `core/store/focus.go`. The schedule's last-fire state goes through two new `core.PipelineStore` methods |
| R9 | Snapshot with `CreateToolhelp32Snapshot` + `ProcessIdToSessionId` + `GetProcessTimes` | Toolhelp has no creation time or session, so each tick would open every process (~300 × 4/s) | `NtQuerySystemInformation(SystemProcessInformation)` (in `x/sys/windows`) returns PID, parent, session, create time and name for every process in one call, with no handles. `QueryFullProcessImageName` runs only for newly seen processes. `PostMessageW`/`IsWindowVisible` aren't in `x/sys` and come from a `user32` `LazyProc` |
| R10 | Engine and runner "re-check on a power-resume event" | `core` can't import Wails | `main.go` hooks `events.Windows.APMResumeAutomatic` and `APMResumeSuspend` to `focus.Engine.Resumed()` and `pipeline.Runner.Resumed()`. The 30 s wall-clock checks cover everything else |
| R11 | Focus wait retries at the session's `EndsAt` | If the session is ended early or extended, a wait sleeping until the old `EndsAt` is wrong | `Runner.WakeTimeWaits()` re-prepares every time-waiting cell now; `main.go` calls it on every focus change |
| R12 | Open in app `closeWhen: runEnds / focusEnds` | The runner has no run-finished hook, and the engine has no subscription | `Runner.OnRunFinished(fn)` and `focus.Engine.Subscribe(fn)` |
| R13 | Apps Toolbox launched are allowed because they descend from Toolbox | After a Toolbox restart their parent (the old Toolbox) is gone, so they no longer descend from it | The engine records each launch in the active session (`Session.Launched`, exe rules that confer), so they stay allowed after a resume |
| R14 | Templates numbered 28–31 | 28 templates exist (13 + 14 + Send to my computer) | The new ones are 29–32 |
| R15 | "The span band in `graphModel.ts`"; schedule "where watch folder and clipboard triggers are (the input node / trigger panel)" | There's no `graphModel.ts`; layout is `tools/pipelines/editorModel.ts`. Triggers are in `tools/pipelines/panels.tsx` | Span pairing is a pure `focusSpans()` in `editorModel.ts`, drawn by `GraphEditor`/`RunGraph`. The schedule editor lives in `panels.tsx` next to Watch a folder and When I copy |
| R16 | (silent) | Every user-facing module must be built in or in exactly one pack (`TestEveryToolIsInOnePack`) | Focus needs no tools, so it's in `packs.BuiltIn` |
| R17 | Hotkey action `focus.startLast` | Action IDs are camelCase (`clipboard`, `quickOpen`) | `focusStart`, no default binding |
| R18 | "Quit from the tray during a session goes through the friction" | Quit is `App.Quit()` from the tray and Cmd+Q; Wails has `Options.ShouldQuit` | `ShouldQuit` refuses while a real session is on and not released, and opens Focus on the quit dialog. Windows shutdown and sign-out (`WM_ENDSESSION`) are never blocked |
| R19 | E2E test "terminates nothing it didn't spawn" | A real engine stops *every* blocked new process on the machine. The test binary would also count as "Toolbox" (rule 2), so all its children would be allowed | The engine takes `Options.Scope func(ProcInfo) bool`. The test sets it to "descends from this test's helper parent" and fakes `Self()` |
| R20 | `dev:sandbox` sets `TOOLBOX_FOCUS_DRYRUN=1` | QA scripts also run `bin/toolbox.exe` with only the sandbox dir variables | Dry run is on when `TOOLBOX_FOCUS_DRYRUN=1`, **or** when `TOOLBOX_SUPPORT_DIR` is set and `TOOLBOX_FOCUS_DRYRUN` isn't `0`. Taskfile `dev:sandbox` and `.dev/p10-qa/dev.sh` also set it explicitly |
| R21 | Continue now on a time wait | `ContinueRequest` handles only manual and check waits | `doContinue` also takes `WaitTime` cells: it re-prepares them with `SkipWait: true` |
| R22 | "Always allowed" is read at match time | The draft wants a session to be a snapshot so edits can't loosen it | The session also snapshots Always allowed (`Session.Always`) |
| R23 | Policy rule 3: only `%SystemRoot%` is "Windows" | Parts of the Windows 11 shell live outside it: Defender's tray, the touch keyboard, `WindowsApps\MicrosoftWindows.*` system packages, the WebView2 runtime | Rule 3b: a frozen **Windows extras** list (§1.3) is allowed and doesn't confer; the tool shows it read-only |
| R24 | Store apps "come from Running apps or Browse" | Fine | Unchanged. The Start-menu `.lnk` parser is written in-repo (`modules/focus/lnk.go`, ~150 lines of MS-SHLLINK: LinkInfo base path, else the environment block, else the relative path) instead of adding a dependency |
| R25 | Open in app escapes with `syscall.EscapeArg` | `SysProcAttr` can't start a window minimized | `proc.Launch` calls `windows.CreateProcess` with `windows.ComposeCommandLine` (per-argument escaping) and `STARTUPINFO.ShowWindow` |

---

## 0. Rule amendment (needs your OK)

On approval, add under **App rules** in CLAUDE.md:

> - **Toolbox stops other programs only during a Focus session** (`core/focus`, `modules/focus`). A session is started by the user, directly or by a pipeline they made, and always has an end time (≤ 12 h). During it, Toolbox may close or terminate programs only:
>   - in the user's own Windows session;
>   - never anything under `%SystemRoot%` or on the Windows extras list;
>   - never Toolbox or its descendants;
>   - never in a dry run.
>
>   Programs already open when a session starts are only asked to close (WM_CLOSE); force-closing them needs a click. If the focus engine errors, it stops enforcing (fail-open) and says so.
> - **Every program Toolbox launches for the user goes through `core/proc.Launch`** (detached, visible, not tree-killed on cancel). It is the only exception to `core/proc`'s tree-kill rule.

And under **Safety rules**. Builders run in bypass mode on this PC, inside VS Code and a terminal that a real session would stop.

> - **Never start a real Focus session while developing.** The engine is in dry run (it decides and logs but never closes or terminates anything) whenever `TOOLBOX_FOCUS_DRYRUN=1`, or `TOOLBOX_SUPPORT_DIR` is set and `TOOLBOX_FOCUS_DRYRUN` isn't `0`. `wails3 task dev:sandbox` and `.dev/p10-qa/dev.sh` set it. Tests use a fake platform; the one real-platform test (`TOOLBOX_FOCUS_E2E=1`) is scoped to processes it spawned.

---

## 1. Focus engine (`core/focus`)

The engine is a polling loop inside the Toolbox process. It sees every new process in the user's session and decides allow or block with a pure policy function. Blocked processes are terminated.

- It never imports Wails, modules or `core/store`.
- OS code sits behind small interfaces, so the policy and the loop are tested without real processes.

### 1.1 Files

```
core/focus/
  types.go             Wave 0, frozen: every type, interface and error code below
  policy.go            Decide (pure) + rule matching + path normalisation
  engine.go            Engine: sessions, the loop, learn mode, events, resume
  store.go             the Store interface (in types.go) is implemented in core/store/focus.go
  platform_windows.go  NtQuerySystemInformation snapshot, paths, terminate, WM_CLOSE, running windows
  platform_darwin.go   sysctl kern.proc.all snapshot, kern.procargs2 paths, SIGKILL, osascript quit (§1.7)
  platform_other.go    Linux and the rest: Supported() = focus_unsupported; empty snapshots
  close_*.go           AskToClose(pid, created, path) for modules/pipelines (Open in app); path is used on the Mac
```

### 1.2 Contracts (`types.go`, Wave 0)

```go
type ProcInfo struct {
    PID, ParentPID uint32
    Created        int64  // creation time, Unix ms; (PID, Created) identifies a process (PIDs are reused)
    Session        uint32 // Windows session ID
    Path           string // full Win32 image path; "" if access was denied
    Name           string // exe name ("Discord.exe")
}

type ProcessSource interface{ Snapshot(ctx context.Context) ([]ProcInfo, error) } // Path filled only on request, see Paths
type Stopper interface {
    Terminate(p ProcInfo) error          // re-checks Created before TerminateProcess; ErrGone if it already exited
    AskToClose(p ProcInfo) (bool, error) // WM_CLOSE to its visible, unowned top-level windows; false = it has none
}
type Platform interface {
    ProcessSource
    Stopper
    Paths(ps []ProcInfo)            // fills Path for these (QueryFullProcessImageName, limited-information handle)
    Windows() map[uint32]bool       // PIDs that own a visible top-level window (Running apps, "Still open")
    Self() ProcInfo
    InteractiveSession() uint32     // Self().Session, not the console session (works over RDP)
    SystemRoot() string             // GetSystemWindowsDirectory, long form, no trailing slash
    Supported() error               // nil on Windows
}

type Clock func() time.Time

type Options struct {
    Platform Platform
    Store    Store
    Clock    Clock                     // nil = time.Now
    DryRun   bool                      // never Terminate or AskToClose
    Scope    func(ProcInfo) bool       // tests only: nil = every process in the session
    Emit     func(name string, payload any)
}
```

Error codes, as `core.ErrorCode` constants in `types.go`:

| Code | Message | Hint |
|---|---|---|
| `focus_unsupported` | Focus Lock works on Windows and macOS | |
| `focus_active` | A focus session is already on | End it in Focus, or choose Extend |
| `focus_not_active` | No focus session is on | |
| `focus_not_yours` | Another focus session is on | End it in Focus |
| `focus_phrase` | That doesn't match the phrase | Type it exactly as shown |
| `focus_too_long` | A session can last 12 hours at most | |
| `focus_profile` | That profile needs a name and at least one app | |
| `focus_countdown` | Wait for the countdown to finish | |

### 1.3 Allow policy (`policy.go`, pure, table-tested)

`Decide(p ProcInfo, s *SessionPolicy, seen Ancestry) Verdict`

```go
type Verdict struct {
    Allow  bool
    Confer bool   // descendants inherit the allowance
    Reason string // "session" | "toolbox" | "windows" | "windows-extra" | "rule:<ruleId>" | "child:<pid>" | "unknown" | "blocked"
}
type Ancestry interface{ Lookup(pid uint32) (ProcInfo, Verdict, bool) } // seen processes, including ones that have exited
```

Rules are checked in this order; the first match wins. **Confers** means the allowance passes to the process's descendants.

1. **Other sessions** (`p.Session != InteractiveSession`, including session 0 services) are ignored. They are never touched and not logged.
2. **Toolbox itself and its descendants** are allowed and confer: FFmpeg, the AI engine, llama-server, WebView2, apps it launched. That includes `Session.Launched` exe rules (R13).
3. **Windows**: an image path under `SystemRoot()`. Paths are compared case-insensitively after stripping `\\?\` and expanding 8.3 names (`GetLongPathNameW`, cached). The process is allowed and **does not confer**. This matters: `explorer.exe`, `cmd.exe` and `powershell.exe` live there, and if they conferred, everything launched from the Start menu or a stray shell would be allowed.

   3b. **Windows extras** are a frozen list in `policy.go`: allowed, do not confer.
   - `%ProgramFiles%\Windows Defender\`
   - `%ProgramFiles%\Common Files\microsoft shared\ink\`
   - `%ProgramFiles%\WindowsApps\MicrosoftWindows.*`
   - `%ProgramFiles(x86)%\Microsoft\EdgeWebView\`
4. **Allow rules**: the session's Always allowed, its profile, and its extras. Allowed; confers when the rule's `Children` is on (the default).
5. **Child of an allowed app**: the nearest ancestor in `seen` whose verdict confers.
   - The walk skips ancestors that are allowed but don't confer, so a VS Code terminal's `powershell.exe` → `go.exe` is allowed through Code.
   - The walk stops at a blocked ancestor.
   - A parent that has already exited still counts if it was seen, so Squirrel-style launchers (`Update.exe --processStart Discord.exe`) work.
   - A parent PID is trusted only if its `Created` is earlier than or equal to the child's (PID reuse).
6. **Path unknown** (access denied): allow, log `unknown`. Fail-open.
7. Everything else is **blocked**.

Rule matching (`policy.go`):
- A **folder** rule matches any image inside that folder tree.
- An **exe** rule matches one exact path.
- `%VAR%` segments are expanded at match time.
- One path segment may contain one `*` (`WindowsApps\Microsoft.WindowsTerminal_*`). It matches within that segment only.
- **Folder rules that are too broad are refused** at save time: drive roots, `%SystemRoot%`, `%ProgramFiles%`, `%ProgramFiles(x86)%`, `%ProgramData%`, `%USERPROFILE%`, `%APPDATA%`, `%LOCALAPPDATA%`, `%LOCALAPPDATA%\Programs`, `WindowsApps` itself, Desktop, Downloads and Documents. Message: "That folder holds too many programs. Pick the app's own folder."

```go
type AllowRule struct {
    ID       string `json:"id"`       // ULID
    Label    string `json:"label"`    // "Ableton Live 12", 1–60
    Kind     string `json:"kind"`     // "folder" | "exe"
    Path     string `json:"path"`     // absolute; %VARS% kept; one "*" in one segment allowed
    Children bool   `json:"children"` // what it starts is allowed too (default true)
}
```

### 1.4 The loop (`engine.go`)

- **When it runs.** It ticks every `PollMs` (default 1000, range 250–2000) **and at once on a platform kick** (Windows: a top-level window shown anywhere, from an out-of-context `SetWinEventHook(EVENT_OBJECT_SHOW)` on a locked OS thread with its own message loop; kicks are coalesced to at most one tick per 50 ms). It runs only while a session is active or learn mode is on.
- **Snapshot.** Each tick takes one snapshot (R9) and diffs it against the last by (PID, Created). New processes in scope get `Paths()` in one batch and are decided **once**, at first sight. The verdict stays in the `seen` table until the process has been gone for 60 s; exited ancestors stay for child lookups. The table is capped at 20,000 entries, oldest exited first.
- **Rule changes.** "Allow for this session" adds to `Extra`. It affects only processes seen after the change, plus the blocked rows the user allowed (they are not re-run; the next launch is allowed).
- **Blocked processes.** The engine calls `Terminate`, then terminates every process seen in the same tick whose nearest seen ancestor is the blocked one, because fast launchers spawn children within one tick. It emits `focus:blocked` and stores a `BlockEvent`.
- **Budget (measured in Wave 0, 2026-11-05):** one `NtQuerySystemInformation` snapshot of 359 processes takes 4.5 ms (Toolhelp 8.3 ms, EnumProcesses 6.0 ms), and paths for all 359 take 4.9 ms. At 250 ms that would be 1.8% of a core, so the loop polls every second (≈ 0.45%) and window kicks catch windowed launches at once. Windowless launches are caught within a second. Target: under 0.5% of one core.
- **Time.** Every tick compares wall-clock now (`Clock`) with `EndsAt`. `Resumed()` re-checks at once, so a session that should have ended while the PC slept ends on wake (reason `time`).
- **Errors.** If the snapshot fails 10 ticks in a row, the session ends with reason `error` and a toast: "Focus stopped: Toolbox couldn't read the process list". Fail-open.

### 1.5 Starting with apps already open

At start the engine decides every existing in-scope process with the same policy, using ancestry from the current snapshot, then applies `OnStart`:

- **`close`** (default):
  1. `AskToClose` each blocked process that owns a visible window.
  2. Windowless ones (tray helpers, driver panels, sync clients) are **left running**, because killing a helper can break an allowed app (an audio interface panel Ableton needs).
  3. After 10 s, anything still running is listed in `State.StillOpen`. The tool offers **Close again**, **Force close** and **Leave it** per app. Nothing is force-closed without that click.
- **`leave`**: existing processes keep running; only new launches are blocked.

Existing processes that were blocked but left running get verdict `blocked` and don't confer, so what they start next is stopped.

New launches during the session are terminated at once, windowed or not, since they can't hold unsaved work yet. Learn mode (§2.6) is how windowless helpers that keep relaunching get onto Always allowed.

### 1.7 macOS backend (`platform_darwin.go`)

Same engine and policy, different OS seam. No cgo: `core/focus` must build with `CGO_ENABLED=0 GOOS=darwin`.

| Piece | macOS |
|---|---|
| Snapshot | `unix.SysctlKinfoProcSlice("kern.proc.all")`: `Proc.P_pid`, `Eproc.Ppid`, `Proc.P_starttime`, `Proc.P_comm` |
| "Session" | the real uid (`Eproc.Pcred.P_ruid`) equals Toolbox's (`Session` = uid). Other users and root are rule 1 (ignored) |
| Path | `unix.SysctlRaw("kern.procargs2", pid)`: the exec path after the argc word. Denied → `""` (rule 6) |
| "Windows" (rule 3) | Prefixes `/System/`, `/usr/`, `/bin/`, `/sbin/`, `/Library/Apple/`, `/private/var/`, `/Library/Application Support/Apple/` |
| Terminate | `SIGKILL`, after re-checking the start time |
| AskToClose | The process's `.app` bundle (from its path) gets `osascript -e 'tell application "<bundle path>" to quit'` through `core/proc`, i.e. the app's own quit with its save prompts. macOS asks once per app for Automation permission. A refusal is reported as "Toolbox isn't allowed to quit <app>", and the row offers Force close. Processes outside an `.app` count as windowless |
| `Windows()` | A process whose path is an `.app`'s main executable (`…/X.app/Contents/MacOS/<file>`) counts as windowed |
| Apps catalog | `/Applications`, `~/Applications`, `/System/Applications` (top level and one subfolder). Each `.app` becomes a **folder rule on the bundle**, so helpers inside it match |
| Running | The `.app` bundles of running processes, de-duplicated |
| AppIcon | `""` (lettered tile) |
| Launch | `open -a <App> [-g when minimized] [--args …]`. There's no PID, so `NoteLaunch` adds a folder rule for the bundle, and `closeWhen` quits it with the same osascript |
| Resume | `events.Common.SystemDidWake` (also used on Windows) |
| Polling | There are no kicks, so the engine polls at `min(PollMs, 500)` ms (a `kern.proc.all` sysctl is cheap) |

**What can't be done on the Mac**, named in the UI with one line under the Active card ("On the Mac: …"):
- **Child-of-allowed-app is limited.** Apps opened from the Dock or Finder are children of `launchd`, not of the app you clicked in. So rule 5 only covers helpers an app starts itself; folder rules on bundles cover the rest.
- **No app icons, and no window list.** There's no icon API without cgo, and windowed apps are guessed from the bundle layout.
- **The first polite close of each app needs your OK** in macOS's Automation prompt.

### 1.6 What can't be stopped

`Terminate` on an elevated or protected process fails with access denied. The engine:
- logs a `failed` event;
- toasts once per app per session ("Couldn't stop Steam: it runs as administrator");
- marks it so the next tick doesn't retry it.

---

## 2. Sessions, profiles, strength

Only one session exists at a time. A session is a **snapshot**: it copies its profile's rules and Always allowed when it starts, so editing either mid-session can't loosen the active one.

### 2.1 Types (`types.go`, Wave 0)

```go
type Profile struct {
    ID        string      `json:"id"`        // ULID
    Name      string      `json:"name"`      // 1–40, unique ignoring case
    Rules     []AllowRule `json:"rules"`     // 1–100
    CreatedAt int64       `json:"createdAt"`
    UpdatedAt int64       `json:"updatedAt"`
}

type Strength string
const ( StrengthSoft Strength = "soft"; StrengthFirm Strength = "firm"; StrengthStrict Strength = "strict" )

type StartRequest struct {
    ProfileID string      `json:"profileId"`
    Minutes   int         `json:"minutes"`  // 1–720; or 0 with Until set
    Until     int64       `json:"until"`    // Unix ms; 1 min–12 h ahead
    Strength  Strength    `json:"strength"`
    Extra     []AllowRule `json:"extra"`    // this session only, ≤ 20
    OnStart   string      `json:"onStart"`  // "close" | "leave"
    RunID     string      `json:"runId"`    // set when a pipeline started it
    StepID    string      `json:"stepId"`
}

type Session struct {
    ID        string      `json:"id"`
    Profile   Profile     `json:"profile"`   // snapshot
    Always    []AllowRule `json:"always"`    // snapshot of Settings.AlwaysAllowed (R22)
    Extra     []AllowRule `json:"extra"`
    Launched  []AllowRule `json:"launched"`  // exe rules for apps Toolbox launched in this session (R13); confer
    Strength  Strength    `json:"strength"`
    OnStart   string      `json:"onStart"`
    StartedAt int64       `json:"startedAt"`
    EndsAt    int64       `json:"endsAt"`
    EndedAt   int64       `json:"endedAt"`   // 0 = active
    EndReason string      `json:"endReason"` // "time" | "user" | "emergency" | "pipeline" | "error"
    RunID     string      `json:"runId"`
    StepID    string      `json:"stepId"`
    DryRun    bool        `json:"dryRun"`
    Blocked   int         `json:"blocked"`   // count, for the summary
}

type BlockEvent struct {
    SessionID string `json:"sessionId"` // "" in learn mode
    At        int64  `json:"at"`
    Path      string `json:"path"`
    Name      string `json:"name"`
    Result    string `json:"result"` // "stopped" | "closed" | "failed" | "wouldStop" | "unknown"
    Error     string `json:"error"`
}

type Settings struct {
    AlwaysAllowed   []AllowRule `json:"alwaysAllowed"`   // ≤ 100
    DefaultStrength Strength    `json:"defaultStrength"` // "firm"
    OnStart         string      `json:"onStart"`         // "close"
    PollMs          int         `json:"pollMs"`          // 1000
    Learn           bool        `json:"learn"`
    LearnSince      int64       `json:"learnSince"`
    LastProfileID   string      `json:"lastProfileId"`
    LastMinutes     int         `json:"lastMinutes"`     // 50
}

// State is what the UI shows (focus:changed carries it).
type State struct {
    Supported  bool        `json:"supported"`
    DryRun     bool        `json:"dryRun"`
    Session    *Session    `json:"session"`    // nil when idle
    Last       *Session    `json:"last"`       // the last ended session (the "Ended" summary)
    StillOpen  []OpenApp   `json:"stillOpen"`  // after an OnStart close
    Friction   *Friction   `json:"friction"`   // a weakening countdown in progress
    QuitReleased bool      `json:"quitReleased"`
}
type OpenApp struct { PID uint32 `json:"pid"`; Created int64 `json:"created"`; Name string `json:"name"`; Path string `json:"path"` }

type Weaken string // "end" | "allow" | "quit" | "emergency"
type Friction struct {
    Action   Weaken `json:"action"`
    Phrase   string `json:"phrase"`   // "" at soft
    ReadyAt  int64  `json:"readyAt"`  // Unix ms the Confirm button enables (firm: +30 s, emergency: +5 min)
    Rule     *AllowRule `json:"rule"` // Action "allow"
}

type LearnEntry struct { Path string `json:"path"`; Name string `json:"name"`; Count int `json:"count"`; LastSeen int64 `json:"lastSeen"` }

// Store is implemented by core/store (focus.go).
type Store interface {
    Profiles(ctx context.Context) ([]Profile, error)
    PutProfile(ctx context.Context, p Profile) error
    DeleteProfile(ctx context.Context, id string) error
    ActiveSession(ctx context.Context) (*Session, error) // EndedAt = 0, newest
    PutSession(ctx context.Context, s Session) error
    RecentSessions(ctx context.Context, limit int) ([]Session, error)
    AddEvents(ctx context.Context, evs []BlockEvent) error // batched
    Events(ctx context.Context, sessionID string, limit int) ([]BlockEvent, error)
    LearnEntries(ctx context.Context, since int64) ([]LearnEntry, error) // grouped by path
    ClearLearn(ctx context.Context, path string) error // "" = all
    PruneEvents(ctx context.Context, before int64, keep int) error
    GetSettings(ctx context.Context) (Settings, bool, error) // settings key "focus"
    PutSettings(ctx context.Context, s Settings) error
}
```

`Engine` (in `engine.go`; the signatures are frozen in Wave 0 as stubs):

```go
func New(o Options) *Engine
func (e *Engine) Start(ctx context.Context) error            // load settings; resume an active session (§2.5); start learn mode
func (e *Engine) Stop()
func (e *Engine) State() State
func (e *Engine) Begin(req StartRequest) (Session, error)    // focus_active if one is on
func (e *Engine) Extend(minutes int) (Session, error)         // 1–720; never past 12 h from StartedAt
func (e *Engine) ExtendTo(until int64) (Session, error)       // never earlier
func (e *Engine) RequestWeaken(a Weaken, rule *AllowRule) (Friction, error) // starts the countdown; soft returns ReadyAt = now
func (e *Engine) ConfirmWeaken(a Weaken, phrase string) error             // checks phrase + ReadyAt, then acts
func (e *Engine) CancelWeaken()
func (e *Engine) EndFor(runID string) error                   // a pipeline's End: only its own session, or any soft one
func (e *Engine) CloseAgain(pid uint32, created int64) error
func (e *Engine) ForceClose(pid uint32, created int64) error
func (e *Engine) LeaveOpen(pid uint32, created int64)
func (e *Engine) NoteLaunch(path string)                      // add an exe rule to Session.Launched (no-op when idle)
func (e *Engine) SetLearn(on bool) error
func (e *Engine) Resumed()                                    // power resume: re-check EndsAt now
func (e *Engine) Subscribe(fn func(State)) (unsubscribe func())
```

### 2.2 Storage (`0008_focus_schedule.sql`)

```sql
CREATE TABLE focus_profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, json TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE focus_sessions (id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL DEFAULT 0, json TEXT NOT NULL);
CREATE INDEX focus_sessions_started ON focus_sessions(started_at DESC);
CREATE TABLE focus_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, at INTEGER NOT NULL,
  path TEXT NOT NULL, name TEXT NOT NULL, result TEXT NOT NULL, error TEXT NOT NULL DEFAULT '');
CREATE INDEX focus_events_session ON focus_events(session_id, at);
CREATE INDEX focus_events_path ON focus_events(result, path);
CREATE TABLE pipeline_schedule_state (pipeline_id TEXT PRIMARY KEY, last_fire_at INTEGER NOT NULL);
```

- Events are pruned at start to the last 30 days and at most 5,000 rows.
- Settings live in the existing `settings` table under the key `focus`.
- Only program paths are stored, never the user's documents.

### 2.3 Lock strength

Extending is always one click (+15 min, +30 min). Anything that weakens the session costs the session's strength. That means End early, allowing a blocked app mid-session, or quitting Toolbox.

| Strength | To weaken the session |
|---|---|
| Soft | A confirm dialog |
| Firm (default) | Type the phrase shown ("I'm choosing to stop early"), then wait a 30 s countdown before Confirm enables |
| Strict | End early, Allow and Quit aren't offered. Only **Emergency unlock**: type the phrase, then a 5 min countdown during which the session keeps enforcing |

- Emergency unlock exists at every strength and ends the session with reason `emergency`.
- Countdowns live in the engine (`Friction.ReadyAt`), so closing the dialog or reloading the window doesn't reset them; `CancelWeaken` does. `ConfirmWeaken` before `ReadyAt` returns `focus_countdown`.
- A pipeline-started session takes its strength from the step. A pipeline can never lower the strength of a session it didn't start.

### 2.4 Quitting during a session (R18)

`desktop.Shell.ShouldQuit()` is wired to `application.Options.ShouldQuit`. While a non-dry-run session is on and `QuitReleased` is false, it:
1. returns false;
2. shows the main window;
3. navigates to `focus` with the quit friction dialog open.

After `ConfirmWeaken("quit", …)`, `QuitReleased` is set and the shell quits. **The session is not ended**: it resumes at the next launch (§2.5). Windows shutdown and sign-out are never blocked.

### 2.5 Surviving restarts

On `Start`, the engine looks for an active session:
- **`EndsAt` still ahead:** it resumes enforcing, with a toast: "Focus resumed, 38 min left. Toolbox was closed during the session". `OnStart` is not re-applied, so only new launches are stopped. Processes already running are decided as `existing` (blocked ones are left running and don't confer).
- **Time passed while Toolbox was closed:** the session ends with reason `time` and `EndedAt = EndsAt`.

### 2.6 Learn mode

Learn mode is a standing setting, separate from sessions.
- While it's on, the engine runs even with no session, in dry run, against the last-used profile and Always allowed.
- It records `wouldStop` events, grouped by path with a count and last-seen time.
- The tool lists them with **Always allow**, **Add to profile** and **Ignore** (Ignore clears that path's entries).
- During a session learn mode pauses; the session's own events are recorded instead.

---

## 3. Pipeline timing (`core/pipeline`)

Runs already start from:
- dropped files;
- the clipboard;
- a watch folder;
- another pipeline.

`ErrWaiting` retries every 5 s. Timing adds the pieces below. Deadlines are stored as absolute wall-clock times, so they are durable across restarts.

### 3.1 Wait-until (Wave 0 contracts)

```go
// core/errors.go
type AppError struct { …; Until int64 `json:"-"` } // Unix ms; only set by ErrWaitingUntil
func ErrWaitingUntil(message, hint string, until time.Time) *AppError // CodeWaiting + Until
func WaitingUntil(err error) (time.Time, bool)

// core/pipeline_types.go
const WaitTime WaitKind = "time" // waiting for a moment; RunCell.Until says when
// RunCell gains:   Until int64 `json:"until"` // Unix ms; 0 = none
// core/steps.go — StepRequest gains:
//   Until    int64 // the cell's stored deadline from an earlier ErrWaitingUntil; 0 the first time
//   SkipWait bool  // the user pressed Continue now on this cell
```

- **Waiting.** A cell whose `PrepareStep` returns `ErrWaitingUntil` becomes `waiting` with `Wait = time` and `Until` set. Its `retryAt` is `Until`, not now + 5 s. `rearm` already picks the nearest `retryAt`.
- **Wall-clock check.** Go timers run on the monotonic clock, which on Windows doesn't advance during sleep. So the loop also checks every 30 s, on `Resumed()` and on `WakeTimeWaits()`: any time-wait cell whose `Until ≤ now` (wall clock) is re-prepared.
- **Plain `ErrWaiting`** (no deadline) keeps the 5 s retry and `Wait = condition`.
- **Continue now** (R21): `doContinue` on a `WaitTime` cell re-prepares it with `SkipWait: true`. Every step decides what that means (§4).
- **Restart.** `Until` is persisted with the cell. `register` sets `retryAt = max(now, Until)`.
- **NeedsYou** already counts only manual and check waits. Time waits need nobody; the tray count is unchanged.

New Runner methods:

```go
func (r *Runner) Resumed()                                   // power resume: wall-clock check now (schedules + time waits)
func (r *Runner) WakeTimeWaits()                             // re-prepare every time-waiting cell now (focus changed)
func (r *Runner) OnRunFinished(fn func(run core.PipelineRun)) // called on the loop goroutine at a run's terminal transition; never block
```

### 3.2 Wait step (`pipelines.wait`, built-in adapter, R4)

```go
type WaitOptions struct {
    Mode    string `json:"mode"`    // "for" | "until"
    Minutes int    `json:"minutes"` // for: 1–1440 (default 25)
    At      string `json:"at"`      // until: "HH:MM" 24 h local (default "17:00")
    Note    string `json:"note"`    // ≤ 200, shown on the waiting card
}
```

`PrepareStep` works like this:
- With `SkipWait`, it returns zero jobs: done, inputs pass through.
- Otherwise the deadline is `req.Until`, or, the first time, now + `Minutes` (`for`) or the next `At` at or after now, today or tomorrow (`until`).
- If now ≥ deadline, it returns zero jobs.
- Otherwise it returns `ErrWaitingUntil(note or "Waiting until 17:30", "", deadline)`.

Its `DescribeStep` returns:
- `NoFiles: true` and `Accepts{Any: true, URLs: true}`;
- `Produces: passThrough`;
- the summary "25 min", or "until 17:30".

`Minutes` and `At` are ordinary parameters (Phase 16), so `{break_minutes}` can drive them. With fan-out each item's cell waits on its own; the step editor says so in one line.

### 3.3 Schedule trigger

```go
// Pipeline gains:       Schedule ScheduleTrigger `json:"schedule"`
type ScheduleTrigger struct {
    Enabled    bool     `json:"enabled"`
    Days       []int    `json:"days"`       // 0 = Sunday … 6; 1–7 unique values
    Times      []string `json:"times"`      // "HH:MM" local, 1–12 unique
    CatchUpMin int      `json:"catchUpMin"` // 0–720, default 30
}
// PipelineEntry gains:  Schedule ScheduleState `json:"schedule"`
type ScheduleState struct {
    Active  bool   `json:"active"`
    Message string `json:"message"` // "" = fine; else why not, or "Skipped 9:30: the last run is still going"
    Next    int64  `json:"next"`    // next fire, Unix ms; 0 = none
}
// PipelineRun.Trigger gains "schedule".
// core.PipelineStore gains:
//   ScheduleFired(ctx, pipelineID string) (lastFireAt int64, err error)
//   SetScheduleFired(ctx, pipelineID string, at int64) error
```

- **Validation.** Saving an enabled schedule with no day or no time fails with `ValidationError` on field `schedule`: "Pick at least one day and one time". A disabled schedule keeps its values.
- **Firing.** A fire starts a run with trigger `schedule`, no inputs (§3.5) and run parameters at their defaults, like watch-folder runs. It writes `last_fire_at` (the slot's time) before starting.
- **Timers.** One timer runs for the earliest next fire across pipelines (`schedule.go`), plus the 30 s wall-clock check.
- **Catch-up.** At `Start` and on `Resumed()`, for each pipeline, take the most recent slot in `(last_fire_at, now]`. It fires once if it's within `CatchUpMin` of now. Older missed slots are dropped.
- **Overlap.** If the previous `schedule` run of the same pipeline is still running or waiting, the fire is skipped, `last_fire_at` still advances, and `Message` says "Skipped 9:30: the last run is still going".
- **Daylight saving.** A time that doesn't exist that day fires at the first valid minute after it. A time that happens twice fires once, the first time.
- **Problems.** `Describe` adds a pipeline problem when the schedule is on and a step reads `From: "input"`: "A scheduled run starts with no files, but step 2 reads the run's files". While there are problems, `Active` is false and `Message` is "Fix the problems in step N", like watch folders.

### 3.4 `{weekday}` (R2)

`builtinVars` gains `"weekday": t.Format("Mon")`, in both `core/pipeline/state.go` and the copy in `modules/pipelines/adapter.go`. `builtinVarList` gains `{weekday, "Run weekday", text}`. `frontend/src/pipelines/vars.ts BUILTIN_VARS` gains `{ name: "weekday", label: "Weekday" }`. `pipeline_vars_test.go` lists it.

### 3.5 Runs without files (R1)

- **When.** `PipelineCheck` gains `TakesFiles bool`: true when some step reads `From: "input"`.
- **Starting.** `StartRun` with `TakesFiles == false` needs `Inputs` to be empty; otherwise it fails with "This pipeline doesn't take files". The run gets **one item**:
  - `Index 0`, `Label` = the pipeline name, `Input ""`, `Merged []`, `MergedAt ""`;
  - built-ins with `item`/`name` = the pipeline name.
- **Merged-item checks.** Code that treats `Input == ""` as "a merged item" (`sched.go` `sourceFiles` and `advance`) must test `MergedAt != ""` instead. An inputless item passes a together step as an ordinary item. Table tests cover a together step in an inputless run.
- **Triggers.** Watch folders and the clipboard can't start such a pipeline (they always bring files): `Describe` adds "This pipeline takes no files, so it can't watch a folder" / "…can't start from a copy" when those are on.
- **UI.** The pipeline list card and the editor show **Run** (with run parameters asked first, as today) instead of "Drop files".

---

## 4. Pipeline steps

A focus session is a **span**, not a transformation: it starts, other steps run during it, and something may wait for it to end. Pipelines stay a list of steps, so the span is a pair:
- a Focus step that *starts* the session and returns at once;
- a Focus step that *waits* for it to end.

Everything between them runs during focus; everything after the wait runs after it. Steps in one item run in order, which is what makes this work.

Once started, the session belongs to the user: cancelling or failing the run never ends it. Pipeline jobs keep running during focus, because they are Toolbox's own processes (rule 2).

### 4.1 Focus step (`focus` module, `core.Chainable`)

```go
type StepOptions struct {
    Action    string            `json:"action"`    // "start" | "wait" | "end"
    ProfileID string            `json:"profileId"` // start; "" = a problem ("Pick a profile")
    Mode      string            `json:"mode"`      // start: "for" | "until"
    Minutes   int               `json:"minutes"`   // 1–720 (default 50)
    At        string            `json:"at"`        // "HH:MM"
    Strength  focus.Strength    `json:"strength"`  // default firm
    Extra     []focus.AllowRule `json:"extra"`     // ≤ 20
    OnStart   string            `json:"onStart"`   // "close" | "leave" (default close)
    IfActive  string            `json:"ifActive"`  // start: "extend" | "wait" | "fail" (default extend)
}

// Job options (made by PrepareStep):
type JobOptions struct {
    Action string             `json:"action"` // "start" | "end"
    Start  *focus.StartRequest `json:"start"`
    IfActive string           `json:"ifActive"`
    RunID  string             `json:"runId"`
}
```

| Action | PrepareStep | Job | Variables |
|---|---|---|---|
| **Start** | Idle → one `focus` job. Active and `IfActive = wait` (without SkipWait) → `ErrWaitingUntil("Waiting for the focus session to end", "", EndsAt)`. Active and `fail` → `focus_active`. | Begins the session (`RunID`/`StepID` set). If one is on: `extend` → `ExtendTo(this step's end)`, never earlier; extras aren't added and strength is unchanged. SkipWait on a wait behaves like `extend` | `{focus_ends}` (HH:MM, text), `{focus_minutes}` (number), `{focus_profile}` (text) |
| **Wait** | Session on and not SkipWait → `ErrWaitingUntil("Focus until 17:30", "", EndsAt)`. Otherwise zero jobs (done, inputs pass on). Continue now never ends the session | none | none |
| **End** | One `focus` job | `EndFor(runID)`: ends with reason `pipeline` if this run started it or its strength is soft. Otherwise `focus_not_yours`. No session → done (logged) | none |

- **All three.**
  - `NoFiles: true`, `Accepts{Any: true, URLs: true}`, `Produces: passThrough`.
  - Start and End jobs pass their inputs on: `StepOutputs` returns the job's inputs as `RunFile`s with their roles.
  - The editor defaults the next step's `From` to this step (it passes files through).
- **Parameters.** `Minutes`, `At` and `Strength` are parameters (Phase 16). `ProfileID` is a choice parameter whose choices are the profile names (`paramDefs.ts` loads them).
- **Other OSes.** With no backend (Linux), `DescribeStep` returns the problem "Focus Lock works on Windows and macOS". The Mac works (§1.7).
- **Wake-ups.** Focus changes call `Runner.WakeTimeWaits()` (R11), so a wait finishes as soon as a session ends early.

### 4.2 Open in app (`pipelines.open`, built-in)

This is the answer to "and whatever app I want running in the background": launch it from the pipeline. Because Toolbox started it, focus allows it and everything it starts.

```go
type OpenStep struct {             // step options
    App       string   `json:"app"`       // absolute .exe path (or a macOS .app); never a template, never bound
    Label     string   `json:"label"`     // "Ableton Live 12"
    Args      []string `json:"args"`      // ≤ 20; each a template: {vars}, {file}; an arg of exactly "{files}" = every file as its own argument
    Files     string   `json:"files"`     // "none" | "each" (one launch per file) | "all" (one launch)
    Window    string   `json:"window"`    // "normal" | "minimized"
    CloseWhen string   `json:"closeWhen"` // "never" | "focusEnds" | "runEnds"
}
type OpenJob struct {              // job options (expanded)
    App, Label string; Args []string; Window, CloseWhen, RunID string
}
```

- **Launching.** The job launches through `core/proc.Launch` and finishes once the process has started. It fails with `launch_failed` ("Couldn't open Ableton Live 12", hint "The program may have moved; pick it again") when:
  - the exe is missing;
  - the start fails;
  - the process exits non-zero within 2 s.
- **Focus.** The job calls `focus.Engine.NoteLaunch(App)` (R13) through a `Launcher` hook the module is given.
- **Files.** `none`: one launch, inputs pass through. `each`: one job per file. `all`: one job. Files always pass through.
- **App.** `App` is picked in the editor (app catalog, running apps, or Browse). It is never taken from a variable or a file. `Templates` lists only `/args/*`; `paramDefs` hides `app` from binds.
- **Closing.** `CloseWhen` closes **politely only**: `focus.AskToClose(pid, created, app)` sends WM_CLOSE (the Mac: the bundle quit), so Ableton gets to ask about saving.
  - Launches are remembered in memory (`modules/pipelines/open.go`).
  - `focusEnds` subscribes to the engine; `runEnds` uses `Runner.OnRunFinished`.
  - After a Toolbox restart they aren't closed.
- **Single-instance apps** (Discord) may hand off to a copy already running and exit 0. That's success, and the copy is judged by the policy as usual.
- **macOS.** `open -a <App> --args …` (§1.7). Closing uses the bundle path, so `focusEnds` and `runEnds` work there too.

`core/proc` gains (Wave 0 signature, O1 implements):

```go
type LaunchSpec struct { Path string; Args []string; Dir string; Minimized bool }
type Launched struct { PID uint32; Created int64 }
// launch_failed (CodeLaunchFailed) lives in modules/pipelines; proc.Launch returns plain errors and *ExitedEarlyError.
func Launch(ctx context.Context, s LaunchSpec) (Launched, error)
// Windows: windows.CreateProcess, ComposeCommandLine, CREATE_NEW_PROCESS_GROUP | CREATE_NEW_CONSOLE for console subsystem exes,
// STARTUPINFO.ShowWindow = SW_SHOWMINNOACTIVE when Minimized; no shell; Dir defaults to the exe's folder.
```

### 4.3 The app catalog (`modules/focus`)

- **`FocusService.Apps()`** lists installed programs from Start-menu shortcuts in `%ProgramData%` and `%APPDATA%` `\Microsoft\Windows\Start Menu\Programs` (recursive). They are resolved with the in-repo `.lnk` parser (R24); targets that aren't `.exe` or don't exist are dropped. Each app comes with:
  - its suggested rule (`SuggestRule(exePath)`: a folder rule at the install root);
  - its icon.

  Results are cached for 10 minutes.
- **Install root.**
  - Start from the exe's folder.
  - Go up one level when the folder is named `app-<version>`, `bin`, `Program`, `current`, or looks like a version (`\d+(\.\d+)+`).
  - If the result is a refused broad folder (§1.3), fall back to an exe rule.
  - Squirrel installs (`…\Discord\app-1.0.9xxx\Discord.exe`) get `…\Discord`, so updates don't break the rule.
  - `WindowsApps\<Name>_<version>_…` gets `WindowsApps\<Name>_*`.
- **`FocusService.Running()`** lists processes in the session that own a visible window, excluding Windows and Toolbox, de-duplicated by path. This is how Store apps like Windows Terminal are found.
- **`FocusService.AppIcon(path string) string`**: a 32 px PNG data URL, from `SHGetFileInfoW(SHGFI_ICON | SHGFI_LARGEICON)` → `GetIconInfo` → `GetDIBits`. Cached in `<support>/cache/focus-icons/` (keyed by path + mtime, pruned after 30 days). `""` on failure; the UI then shows a lettered tile.
- **First open.** The tool offers a "Studio" profile made from detected apps, with Discord, Claude, Visual Studio Code, Windows Terminal and Ableton Live preselected when found.

### 4.4 New templates (29–32, R14)

Where a template needs a profile or an app, the field is left empty and flagged, as other templates do.

Practical:
- **29. Music session**:
  1. Focus start (90 min, firm);
  2. Open in app (App empty, label "Your DAW", closes when focus ends);
  3. Focus wait.

  It takes no files.
- **30. Pomodoro ×4** takes no files. Run parameters: `work_minutes` = 25, `break_minutes` = 5.
  - Four rounds of Focus start (`minutes` ← `{work_minutes}`) → Focus wait → Wait (`minutes` ← `{break_minutes}`).
  - The last round has no break, so it has 11 steps.
- **31. Morning deep work**: a weekday schedule at 09:30 → Focus start (until 12:00, strict). It takes no files.

Just cool:
- **32. Sample, then make something**: a song link →
  1. Focus start (From none, 2 h);
  2. Download (audio, From input);
  3. Stems;
  4. BPM & key;
  5. Rename (`{name} · {bpm} BPM · {key}`);
  6. Open in app (Files none).

  The download and stems run inside the session, which shows that Toolbox's own work is never blocked.

---

## 5. UI

### 5.1 Focus tool (`frontend/src/tools/focus/FocusView.tsx`)

It's a form tool (it may scroll) with three states. It reads `state/focus.ts` (a zustand store fed by `FocusService.State()` and `focus:changed`).

**Idle**
- **Start card:**
  - profile chips (last used selected);
  - length presets 25 / 50 / 90 min / 2 h, plus **Until…** (a time field);
  - a strength segmented control (Soft / Firm / Strict), with a one-line explanation under it;
  - "Also allow for this session" (app chips + Add);
  - Start.
- **Profiles:** a list with app counts. The editor shows rules as dense rows (icon, label, path, a Children switch, remove) and **Add app**, which opens the app picker (`blocks/app-picker`) with tabs Installed / Running / Browse.
- **Always allowed:** the same row list. Below it, a read-only "Windows extras" disclosure (§1.3).
- **Learn mode:** a switch with "Watching since Tue · 14 programs would have been stopped" and the grouped list (§2.6).
- **Recent sessions** (last 10): date, profile, length, how it ended, blocked count.

**Active**
- A countdown ring with the end time ("until 17:30"), the profile name and the strength.
- **+15 min** and **+30 min**.
- **End early** (or **Emergency unlock** at strict), which opens the friction dialog (§2.3).
- **Blocked recently:** icon, name, times stopped, last time. Failed rows say why. Each row has **Allow for this session**, which costs the strength's friction.
- **Still open** (after an `OnStart: close` start): each app with Close again / Force close / Leave it.
- **Dry run:** a banner "Dry run: nothing is being stopped". It also shows in learn mode.

**Ended**: a one-line summary that stays until the next start: "Focused 1 h 30 min · stopped 6 launches (Steam ×4, Epic ×2)".

**Mac**: the same tool, plus the "On the Mac: …" line (§1.7). **Other OSes** (`supported: false`): a single message, "Focus Lock works on Windows and macOS". The profile editor stays usable.

**Friction dialog** (`tools/focus/FrictionDialog.tsx`):
- It shows the phrase.
- The input checks the phrase as you type (case and spacing exact, curly or straight apostrophe both accepted).
- It shows the countdown from `Friction.ReadyAt`.
- Confirm stays `aria-disabled` with the reason until both are satisfied.

### 5.2 Shell, tray, hotkey, toasts (Wave 2)
- **Shell:** while a session is on, a small pill in the top bar ("Focus · 42 min") opens the tool. The sidebar entry shows a dot.
- **Tray:** "Focus · 42 min left" (opens the tool) while active; "Start focus (<last profile>)" while idle (starts with the last profile, minutes and strength). Quit goes through §2.4.
- **Hotkey:** action `focusStart` ("Start focus with the last profile"), no default binding, labelled in Settings → General.
- **Toasts:** "Stopped Steam · Focus until 17:30", at most one per program per 60 s, batched like completion toasts.
- **Events:** `focus:changed` (`State`) and `focus:blocked` (`BlockEvent`). Both are typed, registered in `api/events.go`, and reach every window.

### 5.3 Pipelines UI
- **Step UIs:**
  - `pipelines/steps/focus.tsx`: an action switch, then that action's fields; the profile picker has "Edit profiles", which opens the Focus tool.
  - `pipelines/steps/wait.tsx`: For / Until, minutes or a time, a note.
  - `pipelines/steps/open.tsx`: the app picker from `blocks/app-picker`, an args list with variable chips, files mode, window, close when.

  `paramDefs.ts` entries give every new option a deliberate label.
- **Graph:**
  - Wait and Focus wait nodes show a clock badge.
  - A Focus start node and its matching Focus wait (the next Focus wait after it, in step order) are joined by a faint band behind the nodes, labelled with the session length. Pairing is the pure `focusSpans(steps)` in `editorModel.ts`.
  - It works in the editor and the run graph.
- **Schedule** (`panels.tsx`, next to Watch a folder and When I copy):
  - day chips (Mon–Sun, with Weekdays / Every day shortcuts);
  - a list of times;
  - "If Toolbox wasn't running: catch up within [30 min ▾]".

  The pipeline list shows "Next: Thu 09:30" or the schedule's message.
- **Runs without files:** a **Run** button on the card and in the editor (§3.5).
- **Run view:** a time-waiting cell shows its countdown ("Until 17:30 · 42 min") and **Continue now** (`PipelinesService.Continue`). A run started by a schedule is labelled "Scheduled".

---

## 6. Wiring, errors, dev safety, tests, acceptance

### 6.1 Wiring (`main.go`, Wave 0)

- **Startup.**
  - Build `focus.New(Options{Platform: focus.NewPlatform(), Store: db, DryRun: focusDryRun(), Emit: emitter.Emit})`.
  - `engine.Start(ctx)` runs after the store opens.
  - `focus.Register(reg, engine, runner.WakeTimeWaits)`, and add `focus.NewService(engine, jobs)` to Services.
- **Hooks.**
  - `engine.Subscribe(func(focus.State){ runner.WakeTimeWaits() })`.
  - Power resume: `app.Event.OnApplicationEvent(events.Windows.APMResumeAutomatic | APMResumeSuspend, …)` calls `engine.Resumed(); runner.Resumed()`.
  - `Options.ShouldQuit = shell.ShouldQuit`.
  - `modules/pipelines` gets `Launcher{NoteLaunch: engine.NoteLaunch, Subscribe: engine.Subscribe}`.
- **Config.** `Taskfile.yml dev:sandbox` and `.dev/p10-qa/dev.sh` set `TOOLBOX_FOCUS_DRYRUN=1`. `packs.BuiltIn` gains `focus`.

### 6.2 Dev safety
- In dry run the engine never calls `Terminate`, `AskToClose` or `ForceClose`. It records `wouldStop` and the UI shows the dry-run banner. Builders never run without it, because a real session would stop their own VS Code and terminal.
- Unit tests use a fake `Platform`: scripted snapshots, a fake clock, recorded stop calls.
- **One Windows integration test** (`-tags integration`, `TOOLBOX_FOCUS_E2E=1`, `core/focus/e2e_windows_test.go`):
  1. Build a tiny helper exe into `t.TempDir()`.
  2. Run the real platform with a fake `Self()` (a PID that isn't the test), `DryRun: false`, and `Scope` limited to descendants of the helper processes the test starts.
  3. Start a session whose profile allows a copy named `allowed.exe`. Launch `blocked.exe` and assert it's terminated within 1 s.
  4. Launch `blocked.exe` as a child of `allowed.exe` and assert it survives.

  It terminates nothing it didn't spawn.

### 6.3 Tests
- **Policy (table):**
  - every rule in order;
  - `%SystemRoot%` not conferring (explorer → steam blocked);
  - Code → powershell → go allowed;
  - a Squirrel launcher whose parent exited;
  - PID reuse (parent `Created` after the child's);
  - unknown path allowed;
  - another session ignored;
  - folder rules with `%VARS%` and the one `*` segment;
  - broad folders refused;
  - Toolbox descendants and `Launched`;
  - Windows extras.
- **Loop:**
  - each (PID, Created) decided once;
  - a blocked parent's fast children terminated;
  - dry run never stops anything;
  - `EndsAt` passed during "sleep" (a fake clock jump) ends the session on the next tick and on `Resumed()`;
  - 10 failed snapshots end it with `error`;
  - `close` start: windowed processes are asked, windowless ones are left, and StillOpen is listed after 10 s.
- **Sessions:**
  - start/extend/end/emergency at each strength;
  - phrase and countdown (`focus_countdown` before `ReadyAt`);
  - resume after a restart; ended while closed;
  - isolation from profile and Always-allowed edits;
  - `EndFor` refuses other runs' sessions unless they're soft;
  - quit release.
- **Store:** round trips and event pruning.
- **Runner timing:**
  - `ErrWaitingUntil` retried at `Until`, not every 5 s;
  - the wall-clock check fires a wait the monotonic timer missed;
  - a persisted `Until` survives a restart;
  - Continue now sets `SkipWait`;
  - a Wait "for 25" keeps its deadline across a restart;
  - "until" picks tomorrow when today's time has passed;
  - time waits don't count in `NeedsYou`;
  - `WakeTimeWaits`;
  - `OnRunFinished` is called once per run.
- **Runs without files:**
  - one item;
  - inputs refused;
  - a together step in an inputless run;
  - watch and clip problems.
- **Schedule:**
  - next fire across days;
  - catch-up fires only the latest missed slot within the window;
  - overlap skip with message;
  - DST gap and repeat (`America/Los_Angeles` 2026-03-08 and 2026-11-01, via `time.LoadLocation` with a fixture clock);
  - no double fire after a restart;
  - validation.
- **Steps:**
  - Focus start/wait/end against a fake engine: extend never shortens; `wait` waits until `EndsAt`; SkipWait;
  - Open in app with a fake launcher: argument expansion including `{files}`, `each` vs `all`, `App` never expanded, close on focus end sends a close, not a terminate.
- **`.lnk` parser:** fixtures written by the test (header + LinkInfo; the environment block; a relative path), plus a real Start-menu sweep behind `TOOLBOX_FOCUS_E2E`.
- **Phase 14/16 rules:**
  - `TestEveryToolIsAPipelineStep` and `everyTool.test.tsx` pass with Focus;
  - `TestEveryToolIsInOnePack` passes (built in);
  - `params.test.ts` passes with every new option labelled;
  - `pipeline_vars_test.go` lists `focus_ends` (text), `focus_minutes` (number), `focus_profile` (text) and `weekday`.
- **Frontend:**
  - the friction dialog (countdown, phrase, apostrophes);
  - `focusSpans` (pure, table-tested);
  - schedule editor validation;
  - the Run button for pipelines without files;
  - the Focus view's three states against a fixture store;
  - the app picker tabs.

### 6.4 Acceptance (on the Windows PC, a real build, not the sandbox)
1. With learn mode on for a normal day, the would-stop list contains no Windows component, and clicking it into a sensible Always allowed list takes under 5 minutes.
2. A real 25 min firm session with the Studio profile:
   - Discord, Claude, VS Code (with a terminal running `go test`) and Ableton (scanning plugins) all work normally;
   - Steam, a browser and Notepad++ launched from the Start menu are stopped within 0.5 s, with a toast.
3. Dropping a song link on "Sample, then make something" downloads and splits stems during the session and opens Ableton, which isn't stopped.
4. Quitting Toolbox mid-session through the friction and relaunching it resumes the session with the right time left.
5. "Morning deep work" fires at 09:30 on a weekday.
   - With the PC asleep at 09:30 and woken at 09:45, it fires once at wake.
   - Woken at 10:15, it doesn't fire.
6. CPU for the Toolbox process during an idle session stays under 0.5% of one core (Task Manager, 1 min).

The architect runs 2–4 and 6 at the end of the phase. 1 and 5 need a day and a sleep, so they are listed for you in the summary.

---

## 7. Work packages

### Wave 0 — foundation (architect, sequential, on main)
1. DECISIONS.md: the §R entries and the §0 amendment.
2. CLAUDE.md:
   - the §0 rules;
   - a "Focus Lock and pipeline timing (Phase 18)" section;
   - `TOOLBOX_FOCUS_DRYRUN`.

   Also `Taskfile.yml`, `.dev/p10-qa/dev.sh`, and a ROADMAP row for Phases 17 and 18.
3. Frozen contracts:
   - `core/focus/types.go` (everything in §1.2 and §2.1) and the `Engine` stubs;
   - `core.ErrWaitingUntil`, `WaitingUntil`, `AppError.Until`, `WaitTime`, `RunCell.Until`, `StepRequest.Until/SkipWait`;
   - `ScheduleTrigger`, `ScheduleState`, `Pipeline.Schedule`, `PipelineEntry.Schedule`, `PipelineCheck.TakesFiles`;
   - the `PipelineStore` methods, the Runner method stubs (`Resumed`, `WakeTimeWaits`, `OnRunFinished`);
   - `WaitOptions`, `OpenStep`/`OpenJob`;
   - `proc.LaunchSpec/Launch` (stub) and `focus.AskToClose` (stub);
   - `HotkeyFocusStart`.
4. Migration `0008_focus_schedule.sql` and empty `core/store/focus.go` methods returning `NotImplemented`.
5. Skeletons and wiring:
   - the `modules/focus` skeleton (module, `Chainable` with real `StepDefaults`/`DescribeStep`, stub `PrepareStep`, a service with stub methods, `StepShape()`);
   - `pipelines.wait` and `pipelines.open` registered as built-ins with stub adapters;
   - the `main.go` wiring of §6.1;
   - `packs.BuiltIn`;
   - bindings regenerated, types re-exported from `lib/api.ts`;
   - new icons in `Icon.tsx` (`focus`, `timer`, `app-window`, `calendar-clock`);
   - `tools/index.ts` and `shell/keywords.ts` entries;
   - **stub** `StepUI`s for focus/wait/open, so every check stays green.
6. Frozen props for the app picker: `frontend/src/blocks/app-picker/types.ts`.
7. Spike: time one snapshot plus a path batch on this PC; record it.
8. Run every check, then create the integration branch for Wave 1.

### Wave 1 — parallel builders

| Package | Scope | Owns | Needs |
|---|---|---|---|
| **F1 Engine** | Policy, loop, Windows platform, other-OS stub, sessions, friction, persistence, resume, learn mode, events, `AskToClose`, the E2E test | `core/focus/**`, `core/store/focus.go` (+ test) | Wave 0 |
| **F2 Focus module** | `FocusService` (state, profiles, start/extend/weaken, still-open actions, Apps, Running, AppIcon, learn list, Always allowed), the Focus step (`PrepareStep`, the job's `Run`, `StepOutputs`), the `.lnk` parser, install-root guessing | `modules/focus/**` | Wave 0 (F1 through the `Engine` API; tests use a fake engine interface defined in the module) |
| **T1 Runner timing** | Time waits, wall-clock check, `Resumed`/`WakeTimeWaits`/`OnRunFinished`, Continue now on time waits, runs without files, schedule trigger (fire, catch-up, overlap, DST, Describe problems, validation), `{weekday}`, the Wait step adapter | `core/pipeline/**`, `core/store/pipelines.go` (+ tests), `modules/pipelines/wait.go` (+ test), the `weekday` line in `modules/pipelines/adapter.go` | Wave 0 |
| **O1 Open in app** | The `open` built-in (Describe, Prepare, the job action, close-when tracking), `proc.Launch` on Windows and macOS | `modules/pipelines/open*.go`, the `open` case in `modules/pipelines/run.go`, `core/proc/launch*.go` | Wave 0 |
| **U1 Focus UI** | `FocusView` and its states, the friction dialog, the app picker, the focus store | `frontend/src/tools/focus/**`, `frontend/src/blocks/app-picker/**`, `frontend/src/state/focus.ts` | Wave 0 |
| **U2 Pipelines UI** | Step UIs for focus, wait and open (replacing the stubs), `paramDefs` entries, the schedule editor, the Run button, span bands, clock badges, the countdown and Continue now, the `weekday` var | `frontend/src/pipelines/**`, `frontend/src/tools/pipelines/**` | Wave 0 (picker props) |

### Wave 2 — after Wave 1 merges

| Package | Scope | Owns | Needs |
|---|---|---|---|
| **S1 Shell and tray** | Top-bar pill, sidebar dot, tray items, `ShouldQuit` and the quit dialog route, the `focusStart` hotkey (desktop action + Settings label), focus toasts | `desktop/**`, focus pieces of `frontend/src/shell/**`, the hotkey row in `frontend/src/views/settings/**` | F2, U1 |
| **P1 Templates and E2E** | Templates 29–32 (+ describe/binds tests), the acceptance helpers | `modules/pipelines/templates*.go` | T1, O1, F2 |

The architect does the final CLAUDE.md pass, the sandbox QA and the acceptance run (§6.4).

---

## 8. Open questions (defaults chosen; change them before approving)

- [x] **The §0 rule amendment.** Approved.
- [x] **Mac in this phase?** Yes: it's cross-platform, with the gaps named (§1.7). Windows is the primary machine (CLAUDE.md corrected).
- [ ] **Elevated processes.** Default: reported, not stopped. Stopping them needs an elevated helper (a Windows service: install/UAC flows and a privileged IPC channel).
- [ ] **Default strength:** Firm, with a 30 s countdown and the phrase "I'm choosing to stop early".
- [ ] **Starting with apps open:** default is to ask windowed apps to close (`close`). Note that this closes an open browser, which restores its tabs next time. `leave` only blocks new launches.
- [ ] **Task Manager.** Default: allowed (it's under `%SystemRoot%`), which keeps the escape hatch obvious.
- [ ] **Browsers.** Not in any default profile. Allowing one allows every site.
- [ ] **Apps opened from Toolbox** (Open on a result, Reveal, links that open a browser) start as Toolbox's children, so they're allowed during focus (rule 2). Default: keep that ("you opened it from Toolbox"). The alternative is to have rule 2 cover only processes Toolbox runs through `core/proc`.
- [ ] **Windows extras list** (§1.3, R23). Default: the four folders listed. Learn mode will show if more are needed.

### Later
- Focus triggers: "when a focus session starts / ends" as pipeline triggers, and "only while focusing" on watch folders.
- A statistics view: focused time per week, most-blocked apps.
- Window-title rules and per-site browser blocking.
- An optional elevated helper.
- Syncing profiles to the Mac over Local File Transfer once a Mac backend exists.
