/** The keyframe diamond with ◀ ▶ jumps and the ease of the key at the playhead (§14.8). */
import { IconButton, Select } from "@/components";
import type { EditParam, Key } from "@/viz/edit/types";
import { keyIndexAt, neighbourKey, paramKeys, removeKeyAt, setEaseAt, setKeyAt } from "./paramOps";
import { useEditStudio } from "../store";
import styles from "./inspector.module.css";

const EASES: Array<{ value: Key["ease"]; label: string }> = [
  { value: "ease", label: "Smooth" },
  { value: "linear", label: "Linear" },
  { value: "hold", label: "Hold" },
];

export interface KeyframeToggleProps {
  name: string;
  value: EditParam;
  /** The value shown at the playhead (what a new key records). */
  current: number;
  clipTimeMs: number;
  onChange(next: EditParam): void;
}

export function KeyframeToggle({ name, value, current, clipTimeMs, onChange }: KeyframeToggleProps) {
  const keys = paramKeys(value);
  const at = keyIndexAt(keys, clipTimeMs);
  const onKey = at >= 0;
  const jump = (dir: -1 | 1) => {
    const k = neighbourKey(keys, clipTimeMs, dir);
    if (!k) return;
    const st = useEditStudio.getState();
    st.setPlayhead(st.playheadMs - clipTimeMs + k.t);
  };
  return (
    <span className={styles.paramTools}>
      {onKey && (
        <Select
          size="sm"
          className={styles.easeSelect}
          aria-label={`Easing of ${name} key`}
          value={(keys[at] as Key).ease}
          onChange={(ease) => onChange(setEaseAt(value, clipTimeMs, ease))}
          options={EASES}
        />
      )}
      {keys.length > 0 && <IconButton size="sm" icon="chevron-left" label={`Previous ${name} key`} disabled={!neighbourKey(keys, clipTimeMs, -1)} onClick={() => jump(-1)} />}
      <button
        type="button"
        className={styles.diamondBtn}
        aria-label={onKey ? `Remove ${name} key` : `Add ${name} key`}
        aria-pressed={onKey}
        data-keyed={keys.length > 0 || undefined}
        title={onKey ? "Remove key at the playhead" : "Add key at the playhead"}
        onClick={() => onChange(onKey ? removeKeyAt(value, clipTimeMs) : setKeyAt(value, clipTimeMs, current))}
      >
        <span className={styles.diamond} />
      </button>
      {keys.length > 0 && <IconButton size="sm" icon="chevron-right" label={`Next ${name} key`} disabled={!neighbourKey(keys, clipTimeMs, 1)} onClick={() => jump(1)} />}
    </span>
  );
}
