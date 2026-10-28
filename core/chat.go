package core

import "context"

// Chat wire types (SPEC.md §3.5, §4.4).

// ChatRole is who wrote a chat message.
type ChatRole string

const (
	ChatRoleUser      ChatRole = "user"
	ChatRoleAssistant ChatRole = "assistant"
)

// ChatMessageStatus is how an assistant message ended.
type ChatMessageStatus string

const (
	ChatMessageDone    ChatMessageStatus = "done"
	ChatMessageStopped ChatMessageStatus = "stopped"
	ChatMessageError   ChatMessageStatus = "error"
)

// ChatConversation is one stored conversation.
type ChatConversation struct {
	ID           string `json:"id"`
	Title        string `json:"title"`
	Model        string `json:"model"` // catalog ID or "ollama:<name>"
	SystemPrompt string `json:"systemPrompt"`
	CreatedAt    int64  `json:"createdAt"`
	UpdatedAt    int64  `json:"updatedAt"`
}

// ChatMessage is one message in a conversation.
type ChatMessage struct {
	ID             string            `json:"id"`
	ConversationID string            `json:"conversationId"`
	Role           ChatRole          `json:"role"`
	Content        string            `json:"content"`
	Status         ChatMessageStatus `json:"status"`
	Error          string            `json:"error"`
	Tokens         int               `json:"tokens"`
	TokensPerSec   float64           `json:"tokensPerSec"`
	CreatedAt      int64             `json:"createdAt"`
}

// ChatPage is a page of conversations, newest first.
type ChatPage struct {
	Items      []ChatConversation `json:"items"`
	NextCursor string             `json:"nextCursor"` // "" = no more
}

// ChatConversationPatch updates the non-nil fields.
type ChatConversationPatch struct {
	Title        *string `json:"title"`
	Model        *string `json:"model"`
	SystemPrompt *string `json:"systemPrompt"`
}

// ChatStore persists Local Chat conversations (SPEC.md §3.5).
type ChatStore interface {
	CreateConversation(ctx context.Context, c ChatConversation) error
	UpdateConversation(ctx context.Context, id string, p ChatConversationPatch) (ChatConversation, error)
	// TouchConversation sets updated_at.
	TouchConversation(ctx context.Context, id string, at int64) error
	DeleteConversation(ctx context.Context, id string) error
	// GetConversation returns an *AppError with CodeNotFound for unknown IDs.
	GetConversation(ctx context.Context, id string) (ChatConversation, error)
	// ListConversations matches search (LIKE) against titles and message
	// content; cursor is the previous page's NextCursor ("" = first page).
	ListConversations(ctx context.Context, search string, limit int, cursor string) (ChatPage, error)
	AddMessage(ctx context.Context, m ChatMessage) error
	UpdateMessage(ctx context.Context, id, content string, status ChatMessageStatus, errMsg string, tokens int, tps float64) error
	// ListMessages returns a conversation's messages, oldest first.
	ListMessages(ctx context.Context, conversationID string) ([]ChatMessage, error)
	// DeleteMessagesFrom deletes messageID and every later message of the
	// conversation (regenerate and edit-and-resend).
	DeleteMessagesFrom(ctx context.Context, conversationID, messageID string) error
}

// ChatDelta is the payload of chat:delta (coalesced ≤ every 40 ms).
type ChatDelta struct {
	ConversationID string `json:"conversationId"`
	MessageID      string `json:"messageId"`
	Delta          string `json:"delta"`
}

// ChatDone is the payload of chat:done.
type ChatDone struct {
	ConversationID string            `json:"conversationId"`
	MessageID      string            `json:"messageId"`
	Status         ChatMessageStatus `json:"status"`
	Error          string            `json:"error"`
	Tokens         int               `json:"tokens"`
	TokensPerSec   float64           `json:"tokensPerSec"`
}

// ChatServerState is the chat engine's lifecycle state.
type ChatServerState string

const (
	ChatStopped  ChatServerState = "stopped"
	ChatStarting ChatServerState = "starting"
	ChatReady    ChatServerState = "ready"
	ChatError    ChatServerState = "error"
)

// ChatBackend says where answers come from.
type ChatBackend string

const (
	ChatBackendGPU    ChatBackend = "gpu"
	ChatBackendCPU    ChatBackend = "cpu"
	ChatBackendOllama ChatBackend = "ollama"
)

// ChatStatus is the payload of chat:status. The port is never sent to the UI.
type ChatStatus struct {
	State   ChatServerState `json:"state"`
	Model   string          `json:"model"`
	Backend ChatBackend     `json:"backend"`
	Error   string          `json:"error"`
	Notice  string          `json:"notice"` // e.g. "The GPU ran out of memory, so answers run on the CPU"
}

// VaultState is the payload of vault:state (SPEC.md §6.2).
type VaultState struct {
	Exists          bool  `json:"exists"`
	Unlocked        bool  `json:"unlocked"`
	Entries         int   `json:"entries"`
	AutoLockMinutes int   `json:"autoLockMinutes"`
	LockAt          int64 `json:"lockAt"` // Unix ms; 0 = no timer
}
