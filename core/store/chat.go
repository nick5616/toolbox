package store

import (
	"context"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"toolbox/core"
)

// Chat persistence (SPEC.md §3.5), backed by migration 0004.

var _ core.ChatStore = (*DB)(nil)

const convCols = `id, title, model, system_prompt, created_at, updated_at`
const msgCols = `id, conversation_id, role, content, status, error, tokens, tokens_per_sec, created_at`

func scanConv(sc interface{ Scan(...any) error }) (core.ChatConversation, error) {
	var c core.ChatConversation
	err := sc.Scan(&c.ID, &c.Title, &c.Model, &c.SystemPrompt, &c.CreatedAt, &c.UpdatedAt)
	return c, err
}

func chatNotFound() error { return core.Errorf(core.CodeNotFound, "Conversation not found") }

// CreateConversation implements core.ChatStore.
func (d *DB) CreateConversation(ctx context.Context, c core.ChatConversation) error {
	_, err := d.sql.ExecContext(ctx, `INSERT INTO chat_conversations (`+convCols+`) VALUES (?,?,?,?,?,?)`,
		c.ID, c.Title, c.Model, c.SystemPrompt, c.CreatedAt, c.UpdatedAt)
	if err != nil {
		return fmt.Errorf("insert conversation: %w", err)
	}
	return nil
}

// UpdateConversation implements core.ChatStore.
func (d *DB) UpdateConversation(ctx context.Context, id string, p core.ChatConversationPatch) (core.ChatConversation, error) {
	cur, err := d.GetConversation(ctx, id)
	if err != nil {
		return core.ChatConversation{}, err
	}
	if p.Title != nil {
		cur.Title = *p.Title
	}
	if p.Model != nil {
		cur.Model = *p.Model
	}
	if p.SystemPrompt != nil {
		cur.SystemPrompt = *p.SystemPrompt
	}
	if _, err := d.sql.ExecContext(ctx, `UPDATE chat_conversations SET title = ?, model = ?, system_prompt = ? WHERE id = ?`,
		cur.Title, cur.Model, cur.SystemPrompt, id); err != nil {
		return core.ChatConversation{}, fmt.Errorf("update conversation: %w", err)
	}
	return cur, nil
}

// TouchConversation implements core.ChatStore.
func (d *DB) TouchConversation(ctx context.Context, id string, at int64) error {
	res, err := d.sql.ExecContext(ctx, `UPDATE chat_conversations SET updated_at = ? WHERE id = ?`, at, id)
	if err != nil {
		return fmt.Errorf("touch conversation: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return chatNotFound()
	}
	return nil
}

// DeleteConversation implements core.ChatStore (messages cascade).
func (d *DB) DeleteConversation(ctx context.Context, id string) error {
	res, err := d.sql.ExecContext(ctx, `DELETE FROM chat_conversations WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete conversation: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return chatNotFound()
	}
	return nil
}

// GetConversation implements core.ChatStore.
func (d *DB) GetConversation(ctx context.Context, id string) (core.ChatConversation, error) {
	c, err := scanConv(d.sql.QueryRowContext(ctx, `SELECT `+convCols+` FROM chat_conversations WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return core.ChatConversation{}, chatNotFound()
	}
	if err != nil {
		return core.ChatConversation{}, fmt.Errorf("get conversation: %w", err)
	}
	return c, nil
}

func encodeChatCursor(c core.ChatConversation) string {
	return base64.RawURLEncoding.EncodeToString([]byte(strconv.FormatInt(c.UpdatedAt, 10) + ":" + c.ID))
}

func decodeChatCursor(cur string) (int64, string, error) {
	b, err := base64.RawURLEncoding.DecodeString(cur)
	if err != nil {
		return 0, "", err
	}
	at, id, ok := strings.Cut(string(b), ":")
	if !ok {
		return 0, "", errors.New("malformed cursor")
	}
	n, err := strconv.ParseInt(at, 10, 64)
	return n, id, err
}

// ListConversations implements core.ChatStore.
func (d *DB) ListConversations(ctx context.Context, search string, limit int, cursor string) (core.ChatPage, error) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	var where []string
	var args []any
	if s := strings.TrimSpace(search); s != "" {
		like := "%" + escapeLike(s) + "%"
		where = append(where, `(title LIKE ? ESCAPE '\' OR EXISTS (SELECT 1 FROM chat_messages m WHERE m.conversation_id = chat_conversations.id AND m.content LIKE ? ESCAPE '\'))`)
		args = append(args, like, like)
	}
	if cursor != "" {
		at, id, err := decodeChatCursor(cursor)
		if err != nil {
			return core.ChatPage{}, core.Errorf(core.CodeValidation, "Invalid page cursor")
		}
		where = append(where, `(updated_at < ? OR (updated_at = ? AND id < ?))`)
		args = append(args, at, at, id)
	}
	q := `SELECT ` + convCols + ` FROM chat_conversations`
	if len(where) > 0 {
		q += ` WHERE ` + strings.Join(where, " AND ")
	}
	q += ` ORDER BY updated_at DESC, id DESC LIMIT ?`
	args = append(args, limit+1)
	rows, err := d.sql.QueryContext(ctx, q, args...)
	if err != nil {
		return core.ChatPage{}, fmt.Errorf("list conversations: %w", err)
	}
	defer rows.Close()
	items := []core.ChatConversation{}
	for rows.Next() {
		c, err := scanConv(rows)
		if err != nil {
			return core.ChatPage{}, fmt.Errorf("scan conversation: %w", err)
		}
		items = append(items, c)
	}
	if err := rows.Err(); err != nil {
		return core.ChatPage{}, err
	}
	page := core.ChatPage{Items: items}
	if len(items) > limit {
		page.Items = items[:limit]
		page.NextCursor = encodeChatCursor(page.Items[limit-1])
	}
	return page, nil
}

// AddMessage implements core.ChatStore.
func (d *DB) AddMessage(ctx context.Context, m core.ChatMessage) error {
	if m.Status == "" {
		m.Status = core.ChatMessageDone
	}
	_, err := d.sql.ExecContext(ctx, `INSERT INTO chat_messages (`+msgCols+`) VALUES (?,?,?,?,?,?,?,?,?)`,
		m.ID, m.ConversationID, string(m.Role), m.Content, string(m.Status), m.Error, m.Tokens, m.TokensPerSec, m.CreatedAt)
	if err != nil {
		return fmt.Errorf("insert message: %w", err)
	}
	return nil
}

// UpdateMessage implements core.ChatStore.
func (d *DB) UpdateMessage(ctx context.Context, id, content string, status core.ChatMessageStatus, errMsg string, tokens int, tps float64) error {
	res, err := d.sql.ExecContext(ctx, `UPDATE chat_messages SET content = ?, status = ?, error = ?, tokens = ?, tokens_per_sec = ? WHERE id = ?`,
		content, string(status), errMsg, tokens, tps, id)
	if err != nil {
		return fmt.Errorf("update message: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return core.Errorf(core.CodeNotFound, "Message not found")
	}
	return nil
}

// ListMessages implements core.ChatStore.
func (d *DB) ListMessages(ctx context.Context, conversationID string) ([]core.ChatMessage, error) {
	rows, err := d.sql.QueryContext(ctx, `SELECT `+msgCols+` FROM chat_messages WHERE conversation_id = ? ORDER BY created_at, rowid`, conversationID)
	if err != nil {
		return []core.ChatMessage{}, fmt.Errorf("list messages: %w", err)
	}
	defer rows.Close()
	out := []core.ChatMessage{}
	for rows.Next() {
		var m core.ChatMessage
		var role, status string
		if err := rows.Scan(&m.ID, &m.ConversationID, &role, &m.Content, &status, &m.Error, &m.Tokens, &m.TokensPerSec, &m.CreatedAt); err != nil {
			return []core.ChatMessage{}, fmt.Errorf("scan message: %w", err)
		}
		m.Role, m.Status = core.ChatRole(role), core.ChatMessageStatus(status)
		out = append(out, m)
	}
	return out, rows.Err()
}

// DeleteMessagesFrom implements core.ChatStore: messageID and every later
// message (by creation order) of the conversation.
func (d *DB) DeleteMessagesFrom(ctx context.Context, conversationID, messageID string) error {
	var at, rowid int64
	err := d.sql.QueryRowContext(ctx, `SELECT created_at, rowid FROM chat_messages WHERE id = ? AND conversation_id = ?`,
		messageID, conversationID).Scan(&at, &rowid)
	if errors.Is(err, sql.ErrNoRows) {
		return core.Errorf(core.CodeNotFound, "Message not found")
	}
	if err != nil {
		return fmt.Errorf("find message: %w", err)
	}
	if _, err := d.sql.ExecContext(ctx, `DELETE FROM chat_messages WHERE conversation_id = ? AND (created_at > ? OR (created_at = ? AND rowid >= ?))`,
		conversationID, at, at, rowid); err != nil {
		return fmt.Errorf("delete messages: %w", err)
	}
	return nil
}
