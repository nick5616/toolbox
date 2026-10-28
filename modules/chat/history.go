package chat

import (
	"math"
	"strings"
	"unicode/utf8"

	"toolbox/core"
)

// Context trimming (SPEC.md §4.4): estimated tokens = chars / 3.5; when the
// history exceeds 75% of the context, the oldest turns are dropped.

const (
	charsPerToken = 3.5
	contextBudget = 0.75
)

func estimateTokens(s string) int {
	return int(math.Ceil(float64(utf8.RuneCountInString(s)) / charsPerToken))
}

// buildHistory returns the system prompt plus the conversation's messages,
// dropping the oldest turns when they don't fit ctxSize. Empty assistant
// messages (the placeholder being filled, failed answers) are skipped. The
// latest message is never dropped. trimmed reports that turns were left out.
func buildHistory(system string, msgs []core.ChatMessage, ctxSize int) (out []wireMsg, trimmed bool) {
	var hist []wireMsg
	for _, m := range msgs {
		if m.Role == core.ChatRoleAssistant && strings.TrimSpace(m.Content) == "" {
			continue
		}
		hist = append(hist, wireMsg{Role: string(m.Role), Content: m.Content})
	}
	budget := int(float64(ctxSize) * contextBudget)
	used := 0
	if system != "" {
		used = estimateTokens(system)
	}
	total := used
	for _, m := range hist {
		total += estimateTokens(m.Content) + 4 // a few tokens of chat template per message
	}
	for total > budget && len(hist) > 1 {
		total -= estimateTokens(hist[0].Content) + 4
		hist = hist[1:]
		trimmed = true
	}
	// Start on a user turn so the roles keep alternating.
	for trimmed && len(hist) > 1 && hist[0].Role != string(core.ChatRoleUser) {
		hist = hist[1:]
	}
	if system != "" {
		out = append(out, wireMsg{Role: "system", Content: system})
	}
	return append(out, hist...), trimmed
}
