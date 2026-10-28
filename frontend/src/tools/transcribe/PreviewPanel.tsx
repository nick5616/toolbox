import { useEffect, useState } from "react";
import { IconButton, Spinner } from "@/components";
import { FilesService } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { PREVIEW_BYTES, PREVIEW_LINES, basename } from "./options";
import styles from "./TranscribeView.module.css";

export interface PreviewPanelProps {
  path: string;
  title: string;
  onClose: () => void;
}

/** Side panel with the first ~50 lines of a transcript file. */
export function PreviewPanel({ path, title, onClose }: PreviewPanelProps) {
  const [state, setState] = useState<{ text: string; truncated: boolean } | { error: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState(null);
    FilesService.ReadText(path, PREVIEW_BYTES)
      .then((text) => {
        if (cancelled) return;
        const lines = text.split(/\r?\n/);
        setState({ text: lines.slice(0, PREVIEW_LINES).join("\n"), truncated: lines.length > PREVIEW_LINES });
      })
      .catch((e: unknown) => {
        if (!cancelled) setState({ error: toAppError(e).message });
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  return (
    <aside className={styles.panel} role="complementary" aria-label="Transcript preview">
      <header className={styles.panelHead}>
        <div className={styles.panelTitle}>
          <strong title={title}>{title}</strong>
          <span className={styles.note}>{basename(path)}</span>
        </div>
        <IconButton icon="x" label="Close preview" size="sm" onClick={onClose} />
      </header>
      <div className={styles.panelBody}>
        {state === null ? (
          <Spinner label="Loading preview" />
        ) : "error" in state ? (
          <p className={styles.errorText} role="alert">
            {state.error}
          </p>
        ) : (
          <>
            <pre className={styles.text}>{state.text}</pre>
            {state.truncated && <p className={styles.note}>Showing the first {PREVIEW_LINES} lines.</p>}
          </>
        )}
      </div>
    </aside>
  );
}
