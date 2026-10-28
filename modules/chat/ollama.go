package chat

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"toolbox/core"
)

// Optional Ollama backend (SPEC.md §4.3): only a loopback URL the user set.
// Ollama has no access control; this is outbound to localhost only.

type ollamaModel struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
}

func ollamaBase(raw string) (string, error) {
	raw = strings.TrimRight(strings.TrimSpace(raw), "/")
	if raw == "" || !core.ValidOllamaURL(raw) {
		return "", core.ValidationError("Ollama needs an http:// address on this computer", map[string]string{"ollamaURL": "Use http://127.0.0.1:11434"})
	}
	return raw, nil
}

// ollamaTags lists the models of an Ollama server (2 s timeout).
func ollamaTags(ctx context.Context, rawURL string) ([]ollamaModel, error) {
	base, err := ollamaBase(rawURL)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/api/tags", nil)
	if err != nil {
		return nil, err
	}
	resp, err := loopbackClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, errors.New("Ollama answered " + resp.Status)
	}
	var out struct {
		Models []ollamaModel `json:"models"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&out); err != nil {
		return nil, err
	}
	return out.Models, nil
}

// streamOllama POSTs /api/chat with stream:true (NDJSON) and feeds deltas.
func streamOllama(ctx context.Context, rawURL, model string, msgs []wireMsg, temp float64, numCtx int, onDelta func(string)) (streamStats, error) {
	base, err := ollamaBase(rawURL)
	if err != nil {
		return streamStats{}, err
	}
	body, _ := json.Marshal(map[string]any{
		"model": model, "messages": msgs, "stream": true,
		"options": map[string]any{"temperature": temp, "num_ctx": numCtx},
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/api/chat", bytes.NewReader(body))
	if err != nil {
		return streamStats{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := loopbackClient.Do(req)
	if err != nil {
		return streamStats{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		var e struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(b, &e)
		return streamStats{}, core.Errorf(core.CodeToolFailed, "Ollama couldn't answer").WithCause(errors.New(strings.TrimSpace(resp.Status + " " + e.Error)))
	}
	var st streamStats
	deltas := 0
	br := bufio.NewReaderSize(resp.Body, 64<<10)
	for {
		line, rerr := br.ReadBytes('\n')
		if line = bytes.TrimSpace(line); len(line) > 0 {
			var m struct {
				Message struct {
					Content string `json:"content"`
				} `json:"message"`
				Done         bool   `json:"done"`
				EvalCount    int    `json:"eval_count"`
				EvalDuration int64  `json:"eval_duration"` // ns
				Error        string `json:"error"`
			}
			if err := json.Unmarshal(line, &m); err == nil {
				if m.Error != "" {
					return st, core.Errorf(core.CodeToolFailed, "Ollama stopped with an error").WithCause(errors.New(m.Error))
				}
				if m.Message.Content != "" {
					deltas++
					onDelta(m.Message.Content)
				}
				if m.Done {
					st.Tokens = m.EvalCount
					if m.EvalDuration > 0 {
						st.TPS = float64(m.EvalCount) / (float64(m.EvalDuration) / 1e9)
					}
				}
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return st, rerr
		}
	}
	if st.Tokens == 0 {
		st.Tokens = deltas
	}
	return st, nil
}
