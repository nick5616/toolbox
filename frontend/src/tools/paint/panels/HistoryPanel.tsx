import { formatBytes } from "@/lib/format";
import { useEditor, useEngineEvents } from "../context";
import { usePaintUI } from "../store";
import { TextButton } from "../ui";
import styles from "./panels.module.css";

export const HISTORY_BUDGET = 1.5 * 1024 * 1024 * 1024;

/** History: every step (newest first), jump to one, pick the History brush's source, memory meter. */
export function HistoryPanel() {
  const { engine } = useEditor();
  useEngineEvents(engine, ["history", "change"]);
  const source = usePaintUI((s) => s.historySource);
  const setSource = usePaintUI((s) => s.setHistorySource);
  const setTool = usePaintUI((s) => s.setTool);
  const entries = [...engine.history()].reverse();
  const used = engine.memoryBytes();
  return (
    <div className={styles.stack} data-testid="history-panel">
      <div className={styles.section}>
        <div className={styles.row}>
          <span className={styles.grow}>Memory</span>
          <span className={styles.layerMeta} data-tip="Undo memory used of the 1.5 GB budget; past it the oldest steps are dropped">
            {formatBytes(used)} of {formatBytes(HISTORY_BUDGET)}
          </span>
        </div>
        <div className={styles.meter} role="meter" aria-label="Undo memory" aria-valuemin={0} aria-valuemax={HISTORY_BUDGET} aria-valuenow={used}>
          <div className={styles.meterFill} style={{ width: `${Math.min(100, (used / HISTORY_BUDGET) * 100)}%` }} />
        </div>
      </div>
      <div className={styles.row}>
        <TextButton
          icon="historyBrush"
          tip="Paint back pixels from the step marked as the source (press the source button on a step first)"
          disabled={source === null}
          reason="Mark a step as the History brush source first"
          onClick={() => setTool("history")}
        >
          History brush
        </TextButton>
        {source !== null ? (
          <TextButton tip="Stop using that step as the source" onClick={() => setSource(null)}>
            Clear source
          </TextButton>
        ) : null}
      </div>
      <div role="list" aria-label="History steps">
        {entries.length === 0 ? <p className={styles.layerMeta}>Nothing yet. Every stroke and edit shows up here.</p> : null}
        {entries.map((h, i) => (
          <div key={h.id} role="listitem" className={styles.row}>
            <button
              type="button"
              className={styles.histRow}
              aria-current={i === 0 ? "true" : undefined}
              aria-disabled={!h.available || undefined}
              data-tip={h.available ? `Go back to “${h.label}”` : "Its pixels were dropped to stay within the memory budget"}
              onClick={() => h.available && engine.jumpTo(h.id)}
            >
              <span className={styles.grow}>{h.label}</span>
              {source === h.id ? <span className={styles.layerMeta}>source</span> : null}
            </button>
            <TextButton tip="Use this step as the History brush's source" disabled={!h.available} reason="Its pixels were dropped" onClick={() => setSource(h.id)} aria-pressed={source === h.id}>
              Source
            </TextButton>
          </div>
        ))}
      </div>
    </div>
  );
}
