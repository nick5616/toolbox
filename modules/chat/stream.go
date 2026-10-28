package chat

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"toolbox/core"
)

// wireMsg is one message sent to a backend.
type wireMsg struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// streamStats is what a finished stream reports.
type streamStats struct {
	Tokens int
	TPS    float64 // 0 = unknown
}

// readSSE reads a text/event-stream. fn gets each event's data (multi-line
// data joined with \n) and returns stop=true to end the read ("[DONE]").
func readSSE(r io.Reader, fn func(data string) (stop bool, err error)) error {
	br := bufio.NewReaderSize(r, 64<<10)
	var data []string
	dispatch := func() (bool, error) {
		if len(data) == 0 {
			return false, nil
		}
		d := strings.Join(data, "\n")
		data = data[:0]
		return fn(d)
	}
	for {
		line, err := br.ReadString('\n')
		if line != "" || err == nil {
			line = strings.TrimRight(line, "\r\n")
			switch {
			case line == "":
				if stop, ferr := dispatch(); ferr != nil || stop {
					return ferr
				}
			case strings.HasPrefix(line, ":"): // comment / keep-alive
			case strings.HasPrefix(line, "data:"):
				data = append(data, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
			}
		}
		if err != nil {
			if err == io.EOF {
				_, ferr := dispatch()
				return ferr
			}
			return err
		}
	}
}

// openAIChunk is the part of a chat.completion.chunk we use.
type openAIChunk struct {
	Choices []struct {
		Delta struct {
			Content string `json:"content"`
		} `json:"delta"`
	} `json:"choices"`
	Usage *struct {
		CompletionTokens int `json:"completion_tokens"`
	} `json:"usage"`
	Timings *struct {
		PredictedN         int     `json:"predicted_n"`
		PredictedPerSecond float64 `json:"predicted_per_second"`
	} `json:"timings"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

// streamOpenAI POSTs a streaming chat completion to a llama-server and feeds
// the content deltas to onDelta. Cancelling ctx closes the request, which
// stops generation on the server.
func streamOpenAI(ctx context.Context, base, key string, msgs []wireMsg, temp float64, onDelta func(string)) (streamStats, error) {
	body, _ := json.Marshal(map[string]any{
		"model": "local", "messages": msgs, "stream": true, "temperature": temp,
		"stream_options": map[string]any{"include_usage": true},
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/v1/chat/completions", bytes.NewReader(body))
	if err != nil {
		return streamStats{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+key)
	resp, err := loopbackClient.Do(req)
	if err != nil {
		return streamStats{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return streamStats{}, httpStatusError(resp)
	}
	var st streamStats
	deltas := 0
	err = readSSE(resp.Body, func(data string) (bool, error) {
		if strings.TrimSpace(data) == "[DONE]" {
			return true, nil
		}
		var ch openAIChunk
		if err := json.Unmarshal([]byte(data), &ch); err != nil {
			return false, nil // ignore anything that isn't a chunk
		}
		if ch.Error != nil {
			return false, core.Errorf(core.CodeToolFailed, "The model stopped with an error").WithCause(errors.New(ch.Error.Message))
		}
		for _, c := range ch.Choices {
			if c.Delta.Content != "" {
				deltas++
				onDelta(c.Delta.Content)
			}
		}
		if ch.Usage != nil {
			st.Tokens = ch.Usage.CompletionTokens
		}
		if ch.Timings != nil {
			st.TPS = ch.Timings.PredictedPerSecond
			if st.Tokens == 0 {
				st.Tokens = ch.Timings.PredictedN
			}
		}
		return false, nil
	})
	if st.Tokens == 0 {
		st.Tokens = deltas
	}
	return st, err
}

// httpStatusError maps a non-200 answer from a backend to a user error.
func httpStatusError(resp *http.Response) error {
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	text := strings.ToLower(string(b))
	if strings.Contains(text, "exceed_context_size") || strings.Contains(text, "exceeds the available context") ||
		strings.Contains(text, "context size") {
		return core.Errorf(core.CodeToolFailed, "The conversation is too long for this model's context size").
			WithHint("Start a new chat, or raise the context size in Settings → Chat").
			WithCause(fmt.Errorf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(b))))
	}
	return core.Errorf(core.CodeToolFailed, "The chat engine answered with an error (%d)", resp.StatusCode).
		WithCause(errors.New(strings.TrimSpace(string(b))))
}
