import { useMemo, useState } from "react";
import { Button, ConfirmDialog, MenuButton, TextField, cx } from "@/components";
import type { ChatConversation } from "@/lib/api";
import { groupConversations } from "./grouping";
import styles from "./Chat.module.css";

export interface ConversationListProps {
  items: ChatConversation[];
  activeId: string | null;
  search: string;
  onSearch: (q: string) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onExport: (id: string) => void;
  hasMore: boolean;
  onMore: () => void;
}

export function ConversationList(p: ConversationListProps) {
  const groups = useMemo(() => groupConversations(p.items), [p.items]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [deleting, setDeleting] = useState<ChatConversation | null>(null);

  const commitRename = (c: ChatConversation) => {
    const title = draft.trim();
    setRenaming(null);
    if (title && title !== c.title) p.onRename(c.id, title);
  };

  return (
    <nav className={styles.sidebar} aria-label="Conversations">
      <div className={styles.sideTop}>
        <Button variant="primary" icon="message-square" onClick={p.onNew} className={styles.newBtn}>
          New chat
        </Button>
        <TextField
          icon="search"
          size="sm"
          aria-label="Search conversations"
          placeholder="Search"
          value={p.search}
          onChange={(e) => p.onSearch(e.target.value)}
        />
      </div>
      <div className={styles.sideList}>
        {groups.length === 0 && (
          <p className={styles.sideEmpty}>{p.search.trim() ? "No matching chats" : "No conversations yet"}</p>
        )}
        {groups.map((g) => (
          <section key={g.label} aria-label={g.label}>
            <h3 className={styles.groupLabel}>{g.label}</h3>
            {g.items.map((c) =>
              renaming === c.id ? (
                <div key={c.id} className={styles.convRow}>
                  <TextField
                    size="sm"
                    aria-label="Conversation title"
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => commitRename(c)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename(c);
                      else if (e.key === "Escape") setRenaming(null);
                    }}
                  />
                </div>
              ) : (
                <div key={c.id} className={cx(styles.convRow, c.id === p.activeId && styles.convActive)}>
                  <button
                    type="button"
                    className={styles.convBtn}
                    aria-current={c.id === p.activeId ? "true" : undefined}
                    onClick={() => p.onSelect(c.id)}
                  >
                    {c.title || "New chat"}
                  </button>
                  <MenuButton
                    label={`Actions for ${c.title || "New chat"}`}
                    icon="chevron-down"
                    variant="ghost"
                    size="sm"
                    items={() => [
                      {
                        id: "rename",
                        label: "Rename",
                        onSelect: () => {
                          setDraft(c.title);
                          setRenaming(c.id);
                        },
                      },
                      { id: "export", label: "Export as Markdown", onSelect: () => p.onExport(c.id) },
                      { id: "delete", label: "Delete", icon: "trash-2", onSelect: () => setDeleting(c) },
                    ]}
                  />
                </div>
              ),
            )}
          </section>
        ))}
        {p.hasMore && (
          <Button variant="ghost" size="sm" onClick={p.onMore}>
            Show more
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={deleting !== null}
        tone="danger"
        title="Delete this conversation?"
        body={deleting ? `"${deleting.title || "New chat"}" and its messages will be removed.` : undefined}
        confirmLabel="Delete"
        onConfirm={() => {
          if (deleting) p.onDelete(deleting.id);
          setDeleting(null);
        }}
        onCancel={() => setDeleting(null)}
      />
    </nav>
  );
}
