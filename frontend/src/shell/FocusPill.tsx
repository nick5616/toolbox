import { Icon } from "@/components";
import { FOCUS_MODULE_ID, useFocus } from "@/state/focus";
import { useUI } from "@/state/ui";
import { focusPillLabel, useNow } from "./focusShell";
import styles from "./FocusPill.module.css";

/** "Focus · 42 min" in the top bar while a session is on; opens the tool. */
export function FocusPill() {
  const state = useFocus((s) => s.state);
  const view = useUI((s) => s.view);
  const navigate = useUI((s) => s.navigate);
  const now = useNow();
  const label = focusPillLabel(state, now);
  if (!label || view === FOCUS_MODULE_ID) return null;
  const dry = state.dryRun || !!state.session?.dryRun;
  return (
    <button
      type="button"
      className={styles.pill}
      data-testid="focus-pill"
      data-tip={dry ? "A focus session is on (dry run: nothing is stopped). Open Focus" : "A focus session is on. Open Focus"}
      onClick={() => navigate(FOCUS_MODULE_ID)}
    >
      <Icon name="focus" size={14} />
      <span>{label}</span>
    </button>
  );
}
