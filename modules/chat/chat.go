// Package chat is Local Chat: an app-managed llama-server on 127.0.0.1 with
// a random port and per-launch key, an optional Ollama backend, a pinned
// model catalog and stored conversations. See SPEC.md §4.
//
// CONTRACT STUB (foundation): the exported types and signatures in chat.go
// and service.go are final; CH1 implements them.
package chat

import (
	"context"
	"encoding/json"

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

// Chat owns the server lifecycle and generation. Safe for concurrent use.
type Chat struct {
	cfg Config
}

// New returns Local Chat (no server is started until the first Send).
func New(cfg Config) *Chat { return &Chat{cfg: cfg} }

// Stop stops any generation and the server (app quit).
func (c *Chat) Stop() {}

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

// ModelPresent implements core.ModelProvider (CH1).
func (m *Module) ModelPresent(preset string) bool { return false }

// FetchModel implements core.ModelProvider (CH1).
func (m *Module) FetchModel(ctx context.Context, job *core.JobContext, preset string) error {
	return errNotBuilt
}

// RemoveModel implements core.ModelProvider (CH1).
func (m *Module) RemoveModel(preset string) error { return errNotBuilt }

// Descriptor implements core.Module.
func (m *ModelModule) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: ModelModuleID, Name: "Chat model download", Icon: "download", Category: core.CategoryAI,
		Status: core.StatusReady, Hidden: true, MaxConcurrent: 1,
	}
}

// Validate implements core.Module.
func (m *ModelModule) Validate(inputs []string, options json.RawMessage) error {
	_, err := core.DecodeOptionsJSON[ModelOptions](options)
	return err
}

// Run implements core.Module.
func (m *ModelModule) Run(ctx context.Context, job *core.JobContext) error { return errNotBuilt }

var errNotBuilt = core.Errorf(core.CodeInternal, "Local Chat isn't available yet")
