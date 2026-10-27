import { useEffect, useRef, useState } from "react";
import { IconButton } from "./IconButton";
import { cx } from "./cx";
import styles from "./PathText.module.css";

export interface PathTextProps {
  path: string;
  /** Show a copy-to-clipboard button. */
  copy?: boolean;
  className?: string;
}

/** Splits at the last separator so the file name always stays visible. */
export function splitPath(path: string): [string, string] {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (i < 0) return ["", path];
  return [path.slice(0, i + 1), path.slice(i + 1)];
}

/** Mono path with middle truncation (the head ellipsizes, the file name stays). */
export function PathText({ path, copy = false, className }: PathTextProps) {
  const [head, tail] = splitPath(path);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable; nothing useful to do.
    }
  };

  return (
    <span className={cx(styles.root, className)}>
      <span className={styles.path} title={path}>
        {head && <span className={styles.head}>{head}</span>}
        <span className={styles.tail}>{tail}</span>
      </span>
      {copy && (
        <IconButton
          size="sm"
          icon={copied ? "check" : "copy"}
          label={copied ? "Copied" : "Copy path"}
          onClick={onCopy}
        />
      )}
    </span>
  );
}
