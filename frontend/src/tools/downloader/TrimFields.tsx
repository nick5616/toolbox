import { Field, Switch, TimecodeInput } from "@/components";
import type { TrimErrors } from "./timecode";
import styles from "./OptionsPanel.module.css";

export interface TrimFieldsProps {
  enabled: boolean;
  start: string;
  end: string;
  errors: TrimErrors;
  onEnabled: (v: boolean) => void;
  onStart: (v: string) => void;
  onEnd: (v: string) => void;
}

export function TrimFields({ enabled, start, end, errors, onEnabled, onStart, onEnd }: TrimFieldsProps) {
  return (
    <div className={styles.stack}>
      <Switch checked={enabled} onChange={onEnabled} label="Trim to a section" />
      {enabled && (
        <div className={styles.row}>
          <Field label="Start" error={errors.trimStart}>
            {(c) => <TimecodeInput {...c} value={start} onChange={onStart} placeholder="0:00" invalid={!!errors.trimStart} />}
          </Field>
          <Field label="End" error={errors.trimEnd}>
            {(c) => <TimecodeInput {...c} value={end} onChange={onEnd} placeholder="end" invalid={!!errors.trimEnd} />}
          </Field>
        </div>
      )}
    </div>
  );
}
