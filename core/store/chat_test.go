package store

import (
	"context"
	"fmt"
	"testing"

	"toolbox/core"
)

func mkConv(id, title string, updated int64) core.ChatConversation {
	return core.ChatConversation{ID: id, Title: title, Model: "qwen3-4b", SystemPrompt: "sp", CreatedAt: updated, UpdatedAt: updated}
}

func mkMsg(id, conv string, role core.ChatRole, content string, at int64) core.ChatMessage {
	return core.ChatMessage{ID: id, ConversationID: conv, Role: role, Content: content, Status: core.ChatMessageDone, CreatedAt: at}
}

func TestChatConversationCRUD(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	if err := db.CreateConversation(ctx, mkConv("c1", "Hello", 100)); err != nil {
		t.Fatal(err)
	}
	got, err := db.GetConversation(ctx, "c1")
	if err != nil || got.Title != "Hello" || got.SystemPrompt != "sp" {
		t.Fatalf("get: %+v %v", got, err)
	}
	title, model := "Renamed", "ollama:x"
	up, err := db.UpdateConversation(ctx, "c1", core.ChatConversationPatch{Title: &title, Model: &model})
	if err != nil || up.Title != "Renamed" || up.Model != "ollama:x" || up.SystemPrompt != "sp" {
		t.Fatalf("update: %+v %v", up, err)
	}
	if err := db.TouchConversation(ctx, "c1", 999); err != nil {
		t.Fatal(err)
	}
	got, _ = db.GetConversation(ctx, "c1")
	if got.UpdatedAt != 999 || got.Title != "Renamed" {
		t.Fatalf("touch: %+v", got)
	}
	if _, err := db.GetConversation(ctx, "nope"); !core.IsCode(err, core.CodeNotFound) {
		t.Fatalf("get missing: %v", err)
	}
	if err := db.TouchConversation(ctx, "nope", 1); !core.IsCode(err, core.CodeNotFound) {
		t.Fatalf("touch missing: %v", err)
	}
	if _, err := db.UpdateConversation(ctx, "nope", core.ChatConversationPatch{}); !core.IsCode(err, core.CodeNotFound) {
		t.Fatalf("update missing: %v", err)
	}
}

func TestChatCascadeDelete(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	db.CreateConversation(ctx, mkConv("c1", "a", 1))
	db.AddMessage(ctx, mkMsg("m1", "c1", core.ChatRoleUser, "hi", 1))
	db.AddMessage(ctx, mkMsg("m2", "c1", core.ChatRoleAssistant, "yo", 2))
	if err := db.DeleteConversation(ctx, "c1"); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := db.sql.QueryRow(`SELECT COUNT(*) FROM chat_messages`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("messages left = %d %v", n, err)
	}
	if err := db.DeleteConversation(ctx, "c1"); !core.IsCode(err, core.CodeNotFound) {
		t.Fatalf("second delete: %v", err)
	}
}

func TestChatMessages(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	db.CreateConversation(ctx, mkConv("c1", "a", 1))
	db.AddMessage(ctx, mkMsg("m1", "c1", core.ChatRoleUser, "hi", 10))
	am := mkMsg("m2", "c1", core.ChatRoleAssistant, "", 10) // same ms as the user message
	db.AddMessage(ctx, am)
	if err := db.UpdateMessage(ctx, "m2", "hello", core.ChatMessageStopped, "oops", 7, 12.5); err != nil {
		t.Fatal(err)
	}
	if err := db.UpdateMessage(ctx, "zz", "", core.ChatMessageDone, "", 0, 0); !core.IsCode(err, core.CodeNotFound) {
		t.Fatalf("update missing: %v", err)
	}
	msgs, err := db.ListMessages(ctx, "c1")
	if err != nil || len(msgs) != 2 || msgs[0].ID != "m1" || msgs[1].ID != "m2" {
		t.Fatalf("list: %+v %v", msgs, err)
	}
	m := msgs[1]
	if m.Content != "hello" || m.Status != core.ChatMessageStopped || m.Error != "oops" || m.Tokens != 7 || m.TokensPerSec != 12.5 || m.Role != core.ChatRoleAssistant {
		t.Fatalf("message = %+v", m)
	}
	if other, _ := db.ListMessages(ctx, "none"); other == nil || len(other) != 0 {
		t.Fatalf("empty list = %#v", other)
	}
}

func TestChatDeleteMessagesFrom(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	db.CreateConversation(ctx, mkConv("c1", "a", 1))
	db.CreateConversation(ctx, mkConv("c2", "b", 1))
	db.AddMessage(ctx, mkMsg("m1", "c1", core.ChatRoleUser, "1", 10))
	db.AddMessage(ctx, mkMsg("m2", "c1", core.ChatRoleAssistant, "2", 10))
	db.AddMessage(ctx, mkMsg("m3", "c1", core.ChatRoleUser, "3", 20))
	db.AddMessage(ctx, mkMsg("m4", "c1", core.ChatRoleAssistant, "4", 20))
	db.AddMessage(ctx, mkMsg("o1", "c2", core.ChatRoleUser, "x", 30))
	if err := db.DeleteMessagesFrom(ctx, "c1", "m2"); err != nil {
		t.Fatal(err)
	}
	msgs, _ := db.ListMessages(ctx, "c1")
	if len(msgs) != 1 || msgs[0].ID != "m1" {
		t.Fatalf("after truncate: %+v", msgs)
	}
	if o, _ := db.ListMessages(ctx, "c2"); len(o) != 1 {
		t.Fatalf("other conversation touched: %+v", o)
	}
	if err := db.DeleteMessagesFrom(ctx, "c1", "o1"); !core.IsCode(err, core.CodeNotFound) {
		t.Fatalf("foreign message: %v", err)
	}
}

func TestChatListSearchAndPaging(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	for i := 1; i <= 5; i++ {
		db.CreateConversation(ctx, mkConv(fmt.Sprintf("c%d", i), fmt.Sprintf("Chat %d", i), int64(i*10)))
	}
	db.CreateConversation(ctx, mkConv("c6", "100% sure", 5))
	db.AddMessage(ctx, mkMsg("m1", "c2", core.ChatRoleUser, "tell me about Pineapples", 1))

	p1, err := db.ListConversations(ctx, "", 2, "")
	if err != nil || len(p1.Items) != 2 || p1.Items[0].ID != "c5" || p1.Items[1].ID != "c4" || p1.NextCursor == "" {
		t.Fatalf("page1: %+v %v", p1, err)
	}
	p2, _ := db.ListConversations(ctx, "", 2, p1.NextCursor)
	if len(p2.Items) != 2 || p2.Items[0].ID != "c3" || p2.Items[1].ID != "c2" || p2.NextCursor == "" {
		t.Fatalf("page2: %+v", p2)
	}
	p3, _ := db.ListConversations(ctx, "", 2, p2.NextCursor)
	if len(p3.Items) != 2 || p3.Items[0].ID != "c1" || p3.Items[1].ID != "c6" || p3.NextCursor != "" {
		t.Fatalf("page3: %+v", p3)
	}
	if _, err := db.ListConversations(ctx, "", 2, "!!bad"); !core.IsCode(err, core.CodeValidation) {
		t.Fatalf("bad cursor: %v", err)
	}
	// message content match (case-insensitive), title match, LIKE wildcards escaped
	if r, _ := db.ListConversations(ctx, "pineapple", 10, ""); len(r.Items) != 1 || r.Items[0].ID != "c2" {
		t.Fatalf("content search: %+v", r.Items)
	}
	if r, _ := db.ListConversations(ctx, "Chat 3", 10, ""); len(r.Items) != 1 || r.Items[0].ID != "c3" {
		t.Fatalf("title search: %+v", r.Items)
	}
	if r, _ := db.ListConversations(ctx, "%", 10, ""); len(r.Items) != 1 || r.Items[0].ID != "c6" {
		t.Fatalf("wildcard search: %+v", r.Items)
	}
	if r, _ := db.ListConversations(ctx, "zzz", 10, ""); r.Items == nil || len(r.Items) != 0 {
		t.Fatalf("no match: %#v", r.Items)
	}
}
