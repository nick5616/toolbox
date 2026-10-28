package chat

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"time"
	"unicode"

	"toolbox/core"
	"toolbox/core/deps"
)

// generation is the one running answer. Only one exists at a time.
type generation struct {
	convID string
	msgID  string
	model  string
	cancel context.CancelFunc
	done   chan struct{}
	ctx    context.Context
}

const conflictMsg = "Wait for the current answer or stop it"

// reserve takes the single generation slot (conflict when it's taken).
func (c *Chat) reserve(convID string) (*generation, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.gen != nil {
		return nil, core.Errorf(core.CodeConflict, "%s", conflictMsg)
	}
	ctx, cancel := context.WithCancel(context.Background())
	g := &generation{convID: convID, cancel: cancel, done: make(chan struct{}), ctx: ctx}
	c.gen = g
	return g, nil
}

// release frees the slot (the generation goroutine, or an early failure).
func (c *Chat) release(g *generation) {
	g.cancel()
	c.mu.Lock()
	if c.gen == g {
		c.gen = nil
	}
	c.mu.Unlock()
}

// stopGeneration stops the running generation (if any) and waits until its
// partial answer has been saved as stopped.
func (c *Chat) stopGeneration() {
	c.stopGenerationFor(func(*generation) bool { return true })
}

func (c *Chat) stopGenerationFor(match func(*generation) bool) {
	c.mu.Lock()
	g := c.gen
	c.mu.Unlock()
	if g == nil || !match(g) {
		return
	}
	g.cancel()
	select {
	case <-g.done:
	case <-time.After(15 * time.Second):
		slog.Warn("chat generation did not stop in time")
	}
}

// startGeneration runs the answer for an already-persisted assistant message.
// The caller reserved g; the goroutine releases it.
func (c *Chat) startGeneration(g *generation, conv core.ChatConversation, assistantID string, msgs []core.ChatMessage) bool {
	st := c.cfg.Settings.Current().Chat
	history, trimmed := buildHistory(conv.SystemPrompt, msgs, st.ContextSize)
	g.msgID, g.model = assistantID, conv.Model
	go c.runGeneration(g, conv, history, st)
	return trimmed
}

func (c *Chat) runGeneration(g *generation, conv core.ChatConversation, history []wireMsg, st core.ChatSettings) {
	defer close(g.done)
	defer c.release(g)

	var (
		mu       sync.Mutex
		content  strings.Builder
		pending  strings.Builder
		lastSave = time.Now()
		started  time.Time
		deltas   int
	)
	emitPending := func() {
		mu.Lock()
		d := pending.String()
		pending.Reset()
		mu.Unlock()
		if d != "" {
			c.cfg.Emitter.Emit(core.EventChatDelta, core.ChatDelta{ConversationID: g.convID, MessageID: g.msgID, Delta: d})
		}
	}
	stopTick := make(chan struct{})
	tickDone := make(chan struct{})
	go func() { // coalesces delta events to at most one per interval
		defer close(tickDone)
		t := time.NewTicker(c.tm.coalesce)
		defer t.Stop()
		for {
			select {
			case <-t.C:
				emitPending()
			case <-stopTick:
				return
			}
		}
	}()
	onDelta := func(d string) {
		mu.Lock()
		if started.IsZero() {
			started = time.Now()
		}
		deltas++
		content.WriteString(d)
		pending.WriteString(d)
		save := time.Since(lastSave) >= c.tm.persist
		var snapshot string
		if save {
			lastSave = time.Now()
			snapshot = content.String()
		}
		mu.Unlock()
		if save { // persisted while streaming, so a crash keeps most of the answer
			if err := c.cfg.Store.UpdateMessage(context.Background(), g.msgID, snapshot, core.ChatMessageDone, "", 0, 0); err != nil {
				slog.Warn("saving streaming chat message", "err", err)
			}
		}
	}

	stats, err := c.stream(g.ctx, conv, history, st, onDelta)
	close(stopTick)
	<-tickDone
	emitPending()

	status, errMsg := core.ChatMessageDone, ""
	switch {
	case err == nil:
	case g.ctx.Err() != nil: // Stop, deleting the model or app quit
		status = core.ChatMessageStopped
	default:
		status, errMsg = core.ChatMessageError, userMessage(err)
		slog.Warn("chat generation failed", "err", err)
	}
	mu.Lock()
	final, n := content.String(), deltas
	elapsed := time.Since(started)
	mu.Unlock()
	if stats.Tokens == 0 {
		stats.Tokens = n
	}
	if stats.TPS == 0 && n > 0 && elapsed > 0 {
		stats.TPS = float64(stats.Tokens) / elapsed.Seconds()
	}
	if status != core.ChatMessageDone {
		stats.TPS = 0
	}
	ctx := context.Background()
	if uerr := c.cfg.Store.UpdateMessage(ctx, g.msgID, final, status, errMsg, stats.Tokens, stats.TPS); uerr != nil {
		slog.Warn("saving chat message", "err", uerr)
	}
	_ = c.cfg.Store.TouchConversation(ctx, g.convID, core.NowMillis())
	c.cfg.Emitter.Emit(core.EventChatDone, core.ChatDone{
		ConversationID: g.convID, MessageID: g.msgID, Status: status, Error: errMsg,
		Tokens: stats.Tokens, TokensPerSec: stats.TPS,
	})
	if !isOllamaID(conv.Model) {
		c.touchIdle()
	}
}

// userMessage turns an error into the text stored on the failed message.
func userMessage(err error) string {
	var ae *core.AppError
	if errors.As(err, &ae) {
		if ae.Hint != "" {
			return ae.Message + " — " + ae.Hint
		}
		return ae.Message
	}
	return "The answer stopped unexpectedly"
}

// stream asks the backend for the answer.
func (c *Chat) stream(ctx context.Context, conv core.ChatConversation, history []wireMsg, st core.ChatSettings, onDelta func(string)) (streamStats, error) {
	if isOllamaID(conv.Model) {
		c.setStatus(core.ChatStatus{State: core.ChatReady, Model: conv.Model, Backend: core.ChatBackendOllama})
		stats, err := streamOllama(ctx, st.OllamaURL, ollamaName(conv.Model), history, st.Temperature, st.ContextSize, onDelta)
		return stats, err
	}
	e, ok := c.lookup(conv.Model)
	if !ok {
		return streamStats{}, core.Errorf(core.CodeNotFound, "Unknown chat model")
	}
	srv, err := c.ensureServer(ctx, e)
	if err != nil {
		return streamStats{}, err
	}
	stats, err := streamOpenAI(ctx, srv.base(), srv.key, history, st.Temperature, onDelta)
	if err != nil && ctx.Err() == nil && !srv.alive() {
		err = core.Errorf(core.CodeToolFailed, "The chat engine stopped unexpectedly").
			WithHint("Send again to restart it").WithCause(err)
	}
	return stats, err
}

// preflight checks, before anything is stored, that conv's model can answer.
func (c *Chat) preflight(conv core.ChatConversation) error {
	if isOllamaID(conv.Model) {
		if c.cfg.Settings.Current().Chat.OllamaURL == "" {
			return core.Errorf(core.CodeValidation, "Ollama isn't turned on").WithHint("Add its address in Settings → Chat")
		}
		return nil
	}
	e, ok := c.lookup(conv.Model)
	if !ok {
		return core.Errorf(core.CodeValidation, "Unknown chat model")
	}
	if !c.modelPresent(e.ID) {
		return core.Errorf(core.CodeNotFound, "%s isn't downloaded yet", e.Label).WithHint("Download it from the model list")
	}
	if _, err := c.cfg.Resolve(deps.Llama); err != nil {
		return err
	}
	return nil
}

const maxTitleRunes = 80

// titleFrom is the conversation title for a first message: whitespace
// collapsed, trimmed to 80 characters.
func titleFrom(text string) string {
	t := strings.Join(strings.FieldsFunc(text, unicode.IsSpace), " ")
	r := []rune(t)
	if len(r) > maxTitleRunes {
		t = strings.TrimSpace(string(r[:maxTitleRunes]))
	}
	if t == "" {
		return defaultTitle
	}
	return t
}

const defaultTitle = "New chat"

// send is the shared body of Send, Regenerate and EditAndResend. prep may
// delete messages and returns the text of a new user message ("" = none).
func (c *Chat) send(convID string, prep func(msgs []core.ChatMessage) (newText string, deleteFrom string, err error)) (SendResult, error) {
	ctx := context.Background()
	g, err := c.reserve(convID)
	if err != nil {
		return SendResult{}, err
	}
	started := false
	defer func() {
		if !started {
			c.release(g)
			close(g.done)
		}
	}()
	conv, err := c.cfg.Store.GetConversation(ctx, convID)
	if err != nil {
		return SendResult{}, err
	}
	if err := c.preflight(conv); err != nil {
		return SendResult{}, err
	}
	msgs, err := c.cfg.Store.ListMessages(ctx, convID)
	if err != nil {
		return SendResult{}, err
	}
	text, deleteFrom, err := prep(msgs)
	if err != nil {
		return SendResult{}, err
	}
	oldTitle := defaultTitle
	for _, m := range msgs {
		if m.Role == core.ChatRoleUser {
			oldTitle = titleFrom(m.Content) // the title the first message produced
			break
		}
	}
	if deleteFrom != "" {
		if err := c.cfg.Store.DeleteMessagesFrom(ctx, convID, deleteFrom); err != nil {
			return SendResult{}, err
		}
		if msgs, err = c.cfg.Store.ListMessages(ctx, convID); err != nil {
			return SendResult{}, err
		}
	}

	var res SendResult
	now := core.NowMillis()
	if text != "" {
		um := core.ChatMessage{ID: core.NewID(), ConversationID: convID, Role: core.ChatRoleUser, Content: text, Status: core.ChatMessageDone, CreatedAt: now}
		if err := c.cfg.Store.AddMessage(ctx, um); err != nil {
			return SendResult{}, err
		}
		if len(msgs) == 0 && (conv.Title == defaultTitle || conv.Title == oldTitle) { // not renamed by hand
			if _, err := c.cfg.Store.UpdateConversation(ctx, convID, core.ChatConversationPatch{Title: ptr(titleFrom(text))}); err != nil {
				return SendResult{}, err
			}
		}
		msgs = append(msgs, um)
		res.UserMessageID = um.ID
	} else if len(msgs) > 0 {
		res.UserMessageID = msgs[len(msgs)-1].ID
	}
	am := core.ChatMessage{ID: core.NewID(), ConversationID: convID, Role: core.ChatRoleAssistant, Status: core.ChatMessageDone, CreatedAt: now}
	if err := c.cfg.Store.AddMessage(ctx, am); err != nil {
		return SendResult{}, err
	}
	_ = c.cfg.Store.TouchConversation(ctx, convID, now)
	res.AssistantMessageID = am.ID
	started = true
	res.Trimmed = c.startGeneration(g, conv, am.ID, msgs)
	return res, nil
}

func ptr[T any](v T) *T { return &v }
