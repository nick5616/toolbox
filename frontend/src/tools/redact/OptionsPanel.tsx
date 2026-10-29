import { SegmentedControl, Slider, Switch, cx } from "@/components";
import { RedactSensitivity, RedactStyle } from "@/lib/api";
import type { RedactSettings } from "./logic";
import styles from "./RedactView.module.css";

export interface OptionsPanelProps {
  settings: RedactSettings;
  onChange: (patch: Partial<RedactSettings>) => void;
  /** "detect": what to look for; "effect": how to hide it; "all": both. */
  part: "detect" | "effect" | "all";
  disabled?: boolean;
}

const STYLES = [
  { value: RedactStyle.StyleBlur, label: "Blur", cls: styles.tileBlur },
  { value: RedactStyle.StylePixelate, label: "Pixelate", cls: styles.tilePixel },
  { value: RedactStyle.StyleSolid, label: "Solid", cls: styles.tileSolid },
] as const;

/** Redact's options: faces, plates, sensitivity, style tiles, strength, padding, metadata. */
export function OptionsPanel({ settings, onChange, part, disabled }: OptionsPanelProps) {
  const detect = part !== "effect";
  const effect = part !== "detect";
  return (
    <div className={styles.options}>
      {detect && (
        <>
          <div className={styles.optRow}>
            <span className={styles.optLabel}>Find</span>
            <div className={styles.optControl}>
              <Switch checked={settings.faces} disabled={disabled} onChange={(faces) => onChange({ faces })} label="Find faces" />
              <Switch checked={settings.plates} disabled={disabled} onChange={(plates) => onChange({ plates })} label="Find number plates" />
            </div>
          </div>
          <div className={styles.optRow}>
            <span className={styles.optLabel}>Sensitivity</span>
            <div className={styles.optControl}>
              <SegmentedControl
                aria-label="Sensitivity"
                size="sm"
                disabled={disabled}
                value={settings.sensitivity}
                onChange={(sensitivity) => onChange({ sensitivity })}
                options={[
                  { value: RedactSensitivity.SensitivityNormal, label: "Normal" },
                  { value: RedactSensitivity.SensitivityHigh, label: "High" },
                ]}
              />
              <span className={styles.hint}>High finds more, with more false matches.</span>
            </div>
          </div>
        </>
      )}
      {effect && (
        <>
          <div className={styles.optRow}>
            <span className={styles.optLabel}>Style</span>
            <div className={styles.optControl}>
              <div className={styles.tiles} role="radiogroup" aria-label="Style">
                {STYLES.map((s) => (
                  <button
                    key={s.value}
                    type="button"
                    role="radio"
                    aria-checked={settings.style === s.value}
                    aria-label={s.label}
                    disabled={disabled}
                    className={cx(styles.styleTile, settings.style === s.value && styles.styleTileOn)}
                    onClick={() => onChange({ style: s.value })}
                  >
                    <span className={cx(styles.tilePreview, s.cls)} aria-hidden />
                    <span>{s.label}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className={styles.optRow}>
            <span className={styles.optLabel}>Strength</span>
            <div className={styles.optControl}>
              <Slider aria-label="Strength" min={1} max={10} step={1} value={settings.strength} disabled={disabled || settings.style === RedactStyle.StyleSolid} onChange={(strength) => onChange({ strength })} />
            </div>
          </div>
          <div className={styles.optRow}>
            <span className={styles.optLabel}>Padding</span>
            <div className={styles.optControl}>
              <Slider aria-label="Padding" min={0} max={50} step={1} value={settings.padding} disabled={disabled} onChange={(padding) => onChange({ padding })} format={(v) => `${v}%`} />
            </div>
          </div>
          <div className={styles.optRow}>
            <span className={styles.optLabel}>Privacy</span>
            <div className={styles.optControl}>
              <Switch checked={settings.stripMetadata} disabled={disabled} onChange={(stripMetadata) => onChange({ stripMetadata })} label="Remove location and camera info" />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
