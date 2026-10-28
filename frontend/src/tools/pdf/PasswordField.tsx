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
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  hint?: string;
  autoFocus?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <Field label={label} error={error} hint={hint}>
      {(control) => (
        <TextField
          {...control}
          type={show ? "text" : "password"}
          autoComplete="off"
          autoFocus={autoFocus}
          value={value}
          invalid={!!error}
          onChange={(e) => onChange(e.target.value)}
          trailing={
            <IconButton size="sm" icon={show ? "eye-off" : "eye"} label={show ? "Hide password" : "Show password"} onClick={() => setShow((s) => !s)} />
          }
        />
      )}
    </Field>
  );
}
