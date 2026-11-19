/**
 * The Wildness dial (Phase 21 SPEC §E1): 0 Tasteful → 0.5 Bold → 1 Bonkers,
 * default Bold. It scales every op's amount through the look's own curve, and
 * above 66% switches on the look's Bonkers-only ops.
 */
import { SegmentedControl, Slider } from "@/components";
import { chaosOn, clamp01, WILD_STOPS, wildLabel } from "./recipe";
import { useGrade } from "./store";
import styles from "./Grade.module.css";

export function Wildness() {
  const wild = useGrade((s) => s.wild);
  const setWild = useGrade((s) => s.setWild);
  const stop = WILD_STOPS.find((s) => Math.abs(s.value - wild) < 0.005)?.label ?? "";
  return (
    <div className={styles.wild} role="group" aria-label="Wildness">
      <span className={styles.wildLabel} data-tip="How far the look goes: Tasteful, Bold or Bonkers. Above 66% the look's Bonkers-only steps switch on.">
        Wildness
      </span>
      <div className={styles.wildSlider}>
        <Slider
          value={wild}
          min={0}
          max={1}
          step={0.01}
          onChange={(v) => setWild(clamp01(v))}
          aria-label="Wildness"
          data-tip={`${wildLabel(wild)}${chaosOn(wild) ? " (Bonkers-only steps are on)" : ""}`}
          format={(v) => `${Math.round(v * 100)}%`}
        />
      </div>
      <span className={styles.wildStops}>
        <SegmentedControl
          size="sm"
          aria-label="Wildness stops"
          value={(stop || "") as "Tasteful" | "Bold" | "Bonkers"}
          options={WILD_STOPS.map((s) => ({ value: s.label, label: s.label, tip: `Set Wildness to ${Math.round(s.value * 100)}%` }))}
          onChange={(label) => setWild(WILD_STOPS.find((s) => s.label === label)?.value ?? 0.5)}
        />
      </span>
    </div>
  );
}
