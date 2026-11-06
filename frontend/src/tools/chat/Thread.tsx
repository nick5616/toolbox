import { useLayoutEffect, useRef, useState } from "react";
import { Button, IconButton, Markdown, TextArea, cx } from "@/components";
import { copyText } from "@/lib/copy";
import { TextActions } from "@/tools/_kit";
import { ChatMessageStatus, ChatRole, type ChatMessage } from "@/lib/api";
import { isStreaming } from "./useThread";
import styles from "./Chat.module.css";

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
              data-tip="Change your message; the answer after it is replaced. Esc cancels"
              value={draft}
              minRows={2}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setEditing(false);
              }}
              autoFocus
            />
            <div className={styles.editActions}>
              <Button size="sm" variant="ghost" data-tip="Keep the original message" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={draft.trim() === ""}
                data-tip={draft.trim() === "" ? "The message cannot be empty" : "Replace your message and ask again; later messages are dropped"}
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
              <IconButton size="sm" icon="copy" label="Copy message" data-tip="Copy what you wrote to the clipboard" onClick={() => void copyText(m.content)} />
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                data-tip={busy ? "Wait for the current answer to finish" : "Change this message and get a new answer"}
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
        {stopped && <div className={styles.stateNote} data-tip="You stopped this answer before it finished">Stopped</div>}
        {failed && (
          <div className={cx(styles.stateNote, styles.stateError)} role="alert">
            {m.error || "Something went wrong"}
          </div>
        )}
      </div>
      {!streaming && (
        <div className={styles.actions}>
          {m.content && <TextActions text={m.content} filename="answer.md" what="answer" />}
          {(stopped || failed) && isLast && (
            <Button size="sm" variant="secondary" icon="rotate-ccw" disabled={busy} data-tip={busy ? "Wait for the current answer to finish" : "Ask again and replace this answer"} onClick={onRetry}>
              Retry
            </Button>
          )}
          {m.status === ChatMessageStatus.ChatMessageDone && m.tokensPerSec > 0 && (
            <span className={styles.footer} data-tip="Answer speed in tokens (word pieces) per second, and where it ran">
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
