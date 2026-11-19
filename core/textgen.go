package core

import (
	"context"
	"encoding/json"
)

// TextGenerator runs one-shot prompts on the local chat model (SPEC.md
// §3.5). modules/chat implements it; tools such as Subtitles consume it.
type TextGenerator interface {
	// Ready returns the model that would be used, or a CodeDependencyMissing
	// AppError ("Download a model in Local Chat first") without starting
	// anything.
	Ready() (model string, err error)
	// Complete waits (ctx-cancellable) for the chat engine's generation
	// slot, starts the server if needed, and returns the whole reply.
	// Nothing is stored as a conversation. A background completion holds
	// the slot for one request only; interactive chat has priority.
	Complete(ctx context.Context, req CompletionRequest) (string, error)
	// ContextTokens is the model's context window (Settings.Chat.ContextSize);
	// callers size long prompts against it (SPEC.md §7.3).
	ContextTokens() int
}

// CompletionRequest is one prompt for TextGenerator.Complete.
type CompletionRequest struct {
	System string
	Prompt string
	// JSONSchema optionally constrains the reply (llama-server
	// response_format, Ollama format).
	JSONSchema json.RawMessage
	// MaxTokens caps the reply; 0 = 2048.
	MaxTokens int
	// Temperature is used as given (0 is valid).
	Temperature float64
	// Purpose is shown in Local Chat while the request runs, e.g.
	// "Translating subtitles".
	Purpose string
	// Images are local picture files sent with the prompt (Phase 20). The
	// chat module reads, scales (≤ 896 px) and encodes them; paths never
	// leave Go. Only a model that can see accepts them: see VisionGenerator.
	Images []string
	// Model picks a catalog/Ollama model for this request; "" = the chat
	// model. Caption Writer passes VisionGenerator.Vision()'s answer.
	Model string
	// Seed makes sampling repeatable (llama-server "seed"); 0 = the server's default.
	Seed int64
}

// VisionGenerator is a TextGenerator that can also look at pictures
// (Phase 20, SPEC.md §5.2; implemented by modules/chat).
type VisionGenerator interface {
	TextGenerator
	// Vision returns the model that will read images: the chat model when it
	// can see, else the installed vision-default model, else a
	// CodeDependencyMissing AppError naming the Caption Writer pack. It never
	// starts anything.
	Vision() (model string, err error)
}
