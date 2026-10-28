import { useLayoutEffect, useRef, useState } from "react";
import { Button, IconButton, Markdown, TextArea, toast, cx } from "@/components";
import { ChatMessageStatus, ChatRole, type ChatMessage } from "@/lib/api";
import { isStreaming } from "./useThread";
import styles from "./Chat.module.css";

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast({ title: "Copied", tone: "success", duration: 1800 });
  } catch {
    toast({ title: "Couldn't copy to the clipboard", tone: "danger" });
  }
}

interface BubbleProps {
  message: ChatMessage;
  isLast: boolean;
  busy: boolean;
  backendLabel: string;
  onRetry: () => void;
  onEdit: (messageId: string, text: string) => void;
}

function Bubble({ message: m, isLast, busy, backendLabel, onRetry, onEdit }: BubbleProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  if (m.role === ChatRole.ChatRoleUser) {
    return (
      <article className={cx(styles.msg, styles.user)} aria-label="You">
        {editing ? (
          <div className={styles.editBox}>
            <TextArea
              aria-label="Edit message"
              value={draft}
              minRows={2}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setEditing(false);
              }}
              autoFocus
            />
            <div className={styles.editActions}>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={draft.trim() === ""}
                onClick={() => {
                  setEditing(false);
                  onEdit(m.id, draft.trim());
                }}
              >
                Save and resend
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className={cx(styles.bubble, styles.userBubble)}>{m.content}</div>
            <div className={styles.actions}>
              <IconButton size="sm" icon="copy" label="Copy message" onClick={() => void copy(m.content)} />
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setDraft(m.content);
                  setEditing(true);
                }}
              >
                Edit &amp; resend
              </Button>
            </div>
          </>
        )}
      </article>
    );
  }

  const streaming = isStreaming(m);
  const stopped = m.status === ChatMessageStatus.ChatMessageStopped;
  const failed = m.status === ChatMessageStatus.ChatMessageError;
  return (
    <article className={cx(styles.msg, styles.assistant)} aria-label="Assistant" aria-busy={streaming || undefined}>
      <div className={cx(styles.bubble, styles.assistantBubble)}>
        {m.content && <Markdown text={m.content} />}
        {streaming && <span className={styles.caret} data-testid="caret" aria-hidden="true" />}
        {stopped && <div className={styles.stateNote}>Stopped</div>}
        {failed && (
          <div className={cx(styles.stateNote, styles.stateError)} role="alert">
            {m.error || "Something went wrong"}
          </div>
        )}
      </div>
      {!streaming && (
        <div className={styles.actions}>
          {m.content && <IconButton size="sm" icon="copy" label="Copy answer" onClick={() => void copy(m.content)} />}
          {(stopped || failed) && isLast && (
            <Button size="sm" variant="secondary" icon="rotate-ccw" disabled={busy} onClick={onRetry}>
              Retry
            </Button>
          )}
          {m.status === ChatMessageStatus.ChatMessageDone && m.tokensPerSec > 0 && (
            <span className={styles.footer}>
              {Math.round(m.tokensPerSec)} tok/s{backendLabel ? ` · ${backendLabel}` : ""}
            </span>
          )}
        </div>
      )}
    </article>
  );
}

export interface ThreadProps {
  messages: ChatMessage[];
  busy: boolean;
  backendLabel: string;
  onRetry: () => void;
  onEdit: (messageId: string, text: string) => void;
}

/** Scrolling list of bubbles; sticks to the bottom while the user hasn't scrolled up. */
export function Thread({ messages, busy, backendLabel, onRetry, onEdit }: ThreadProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  return (
    <div
      ref={scroller}
      className={styles.thread}
      role="log"
      aria-label="Conversation"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      }}
    >
      <div className={styles.threadInner}>
        {messages.map((m, i) => (
          <Bubble
            key={m.id}
            message={m}
            isLast={i === messages.length - 1}
            busy={busy}
            backendLabel={backendLabel}
            onRetry={onRetry}
            onEdit={onEdit}
          />
        ))}
      </div>
    </div>
  );
}
