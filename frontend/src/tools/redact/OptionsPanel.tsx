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

const STYLE_TIPS: Record<string, string> = {
  [RedactStyle.StyleBlur]: "Smooth blur that keeps the shape and colours; strength sets how heavy",
  [RedactStyle.StylePixelate]: "Chunky mosaic blocks; strength sets how large the blocks are",
  [RedactStyle.StyleSolid]: "Opaque black box; cannot be reversed",
};

/** Redact's options: faces, plates, sensitivity, style tiles, strength, padding, metadata. */
export function OptionsPanel({ settings, onChange, part, disabled }: OptionsPanelProps) {
  const detect = part !== "effect";
  const effect = part !== "detect";
  return (
    <div className={styles.options}>
      {detect && (
        <>
          <div className={styles.optRow}>
            <span className={styles.optLabel} data-tip="What the search should look for in your photos or video">Find</span>
            <div className={styles.optControl}>
              <Switch checked={settings.faces} disabled={disabled} onChange={(faces) => onChange({ faces })} label="Find faces" tip="Look for human faces to hide" />
              <Switch checked={settings.plates} disabled={disabled} onChange={(plates) => onChange({ plates })} label="Find number plates" tip="Look for vehicle licence plates to hide" />
            </div>
          </div>
          <div className={styles.optRow}>
            <span className={styles.optLabel} data-tip="How eagerly the search reports a match">Sensitivity</span>
            <div className={styles.optControl}>
              <SegmentedControl
                aria-label="Sensitivity"
                size="sm"
                disabled={disabled}
                value={settings.sensitivity}
                onChange={(sensitivity) => onChange({ sensitivity })}
                options={[
                  { value: RedactSensitivity.SensitivityNormal, label: "Normal", tip: "Report clear matches only; fewer false alarms but may miss small or blurry faces" },
                  { value: RedactSensitivity.SensitivityHigh, label: "High", tip: "Report more possible matches, including small or partial ones; you will review more false matches" },
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
            <span className={styles.optLabel} data-tip="How the hidden areas look">Style</span>
            <div className={styles.optControl}>
              <div className={styles.tiles} role="radiogroup" aria-label="Style">
                {STYLES.map((s) => (
                  <button
                    key={s.value}
                    type="button"
                    role="radio"
                    aria-checked={settings.style === s.value}
                    aria-label={s.label}
                    data-tip={STYLE_TIPS[s.value]}
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
            <label className={styles.optLabel} htmlFor="redact-strength" data-tip="How strongly blur or pixelation hides the area; higher is harder to undo">
              Strength
            </label>
            <div className={styles.optControl}>
              <div data-tip={settings.style === RedactStyle.StyleSolid ? "Not used by the solid style" : "How strongly blur or pixelation hides the area; higher is harder to undo"}>
                <Slider id="redact-strength" min={1} max={10} step={1} value={settings.strength} disabled={disabled || settings.style === RedactStyle.StyleSolid} onChange={(strength) => onChange({ strength })} />
              </div>
            </div>
          </div>
          <div className={styles.optRow}>
            <label className={styles.optLabel} htmlFor="redact-padding" data-tip="Grow each box by this percentage so edges and hair are covered too">
              Padding
            </label>
            <div className={styles.optControl}>
              <div data-tip="Grow each box by this percentage so edges and hair are covered too">
                <Slider id="redact-padding" min={0} max={50} step={1} value={settings.padding} disabled={disabled} onChange={(padding) => onChange({ padding })} format={(v) => `${v}%`} />
              </div>
            </div>
          </div>
          <div className={styles.optRow}>
            <span className={styles.optLabel} data-tip="Hidden data inside the file itself">Privacy</span>
            <div className={styles.optControl}>
              <Switch checked={settings.stripMetadata} disabled={disabled} onChange={(stripMetadata) => onChange({ stripMetadata })} label="Remove location and camera info" tip="Strip GPS position and camera details from the saved copy so they cannot leak" />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
