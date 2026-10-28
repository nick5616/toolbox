// Package vault is a passphrase-encrypted file store (age). See SPEC.md §6.
package vault

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"filippo.io/age"

	"toolbox/core"
)

// ModuleID is the Vault module ID (same as the Phase 1 placeholder).
const ModuleID = "vault"

// Job actions (Options.Action).
const (
	ActionAdd    = "add"
	ActionExport = "export"
)

// Options are a vault job's options.
type Options struct {
	Action string   `json:"action"` // "add" | "export"
	Folder string   `json:"folder"` // add: target folder ("" = root)
	IDs    []string `json:"ids"`    // export: entry IDs
}

// Entry is one file in the vault (decrypted index data; only sent while unlocked).
type Entry struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Folder  string `json:"folder"` // "" = root; one level only
	Size    int64  `json:"size"`
	ModTime int64  `json:"modTime"` // Unix ms of the original file
	AddedAt int64  `json:"addedAt"`
}

// Config wires the vault.
type Config struct {
	// LibraryDir returns the current library folder (the vault lives in <library>/Vault).
	LibraryDir func() string
	// OpenDir is <support>/tmp/vault-open (temporary decrypted copies).
	OpenDir  string
	Settings *core.SettingsService
	Jobs     *core.Jobs
	Emitter  core.Emitter
	// OpenFile opens a file with the default app (desktop integration).
	OpenFile func(path string) error
}

// Vault holds the vault state. Safe for concurrent use.
type Vault struct {
	cfg Config

	// opMu serialises every index mutation, passphrase change and unlock.
	// Lock order: opMu before mu.
	opMu sync.Mutex

	// mu guards the fields below (short critical sections only).
	mu         sync.Mutex
	identity   *age.X25519Identity // non-nil exactly while unlocked
	idx        *index
	dir        string // vault folder while unlocked
	session    string // per-unlock ID; names the open-copies folder
	lastActive time.Time
	lastEmit   time.Time
	active     int // running vault jobs
	cancels    map[int]context.CancelFunc
	nextCancel int
	wipeTimer  *time.Timer
	closed     bool
	started    bool
	stop       chan struct{}
	notice     string // set when the index came from the .bak copy

	// Test hooks (unexported).
	now        func() time.Time
	workFactor int
	retryEvery time.Duration
	tickEvery  time.Duration
	minutes    func() int // nil = read from Settings
	submit     func(ctx context.Context, inputs []string, optionsJSON string) ([]core.Job, error)
}

// New returns a locked vault.
func New(cfg Config) *Vault {
	if cfg.Emitter == nil {
		cfg.Emitter = core.NopEmitter{}
	}
	v := &Vault{
		cfg: cfg, cancels: map[int]context.CancelFunc{}, stop: make(chan struct{}),
		now: time.Now, workFactor: defaultWorkFactor,
		retryEvery: 30 * time.Second, tickEvery: 10 * time.Second,
	}
	v.submit = func(ctx context.Context, inputs []string, optionsJSON string) ([]core.Job, error) {
		return v.cfg.Jobs.Submit(ctx, ModuleID, inputs, optionsJSON)
	}
	return v
}

// Module implements core.Module for add/export jobs.
type Module struct{ v *Vault }

// Register adds the module to the registry.
func Register(reg *core.Registry, v *Vault) error { return reg.Register(&Module{v: v}) }

// Descriptor implements core.Module.
func (m *Module) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: ModuleID, Name: "Vault", Icon: "lock", Category: core.CategoryUtility,
		Tagline:     "Encrypt files you want kept private",
		Description: "An encrypted folder for sensitive files, unlocked only when you need it.",
		Status:      core.StatusReady,
		Accepts:     core.Accepts{Any: true},
		Order:       210, OutputSubdir: "Vault exports",
		MaxConcurrent: 1,
	}
}

// Validate implements core.Module.
func (m *Module) Validate(inputs []string, options json.RawMessage) error {
	return m.v.validate(inputs, options)
}

// Run implements core.Module.
func (m *Module) Run(ctx context.Context, job *core.JobContext) error {
	return m.v.run(ctx, job)
}

// Start begins housekeeping: wipes leftover temporary open copies (crash
// leftovers) and starts the auto-lock timer. Call once at app start.
func (v *Vault) Start(ctx context.Context) {
	v.mu.Lock()
	if v.started || v.closed {
		v.mu.Unlock()
		return
	}
	v.started = true
	v.mu.Unlock()

	v.wipeOpen()
	if v.cfg.Settings != nil {
		v.cfg.Settings.OnChange(func(old, new core.Settings) {
			if old.Vault != new.Vault {
				v.emitState()
			}
		})
	}
	go func() {
		t := time.NewTicker(v.tickEvery)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-v.stop:
				return
			case <-t.C:
				v.checkAutoLock()
			}
		}
	}()
}

// Close locks the vault (app quit).
func (v *Vault) Close() {
	v.mu.Lock()
	if !v.closed {
		v.closed = true
		close(v.stop)
	}
	v.mu.Unlock()
	v.lock()
	v.mu.Lock()
	if v.wipeTimer != nil {
		v.wipeTimer.Stop()
		v.wipeTimer = nil
	}
	v.mu.Unlock()
}
