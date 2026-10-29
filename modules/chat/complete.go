package chat

// core.TextGenerator on top of the chat engine (SPEC.md §3.5).

import (
	"context"
	"encoding/json"
	"strings"

	"toolbox/core"
)

// Chat implements core.TextGenerator.
var _ core.TextGenerator = (*Chat)(nil)

const defaultCompletionTokens = 2048

func errNoModel() error {
	return core.Errorf(core.CodeDependencyMissing, "Download a model in Local Chat first").
		WithHint("Open Local Chat and download a model")
}

// pickModel is the default model if usable, else the first downloaded one.
func (c *Chat) pickModel() (string, error) {
	st := c.cfg.Settings.Current().Chat
	if m := st.DefaultModel; m != "" {
		if isOllamaID(m) {
			if st.OllamaURL != "" && ollamaName(m) != "" {
				return m, nil
			}
		} else if c.modelPresent(m) {
			return m, nil
		}
	}
	for _, e := range c.entries() {
		if c.modelPresent(e.ID) {
			return e.ID, nil
		}
	}
	return "", errNoModel()
}

// Ready implements core.TextGenerator.
func (c *Chat) Ready() (string, error) { return c.pickModel() }

// Complete implements core.TextGenerator.
func (c *Chat) Complete(ctx context.Context, req core.CompletionRequest) (string, error) {
	model, err := c.pickModel()
	if err != nil {
		return "", err
	}
	g, err := c.acquire(ctx, &generation{background: true, purpose: req.Purpose, model: model})
	if err != nil {
		return "", err
	}
	defer close(g.done)
	defer c.release(g)

	// Either the caller or Stop/quit (g.ctx) aborts the request.
	rctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stop := context.AfterFunc(g.ctx, cancel)
	defer stop()

	out, err := c.complete(rctx, model, req)
	if err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		if g.ctx.Err() != nil {
			return "", core.Errorf(core.CodeCancelled, "Local Chat was stopped")
		}
		return "", err
	}
	if !isOllamaID(model) {
		c.touchIdle()
	}
	return out, nil
}

func (c *Chat) complete(ctx context.Context, model string, req core.CompletionRequest) (string, error) {
	st := c.cfg.Settings.Current().Chat
	maxTokens := req.MaxTokens
	if maxTokens <= 0 {
		maxTokens = defaultCompletionTokens
	}
	var msgs []wireMsg
	if strings.TrimSpace(req.System) != "" {
		msgs = append(msgs, wireMsg{Role: "system", Content: req.System})
	}
	msgs = append(msgs, wireMsg{Role: "user", Content: req.Prompt})

	if isOllamaID(model) {
		c.setStatus(core.ChatStatus{State: core.ChatReady, Model: model, Backend: core.ChatBackendOllama})
		return completeOllama(ctx, st.OllamaURL, ollamaName(model), msgs, req.Temperature, st.ContextSize, maxTokens, req.JSONSchema)
	}
	e, ok := c.lookup(model)
	if !ok {
		return "", core.Errorf(core.CodeNotFound, "Unknown chat model")
	}
	srv, err := c.ensureServer(ctx, e)
	if err != nil {
		return "", err
	}
	extra := map[string]any{"max_tokens": maxTokens}
	if len(req.JSONSchema) > 0 {
		extra["response_format"] = map[string]any{
			"type": "json_schema",
			"json_schema": map[string]any{
				"name": "reply", "schema": json.RawMessage(req.JSONSchema), "strict": true,
			},
		}
	}
	var b strings.Builder
	_, err = streamOpenAIExtra(ctx, srv.base(), srv.key, msgs, req.Temperature, extra, func(d string) { b.WriteString(d) })
	if err != nil {
		if ctx.Err() == nil && !srv.alive() {
			err = core.Errorf(core.CodeToolFailed, "The chat engine stopped unexpectedly").
				WithHint("Try again to restart it").WithCause(err)
		}
		return "", err
	}
	return b.String(), nil
}
