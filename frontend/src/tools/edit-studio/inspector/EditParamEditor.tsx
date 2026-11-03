/**
 * One numeric EditParam (§14.8): a slider, a keyframe diamond (◀ ▶, ease) and a
 * reactions toggle. A keyed param's slider shows (and writes) the value at the
 * playhead's clip time; a plain one its base.
 */
import { useId, useState } from "react";
import { IconButton, Slider, cx } from "@/components";
import type { EditParam } from "@/viz/edit/types";
import { EditModsEditor } from "./EditModsEditor";
import { KeyframeToggle } from "./KeyframeToggle";
import { isKeyed, paramBase, paramMods, valueAt, withMods, writeValue } from "./paramOps";
import styles from "./inspector.module.css";

export interface ParamRange {
  min: number;
  max: number;
  step?: number;
  label: string;
}

export interface EditParamEditorProps {
  spec: ParamRange;
  value: EditParam;
  /** `key` is stable per field while it is edited (slider drags coalesce into one undo step); "" for one-off changes. */
  onChange(next: EditParam, key: string): void;
  /** The playhead in the clip's time (timeline ms − clip start). */
  clipTimeMs: number;
  allowKeys: boolean;
  allowMods: boolean;
  /** Number format for the readout (default by range). */
  format?: (v: number) => string;
}

function defaultFormat(spec: ParamRange): (v: number) => string {
  const span = spec.max - spec.min;
  const digits = span >= 50 ? 0 : span >= 5 ? 1 : 2;
  return (v) => v.toFixed(digits);
}

export function EditParamEditor({ spec, value, onChange, clipTimeMs, allowKeys, allowMods, format }: EditParamEditorProps) {
  const uid = useId();
  const fieldKey = `ep:${uid}`;
  const [open, setOpen] = useState(false);
  const keyed = isKeyed(value);
  const mods = paramMods(value);
  const shown = keyed ? valueAt(value, spec.min, spec.max, clipTimeMs) : Math.max(spec.min, Math.min(spec.max, paramBase(value)));
  const step = spec.step ?? Math.max(0.001, Math.round(((spec.max - spec.min) / 100) * 1000) / 1000);
  return (
    <div className={styles.param}>
      <div className={styles.paramHead}>
        <span className={styles.label}>{spec.label}</span>
        <span className={styles.paramTools}>
          {allowKeys && <KeyframeToggle name={spec.label} value={value} current={shown} clipTimeMs={clipTimeMs} onChange={(next) => onChange(next, "")} />}
          {allowMods && (
            <IconButton
              size="sm"
              icon="activity"
              label={`Reactions for ${spec.label}`}
              pressed={open || mods.length > 0}
              className={cx(mods.length > 0 && styles.reactive)}
              onClick={() => setOpen((o) => !o)}
            />
          )}
        </span>
      </div>
      <Slider
        aria-label={spec.label}
        min={spec.min}
        max={spec.max}
        step={step}
        value={shown}
        onChange={(v) => onChange(writeValue(value, v, spec.min, spec.max, clipTimeMs), fieldKey)}
        format={format ?? defaultFormat(spec)}
      />
      {allowMods && open && <EditModsEditor label={spec.label} mods={mods} onChange={(next) => onChange(withMods(value, next), fieldKey)} />}
    </div>
  );
}
