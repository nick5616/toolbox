/**
 * Calm / Balanced / Wild (Phase 21, SPEC C2.4): the master Intensity of a visual design as three stops.
 * Balanced (1) is the default and what the presets are tuned for. The fine control stays next to it.
 */
import { SegmentedControl } from "@/components/SegmentedControl";

export const INTENSITY_STOPS = [
  { id: "calm", label: "Calm", value: 0.5, tip: "Gentle: small, slow reactions (0.5)" },
  { id: "balanced", label: "Balanced", value: 1, tip: "What the designs are tuned for (1)" },
  { id: "wild", label: "Wild", value: 1.5, tip: "Bolder: bigger, quicker reactions (1.5)" },
] as const;

type StopId = (typeof INTENSITY_STOPS)[number]["id"] | "custom";

/** The stop a value sits on, or "custom" when the fine control moved it between stops. */
export function stopFor(value: number): StopId {
  return INTENSITY_STOPS.find((s) => Math.abs(s.value - value) < 0.005)?.id ?? "custom";
}

export interface IntensityStopsProps {
  value: number;
  onChange(v: number): void;
  disabled?: boolean;
}

export function IntensityStops({ value, onChange, disabled }: IntensityStopsProps) {
  return (
    <SegmentedControl<StopId>
      size="sm"
      aria-label="Intensity stops"
      disabled={disabled}
      value={stopFor(value)}
      onChange={(id) => {
        const s = INTENSITY_STOPS.find((x) => x.id === id);
        if (s) onChange(s.value);
      }}
      options={INTENSITY_STOPS.map((s) => ({ value: s.id, label: s.label, tip: s.tip }))}
    />
  );
}
