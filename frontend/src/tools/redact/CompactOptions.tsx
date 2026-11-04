import { ClickIn, SegmentedControl, Switch } from "@/components";
import { RedactSensitivity } from "@/lib/api";
import { effectSummary, sensitivitySummary, type RedactSettings } from "./logic";
import { OptionsPanel } from "./OptionsPanel";
import styles from "./RedactView.module.css";

export interface CompactOptionsProps {
  settings: RedactSettings;
  onChange: (patch: Partial<RedactSettings>) => void;
  /** "effect": only the Effect click-in (during review); "all": what to find, plus the click-ins. */
  part: "effect" | "all";
}

/**
 * Redact's options for the tool itself. At the top level: what to find (faces, plates). Everything else is a
 * click-in with a summary: Sensitivity (how eagerly it reports) and Effect (style, strength, padding, privacy).
 * (`OptionsPanel` is the flat form the pipeline step editor still uses.)
 */
export function CompactOptions({ settings, onChange, part }: CompactOptionsProps) {
  const all = part === "all";
  return (
    <div className={styles.options}>
      {all && (
        <div className={styles.optControl} role="group" aria-label="Find">
          <Switch checked={settings.faces} onChange={(faces) => onChange({ faces })} label="Find faces" tip="Look for human faces to hide" />
          <Switch checked={settings.plates} onChange={(plates) => onChange({ plates })} label="Find number plates" tip="Look for vehicle licence plates to hide" />
        </div>
      )}
      <div className={styles.rows}>
        {all && (
          <ClickIn icon="sliders-horizontal" title="Sensitivity" summary={sensitivitySummary(settings)} tip="How eagerly the search reports a match" width={320}>
            <div className={styles.optControl}>
              <SegmentedControl
                aria-label="Sensitivity"
                size="sm"
                value={settings.sensitivity}
                onChange={(sensitivity) => onChange({ sensitivity })}
                options={[
                  { value: RedactSensitivity.SensitivityNormal, label: "Normal", tip: "Report clear matches only; fewer false alarms but may miss small or blurry faces" },
                  { value: RedactSensitivity.SensitivityHigh, label: "High", tip: "Report more possible matches, including small or partial ones; you will review more false matches" },
                ]}
              />
              <span className={styles.hint}>High finds more, with more false matches.</span>
            </div>
          </ClickIn>
        )}
        <ClickIn icon="scan-face" title="Effect" summary={effectSummary(settings)} tip="How the hidden areas look in the saved copy" width={340}>
          <OptionsPanel settings={settings} onChange={onChange} part="effect" />
        </ClickIn>
      </div>
    </div>
  );
}
