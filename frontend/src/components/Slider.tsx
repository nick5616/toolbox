// STUB (foundation). WP-K1 implements; props are frozen.
export interface SliderProps {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  /** Formats the value shown next to the track (mono). */
  format?: (value: number) => string;
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
}

export function Slider({ value, onChange, min, max, step, id, disabled, ...rest }: SliderProps) {
  return (
    <input
      type="range"
      id={id}
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      aria-label={rest["aria-label"]}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}
