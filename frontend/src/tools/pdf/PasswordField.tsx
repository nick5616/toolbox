import { useState } from "react";
import { Field, IconButton, TextField } from "@/components";

/** Password input with a show/hide toggle; the value lives only in React state. */
export function PasswordField({
  label,
  value,
  onChange,
  error,
  hint,
  autoFocus,
  tip = "Needed to open this PDF; it is kept in memory only and never saved",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  hint?: string;
  autoFocus?: boolean;
  /** Tooltip for the field. */
  tip?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <Field label={label} error={error} hint={hint}>
      {(control) => (
        <TextField
          {...control}
          data-tip={tip}
          type={show ? "text" : "password"}
          autoComplete="off"
          autoFocus={autoFocus}
          value={value}
          invalid={!!error}
          onChange={(e) => onChange(e.target.value)}
          trailing={
            <IconButton size="sm" icon={show ? "eye-off" : "eye"} label={show ? "Hide password" : "Show password"} data-tip={show ? "Hide the typed password again" : "Show the typed password so you can check it"} onClick={() => setShow((s) => !s)} />
          }
        />
      )}
    </Field>
  );
}
