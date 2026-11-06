# Toolbox — Phase 13 Spec: Local File Transfer

Status: **BUILT 2026-11-04 (approved), uncommitted for review.** This phase changes an app rule: Toolbox listens on the local network for the first time (CLAUDE.md amended). The foundation (types, stubs, wiring) is in `core/lan/types.go`, `core/lan/runtime.go` and `modules/lanshare/`; where this spec and those files differ in detail, the files win.

The user asked for it on 2026-11-04: "it should be able to do local file transfer actually because that is so sick to do between your own two computers like mac laptop and windows desktop."

Phase 15 is archived in `docs/specs/phase-15.md`. Phase 16 (parameters as inputs and the value colour system) was asked for directly and is specced in `docs/specs/phase-16.md`. Every Phase 14/15 rule still holds:
- every tool is an automatic pipeline step with a `StepUI`, with no exemptions;
- every file row is draggable and has Send to;
- the polish rules apply.

---

## 0. The rule amendment (needs your OK)

CLAUDE.md "App rules" currently says: *"No network listeners. Open no ports. If a local server ever becomes unavoidable, bind 127.0.0.1 only with a random per-launch token."*

On approval it becomes:

> - **No network listeners, with one exception: Local File Transfer** (`core/lan`, `modules/lanshare`). It may listen on the local network (TCP and UDP multicast, port 53317 by default) **only while receiving is on**, which only the user turns on. It accepts connections only from private, link-local and Tailscale-range (100.64.0.0/10) addresses, speaks only HTTPS (TLS 1.3 with a self-signed per-install certificate), and writes received files only into `<library>/Received/`. Nothing else in the app listens on a non-loopback address. Any other local server binds 127.0.0.1 only with a random per-launch token.
> - **Never build with the Wails `server` or `mcp` build tags** (unchanged).

The Local Chat engine's loopback rule is unchanged. The Phase 15 placeholder (`lan-share` in `modules/placeholders`) is replaced by the real tool.

## 1. Goals
1. **Your own computers first.** Toolbox on the Mac laptop and Toolbox on the Windows desktop find each other, pair once with a matching 6-digit code, and then send files and folders to each other in one drag. A paired device can be set to **accept automatically**, so you don't have to walk over to the other computer.
2. **Phones and everything else via LocalSend.** Toolbox speaks the LocalSend protocol v2 (HTTPS mode), so the free LocalSend apps on iPhone, Android, Mac, Windows and Linux can send to Toolbox and receive from it. LocalSend senders can't prove who they are (§4.3), so their transfers always ask.
3. **It composes.**
   - Received files are library outputs: `ResultRow`s that are draggable, with Send to.
   - Any file row or folder can be dropped on a device to send it.
   - "Send to a device" is a pipeline step.
   - Text can be sent and received too, for links and snippets.
4. **Off unless you turn it on, and obvious when on.** Receiving has three settings: Off (the default), While this tool is open, and Always (while Toolbox runs). The tray and the tool header always show when Toolbox is receiving.

## 2. Non-goals
- The LocalSend **download API** (browser share over plain HTTP). It would serve files to anyone who asks.
- **Plain-HTTP** LocalSend peers, whether that means sending to them or accepting from them. LocalSend's "Encryption" setting is on by default; Toolbox shows such devices as "Encryption off on that device" and won't use them.
- Anything over the internet: no relays, NAT traversal or cloud. Tailscale works because its addresses are reachable directly; add the device by address, since multicast doesn't cross it.
- Folder sync, clipboard sync, resume of interrupted transfers.
- Marking received files as downloaded (Mark-of-the-Web / quarantine). They come from your own devices, and the flag would make Office open them read-only. Recorded in DECISIONS.

## 3. Architecture

```
core/lan/             pure Go, no Wails, no modules: the protocol
  identity.go         self-signed ECDSA P-256 cert (10 y), fingerprint, short code
  wire.go             LocalSend JSON types (announce/register/prepare-upload), constants
  addr.go             allowed remote addresses, local interface addresses
  names.go            received-name sanitising + unique names
  discovery.go        multicast announce/listen (injectable PacketConn), subnet scan
  server.go           HTTPS server: register, info, prepare-upload, upload, cancel, toolbox pair
  client.go           pinned HTTPS client: register, prepare-upload, upload, cancel, pair
  devices.go          the known-device store (devices.json)
  runtime.go          Runtime: owns listener lifecycle, sessions, prompts, events
modules/lanshare/     the `lan-share` module (send jobs), hidden `lan-receive` module, service, pipeline step
frontend/src/tools/lan-share/   the tool view, the incoming-transfer prompt, the settings click-in
frontend/src/pipelines/steps/lanshare.tsx   "Send to a device" step editor
```

- `core/lan` depends only on the stdlib and `golang.org/x/net/ipv4`/`ipv6` (multicast joins per interface). It knows nothing about jobs. It hands accepted sessions to a `SessionSink` interface (§3.3).
- `modules/lanshare` implements the sink with jobs, so incoming files get progress, cancel, logs and library outputs exactly like any job.

### 3.1 Identity
- `<support>/lanshare/identity.pem` holds the certificate and key (PEM, 0600), created on first use.
  - Subject CN = alias.
  - Serial random; not-before = now − 1 h; validity 10 years.
  - SAN: none (peers pin the fingerprint, not names).
- **Fingerprint** = lowercase hex SHA-256 of the certificate DER, which is how LocalSend defines it in HTTPS mode. Compare fingerprints case-insensitively.
- **Short code** = the first 4 hex characters, upper-case, shown as "This computer · 4F2A".
- **Pair code** for two devices = `SHA-256(sort(fpA, fpB) joined by "|")`, first 6 decimal digits (big-endian uint32 of the first 4 bytes mod 1,000,000, zero-padded). It's the same on both screens.
- **Alias** defaults to the OS hostname with the domain removed. It can be changed in settings (1–64 chars, trimmed).
- `deviceModel` = "Toolbox"; `deviceType` = "desktop".

### 3.2 Wire format (LocalSend v2, HTTPS)
The reference is the LocalSend protocol README (v2.x).
- **Multicast:**
  - group 224.0.0.167 and `ff12::167`, port 53317;
  - join on every up, multicast-capable interface that has an allowed address (§3.5).
- **Announcement** (a JSON UDP datagram, ≤ 8 KiB):
  `{alias, version:"2.1", deviceModel:"Toolbox", deviceType:"desktop", fingerprint, port, protocol:"https", download:false, announce:true, toolbox:1}`.
  - `toolbox` is an extension field.
  - LocalSend ignores unknown fields. A builder must confirm this with a fixture from the LocalSend repo and record it.
- **Answering** an announcement with `announce:true` from someone else:
  1. `POST https://<ip>:<their port>/api/localsend/v2/register` with our info.
  2. If that fails within 2 s, send a UDP multicast reply with `announce:false`.
- **Server routes** (base `/api/localsend/v2`):

| Route | Behaviour |
|---|---|
| `POST /register` | Records the caller as a nearby device; answers with our info. Allowed while listening. |
| `GET /info` | Our info (debug route in LocalSend; kept for compatibility). |
| `POST /prepare-upload?pin=` | §4. Returns `200 {sessionId, files:{id:token}}`, or `204` (text-only, handled), `400` bad body, `401` PIN needed or wrong, `403` declined / not allowed, `409` another session or prompt active, `429` rate limit, `500`. |
| `POST /upload?sessionId&fileId&token` | Raw bytes. Returns `400` missing params, `403` bad token or a different IP from the prepare, `409` session gone, `422` size or sha256 mismatch, `500`. |
| `POST /cancel?sessionId` | Cancels the session (same IP only). |
| `POST /api/toolbox/v1/pair` | Toolbox extension, §4.4. Requires a TLS client certificate. |

  Everything else is `404`. No download routes exist.
- **Request limits:**
  - JSON bodies ≤ 1 MiB;
  - ≤ 10,000 files per session;
  - each name component ≤ 255 bytes, path depth ≤ 16;
  - `ReadHeaderTimeout` 10 s;
  - an upload with no bytes for 60 s fails the session.
- **TLS:** `MinVersion` TLS 1.2 (LocalSend's Dart stack), preferring 1.3. The server uses `ClientAuth: tls.RequestClientCert` and never verifies a chain; it only records the presented certificate's fingerprint.
- **Client** (sending): always presents our identity certificate.
  - It pins the peer: `InsecureSkipVerify` plus `VerifyPeerCertificate`, which requires the leaf's fingerprint to equal the device's known fingerprint. A mismatch fails with `CodeLanWrongDevice`: "This isn't the device you paired with".
  - Timeouts: connect 3 s; prepare-upload waits up to 5 minutes (the other side may be asking its user); upload idle 60 s.

### 3.3 Runtime (core/lan)

```go
type Config struct {
    Dir        string           // <support>/lanshare
    Alias      func() string
    Settings   func() Settings  // receive mode, from, pin
    Sink       SessionSink      // modules/lanshare
    Emit       func(name string, data any) // core events
    Port       int              // 0 = 53317 with fallback; tests pass a fixed port
    AllowLoopback bool          // tests only
    Packet     PacketFactory    // nil = real multicast; tests inject
    Now        func() time.Time
}
type Settings struct { Receive ReceiveMode; From FromMode; PIN string }
type ReceiveMode string // "off" | "open" | "always"
type FromMode string    // "mine" (paired devices only) | "anyone" (asks every time)

type SessionSink interface {
    // Accepted is called once a prepare-upload is accepted; files stream in through sess.
    Accepted(sess *IncomingSession) error
}
type IncomingSession struct { ID string; From Device; Verified bool; Files []FileMeta; /* Next(ctx) (FileStream, error); Cancel() */ }

func New(cfg Config) (*Runtime, error)
func (r *Runtime) Hold(key string)           // "open" mode: a window shows the tool; expires after 30 s without renewal
func (r *Runtime) Release(key string)
func (r *Runtime) Apply()                    // settings changed: start/stop listening
func (r *Runtime) State() State
func (r *Runtime) Devices() []Device
func (r *Runtime) Scan(ctx context.Context)  // announce + subnet scan; results via events
func (r *Runtime) AddByAddress(ctx context.Context, host string, port int) (Device, error)
func (r *Runtime) Pair(ctx context.Context, fp string) (code string, err error) // blocks until the other side answers (≤ 90 s)
func (r *Runtime) Respond(promptID string, accept, always bool) error
func (r *Runtime) Forget(fp string) error
func (r *Runtime) SetAutoAccept(fp string, on bool) error
func (r *Runtime) Client() *Client            // used by send jobs
func (r *Runtime) Close() error
```

- **Listening** is on when `Receive == "always"`, or when `Receive == "open"` and at least one hold is live.
  - It is off when the app is quitting or the receive mode is off.
  - Starting binds TCP `:53317` (all interfaces; the connection filter is §3.5) and the multicast socket, then announces 3 times (0, 1, 3 s).
  - **Port busy** (for example, the LocalSend app runs on the same computer): bind a random port and announce that one. LocalSend peers use the announced port. `State.Port` shows it.
  - **Stopping** closes the listener and the multicast socket, cancels any incoming session and rejects any open prompt.
  - Listening never starts at app launch unless the mode is "always".
- **Sending and scanning never need a listener.**
  - `Scan` sends one multicast announcement from an ephemeral socket. That reaches LocalSend devices, which answer with `POST /register`; we only see that when listening.
  - It also does an outbound **subnet scan**: `POST /register` to every host of each local /24 with an allowed address (≤ 1,024 hosts total), 64 at a time, 1 s timeout.
  - It also tries every known device's last address.
  - A device seen in the last 2 minutes is "online".
- **Events**:
  - `lanshare:state` with `State {listening, mode, port, addresses[], alias, fingerprint, shortCode, error}`;
  - `lanshare:devices` with `[]Device`;
  - `lanshare:prompt` with `Prompt {id, device, verified, files[{name,size,type}], totalBytes, text?, canAlways, expiresAt}`, plus `lanshare:prompt-closed {id}`;
  - `lanshare:message` with `{from, text, at}`.
  - All are typed core events (`core/events.go`) so the bindings carry them.

### 3.4 Known devices (`<support>/lanshare/devices.json`, ≤ 100 entries)

```go
type Device struct {
    Fingerprint string; Alias string; DeviceType string; DeviceModel string
    Toolbox bool        // announced toolbox:1 and presented its cert on pair
    Paired bool         // mutual pairing done (§4.4)
    AutoAccept bool     // only settable when Paired && Toolbox
    Address string; Port int; Protocol string
    LastSeen int64      // unix ms
    Online bool         // computed, not stored
}
```

- Devices that are only nearby (never paired, never sent to) aren't stored; only paired devices and devices you sent to are.
- Forget removes the device. It doesn't tell the other side.
- Writes go to a temporary file in the same directory, then rename.

### 3.5 Who may connect
- **Allowed remote addresses:** 10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10, fc00::/7 and fe80::/10, plus loopback only when `AllowLoopback` is set (tests). Anything else is closed right after accept, before TLS.
- **Rate limit:** ≤ 20 requests per second per IP across all routes, and ≤ 10 prepare-uploads per minute per IP (`429`).
- **One session at a time:** while a prompt is open or a session is receiving, other prepare-uploads get `409`.

## 4. Receiving

### 4.1 Decision for a prepare-upload, in order
1. Receiving off: the server isn't listening.
2. Bad body or limits exceeded → `400`.
3. The sender is **verified** when it presented a TLS client certificate. Its fingerprint is then that certificate's, not the claimed `info.fingerprint`.
4. `From == "mine"`, and the sender isn't a verified paired device → `403`. Nothing is shown; the activity log gets one line, "Turned away a transfer from <alias> (not one of your devices)".
5. A PIN is set, the sender isn't a verified paired device, and `pin` is missing or wrong → `401`. After 5 wrong PINs from one IP, that IP gets `403` for 10 minutes.
6. Not enough free space for the total plus 512 MiB → `403`, with an activity line saying how much space was needed.
7. **Text only:** every file is `text/plain`, has a non-empty `preview` and is ≤ 64 KiB.
   - The text appears as a message: in the tool and as a toast, with Copy and "Save as a file".
   - The reply is `204`.
   - For an unverified sender who isn't trusted, a prompt asks first, and declining gives `403`.
8. A verified paired device with `AutoAccept` → accept.
9. Otherwise → **prompt** (§4.2): accept → `200`; decline or timeout (60 s) → `403`.
10. **On accept:**
    - one 128-bit random token per file;
    - the session is bound to the sender's IP;
    - `SessionSink.Accepted` creates the receive job.

### 4.2 The prompt
- A dialog in the main window, shown whatever view is open. If the window is hidden, it is shown (`ShowMain`). Pop-out windows don't show prompts.
- It shows:
  - the device alias with a verified lock, or "Can't confirm who this is" for unverified senders;
  - the number of files and total size;
  - the first 5 names, then "and 12 more";
  - the text, for messages;
  - a 60 s countdown.
- Buttons: **Accept** (primary, Enter) and **Decline** (Esc).
- "Always accept from this device" appears only when the sender is a verified paired Toolbox device that has AutoAccept off.
- Accepting focuses nothing; the transfer appears in the tool's activity and as a job.
- The tray tooltip becomes "Toolbox — <alias> wants to send you files" while a prompt is open.

### 4.3 Trust, in one table

| Sender | Verified | Can auto-accept | Notes |
|---|---|---|---|
| Toolbox, paired | yes (client cert pinned on pair) | yes, if you turn it on | your own computers |
| Toolbox, not paired | yes | no (pair first) | |
| LocalSend app | no (sends no client cert; its fingerprint is a claim) | no | always asks; PIN optional |

### 4.4 Pairing (Toolbox ↔ Toolbox)
1. A nearby device with `toolbox:1` shows **Pair**. Clicking it makes a mutual-TLS `POST /api/toolbox/v1/pair {alias}` to that device, with our certificate pinned in theirs.
2. The receiver must be listening and must have a client certificate; otherwise `403`.
   - It shows a pair prompt: "Pair with <alias>? Check that both screens show **482 911**", with Pair / Decline and a 60 s timeout.
   - On Pair it stores us as `Paired, Toolbox` and answers `200 {alias}`. We store it the same way.
3. Both sides show the code. The sender's dialog shows "Waiting for <alias>…" with the code and Cancel.
4. Pairing never turns on AutoAccept. That is a per-device toggle on the receiving side ("Accept from <alias> without asking").

### 4.5 Where files go
- Received files go to `<library>/Received/<device alias>/`.
  - Relative folders in `fileName` ("Trip/IMG_1.jpg") are kept after sanitising.
  - A name never overwrites; a collision gets " (2)", " (3)", and so on.
- **Sanitising** (`names.go`, table-tested), applied per component:
  - NFC; strip control characters and `< > : " | ? * \`;
  - drop leading and trailing spaces and dots;
  - refuse `.` and `..` (`400`);
  - Windows reserved names (CON, PRN, AUX, NUL, COM1–9, LPT1–9, with any extension) get a `_` suffix;
  - an empty result becomes `file`;
  - the alias folder is sanitised the same way.
- Each file streams to `<job TempDir>/<n>.part`. When it's complete:
  - the size must match the declared size (`422` and the session fails otherwise);
  - if `sha256` was given, the hash must match (`422`);
  - the file is renamed into place and registered with `job.Output`, and `metadata.modified` is applied as its mtime when present.
- Received files are never opened, executed or unpacked.

## 5. Sending
- **Module `lan-share`** ("Local File Transfer", icon `arrow-left-right`, category Utility, built in).
  - It is a job module whose inputs are files and folders. `Accepts`: any file, folders allowed.
  - Options:

```go
type Options struct {
    Device string `json:"device"` // fingerprint
    Text   string `json:"text"`   // optional message (≤ 64 KiB), sent alone or before the files
    PIN    string `json:"pin"`    // only for this job; never stored in job options in the DB: the service puts it in an in-memory map keyed by job ID (PDF passwordRef pattern) and Options carries pinRef
}
```

  - The PIN travels as `PinRef string`, never as `PIN`. The struct above is what the UI sends to `Send`; the service converts it.
- **The send job:**
  1. Resolve the device and its last address. Probe with `POST /register`; if the device is unreachable, rescan once. If it's still unreachable, fail with `CodeLanOffline`: "<alias> isn't on this network right now" (hint: "Open Toolbox or LocalSend on it and make sure it's receiving").
  2. Expand folders: files are sent with their relative paths under the folder's name; hidden files and symlinks are skipped.
  3. Send `prepare-upload` with `sha256: null`. The job shows "Waiting for <alias> to accept…" with indeterminate progress.
  4. Upload ≤ 3 files in parallel; progress is bytes over total.
  5. Map the responses:
     - `204` → done ("Delivered as a message");
     - `401` → `CodeLanPinRequired`. The UI shows a PIN field and resubmits.
     - `403` → `CodeLanDeclined`: "<alias> declined";
     - `409` → `CodeLanBusy`: "<alias> is busy with another transfer";
     - `422` → retry that file once, then fail.
  6. On cancel: `POST /cancel`, then stop.
- Inputs are only read, never changed. The job has no outputs and returns a result `{device, files, bytes}`.
- **Receive jobs:** hidden module `lan-receive` ("Received files"), `OutputSubdir` "Received".
  - Submitted by `SessionSink.Accepted` with no inputs. `Run` drains the session's file streams.
  - Title: "From <alias> · 12 files".
  - Cancelling the job cancels the session (the sender gets an error on its next upload).
  - `Hidden: true`, so it isn't a sidebar tool and needs no step.

### 5.1 Service (`modules/lanshare/service.go`, `LanShareService`)

```go
State() lan.State
Devices() []lan.Device
SetReceive(mode lan.ReceiveMode) error
Settings() LanSettings                      // {alias, from, pinSet bool}
SetSettings(s LanSettingsInput) error       // {alias, from, pin *string (nil = unchanged, "" = clear)}
Hold(windowKey string)                      // renewed every 10 s by the view while it is mounted and the document is visible
Release(windowKey string)
Scan()
AddByAddress(host string, port int) (lan.Device, error)
Pair(fingerprint string) (string, error)    // returns the code once paired
CancelPair()
Respond(promptID string, accept bool, always bool) error
Forget(fingerprint string) error
SetAutoAccept(fingerprint string, on bool) error
Send(fingerprint string, paths []string, text string, pin string) ([]core.Job, error)
Messages() []lan.Message                    // in memory, last 50, cleared at quit
ClearMessages()
StepShape() StepOptions
```

Settings (in the settings DB): `lanShare.receive`, `lanShare.alias`, `lanShare.from` (default `"anyone"`) and `lanShare.pin`. The PIN is a short shared code, not a credential of yours; it is kept in settings and never logged.

### 5.2 Pipeline step: "Send to a device" (`lan-share`, `core.Chainable`)
- **Options:** `{device: fingerprint, waitMinutes: 0..1440 (default 30), text: ""}`. `text` takes `{vars}` (template pointer `/text`).
- **Accepts:** any file. `PrepareStep` groups all of an item's files into one job.
  - If the device isn't online, it returns `core.ErrWaiting("Waiting for <alias> to be on the network")`. The runner retries; after `waitMinutes` the step fails with `CodeLanOffline`.
- **Produces:** the same files with role `sent` (pass-through), so steps can follow it. Vars: `device` (alias).
- **Validation:** a device must be chosen and must be a known device. Only paired Toolbox devices and devices you sent to before can be picked; the picker lists them.
- An automatic step to an unverified LocalSend device still works, but that device will ask its user. The step's summary says so.
- **Template** (Practical group): "Shrink photos and send them to my other computer": Image Batch (2048 px, strip location) → Send to a device, with the device flagged for the user to pick.

## 6. UI

### 6.1 The tool (`tools/lan-share/LanShareView.tsx`)
This is a workspace-free form tool that follows the polish rules.
- **Header** (`ToolHeader`): the receiving control is a compact segmented control: **Off · While open · Always**.
  - A green dot and "Receiving on 192.168.1.20" show while listening.
  - The header's primary action is **Send…**, which picks files and then a device.
- **Body:** two regions side by side at ≥ 1100 px wide, stacked below that (`useElementSize`).
  1. **Devices** (a dense list):
     - Your devices (paired) come first, then Nearby, then Other.
     - Each row: a device-type icon, the alias, a tag (Toolbox / LocalSend), a lock when verified, and an online dot with "seen 2 min ago".
     - Hover actions: **Send…**, **Pair** (Toolbox, unpaired), **Accept without asking** (a toggle on paired devices), **Forget**.
     - **Each row is a file drop target.** Drop files or folders (OS or in-app drags, via `data-file-drop-target`) and they are sent to that device. A dropped *text* drag becomes a message.
     - Under the list are "Add by address…" (host and optional port) and a Refresh icon, which scans.
     - Empty state: "No devices yet. Open Toolbox or LocalSend on your other device, turn on receiving there, then Refresh."
  2. **Activity:**
     - Incoming and outgoing transfers as `JobRow`s while active;
     - received files as `ResultRow`s grouped by transfer ("From Nicole's MacBook · 12 files · 2 min ago", collapsible);
     - messages with Copy and Save as file;
     - one-line notes ("Turned away a transfer from …").
- **Queued files:** files handed to the tool (Send to, a sidebar drop, paste, Mod+O) wait in a strip above the devices, "3 files ready — drop them on a device or click Send on one", with Clear.
  - A **Message** field ("Send text…") sits next to it.
  - `useToolHandoff("lan-share", …)` takes hand-offs.
- **Bottom bar** (one line): "This computer · Nicole's Desktop · 4F2A · port 53317". A **Settings** click-in holds:
  - alias;
  - who can send ("Only my devices" / "Anyone nearby (asks every time)");
  - PIN;
  - the Received folder (opens it);
  - the firewall hint.
- **Firewall hint** (always in the settings drawer; also shown under the devices when listening and no one has registered for 2 minutes):
  - Windows: "If your other devices can't see this computer, allow Toolbox on private networks in Windows Security → Firewall."
  - macOS: "If asked, allow Toolbox to find devices on your local network."
- **Hold:** while mounted and visible, the view calls `Hold(windowKey)` every 10 s, and `Release` on unmount. Only the "While open" mode uses holds.
- **Fits** at 1180×720 and 960×600.

### 6.2 Shell
- `tools/index.ts` gains `shellOverlays: ComponentType[]`. The main window's shell renders them; this phase registers `LanSharePrompt`, which covers both the transfer and pair prompts.
- Messages and completed receives raise a toast (batched like job toasts) with **Show**.
- The sidebar entry shows a small dot while receiving.
- The palette gains "Start receiving files", "Stop receiving files" and "Send files to a device…". Keywords: send, share, transfer, airdrop, localsend, phone, wifi.

### 6.3 Tray (`desktop/`)
- While listening, the menu shows "Receiving files — <alias>" and "Stop receiving". The tooltip says so too.
- When receiving is off and the mode was "always", the menu offers "Start receiving files".
- Subscribe to `lanshare:state`.

### 6.4 macOS
- `build/darwin/Info.plist` and `Info.dev.plist` gain `NSLocalNetworkUsageDescription`: "Toolbox finds your other devices on this network and sends files to them when you use Local File Transfer."
- **Untested on a Mac in this phase.** The architect has only the Windows box. The Mac ↔ Windows check is yours (§8).

## 7. Errors (`core/errors.go` codes)
Each code has a message and a hint:
- `lan_offline`
- `lan_declined`
- `lan_busy`
- `lan_pin_required` (field `pin`)
- `lan_wrong_device`
- `lan_port_unavailable` (neither 53317 nor a random port could be bound)
- `lan_encryption_off` (the peer announced `protocol:"http"`)
- `lan_too_large` (the receiver refused for space)

Listener failures never crash the app. They show in `State.error` and in the header.

## 8. Tests and acceptance

**Go (`core/lan`):**
- **Table tests:** sanitising; allowed addresses; fingerprint, short code and pair code (fixed vectors); wire JSON against a LocalSend announcement and prepare-upload fixture copied from the protocol README (in `testdata/`, with its source noted).
- **Server tests** on loopback (`AllowLoopback`, fixed port, injected `PacketConn`), one subtest per §4.1 branch:
  - 200 → upload → done;
  - 204 text;
  - 401, and the PIN lockout;
  - 403 (mine-only, decline, prompt timeout);
  - 409, 429, 422 (size and sha), 400 (limits, `..`);
  - an upload from another IP (simulated with a test hook) → 403;
  - cancel;
  - verified vs unverified sender;
  - auto-accept only when verified and paired.
- **Client tests:** a wrong pinned fingerprint fails the handshake; a 5-minute prepare wait is cancellable.
- **Pair test:** two Runtimes in one process exchange certificates, show the same code and both store `Paired`.
- **Two-runtime transfer test:** a folder with nested names, a Unicode name and a 50 MB file. The files arrive byte-identical in `Received/<alias>/`, and the inputs are untouched.
- **Lifecycle tests:**
  - "open" mode stops listening 30 s after the last hold expires (injected clock);
  - "off" leaves no open sockets (the bound port is free afterwards);
  - a busy port falls back to a random one;
  - `Close` stops every goroutine (no leaks: the test waits on the runtime's done channel).

**Module:**
- The send job maps every status;
- the receive job registers outputs and cancels the session;
- step `Describe`/`Prepare`, `ErrWaiting` and the timeout.

**Root:** `TestEveryToolIsAPipelineStep` includes `lan-share` with no exemption, and the packs test has `lan-share` built in.

**Frontend:** the view's states (off, listening, no devices, devices, queued files, drop on a device sends), the prompt (accept, decline, countdown, "always" only when allowed), the pair dialog, the step UI, and `everyTool.test.tsx`.

**Sandbox QA (architect, Windows):**
- Two sandbox instances on the same machine, with support dirs `.dev/p13-qa/a` and `b`. The second takes the fallback port.
- Pair them, send a folder each way, accept once, then auto-accept, and send a message.
- Screenshots at 1180×720 and 960×600.

**Interop (manual, yours):**
- Mac Toolbox ↔ Windows Toolbox: pair, then send each way.
- A phone with LocalSend → Toolbox (it prompts), and Toolbox → phone.

**Acceptance:**
- `go build/vet/test`, `npm run check`, the production build and `gofmt` all pass.
- Every §8 test passes.
- With receiving Off, nothing listens: `netstat`/`Get-NetTCPConnection` shows no Toolbox socket on 53317 or any non-loopback address.
- CLAUDE.md carries the amended rule plus a "Local File Transfer (Phase 13)" section.

## 9. Work packages

**Architect, first (sequential):**
- the rule amendment in CLAUDE.md;
- `core/lan/types.go` (all exported types in §3.3–3.4, `State`, `Prompt`, `Message`, the error codes and the event names) with stub functions;
- `modules/lanshare` service signatures returning stubs;
- `main.go` wiring and removing the placeholder;
- bindings regenerated and `lib/api.ts` re-exports;
- `tools/index.ts` and `steps/index.ts` entries;
- the packs `BuiltIn` entry;
- the root test lists;
- the Info.plist key;
- the `shellOverlays` hook in the shell.

| Wave | WP | Owns | Depends on |
|---|---|---|---|
| 1 | **L1 Protocol** | `core/lan/**` (all files and tests, filling in the stubs), `go.mod` (`x/net`) | foundation |
| 1 | **L2 UI** | `frontend/src/tools/lan-share/**`, `frontend/src/pipelines/steps/lanshare.tsx` (+ tests), `shell/keywords.ts` entry | foundation (stubbed bindings) |
| 2 | **L3 Module** | `modules/lanshare/**` (send/receive jobs, sink, service bodies, step, template entry in `modules/pipelines/templates_workflows.go`), `desktop/` tray lines | L1 merged |

The architect integrates and runs the sandbox QA (two instances). L2 builds against the stubbed service and the fixture states, and is checked against the real service after L3.
