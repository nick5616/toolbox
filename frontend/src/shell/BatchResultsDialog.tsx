import { useMemo } from "react";
import { Button, Icon, toast } from "@/components";
import { LibraryService } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { useShortcut } from "@/lib/shortcuts";
import { openTool } from "@/lib/openTool";
import { isReady, useModules } from "@/state/modules";
import { moduleTakesFile } from "@/tools/_kit/sendTo";
import { useBatchResults } from "./batchResults";
import styles from "./BatchResultsDialog.module.css";

/** Opened by the merged "N files saved" toast: Reveal, and Send to… every tool that takes all of the files. */
export function BatchResultsDialog() {
  const batch = useBatchResults((s) => s.current);
  const close = useBatchResults((s) => s.close);
  const list = useModules((s) => s.list);
  useShortcut("Escape", close, { when: !!batch, allowInInputs: true });
  const paths = useMemo(() => (batch?.outputs ?? []).map((o) => o.path), [batch]);
  const targets = useMemo(
    () => (batch ? list.filter((m) => m.id !== batch.moduleId && !m.hidden && isReady(m) && m.id !== "post-builder" && paths.length > 0 && paths.every((p) => moduleTakesFile(m, p))) : []),
    [batch, list, paths],
  );
  if (!batch) return null;
  const first = batch.outputs[0];
  return (
    <div className={styles.backdrop} onMouseDown={close}>
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-label="Send files to" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className={styles.title}>{batch.title}</h2>
        <div className={styles.actions}>
          {first && (
            <Button
              size="sm"
              icon="folder-open"
              data-tip="Show the first saved file in your file manager"
              onClick={() => {
                LibraryService.Reveal(first.id).catch((e: unknown) => toast({ tone: "danger", title: toAppError(e).message }));
                close();
              }}
            >
              Reveal
            </Button>
          )}
        </div>
        <h3 className={styles.heading}>Send to…</h3>
        <ul className={styles.list}>
          {targets.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                className={styles.item}
                data-tip={m.tagline || undefined}
                onClick={() => {
                  close();
                  void openTool(m.id, paths);
                }}
              >
                <Icon name={m.icon} size={16} />
                {m.name}
              </button>
            </li>
          ))}
        </ul>
        {targets.length === 0 && <p className={styles.none}>No tool takes all of these files together. Open the Library to send them one by one.</p>}
      </div>
    </div>
  );
}
