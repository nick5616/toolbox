package chat

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"toolbox/core"
)

// completeOllama POSTs a non-streaming /api/chat (stream:false) and returns
// the reply. format, when set, is a JSON schema constraining it.
func completeOllama(ctx context.Context, rawURL, model string, msgs []wireMsg, temp float64, numCtx, maxTokens int, format json.RawMessage) (string, error) {
	base, err := ollamaBase(rawURL)
	if err != nil {
		return "", err
	}
	payload := map[string]any{
		"model": model, "messages": msgs, "stream": false,
		"options": map[string]any{"temperature": temp, "num_ctx": numCtx, "num_predict": maxTokens},
	}
	if len(format) > 0 {
		payload["format"] = format
	}
	body, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/api/chat", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := loopbackClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		var e struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(b, &e)
		return "", core.Errorf(core.CodeToolFailed, "Ollama couldn't answer").WithCause(errors.New(strings.TrimSpace(resp.Status + " " + e.Error)))
	}
	var out struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
		Error string `json:"error"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 16<<20)).Decode(&out); err != nil {
		return "", err
	}
	if out.Error != "" {
		return "", core.Errorf(core.CodeToolFailed, "Ollama stopped with an error").WithCause(errors.New(out.Error))
	}
	return out.Message.Content, nil
}
