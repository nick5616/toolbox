import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button, Spinner, TextArea } from "@/components";
import styles from "./Chat.module.css";

export interface ComposerProps {
  /** The engine is starting: the box is disabled and shows "Loading model…". */
  loading: boolean;
  /** Cannot send for another reason (no model, missing engine). */
  blocked: boolean;
  blockedReason?: string;
  generating: boolean;
  /** Purpose of a background completion using the engine ("" = none). */
  busy?: string;
  /** Resolves true when the message was accepted (the box is then cleared). */
  onSend: (text: string) => Promise<boolean>;
  onStop: () => void;
}

/** Auto-growing composer: Enter sends, Shift+Enter adds a line, Esc or the Stop button stops. */
export function Composer({ loading, blocked, blockedReason, generating, busy, onSend, onStop }: ComposerProps) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const disabled = loading || blocked;

  useEffect(() => {
    if (!disabled) ref.current?.focus();
  }, [disabled]);

  const send = async () => {
    const value = text.trim();
    if (!value || disabled || generating) return;
    setText("");
    const ok = await onSend(value);
    if (!ok) setText((cur) => (cur === "" ? value : cur));
    ref.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    } else if (e.key === "Escape" && generating) {
      e.preventDefault();
      onStop();
    }
  };

  return (
    <div className={styles.composer}>
      {busy ? (
        <p className={styles.busyLine} role="status">
          Busy: {busy.toLowerCase()}…
        </p>
      ) : null}
      <div className={styles.composerBox}>
        <TextArea
          ref={ref}
          aria-label="Message"
          value={text}
          minRows={1}
          maxRows={8}
          disabled={disabled}
          placeholder={loading ? "Loading model…" : (blockedReason ?? "Message")}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {loading && <Spinner size={14} label="Loading model" className={styles.composerSpin} />}
      </div>
      {generating ? (
        <Button variant="secondary" icon="square" onClick={onStop}>
          Stop
        </Button>
      ) : (
        <Button variant="primary" disabled={disabled || text.trim() === ""} onClick={() => void send()}>
          Send
        </Button>
      )}
    </div>
  );
}
