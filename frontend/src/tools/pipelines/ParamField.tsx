import { Select, Switch, TextField } from "@/components";
import { validParamValue } from "@/pipelines/params";
import styles from "./ParamField.module.css";

export type ParamFieldType = "text" | "number" | "toggle" | "choice" | "color";

export interface ParamFieldProps {
  type: ParamFieldType;
  value: string;
  onChange: (value: string) => void;
  choices?: readonly string[];
  /** Accessible name (the field has no visible label of its own). */
  label: string;
  size?: "sm" | "md";
  /** Marks the field invalid. Defaults to checking the value against its type. */
  invalid?: boolean;
}

const isTrue = (v: string) => /^(true|yes|on|1)$/i.test(v.trim());

/** One field of a run parameter, fitting its type: input, number input, switch, select or colour (the start sheet and the Input panel use it). */
export function ParamField({ type, value, onChange, choices = [], label, size = "sm", invalid }: ParamFieldProps) {
  const bad = invalid ?? !validParamValue(type, value, choices);
  switch (type) {
    case "toggle":
      return <Switch checked={isTrue(value)} onChange={(on) => onChange(on ? "true" : "false")} aria-label={label} label={isTrue(value) ? "On" : "Off"} />;
    case "choice":
      return <Select size={size} aria-label={label} value={choices.includes(value) ? value : ""} options={[...(choices.includes(value) ? [] : [{ value: "", label: "Pick one", disabled: true }]), ...choices.map((c) => ({ value: c, label: c }))]} onChange={onChange} />;
    case "color":
      return (
        <span className={styles.color}>
          <input type="color" className={styles.swatch} aria-label={`${label} (colour picker)`} value={/^#[0-9a-f]{6}$/i.test(value) ? value : "#000000"} onChange={(e) => onChange(e.target.value)} />
          <TextField size={size} mono aria-label={label} value={value} invalid={bad} maxLength={7} onChange={(e) => onChange(e.target.value)} />
        </span>
      );
    case "number":
      return <TextField size={size} mono type="number" step="any" aria-label={label} value={value} invalid={bad} onChange={(e) => onChange(e.target.value)} />;
    default:
      return <TextField size={size} aria-label={label} value={value} maxLength={1000} onChange={(e) => onChange(e.target.value)} />;
  }
}
