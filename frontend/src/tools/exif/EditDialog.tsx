import { useId, useState } from "react";
import { ConfirmDialog, Field, TextArea, TextField } from "@/components";
import { FIELD_HINTS, FIELD_LABELS, changedFields, validateField } from "./options";
import styles from "./ExifView.module.css";

export interface EditDialogProps {
  open: boolean;
  fields: readonly string[];
  /** Current values (single-file) or {} for several files. */
  initial: Readonly<Record<string, string>>;
  count: number;
  onApply: (changed: Record<string, string>) => void;
  onCancel: () => void;
}

function Form({ fields, initial, count, onApply, onCancel }: Omit<EditDialogProps, "open">) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f, initial[f] ?? ""])),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const uid = useId();

  const submit = () => {
    const errs: Record<string, string> = {};
    for (const f of fields) {
      const msg = validateField(f, values[f] ?? "");
      if (msg) errs[f] = msg;
    }
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    const changed = changedFields(values, initial);
    if (Object.keys(changed).length === 0) {
      setFormError("Change at least one field.");
      return;
    }
    setFormError("");
    onApply(changed);
  };

  return (
    <ConfirmDialog
      open
      title={count === 1 ? "Edit metadata" : `Edit metadata of ${count} files`}
      confirmLabel="Apply"
      onConfirm={submit}
      onCancel={onCancel}
      body={
        <div className={styles.form}>
          {fields.map((f) => {
            const set = (v: string) => {
              setValues((s) => ({ ...s, [f]: v }));
              setFormError("");
            };
            return (
              <Field key={f} label={FIELD_LABELS[f] ?? f} hint={FIELD_HINTS[f]} error={errors[f]} htmlFor={`${uid}-${f}`}>
                {f === "Description" ? (
                  <TextArea id={`${uid}-${f}`} minRows={3} value={values[f] ?? ""} onChange={(e) => set(e.target.value)} />
                ) : (
                  <TextField
                    id={`${uid}-${f}`}
                    size="sm"
                    invalid={!!errors[f]}
                    mono={f === "DateTimeOriginal"}
                    value={values[f] ?? ""}
                    onChange={(e) => set(e.target.value)}
                  />
                )}
              </Field>
            );
          })}
          {count > 1 && <p className={styles.note}>Only the fields you change are applied to every file.</p>}
          {count === 1 && <p className={styles.note}>Clear a field to remove it.</p>}
          {formError && (
            <p className={styles.formError} role="alert">
              {formError}
            </p>
          )}
        </div>
      }
    />
  );
}

/** Edit dialog; sends only the fields that differ from `initial`. */
export function EditDialog(props: EditDialogProps) {
  if (!props.open) return null;
  const { open: _open, ...rest } = props;
  return <Form {...rest} />;
}
