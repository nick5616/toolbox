import { useEffect, useState } from "react";
import { TextField } from "./TextField";
import { cx } from "./cx";
import styles from "./ColorSwatchPicker.module.css";

export const TRANSPARENT = "transparent";

export interface ColorSwatchPickerProps {
  /** "#rrggbb", or "transparent" when `allowTransparent`. */
  value: string;
  onChange: (value: string) => void;
  /** Show the transparent swatch (default false). */
  allowTransparent?: boolean;
  "aria-label"?: string;
  className?: string;
}

const HEX = /^#[0-9a-f]{6}$/i;

/** Normalises "ff0000" / "#FF0000" to "#ff0000"; null when invalid. */
export function normalizeHex(v: string): string | null {
  const t = v.trim();
  const h = t.startsWith("#") ? t : `#${t}`;
  return HEX.test(h) ? h.toLowerCase() : null;
}

/** White / black / (transparent) swatches plus a validated #rrggbb field. */
export function ColorSwatchPicker({ value, onChange, allowTransparent, className, ...aria }: ColorSwatchPickerProps) {
  const [draft, setDraft] = useState(value === TRANSPARENT ? "" : value);
  useEffect(() => setDraft(value === TRANSPARENT ? "" : value), [value]);

  const invalid = draft !== "" && normalizeHex(draft) === null;
  const swatches: Array<{ id: string; label: string; color?: string }> = [
    { id: "#ffffff", label: "White", color: "#ffffff" },
    { id: "#000000", label: "Black", color: "#000000" },
    ...(allowTransparent ? [{ id: TRANSPARENT, label: "Transparent" }] : []),
  ];

  return (
    <div role="group" aria-label={aria["aria-label"] ?? "Colour"} className={cx(styles.root, className)}>
      {swatches.map((s) => (
        <button
          key={s.id}
          type="button"
          aria-label={s.label}
          aria-pressed={value.toLowerCase() === s.id}
          title={s.label}
          className={cx(
            styles.swatch,
            s.id === TRANSPARENT && styles.transparent,
            value.toLowerCase() === s.id && styles.selected,
          )}
          style={s.color ? { background: s.color } : undefined}
          onClick={() => onChange(s.id)}
        />
      ))}
      <TextField
        mono
        size="sm"
        wrapperClassName={styles.hex}
        aria-label="Hex colour"
        placeholder="#rrggbb"
        maxLength={7}
        value={draft}
        invalid={invalid}
        onChange={(e) => {
          setDraft(e.target.value);
          const n = normalizeHex(e.target.value);
          if (n) onChange(n);
        }}
        onBlur={() => {
          if (invalid) setDraft(value === TRANSPARENT ? "" : value);
        }}
      />
    </div>
  );
}
