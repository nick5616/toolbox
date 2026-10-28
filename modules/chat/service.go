package chat

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"

	"toolbox/core"
)

// ModelInfo is one model the UI can pick: a catalog entry (with install
// state) or, when Ollama is enabled, an Ollama model.
type ModelInfo struct {
	ID        string `json:"id"` // catalog ID or "ollama:<name>"
	Label     string `json:"label"`
	Bytes     int64  `json:"bytes"`
	License   string `json:"license"`
	Hint      string `json:"hint"` // e.g. "Best all-rounder · needs ~4 GB free"
	IsDefault bool   `json:"isDefault"`
	Verified  bool   `json:"verified"` // false → "not tested on this machine"
	Installed bool   `json:"installed"`
	JobID     string `json:"jobId"`  // running or queued download job
	Ollama    bool   `json:"ollama"` // "via Ollama"
}

// ConversationView is a conversation with its messages.
type ConversationView struct {
	Conversation core.ChatConversation `json:"conversation"`
	Messages     []core.ChatMessage    `json:"messages"`
	// Trimmed is true when older messages no longer fit the context.
	Trimmed bool `json:"trimmed"`
}

// SendResult names the messages Send created; text streams via chat:delta.
type SendResult struct {
	UserMessageID      string `json:"userMessageId"`
	AssistantMessageID string `json:"assistantMessageId"`
	Trimmed            bool   `json:"trimmed"` // "Older messages were left out to fit the context"
}

// Service is Local Chat's typed Wails service (SPEC.md §4.4).
type Service struct{ c *Chat }

// NewService builds the service.
func NewService(c *Chat) *Service { return &Service{c: c} }

// Catalog lists models with install state (plus Ollama models when enabled).
func (s *Service) Catalog() []ModelInfo {
	c := s.c
	out := []ModelInfo{}
	for _, e := range c.entries() {
		out = append(out, ModelInfo{
			ID: e.ID, Label: e.Label, Bytes: e.Bytes, License: e.License, Hint: e.Hint,
			IsDefault: e.IsDefault, Verified: e.Verified, Installed: c.modelPresent(e.ID), JobID: c.downloadJob(e.ID),
		})
	}
	url := c.cfg.Settings.Current().Chat.OllamaURL
	if url == "" {
		c.setOllamaNote("")
		return out
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	models, err := ollamaTags(ctx, url)
	if err != nil {
		slog.Debug("ollama unreachable", "err", err)
		c.setOllamaNote("Ollama isn't reachable at the address in Settings")
		return out
	}
	c.setOllamaNote("")
	for _, m := range models {
		out = append(out, ModelInfo{
			ID: ollamaPrefix + m.Name, Label: m.Name, Bytes: m.Size, Hint: "via Ollama",
			Verified: true, Installed: true, Ollama: true,
		})
	}
	return out
}

// setOllamaNote shows (or clears) the "Ollama unreachable" note on the status.
func (c *Chat) setOllamaNote(note string) {
	c.mu.Lock()
	changed := c.ollamaErr != note
	c.ollamaErr = note
	out := c.statusLocked()
	c.mu.Unlock()
	if changed {
		c.cfg.Emitter.Emit(core.EventChatStatus, out)
	}
}

// DownloadModel queues a model download (or returns the one already queued).
func (s *Service) DownloadModel(id string) (core.Job, error) {
	c := s.c
	if _, ok := c.lookup(id); !ok {
		return core.Job{}, core.ValidationError("Unknown chat model", map[string]string{"model": "Pick a model from the list"})
	}
	if c.cfg.Jobs == nil {
		return core.Job{}, core.Errorf(core.CodeInternal, "Downloads aren't available")
	}
	if jid := c.downloadJob(id); jid != "" {
		return c.cfg.Jobs.Get(context.Background(), jid)
	}
	opts, _ := json.Marshal(ModelOptions{Model: id})
	jobs, err := c.cfg.Jobs.Submit(context.Background(), ModelModuleID, nil, string(opts))
	if err != nil {
		return core.Job{}, err
	}
	if len(jobs) == 0 {
		return core.Job{}, core.Errorf(core.CodeInternal, "The download didn't start")
	}
	return jobs[0], nil
}

// DeleteModel deletes a downloaded model (stopping the server if it uses it).
func (s *Service) DeleteModel(id string) error { return s.c.deleteModel(id) }

// Status returns the chat engine status.
func (s *Service) Status() core.ChatStatus {
	s.c.mu.Lock()
	defer s.c.mu.Unlock()
	return s.c.statusLocked()
}

// Conversations lists conversations, newest first.
func (s *Service) Conversations(search string, cursor string) (core.ChatPage, error) {
	page, err := s.c.cfg.Store.ListConversations(context.Background(), search, 50, cursor)
	if page.Items == nil {
		page.Items = []core.ChatConversation{}
	}
	return page, err
}

// Conversation returns a conversation with its messages.
func (s *Service) Conversation(id string) (ConversationView, error) {
	ctx := context.Background()
	conv, err := s.c.cfg.Store.GetConversation(ctx, id)
	if err != nil {
		return ConversationView{Messages: []core.ChatMessage{}}, err
	}
	msgs, err := s.c.cfg.Store.ListMessages(ctx, id)
	if err != nil {
		return ConversationView{Messages: []core.ChatMessage{}}, err
	}
	if msgs == nil {
		msgs = []core.ChatMessage{}
	}
	_, trimmed := buildHistory(conv.SystemPrompt, msgs, s.c.cfg.Settings.Current().Chat.ContextSize)
	return ConversationView{Conversation: conv, Messages: msgs, Trimmed: trimmed}, nil
}

// validModel accepts a catalog ID or "ollama:<name>".
func (c *Chat) validModel(id string) error {
	if isOllamaID(id) {
		if ollamaName(id) == "" {
			return core.ValidationError("Pick a model", map[string]string{"model": "Pick a model"})
		}
		return nil
	}
	if _, ok := c.lookup(id); !ok {
		return core.ValidationError("Unknown chat model", map[string]string{"model": "Pick a model from the list"})
	}
	return nil
}

// NewConversation creates an empty conversation.
func (s *Service) NewConversation(model string) (core.ChatConversation, error) {
	st := s.c.cfg.Settings.Current().Chat
	if model == "" {
		model = st.DefaultModel
	}
	if err := s.c.validModel(model); err != nil {
		return core.ChatConversation{}, err
	}
	now := core.NowMillis()
	conv := core.ChatConversation{
		ID: core.NewID(), Title: defaultTitle, Model: model, SystemPrompt: st.SystemPrompt,
		CreatedAt: now, UpdatedAt: now,
	}
	if err := s.c.cfg.Store.CreateConversation(context.Background(), conv); err != nil {
		return core.ChatConversation{}, err
	}
	return conv, nil
}

// UpdateConversation renames it or changes its model or system prompt.
func (s *Service) UpdateConversation(id string, patch core.ChatConversationPatch) (core.ChatConversation, error) {
	if patch.Title != nil {
		t := strings.TrimSpace(*patch.Title)
		if t == "" {
			return core.ChatConversation{}, core.ValidationError("The title can't be empty", map[string]string{"title": "Enter a title"})
		}
		if r := []rune(t); len(r) > 200 {
			t = string(r[:200])
		}
		patch.Title = &t
	}
	if patch.Model != nil {
		if err := s.c.validModel(*patch.Model); err != nil {
			return core.ChatConversation{}, err
		}
	}
	if patch.SystemPrompt != nil && len([]rune(*patch.SystemPrompt)) > core.MaxSystemPromptChars {
		return core.ChatConversation{}, core.ValidationError("The system prompt is too long",
			map[string]string{"systemPrompt": fmt.Sprintf("Use at most %d characters", core.MaxSystemPromptChars)})
	}
	return s.c.cfg.Store.UpdateConversation(context.Background(), id, patch)
}

// DeleteConversation deletes a conversation and its messages.
func (s *Service) DeleteConversation(id string) error {
	s.c.stopGenerationFor(func(g *generation) bool { return g.convID == id })
	return s.c.cfg.Store.DeleteConversation(context.Background(), id)
}

// Send appends the user message and an empty assistant message, then streams.
func (s *Service) Send(conversationID string, text string) (SendResult, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return SendResult{}, core.ValidationError("Type a message first", nil)
	}
	return s.c.send(conversationID, func([]core.ChatMessage) (string, string, error) { return text, "", nil })
}

// Regenerate deletes the last assistant message and sends again.
func (s *Service) Regenerate(conversationID string) (SendResult, error) {
	return s.c.send(conversationID, func(msgs []core.ChatMessage) (string, string, error) {
		hasUser := false
		for _, m := range msgs {
			hasUser = hasUser || m.Role == core.ChatRoleUser
		}
		if !hasUser {
			return "", "", core.ValidationError("There's nothing to regenerate yet", nil)
		}
		last := msgs[len(msgs)-1]
		if last.Role == core.ChatRoleAssistant {
			return "", last.ID, nil
		}
		return "", "", nil
	})
}

// EditAndResend truncates from messageID and sends text instead.
func (s *Service) EditAndResend(conversationID, messageID, text string) (SendResult, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return SendResult{}, core.ValidationError("Type a message first", nil)
	}
	return s.c.send(conversationID, func(msgs []core.ChatMessage) (string, string, error) {
		for _, m := range msgs {
			if m.ID == messageID {
				if m.Role != core.ChatRoleUser {
					return "", "", core.ValidationError("Only your own messages can be edited", nil)
				}
				return text, messageID, nil
			}
		}
		return "", "", core.Errorf(core.CodeNotFound, "Message not found")
	})
}

// Stop stops the running generation of a conversation.
func (s *Service) Stop(conversationID string) error {
	s.c.stopGenerationFor(func(g *generation) bool { return g.convID == conversationID })
	return nil
}

// Export writes the conversation as Markdown in <library>/Chats and returns the path.
func (s *Service) Export(conversationID string) (string, error) {
	c := s.c
	ctx := context.Background()
	conv, err := c.cfg.Store.GetConversation(ctx, conversationID)
	if err != nil {
		return "", err
	}
	msgs, err := c.cfg.Store.ListMessages(ctx, conversationID)
	if err != nil {
		return "", err
	}
	lib := ""
	if c.cfg.LibraryDir != nil {
		lib = c.cfg.LibraryDir()
	}
	if lib == "" {
		return "", core.Errorf(core.CodeInternal, "The library folder isn't set")
	}
	dir := filepath.Join(lib, "Chats")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", core.Errorf(core.CodeInternal, "Couldn't create the Chats folder").WithCause(err)
	}
	path := core.UniquePath(dir, fileStem(conv.Title), ".md")
	if err := os.WriteFile(path, []byte(renderMarkdown(conv, msgs)), 0o644); err != nil {
		return "", core.Errorf(core.CodeInternal, "Couldn't save the chat").WithCause(err)
	}
	if c.cfg.RegisterOutput != nil {
		if err := c.cfg.RegisterOutput(path); err != nil {
			slog.Warn("registering chat export", "err", err) // the file is saved either way
		}
	}
	return path, nil
}

// fileStem makes a safe file name stem from a conversation title.
func fileStem(title string) string {
	var b strings.Builder
	for _, r := range title {
		switch {
		case r < 32 || strings.ContainsRune(`<>:"/\|?*`, r):
			b.WriteRune(' ')
		case unicode.IsControl(r):
		default:
			b.WriteRune(r)
		}
	}
	s := strings.Join(strings.Fields(b.String()), " ")
	if r := []rune(s); len(r) > 80 {
		s = string(r[:80])
	}
	s = strings.Trim(s, " .")
	if s == "" || isReservedName(s) {
		return "Chat"
	}
	return s
}

func isReservedName(s string) bool {
	switch strings.ToUpper(strings.SplitN(s, ".", 2)[0]) {
	case "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
		"LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9":
		return true
	}
	return false
}

// renderMarkdown is the exported transcript.
func renderMarkdown(conv core.ChatConversation, msgs []core.ChatMessage) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# %s\n\n", conv.Title)
	fmt.Fprintf(&b, "*Model: %s · %s*\n\n", conv.Model, time.UnixMilli(conv.CreatedAt).Format("2006-01-02 15:04"))
	if conv.SystemPrompt != "" {
		fmt.Fprintf(&b, "> System prompt: %s\n\n", strings.ReplaceAll(conv.SystemPrompt, "\n", "\n> "))
	}
	for _, m := range msgs {
		who := "You"
		if m.Role == core.ChatRoleAssistant {
			who = "Assistant"
			if strings.TrimSpace(m.Content) == "" && m.Status != core.ChatMessageError {
				continue
			}
		}
		fmt.Fprintf(&b, "## %s\n\n%s\n\n", who, strings.TrimSpace(m.Content))
		switch m.Status {
		case core.ChatMessageStopped:
			b.WriteString("*(stopped)*\n\n")
		case core.ChatMessageError:
			fmt.Fprintf(&b, "*(error: %s)*\n\n", m.Error)
		}
	}
	return b.String()
}
