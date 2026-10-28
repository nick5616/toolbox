package core

// Event names. They are registered with Wails (typed) in api/events.go.
const (
	EventJobsChanged     = "jobs:changed"      // Job
	EventJobsRemoved     = "jobs:removed"      // JobsRemoved
	EventJobsProgress    = "jobs:progress"     // JobProgress (throttled ≤ 1/100ms/job)
	EventJobsLog         = "jobs:log"          // JobLogBatch (batched every 150ms/job)
	EventLibraryAdded    = "library:added"     // Output
	EventLibraryRemoved  = "library:removed"   // OutputsRemoved
	EventDepsChanged     = "deps:changed"      // DepsChanged
	EventSettingsChanged = "settings:changed"  // Settings
	EventFilesDropped    = "app:files-dropped" // FilesDropped
	EventNavigate        = "app:navigate"      // Navigate

	// Phase 3
	EventClipboardAdded   = "clipboard:added"    // ClipItem (new or bumped)
	EventClipboardRemoved = "clipboard:removed"  // ClipsRemoved
	EventClipboardState   = "clipboard:state"    // ClipboardState
	EventHotkeysStatus    = "hotkeys:status"     // HotkeysChanged
	EventWindowShow       = "window:show"        // ShowView (sent when a window is shown)
	EventHiddenToTray     = "app:hidden-to-tray" // HiddenToTray

	// Phase 5
	EventChatDelta    = "chat:delta"    // ChatDelta
	EventChatDone     = "chat:done"     // ChatDone
	EventChatStatus   = "chat:status"   // ChatStatus
	EventVaultState   = "vault:state"   // VaultState
	EventPacksChanged = "packs:changed" // PacksChanged
)

// Emitter publishes events to the UI. Core code depends on this interface,
// never on Wails directly. Implementations must be safe for concurrent use.
type Emitter interface {
	Emit(name string, data any)
}

// EmitterFunc adapts a function to Emitter.
type EmitterFunc func(name string, data any)

func (f EmitterFunc) Emit(name string, data any) { f(name, data) }

// NopEmitter discards events.
type NopEmitter struct{}

func (NopEmitter) Emit(string, any) {}
