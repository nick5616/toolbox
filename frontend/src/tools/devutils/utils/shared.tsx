import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components";
import { copyText } from "@/lib/copy";
import { saveTextAs } from "@/lib/saveText";
import { TextActions } from "@/tools/_kit";
import styles from "../DevUtils.module.css";

/** Returns `value` after it has been stable for `ms` (150 ms by default, SPEC §10.2). */
export function useDebounced<T>(value: T, ms = 150): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function CopyButton({ text, label = "Copy", disabled, what }: { text: string; label?: string; disabled?: boolean; what?: string }) {
  return (
    <Button size="sm" variant="secondary" icon="copy" disabled={disabled ?? text === ""} data-tip={(disabled ?? text === "") ? "Nothing to copy yet" : what ? `Copy ${what} to the clipboard` : "Copy this result to the clipboard"} onClick={() => void copyText(text)}>
      {label}
    </Button>
  );
}

/** Save as… next to a CopyButton, for results that aren't in an OutputBox. */
export function SaveButton({ text, filename, label = "Save…", what }: { text: string; filename: string; label?: string; what?: string }) {
  return (
    <Button size="sm" variant="secondary" icon="download" disabled={text === ""} data-tip={text === "" ? "Nothing to save yet" : `Save ${what ?? "this result"} as a file`} onClick={() => void saveTextAs(text, filename)}>
      {label}
    </Button>
  );
}

/** A labelled read-only output with Copy and Save as… buttons. */
export function OutputBox({
  label,
  value,
  children,
  className,
  filename = "result.txt",
}: {
  label: string;
  value: string;
  children?: ReactNode;
  className?: string;
  /** Suggested name for Save as… ("data.json"). */
  filename?: string;
}) {
  return (
    <div className={styles.col}>
      <div className={styles.outHead}>
        <span className={styles.label}>{label}</span>
        <span className={styles.row}>
          <TextActions text={value} filename={filename} what={label} disabled={value === ""} />
        </span>
      </div>
      <pre data-tip="Result; select text to copy part of it" className={[styles.out, value === "" ? styles.outEmpty : "", className ?? ""].join(" ").trim()} aria-label={label}>
        {children ?? (value === "" ? "—" : value)}
      </pre>
    </div>
  );
}
