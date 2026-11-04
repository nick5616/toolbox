import { useState } from "react";
import { Button, IconButton } from "@/components";
import type { TextSeed } from "@/state/ui";
import styles from "./Chat.module.css";

/** "850 characters", "12 k characters". */
export function formatChars(n: number): string {
  return n < 1000 ? `${n} characters` : `${Math.round(n / 1000)} k characters`;
}

/** What the model is sent for the first message: the text as context, then the question. */
export function withContext(seed: TextSeed, question: string): string {
  return `${seed.title}:\n\n${seed.body}\n\n---\n\n${question}`;
}

/** The text a tool handed over, above the thread: title and size, expandable to read it. */
export function ContextCard({ seed, onRemove }: { seed: TextSeed; onRemove?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <section className={styles.context} aria-label="Attached text">
      <header className={styles.contextHead}>
        <span className={styles.contextTitle}>
          {seed.title} · {formatChars(seed.body.length)}
        </span>
        <Button size="sm" variant="ghost" data-tip={open ? "Hide the text" : "Read the text the model will be given"} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? "Hide" : "Read"}
        </Button>
        {onRemove && <IconButton size="sm" icon="x" label="Remove attached text" data-tip="Chat without this text" onClick={onRemove} />}
      </header>
      {open && <pre className={styles.contextBody}>{seed.body}</pre>}
    </section>
  );
}
