import { Button } from "@/components";
import { useShortcut } from "@/lib/shortcuts";
import styles from "./Panels.module.css";

/** Run button with Mod+Enter and the reason it is disabled. */
export function RunBar({
  label,
  reason,
  running,
  onRun,
}: {
  label: string;
  /** Non-empty = disabled, shown under the button. */
  reason: string;
  running: boolean;
  onRun: () => void;
}) {
  const can = reason === "" && !running;
  useShortcut("Mod+Enter", () => can && onRun(), { when: can, allowInInputs: true });
  return (
    <div className={styles.runBar}>
      <Button variant="primary" kbd="Mod+Enter" loading={running} disabled={!can} onClick={onRun}>
        {label}
      </Button>
      {reason && <p className={styles.reason}>{reason}</p>}
    </div>
  );
}
