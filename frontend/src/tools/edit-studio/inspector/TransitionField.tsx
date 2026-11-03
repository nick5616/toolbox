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

export interface TransitionFieldProps {
  value: EditTransition;
  onChange(next: EditTransition, key: string): void;
}

export function TransitionField({ value, onChange }: TransitionFieldProps) {
  return (
    <Section label="Transition in">
      <div className={styles.stack}>
        <div className={styles.row}>
          <span className={styles.label}>Kind</span>
          <Select
            size="sm"
            aria-label="Transition kind"
            value={value.kind}
            onChange={(kind) => onChange({ kind, ms: kind === "cut" ? 0 : value.ms > 0 ? value.ms : DEFAULT_TRANSITION_MS }, "")}
            options={TRANSITION_KINDS.map((k) => ({ value: k, label: TRANSITION_LABELS[k] }))}
          />
        </div>
        {value.kind !== "cut" && (
          <div className={styles.stack}>
            <span className={styles.label}>Length</span>
            <Slider
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
