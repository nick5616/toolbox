import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Button, Icon, TextField } from "@/components";
import { FocusWeaken, type FocusFriction } from "@/lib/api";
import { formatMmSs, phraseMatches, secondsUntil } from "./model";
import styles from "./FrictionDialog.module.css";

export interface FrictionDialogProps {
  friction: FocusFriction;
  /** True while the confirm call is in flight. */
  busy?: boolean;
  /** Called with the typed phrase once Confirm is enabled and clicked. */
  onConfirm: (phrase: string) => void;
  /** Cancels the weakening (the host calls FocusService.CancelWeaken). */
  onCancel: () => void;
  /** Clock override for tests. */
  now?: () => number;
}

export function frictionTitle(f: FocusFriction): string {
  switch (f.action) {
    case FocusWeaken.WeakenEnd:
      return "End this session early";
    case FocusWeaken.WeakenAllow:
      return f.rule ? `Allow ${f.rule.label} for this session` : "Allow an app for this session";
    case FocusWeaken.WeakenQuit:
      return "Quit Toolbox during a session";
    case FocusWeaken.WeakenEmergency:
      return "Emergency unlock";
    default:
      return "Weaken this session";
  }
}

function frictionBody(f: FocusFriction): string {
  switch (f.action) {
    case FocusWeaken.WeakenEmergency:
      return "The session keeps enforcing during the countdown and ends once you confirm.";
    case FocusWeaken.WeakenQuit:
      return "The session isn't ended. It resumes the next time Toolbox starts.";
    case FocusWeaken.WeakenAllow:
      return "The app stays allowed until this session ends.";
    default:
      return "The session ends now and blocked programs can start again.";
  }
}

/** The reason Confirm is off, or "" when it's ready. Pure so the dialog and tests agree. */
export function confirmBlocker(phrase: string, typed: string, secondsLeft: number): string {
  const needsPhrase = phrase !== "" && !phraseMatches(typed, phrase);
  if (needsPhrase && secondsLeft > 0) return `Type the phrase and wait ${formatMmSs(secondsLeft)}`;
  if (needsPhrase) return "Type the phrase exactly as shown";
  if (secondsLeft > 0) return `Wait ${formatMmSs(secondsLeft)}`;
  return "";
}

const FOCUSABLE = "button, input";

/** Modal friction for weakening a session (SPEC §2.3, §5.1): phrase check plus an engine-owned countdown. */
export function FrictionDialog({ friction, busy, onConfirm, onCancel, now = Date.now }: FrictionDialogProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState("");
  const [tick, setTick] = useState(() => now());

  const needsPhrase = friction.phrase !== "";
  const secondsLeft = secondsUntil(friction.readyAt, tick);

  useEffect(() => {
    setTick(now());
    const id = setInterval(() => setTick(now()), 250);
    return () => clearInterval(id);
  }, [now, friction.readyAt]);

  useEffect(() => {
    if (needsPhrase) inputRef.current?.focus();
  }, [needsPhrase]);

  const blocker = busy ? "Working…" : confirmBlocker(friction.phrase, typed, secondsLeft);
  const phraseOk = needsPhrase && phraseMatches(typed, friction.phrase);
  const danger = friction.action !== FocusWeaken.WeakenAllow;

  const confirm = () => {
    if (blocker) return;
    onConfirm(typed);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    } else if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") {
      e.preventDefault();
      confirm();
    } else if (e.key === "Tab") {
      const nodes = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter((n) => !n.hasAttribute("disabled"));
      if (nodes.length === 0) return;
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return (
    <div className={styles.backdrop} onMouseDown={onCancel}>
      <div ref={panelRef} className={styles.panel} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <h2 id={titleId} className={styles.title}>
          {frictionTitle(friction)}
        </h2>
        <p className={styles.body}>{frictionBody(friction)}</p>
        {needsPhrase && (
          <div className={styles.phraseBlock}>
            <span className={styles.label}>Type this to continue</span>
            <code className={styles.phrase} data-testid="friction-phrase">
              {friction.phrase}
            </code>
            <TextField
              ref={inputRef}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              aria-label="Type the phrase"
              autoComplete="off"
              spellCheck={false}
              invalid={typed !== "" && !phraseOk && typed.length >= friction.phrase.length}
              trailing={phraseOk ? <Icon name="check" size={14} className={styles.ok} /> : undefined}
            />
          </div>
        )}
        {secondsLeft > 0 && (
          <div className={styles.countdown} role="timer" aria-live="off" data-testid="friction-countdown">
            <Icon name="hourglass" size={14} />
            <span>Ready in {formatMmSs(secondsLeft)}</span>
          </div>
        )}
        <div className={styles.footer}>
          <Button variant="secondary" data-tip="Close this without doing anything" data-tip-kbd="Esc" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant={danger ? "danger" : "primary"} disabled={blocker !== ""} data-tip={blocker || "Confirm"} onClick={confirm}>
            Confirm
          </Button>
        </div>
      </div>
    </div>
  );
}
