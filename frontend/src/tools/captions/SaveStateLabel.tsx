import type { SaveState } from "./useBatch";
import styles from "./captions.module.css";

const LABEL: Record<SaveState, string> = {
  idle: "",
  dirty: "Unsaved changes",
  saving: "Saving…",
  saved: "Saved",
  error: "Couldn't save",
};

const TIP: Record<SaveState, string> = {
  idle: "",
  dirty: "Your edits are saved a moment after you stop typing",
  saving: "Writing your edits to the batch folder",
  saved: "Your edits are saved in the batch folder",
  error: "Saving failed; keep editing and it will try again",
};

/** The header's save state (empty until a batch is open). */
export function SaveStateLabel({ state }: { state: SaveState }) {
  if (state === "idle") return null;
  return (
    <span className={state === "error" ? styles.saveError : styles.saveState} role="status" data-tip={TIP[state]}>
      {LABEL[state]}
    </span>
  );
}
