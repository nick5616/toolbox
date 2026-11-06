import { IconButton } from "@/components";
import { copyText } from "@/lib/copy";
import { saveTextAs } from "@/lib/saveText";

export interface TextActionsProps {
  /** The text, or a function that builds it on click (big results). */
  text: string | (() => string);
  /** Suggested file name with extension ("Interview.txt", "rows.csv"). */
  filename: string;
  /** What it is, for tooltips and the Copied toast ("transcript"). */
  what?: string;
  disabled?: boolean;
  size?: "sm" | "md";
}

/**
 * Copy and Save as… for a text or data result (CLAUDE.md "Every tool stands
 * on its own"): every tool whose result is text lets the user copy it and
 * keep it as a file, on its own, without another tool.
 */
export function TextActions({ text, filename, what = "text", disabled, size = "sm" }: TextActionsProps) {
  const get = () => (typeof text === "function" ? text() : text);
  return (
    <>
      <IconButton size={size} icon="copy" label={`Copy ${what}`} data-tip={`Copy the ${what} to the clipboard`} disabled={disabled} onClick={() => void copyText(get(), { what })} />
      <IconButton size={size} icon="download" label="Save as…" data-tip={`Save the ${what} as a file`} disabled={disabled} onClick={() => void saveTextAs(get(), filename)} />
    </>
  );
}
