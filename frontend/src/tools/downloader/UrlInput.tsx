import { forwardRef } from "react";
import { Icon, TextArea, Tooltip, cx } from "@/components";
import type { ParsedUrl } from "./urls";
import styles from "./UrlInput.module.css";

export interface UrlInputProps {
  value: string;
  onChange: (value: string) => void;
  parsed: ParsedUrl[];
  /** Server-side errors keyed by raw URL. */
  serverErrors: Record<string, string>;
  /** Error for the whole list (e.g. too many links). */
  listError?: string;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export const UrlInput = forwardRef<HTMLTextAreaElement, UrlInputProps>(function UrlInput(
  { value, onChange, parsed, serverErrors, listError },
  ref,
) {
  const invalid = parsed.filter((p) => !p.valid || serverErrors[p.raw]).length;
  const summary = `${parsed.length} ${parsed.length === 1 ? "link" : "links"}${invalid ? ` · ${invalid} invalid` : ""}`;
  return (
    <div className={styles.root}>
      <TextArea
        ref={ref}
        mono
        minRows={1}
        maxRows={8}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Paste one or more links…"
        aria-label="Links"
        invalid={invalid > 0 || !!listError}
        spellCheck={false}
      />
      {parsed.length > 0 && (
        <>
          <ul className={styles.chips} aria-label="Parsed links">
            {parsed.map((p) => {
              const error = p.error ?? serverErrors[p.raw];
              return (
                <li key={p.raw}>
                  <Tooltip label={error ?? p.raw}>
                    <span className={cx(styles.chip, error && styles.bad)} tabIndex={0}>
                      <Icon name={error ? "x" : "check"} size={12} className={error ? styles.badIcon : styles.okIcon} />
                      <span className={styles.host}>{p.valid ? p.host : truncate(p.raw, 28)}</span>
                      {p.valid && p.path && <span className={styles.path}>{truncate(p.path, 28)}</span>}
                      {p.count > 1 && <span className={styles.count}>×{p.count}</span>}
                    </span>
                  </Tooltip>
                </li>
              );
            })}
          </ul>
          <p className={cx(styles.summary, (invalid > 0 || listError) && styles.summaryBad)}>
            {summary}
            {listError ? ` · ${listError}` : ""}
          </p>
        </>
      )}
    </div>
  );
});
