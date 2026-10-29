// Package chat is Local Chat: an app-managed llama-server on 127.0.0.1 with
// a random port and per-launch key, an optional Ollama backend, a pinned
// model catalog and stored conversations. See SPEC.md §4.
package chat

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"toolbox/core"
)

// ModuleID is the Local Chat module ID (same as the Phase 1 placeholder).
const ModuleID = "llm-chat"

// ModelModuleID is the hidden module whose jobs download catalog models.
const ModelModuleID = "system-chat-model"

// Config wires Local Chat.
type Config struct {
	Store    core.ChatStore
	Settings *core.SettingsService
	Jobs     *core.Jobs
	Emitter  core.Emitter
	// ModelsDir is <tools>/models; GGUF files go in <ModelsDir>/llm/.
	ModelsDir string
	// TmpDir is <support>/tmp (the per-launch key file).
	TmpDir string
	// Resolve finds a dependency (llama-runtime).
	Resolve func(depID string) (string, error)
	// LibraryDir returns the current library folder (exports go to <library>/Chats).
	LibraryDir func() string
	// RegisterOutput records an exported file in the library.
	RegisterOutput func(path string) error
}

// Timings of the server lifecycle and streaming; tests shorten them.
type timings struct {
	ready     time.Duration // server readiness timeout
	poll      time.Duration // /health poll interval
	idle      time.Duration // stop the server after this long without requests
	persist   time.Duration // save the streaming assistant message this often
	coalesce  time.Duration // delta event coalescing interval
	killGrace time.Duration // wait for a killed server to exit
}

func defaultTimings() timings {
	return timings{
		ready: 120 * time.Second, poll: 250 * time.Millisecond, idle: 20 * time.Minute,
		persist: 2 * time.Second, coalesce: 40 * time.Millisecond, killGrace: 5 * time.Second,
	}
}

// Chat owns the server lifecycle and generation. Safe for concurrent use.
type Chat struct {
	cfg Config
	tm  timings

	// Test seams.
	serverEnv []string                    // extra environment for llama-server
	modelURL  func(e catalogEntry) string // model download URL
	entries   func() []catalogEntry       // the catalog
	dlMu      sync.Mutex                  // one model download at a time

	srvMu sync.Mutex // serialises server start/stop

	mu        sync.Mutex // protects the fields below
	srv       *server
	status    core.ChatStatus
	ollamaErr string // note shown when Ollama is configured but unreachable
	gen       *generation
	freed     chan struct{} // closed (and reset) whenever the slot frees or a waiter leaves
	waitingIx int           // interactive requests waiting for the slot
	ixWait    time.Duration // how long an interactive request waits for a background one
	idleTimer *time.Timer
}

// New returns Local Chat (no server is started until the first Send).
func New(cfg Config) *Chat {
	c := &Chat{cfg: cfg, tm: defaultTimings(), ixWait: 60 * time.Second}
	c.status = core.ChatStatus{State: core.ChatStopped}
	c.modelURL = func(e catalogEntry) string { return e.URL() }
	c.entries = func() []catalogEntry { return catalog }
	if c.cfg.Emitter == nil {
		c.cfg.Emitter = core.NopEmitter{}
	}
	return c
}

// Stop stops any generation (saving it as stopped) and the server. The Chat
// stays usable: the next Send starts the server again.
func (c *Chat) Stop() {
	c.stopGeneration()
	c.stopServer()
}

// Module is the job-less Local Chat module (it has a UI, never runs jobs).
type Module struct{ c *Chat }

// ModelModule is the hidden model-download module (system-chat-model).
type ModelModule struct{ c *Chat }

// ModelOptions are a system-chat-model job's options.
type ModelOptions struct {
	Model string `json:"model"` // catalog ID
}

// Register adds Local Chat and its hidden model downloader.
func Register(reg *core.Registry, c *Chat) error {
	if err := reg.Register(&Module{c: c}); err != nil {
		return err
	}
	return reg.Register(&ModelModule{c: c})
}

var _ core.ModelProvider = (*Module)(nil)

// Descriptor implements core.Module.
func (m *Module) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: ModuleID, Name: "Local Chat", Icon: "message-square", Category: core.CategoryAI,
		Tagline:     "Chat with AI models on this computer",
		Description: "A private chat with language models that run on your own GPU. Nothing leaves this computer.",
		Status:      core.StatusReady, Order: 180, JobLess: true,
	}
}

// Validate implements core.Module.
func (m *Module) Validate([]string, json.RawMessage) error { return core.ErrJobLess }

// Run implements core.Module.
func (m *Module) Run(context.Context, *core.JobContext) error { return core.ErrJobLess }

// ModelPresent implements core.ModelProvider.
func (m *Module) ModelPresent(preset string) bool { return m.c.modelPresent(preset) }

// FetchModel implements core.ModelProvider: a no-op when the model is
// present, else the same Range-resuming, sha-verified download as the model job.
func (m *Module) FetchModel(ctx context.Context, job *core.JobContext, preset string) error {
	e, ok := m.c.lookup(preset)
	if !ok {
		return core.ValidationError("Unknown chat model "+preset, nil)
	}
	return m.c.downloadModel(ctx, job, e)
}

// RemoveModel implements core.ModelProvider.
func (m *Module) RemoveModel(preset string) error { return m.c.deleteModel(preset) }

// Descriptor implements core.Module.
func (m *ModelModule) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: ModelModuleID, Name: "Chat model download", Icon: "download", Category: core.CategoryAI,
		Status: core.StatusReady, Hidden: true, MaxConcurrent: 1,
	}
}

// Validate implements core.Module.
func (m *ModelModule) Validate(inputs []string, options json.RawMessage) error {
	o, err := core.DecodeOptionsJSON[ModelOptions](options)
	if err != nil {
		return err
	}
	if _, ok := m.c.lookup(o.Model); !ok {
		return core.ValidationError("Unknown chat model", map[string]string{"model": "Pick a model from the list"})
	}
	return nil
}

// Run implements core.Module.
func (m *ModelModule) Run(ctx context.Context, job *core.JobContext) error {
	o, err := core.DecodeOptions[ModelOptions](job)
	if err != nil {
		return err
	}
	e, ok := m.c.lookup(o.Model)
	if !ok {
		return core.ValidationError("Unknown chat model", nil)
	}
	job.SetTitle("Download " + e.Label)
	return m.c.downloadModel(ctx, job, e)
}
