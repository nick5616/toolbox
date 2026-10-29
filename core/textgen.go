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
}
