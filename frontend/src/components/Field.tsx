import { useId, type ReactNode } from "react";
import { cx } from "./cx";
import styles from "./Field.module.css";

/** Props to spread onto the control (also passed to a render-prop child). */
export interface FieldControlProps {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
}

export interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  /**
   * Either plain children (use `htmlFor` to bind the label) or a render prop
   * receiving id / aria-describedby / aria-invalid to spread on the control.
   */
  children: ReactNode | ((control: FieldControlProps) => ReactNode);
  /** Bind the label to an existing control id (plain children only). */
  htmlFor?: string;
  className?: string;
}

export function Field({ label, hint, error, required, children, htmlFor, className }: FieldProps) {
  const uid = useId();
  const controlId = htmlFor ?? `${uid}-control`;
  const hintId = hint ? `${uid}-hint` : undefined;
  const errorId = error ? `${uid}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(" ") || undefined;

  const control: FieldControlProps = {
    id: controlId,
    "aria-describedby": describedBy,
    "aria-invalid": error ? true : undefined,
  };

  return (
    <div className={cx(styles.field, className)}>
      <label htmlFor={controlId} className={styles.label}>
        {label}
        {required && (
          <span className={styles.required} aria-hidden="true">
            {" "}
            *
          </span>
        )}
      </label>
      {typeof children === "function" ? children(control) : children}
      {error && (
        <p id={errorId} className={styles.error} role="alert">
          {error}
        </p>
      )}
      {hint && (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      )}
    </div>
  );
}
