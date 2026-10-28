package store

import (
	"context"

	"toolbox/core"
)

// Chat persistence (SPEC.md §3.5). CONTRACT STUB: CH1 implements these
// against migration 0004.

var _ core.ChatStore = (*DB)(nil)

var errChatNotBuilt = core.Errorf(core.CodeInternal, "Chat storage isn't available yet")

// CreateConversation implements core.ChatStore.
func (db *DB) CreateConversation(ctx context.Context, c core.ChatConversation) error {
	return errChatNotBuilt
}

// UpdateConversation implements core.ChatStore.
func (db *DB) UpdateConversation(ctx context.Context, id string, p core.ChatConversationPatch) (core.ChatConversation, error) {
	return core.ChatConversation{}, errChatNotBuilt
}

// TouchConversation implements core.ChatStore.
func (db *DB) TouchConversation(ctx context.Context, id string, at int64) error {
	return errChatNotBuilt
}

// DeleteConversation implements core.ChatStore.
func (db *DB) DeleteConversation(ctx context.Context, id string) error { return errChatNotBuilt }

// GetConversation implements core.ChatStore.
func (db *DB) GetConversation(ctx context.Context, id string) (core.ChatConversation, error) {
	return core.ChatConversation{}, errChatNotBuilt
}

// ListConversations implements core.ChatStore.
func (db *DB) ListConversations(ctx context.Context, search string, limit int, cursor string) (core.ChatPage, error) {
	return core.ChatPage{Items: []core.ChatConversation{}}, errChatNotBuilt
}

// AddMessage implements core.ChatStore.
func (db *DB) AddMessage(ctx context.Context, m core.ChatMessage) error { return errChatNotBuilt }

// UpdateMessage implements core.ChatStore.
func (db *DB) UpdateMessage(ctx context.Context, id, content string, status core.ChatMessageStatus, errMsg string, tokens int, tps float64) error {
	return errChatNotBuilt
}

// ListMessages implements core.ChatStore.
func (db *DB) ListMessages(ctx context.Context, conversationID string) ([]core.ChatMessage, error) {
	return []core.ChatMessage{}, errChatNotBuilt
}

// DeleteMessagesFrom implements core.ChatStore.
func (db *DB) DeleteMessagesFrom(ctx context.Context, conversationID, messageID string) error {
	return errChatNotBuilt
}
