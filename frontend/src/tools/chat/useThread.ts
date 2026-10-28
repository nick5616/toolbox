import { useCallback, useEffect, useRef, useState } from "react";
import { ChatMessageStatus, ChatRole, ChatService, type ChatDone, type ChatMessage, type ChatSendResult } from "@/lib/api";
import { on } from "@/lib/events";

export function isStreaming(m: ChatMessage): boolean {
  return m.role === ChatRole.ChatRoleAssistant && !m.status;
}

interface Pending {
  text: string;
  done?: ChatDone;
}

function applyDone(m: ChatMessage, d: ChatDone): ChatMessage {
  return { ...m, status: d.status, error: d.error, tokens: d.tokens, tokensPerSec: d.tokensPerSec };
}

export interface BeginOptions {
  /** Text of the new user message (Send, EditAndResend). Omitted for Regenerate. */
  userText?: string;
  /** Regenerate: the last assistant message is replaced. */
  dropLastAssistant?: boolean;
  /** EditAndResend: everything from this message on is replaced. */
  truncateFrom?: string;
}

/**
 * Messages of the open conversation, kept in step with chat:delta / chat:done.
 * Deltas that arrive before Send resolves (so the message ID isn't known yet)
 * are buffered and applied when the assistant message is added.
 */
export function useThread(activeId: string | null, onDone: (d: ChatDone) => void) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [trimmed, setTrimmed] = useState(false);
  const ref = useRef<ChatMessage[]>([]);
  const activeRef = useRef<string | null>(activeId);
  const pending = useRef(new Map<string, Pending>());
  const seq = useRef(0);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  activeRef.current = activeId;

  const commit = useCallback((next: ChatMessage[]) => {
    ref.current = next;
    setMessages(next);
  }, []);

  useEffect(() => {
    const offDelta = on("chat:delta", (d) => {
      if (d.conversationId !== activeRef.current) return;
      if (ref.current.some((m) => m.id === d.messageId)) {
        commit(ref.current.map((m) => (m.id === d.messageId ? { ...m, content: m.content + d.delta } : m)));
      } else {
        const p = pending.current.get(d.messageId) ?? { text: "" };
        p.text += d.delta;
        pending.current.set(d.messageId, p);
      }
    });
    const offDone = on("chat:done", (d) => {
      if (d.conversationId === activeRef.current) {
        if (ref.current.some((m) => m.id === d.messageId)) {
          commit(ref.current.map((m) => (m.id === d.messageId ? applyDone(m, d) : m)));
        } else {
          const p = pending.current.get(d.messageId) ?? { text: "" };
          p.done = d;
          pending.current.set(d.messageId, p);
        }
      }
      onDoneRef.current(d);
    });
    return () => {
      offDelta();
      offDone();
    };
  }, [commit]);

  const load = useCallback(
    async (id: string) => {
      const my = ++seq.current;
      pending.current.clear();
      const view = await ChatService.Conversation(id);
      if (seq.current !== my) return;
      setTrimmed(view.trimmed);
      commit(view.messages ?? []);
    },
    [commit],
  );

  const clear = useCallback(() => {
    seq.current++;
    pending.current.clear();
    setTrimmed(false);
    commit([]);
  }, [commit]);

  const begin = useCallback(
    (conversationId: string, res: ChatSendResult, opts: BeginOptions = {}) => {
      let base = ref.current;
      if (opts.dropLastAssistant) {
        const last = base[base.length - 1];
        if (last && last.role === ChatRole.ChatRoleAssistant) base = base.slice(0, -1);
      }
      if (opts.truncateFrom) {
        const at = base.findIndex((m) => m.id === opts.truncateFrom);
        if (at >= 0) base = base.slice(0, at);
      }
      const now = Date.now();
      const blank = { conversationId, error: "", tokens: 0, tokensPerSec: 0, createdAt: now };
      const next = base.slice();
      if (opts.userText !== undefined) {
        next.push({
          ...blank,
          id: res.userMessageId,
          role: ChatRole.ChatRoleUser,
          content: opts.userText,
          status: ChatMessageStatus.ChatMessageDone,
        });
      }
      let assistant: ChatMessage = {
        ...blank,
        id: res.assistantMessageId,
        role: ChatRole.ChatRoleAssistant,
        content: "",
        status: ChatMessageStatus.$zero,
      };
      const p = pending.current.get(res.assistantMessageId);
      if (p) {
        pending.current.delete(res.assistantMessageId);
        assistant = { ...assistant, content: p.text };
        if (p.done) assistant = applyDone(assistant, p.done);
      }
      next.push(assistant);
      setTrimmed(res.trimmed);
      commit(next);
    },
    [commit],
  );

  return { messages, trimmed, load, clear, begin };
}
