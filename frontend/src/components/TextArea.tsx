import { forwardRef, useLayoutEffect, useRef, type TextareaHTMLAttributes } from "react";
import { cx, useMergedRef } from "./cx";
import styles from "./TextArea.module.css";

export interface TextAreaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "rows"> {
  invalid?: boolean;
  mono?: boolean;
  /** Minimum visible rows (default 2). */
  minRows?: number;
  /** Grow up to this many rows, then scroll (default 8). */
  maxRows?: number;
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { invalid, mono, minRows = 2, maxRows = 8, className, value, onChange, ...rest },
  ref,
) {
  const inner = useRef<HTMLTextAreaElement>(null);
  const merged = useMergedRef(inner, ref);

  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const parsed = parseFloat(cs.lineHeight);
    const lineHeight = Number.isFinite(parsed) ? parsed : 20;
    const extra =
      parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    const pad = Number.isFinite(extra) ? extra : 0;
    el.style.height = "auto";
    const min = minRows * lineHeight + pad;
    const max = maxRows * lineHeight + pad;
    el.style.height = `${Math.min(max, Math.max(min, el.scrollHeight))}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [value, minRows, maxRows]);

  return (
    <textarea
      ref={merged}
      rows={minRows}
      value={value}
      onChange={onChange}
      aria-invalid={invalid || undefined}
      className={cx(styles.textarea, mono && styles.mono, invalid && styles.invalid, className)}
      {...rest}
    />
  );
});
