/** "Transition in": kind + length (§14.8). */
import { Section, Select, Slider } from "@/components";
import { MAX_TRANSITION_MS, TRANSITION_KINDS } from "@/viz/edit/schema";
import type { EditTransition } from "@/viz/edit/types";
import type { TransitionKind } from "@/viz/types";
import styles from "./inspector.module.css";

export const TRANSITION_LABELS: Record<TransitionKind, string> = {
  cut: "Cut",
  crossfade: "Crossfade",
  flash: "Flash",
  zoom: "Zoom",
  sweep: "Sweep",
  glitch: "Glitch",
  zoomout: "Zoom out",
  spin: "Spin",
  whip: "Whip pan",
  slide: "Slide",
  blur: "Blur",
  rgbsplit: "RGB split",
  shake: "Shake",
  warp: "Warp",
  luma: "Luma fade",
  iris: "Iris",
  stripes: "Stripes",
  flashblack: "Black flash",
};

export const DEFAULT_TRANSITION_MS = 300;

const TRANSITION_TIPS: Record<TransitionKind, string> = {
  cut: "Switch straight to this clip with no transition",
  crossfade: "Fade from the previous clip into this one",
  flash: "A white flash covers the switch",
  zoom: "Zoom in through the previous clip into this one",
  sweep: "A wipe sweeps across and reveals this clip",
  glitch: "Digital tearing and colour splits cover the switch",
  zoomout: "Pull back from the previous clip into this one",
  spin: "The picture spins as it switches",
  whip: "A fast, blurred pan from one clip to the next",
  slide: "This clip slides in and pushes the previous one out",
  blur: "Blur out of the previous clip and into this one",
  rgbsplit: "The red, green and blue channels split apart during the switch",
  shake: "The frame shakes as the clip changes",
  warp: "The picture warps and stretches into the next clip",
  luma: "Fade by brightness: brighter areas switch first",
  iris: "A circle opens from the centre to reveal this clip",
  stripes: "Bands wipe in one by one to reveal this clip",
  flashblack: "A quick dip to black covers the switch",
};

export interface TransitionFieldProps {
  value: EditTransition;
  onChange(next: EditTransition, key: string): void;
}

export function TransitionField({ value, onChange }: TransitionFieldProps) {
  return (
    <Section label="Transition in" tip="How this clip arrives from the one before it (or from the background)">
      <div className={styles.stack}>
        <div className={styles.row}>
          <span className={styles.label}>Kind</span>
          <Select
            size="sm"
            aria-label="Transition kind"
            data-tip={TRANSITION_TIPS[value.kind]}
            value={value.kind}
            onChange={(kind) => onChange({ kind, ms: kind === "cut" ? 0 : value.ms > 0 ? value.ms : DEFAULT_TRANSITION_MS }, "")}
            options={TRANSITION_KINDS.map((k) => ({ value: k, label: TRANSITION_LABELS[k] }))}
          />
        </div>
        {value.kind !== "cut" && (
          <div className={styles.stack}>
            <span className={styles.label}>Length</span>
            <Slider
              data-tip="How long the transition lasts, in milliseconds"
              aria-label="Transition length"
              min={0}
              max={MAX_TRANSITION_MS}
              step={50}
              value={value.ms}
              onChange={(ms) => onChange({ kind: value.kind, ms }, "transition-ms")}
              format={(v) => `${Math.round(v)} ms`}
            />
          </div>
        )}
      </div>
    </Section>
  );
}
