import { useState } from "react";
import { Icon, cx } from "@/components";
import { VALUE_TYPE_LABELS, VALUE_TYPES, type ValueType } from "@/pipelines/params";
import { typeStyle } from "./graph/wireStyle";
import styles from "./GraphEditor.module.css";

export const LEGEND_KEY = "toolbox.pipelines.legendOpen";

/** What each colour means (SPEC phase-16 §1). */
const MEANING: Record<ValueType | "any", string> = {
  files: "a step's files: what it takes in and makes",
  file: "one file as a value",
  text: "words, names, templates",
  number: "a count, a speed, a size",
  toggle: "on or off",
  choice: "one of a fixed set",
  color: "a colour",
  any: "mixed or unknown",
};

export function loadLegendPref(): boolean | null {
  try {
    const v = localStorage.getItem(LEGEND_KEY);
    return v === "1" ? true : v === "0" ? false : null;
  } catch {
    return null;
  }
}

function saveLegendPref(open: boolean): void {
  try {
    localStorage.setItem(LEGEND_KEY, open ? "1" : "0");
  } catch {
    // not remembered; fine
  }
}

/** The colour legend, floating at the bottom left of the canvas; collapses to a "Colours" chip. `roomy` decides the first state. */
export function Legend({ roomy }: { roomy: boolean }) {
  const [pref, setPref] = useState<boolean | null>(loadLegendPref);
  const open = pref ?? roomy;
  const set = (next: boolean) => {
    setPref(next);
    saveLegendPref(next);
  };
  const types: Array<ValueType | "any"> = [...VALUE_TYPES, "any"];
  if (!open) {
    return (
      <button type="button" className={styles.legendChip} aria-expanded={false} data-no-wheel="1" data-tip="What the port and wire colours mean" onClick={() => set(true)}>
        <span className={cx(styles.legendDot, styles.legendFiles)} style={typeStyle("files")} />
        Colours
      </button>
    );
  }
  return (
    <div className={styles.legend} role="group" aria-label="Colours" data-no-wheel="1">
      <button type="button" className={styles.legendHead} aria-expanded data-tip="Hide the colours" onClick={() => set(false)}>
        <span>Colours</span>
        <Icon name="chevron-down" size={12} />
      </button>
      {types.map((t) => (
        <div key={t} className={styles.legendRow} data-tip={MEANING[t]}>
          <span className={cx(styles.legendDot, t === "files" && styles.legendFiles)} style={typeStyle(t)} />
          <span>{t === "any" ? "Mixed" : VALUE_TYPE_LABELS[t]}</span>
        </div>
      ))}
      <span className={styles.legendNote}>Dashed: may not fit</span>
    </div>
  );
}
