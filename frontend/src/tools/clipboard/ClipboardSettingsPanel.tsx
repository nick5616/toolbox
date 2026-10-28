import { useState } from "react";
import { Field, Select, Stepper, Switch, cx, type SelectOption } from "@/components";
import type { ClipboardSettings } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { useSettings } from "@/state/settings";
import { AutoPasteSetting } from "./AutoPasteSetting";
import styles from "./ClipboardSettingsPanel.module.css";

export interface ClipboardSettingsPanelProps {
  className?: string;
}

const RETENTION: ReadonlyArray<SelectOption<string>> = [
  { value: "1", label: "1 day" },
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "0", label: "Forever" },
];

type FieldName = "images" | "retentionDays" | "maxItems";

/** Finds the error for a setting in AppError.fields (`clipboard.maxItems`, `maxItems`, …). */
function fieldError(fields: Record<string, string> | undefined, name: FieldName): string | undefined {
  if (!fields) return undefined;
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(fields)) {
    const tail = k.split(".").pop()?.replace(/_/g, "").toLowerCase();
    if (tail === want) return v;
  }
  return undefined;
}

/** Capture images, retention and max items; saved immediately. Used in the tool view and Settings → Clipboard. */
export function ClipboardSettingsPanel({ className }: ClipboardSettingsPanelProps) {
  const clip = useSettings((s) => s.settings.clipboard);
  const update = useSettings((s) => s.update);
  const [errors, setErrors] = useState<Partial<Record<FieldName | "general", string>>>({});

  const save = async (name: FieldName, patch: Partial<ClipboardSettings>) => {
    try {
      await update({ clipboard: { ...clip, ...patch } });
      setErrors({});
    } catch (e) {
      const err = toAppError(e);
      const specific = fieldError(err.fields, name);
      setErrors(specific ? { [name]: specific } : { general: err.message });
    }
  };

  return (
    <div className={cx(styles.panel, className)}>
      <Switch
        checked={clip.images}
        onChange={(images) => void save("images", { images })}
        label="Capture images"
        aria-describedby={errors.images ? "clip-images-error" : undefined}
      />
      {errors.images && (
        <p id="clip-images-error" className={styles.error} role="alert">
          {errors.images}
        </p>
      )}
      <AutoPasteSetting checked={clip.autoPaste} onChange={(autoPaste) => save("images", { autoPaste })} />
      <div className={styles.grid}>
        <Field label="Keep history for" error={errors.retentionDays} hint="Pinned items are never removed.">
          {(c) => (
            <Select
              id={c.id}
              aria-describedby={c["aria-describedby"]}
              invalid={!!errors.retentionDays}
              value={String(clip.retentionDays)}
              options={RETENTION}
              onChange={(v) => void save("retentionDays", { retentionDays: Number(v) })}
            />
          )}
        </Field>
        <Field label="Maximum items" error={errors.maxItems} hint="50 to 5000.">
          {(c) => (
            <Stepper
              id={c.id}
              aria-describedby={c["aria-describedby"]}
              value={clip.maxItems}
              min={50}
              max={5000}
              step={50}
              onChange={(maxItems) => void save("maxItems", { maxItems })}
            />
          )}
        </Field>
      </div>
      {errors.general && (
        <p className={styles.error} role="alert">
          {errors.general}
        </p>
      )}
    </div>
  );
}
