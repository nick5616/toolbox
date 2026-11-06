// Package lan is Local File Transfer's protocol (SPEC.md Phase 13): the
// LocalSend v2 protocol in HTTPS mode plus Toolbox's pairing extension. It is
// the only code in the app that listens on a non-loopback address, and only
// while receiving is on (CLAUDE.md "App rules").
//
// It depends on the stdlib and golang.org/x/net only; it never imports Wails
// or modules. Accepted incoming sessions are handed to a SessionSink
// (modules/lanshare turns each into a job).
package lan

import (
	"context"
	"io"
	"time"

	"toolbox/core"
)

// Protocol constants.
const (
	DefaultPort     = 53317
	MulticastV4     = "224.0.0.167"
	MulticastV6     = "ff12::167"
	ProtocolVersion = "2.1"
	DeviceModel     = "Toolbox"
	APIBase         = "/api/localsend/v2"
	PairPath        = "/api/toolbox/v1/pair"

	MaxJSONBytes      = 1 << 20
	MaxFilesPerSess   = 10000
	MaxNameBytes      = 255
	MaxPathDepth      = 16
	MaxTextBytes      = 64 << 10
	MaxKnownDevices   = 100
	MaxMessages       = 50
	MaxPINLen         = 32
	PromptTimeout     = 60 * time.Second
	PairTimeout       = 90 * time.Second
	HoldTTL           = 30 * time.Second
	OnlineWindow      = 2 * time.Minute
	FreeSpaceMargin   = 512 << 20
	UploadIdleTimeout = 60 * time.Second
)

// Event names (registered with Wails in api/events.go).
const (
	EventState       = "lanshare:state"         // State
	EventDevices     = "lanshare:devices"       // DevicesChanged
	EventPrompt      = "lanshare:prompt"        // Prompt
	EventPromptClose = "lanshare:prompt-closed" // PromptClosed
	EventMessage     = "lanshare:message"       // Message
	EventActivity    = "lanshare:activity"      // Activity
)

// Error codes (SPEC.md Phase 13 §7).
const (
	CodeOffline         core.ErrorCode = "lan_offline"
	CodeDeclined        core.ErrorCode = "lan_declined"
	CodeBusy            core.ErrorCode = "lan_busy"
	CodePinRequired     core.ErrorCode = "lan_pin_required"
	CodeWrongDevice     core.ErrorCode = "lan_wrong_device"
	CodePortUnavailable core.ErrorCode = "lan_port_unavailable"
	CodeEncryptionOff   core.ErrorCode = "lan_encryption_off"
	CodeTooLarge        core.ErrorCode = "lan_too_large"
)

// ReceiveMode says when Toolbox listens.
type ReceiveMode string

const (
	ReceiveOff    ReceiveMode = "off"    // never (default)
	ReceiveOpen   ReceiveMode = "open"   // while the tool is on screen in some window (holds)
	ReceiveAlways ReceiveMode = "always" // while Toolbox runs
)

// FromMode says who may send.
type FromMode string

const (
	FromMine   FromMode = "mine"   // paired, verified Toolbox devices only
	FromAnyone FromMode = "anyone" // anyone nearby; every transfer asks (default)
)

// Settings are Local File Transfer's settings, kept in <support>/lanshare/settings.json.
type Settings struct {
	Receive ReceiveMode `json:"receive"`
	Alias   string      `json:"alias"` // "" = the hostname
	From    FromMode    `json:"from"`
	PIN     string      `json:"pin"` // "" = none; ≤ MaxPINLen chars; never logged
}

// State is what the tool, the tray and the header show.
type State struct {
	Mode        ReceiveMode `json:"mode"`
	Listening   bool        `json:"listening"`
	Port        int         `json:"port"`      // 0 when not listening
	Addresses   []string    `json:"addresses"` // this computer's allowed addresses
	Alias       string      `json:"alias"`
	Fingerprint string      `json:"fingerprint"`
	ShortCode   string      `json:"shortCode"` // "4F2A"
	From        FromMode    `json:"from"`
	PINSet      bool        `json:"pinSet"`
	Error       string      `json:"error"` // a listener problem, "" when fine
}

// Device is a device Toolbox knows about (stored when paired or sent to; nearby otherwise).
type Device struct {
	Fingerprint string `json:"fingerprint"` // lowercase hex SHA-256 of its certificate (HTTPS)
	Alias       string `json:"alias"`
	DeviceType  string `json:"deviceType"` // mobile | desktop | web | headless | server | ""
	DeviceModel string `json:"deviceModel"`
	Toolbox     bool   `json:"toolbox"`    // announced toolbox:1
	Paired      bool   `json:"paired"`     // mutual pairing done
	AutoAccept  bool   `json:"autoAccept"` // only when Paired && Toolbox
	Address     string `json:"address"`    // last IP seen
	Port        int    `json:"port"`
	Protocol    string `json:"protocol"` // "https" | "http"
	LastSeen    int64  `json:"lastSeen"` // unix ms
	Online      bool   `json:"online"`   // computed: seen within OnlineWindow
	Stored      bool   `json:"stored"`   // kept in devices.json (paired or sent to)
}

// DevicesChanged carries the whole device list.
type DevicesChanged struct {
	Devices []Device `json:"devices"`
}

// PromptKind is what a prompt asks.
type PromptKind string

const (
	PromptTransfer PromptKind = "transfer"
	PromptPair     PromptKind = "pair"
	PromptMessage  PromptKind = "message" // a text from a sender that isn't a verified paired device
)

// PromptFile is one file in a transfer prompt.
type PromptFile struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
	Type string `json:"type"`
}

// Prompt asks the user to accept something.
type Prompt struct {
	ID         string       `json:"id"`
	Kind       PromptKind   `json:"kind"`
	Device     Device       `json:"device"`
	Verified   bool         `json:"verified"`
	Files      []PromptFile `json:"files"` // at most the first 20
	FileCount  int          `json:"fileCount"`
	TotalBytes int64        `json:"totalBytes"`
	Text       string       `json:"text"`      // messages
	PairCode   string       `json:"pairCode"`  // pairing: "482911"
	CanAlways  bool         `json:"canAlways"` // offer "Always accept from this device"
	ExpiresAt  int64        `json:"expiresAt"` // unix ms
}

// PromptClosed says a prompt went away (answered, timed out or cancelled).
type PromptClosed struct {
	ID     string `json:"id"`
	Reason string `json:"reason"` // "accepted" | "declined" | "timeout" | "cancelled"
}

// Message is a text received from a device (kept in memory, newest last, ≤ MaxMessages).
type Message struct {
	ID   string `json:"id"`
	From Device `json:"from"`
	Text string `json:"text"`
	At   int64  `json:"at"`
}

// Activity is one line in the tool's activity list ("Turned away a transfer from …").
type Activity struct {
	ID   string `json:"id"`
	Text string `json:"text"`
	At   int64  `json:"at"`
}

// FileMeta is one file of an incoming session.
type FileMeta struct {
	ID       string `json:"id"`
	RelPath  string `json:"relPath"` // sanitised, "/" separated
	Size     int64  `json:"size"`
	Type     string `json:"type"`
	SHA256   string `json:"sha256"`   // "" = not given
	Modified int64  `json:"modified"` // unix ms, 0 = unknown
}

// FileStream is one incoming file's bytes.
type FileStream struct {
	File FileMeta
	// Body yields exactly File.Size bytes, then io.EOF; it errors on a short
	// upload, an sha256 mismatch (checked at EOF), cancel or the idle timeout.
	Body io.Reader
	// Done must be called once: nil when the file was stored, an error when
	// it was abandoned. The server answers the sender's upload request with it.
	Done func(err error)
}

// IncomingSession is an accepted incoming transfer.
type IncomingSession interface {
	ID() string
	From() Device
	Verified() bool
	Files() []FileMeta
	TotalBytes() int64
	// Next waits for the next uploaded file; io.EOF once every file arrived.
	Next(ctx context.Context) (FileStream, error)
	// Cancel ends the session (the sender's next request fails).
	Cancel()
	// Finished releases the session after the sink is done (nil = success).
	Finished(err error)
}

// SessionSink receives accepted sessions (modules/lanshare submits a receive job for each).
type SessionSink interface {
	Accepted(sess IncomingSession) error
}

// SendProgress reports a send's progress.
type SendProgress struct {
	Stage     string // "connecting" | "waiting" | "uploading"
	Done      int64
	Total     int64
	FileIndex int
	FileCount int
}

// SendFile is one file to send.
type SendFile struct {
	Path    string // on disk
	RelPath string // the name the receiver sees, "/" separated (folder/sub/file)
	Size    int64
	Type    string // MIME type
}

// SendRequest is one outgoing transfer.
type SendRequest struct {
	Device Device
	Files  []SendFile
	Text   string // optional message
	PIN    string // "" = none
}

// SendResult is what a finished send did.
type SendResult struct {
	Files     int   `json:"files"`
	Bytes     int64 `json:"bytes"`
	AsMessage bool  `json:"asMessage"` // the receiver answered 204
}

// Config configures a Runtime.
type Config struct {
	Dir           string                                    // <support>/lanshare: identity.pem, devices.json, settings.json
	Sink          SessionSink                               // modules/lanshare
	Emit          func(name string, data any)               // core events
	Port          int                                       // 0 = DefaultPort with a random-port fallback; tests pass a fixed port
	AllowLoopback bool                                      // tests only
	Packet        PacketFactory                             // nil = real multicast sockets; tests inject
	Now           func() time.Time                          // nil = time.Now
	FreeSpace     func(dir string) (free uint64, err error) // nil = no check
	ReceiveDir    func() string                             // <library>/Received (for the free-space check)
	Hostname      func() (string, error)                    // nil = os.Hostname
}

// PacketConn is the multicast socket the runtime reads announcements from and writes them to.
type PacketConn interface {
	ReadFrom(b []byte) (n int, from string, err error)
	WriteTo(b []byte, to string) error
	Close() error
}

// PacketFactory opens the multicast socket (listen=true while receiving) or an ephemeral sender.
type PacketFactory func(listen bool) (PacketConn, error)
