package chat

import "toolbox/core"

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
func (s *Service) Catalog() []ModelInfo { return []ModelInfo{} }

// DownloadModel queues a model download.
func (s *Service) DownloadModel(id string) (core.Job, error) { return core.Job{}, errNotBuilt }

// DeleteModel deletes a downloaded model (stopping the server if it uses it).
func (s *Service) DeleteModel(id string) error { return errNotBuilt }

// Status returns the chat engine status.
func (s *Service) Status() core.ChatStatus { return core.ChatStatus{State: core.ChatStopped} }

// Conversations lists conversations, newest first.
func (s *Service) Conversations(search string, cursor string) (core.ChatPage, error) {
	return core.ChatPage{Items: []core.ChatConversation{}}, errNotBuilt
}

// Conversation returns a conversation with its messages.
func (s *Service) Conversation(id string) (ConversationView, error) {
	return ConversationView{Messages: []core.ChatMessage{}}, errNotBuilt
}

// NewConversation creates an empty conversation.
func (s *Service) NewConversation(model string) (core.ChatConversation, error) {
	return core.ChatConversation{}, errNotBuilt
}

// UpdateConversation renames it or changes its model or system prompt.
func (s *Service) UpdateConversation(id string, patch core.ChatConversationPatch) (core.ChatConversation, error) {
	return core.ChatConversation{}, errNotBuilt
}

// DeleteConversation deletes a conversation and its messages.
func (s *Service) DeleteConversation(id string) error { return errNotBuilt }

// Send appends the user message and an empty assistant message, then streams.
func (s *Service) Send(conversationID string, text string) (SendResult, error) {
	return SendResult{}, errNotBuilt
}

// Regenerate deletes the last assistant message and sends again.
func (s *Service) Regenerate(conversationID string) (SendResult, error) {
	return SendResult{}, errNotBuilt
}

// EditAndResend truncates from messageID and sends text instead.
func (s *Service) EditAndResend(conversationID, messageID, text string) (SendResult, error) {
	return SendResult{}, errNotBuilt
}

// Stop stops the running generation of a conversation.
func (s *Service) Stop(conversationID string) error { return errNotBuilt }

// Export writes the conversation as Markdown in <library>/Chats and returns the path.
func (s *Service) Export(conversationID string) (string, error) { return "", errNotBuilt }
