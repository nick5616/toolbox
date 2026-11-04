import { useId, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { parseTemplate } from "@/pipelines/vars";
import { MenuButton } from "./MenuButton";
import { TextArea } from "./TextArea";
import { TextField } from "./TextField";
import { cx } from "./cx";
import styles from "./TemplateField.module.css";

export interface TemplateVar {
  name: string;
  label: string;
}

export interface TemplateFieldProps {
  value: string;
  onChange: (next: string) => void;
  /** Variables available here (built-ins + earlier steps'). */
  vars: readonly TemplateVar[];
  label: string;
  multiline?: boolean;
  placeholder?: string;
  error?: string;
  /** Visible rows when multiline (default 3). */
  minRows?: number;
}

/**
 * A text field for pipeline templates (SPEC.md §11.4): `{vars}` are shown
 * under the field, unknown ones in red; typing `{` opens the variable list;
 * "Insert variable" adds one at the cursor.
 */
export function TemplateField({ value, onChange, vars, label, multiline, placeholder, error, minRows = 3 }: TemplateFieldProps) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const [suggest, setSuggest] = useState<{ at: number; query: string } | null>(null);
  const [active, setActive] = useState(0);

  const known = useMemo(() => new Set(vars.map((v) => v.name)), [vars]);
  const used = useMemo(() => parseTemplate(value).filter((p) => p.variable), [value]);
  const unknown = useMemo(() => [...new Set(used.filter((p) => !known.has(p.text)).map((p) => p.text))], [used, known]);
  const matches = useMemo(
    () => (suggest ? vars.filter((v) => v.name.startsWith(suggest.query) || v.label.toLowerCase().includes(suggest.query)) : []),
    [vars, suggest],
  );

  const el = (): HTMLInputElement | HTMLTextAreaElement | null => (multiline ? areaRef.current : inputRef.current);

  const insertAt = (start: number, end: number, text: string) => {
    const next = value.slice(0, start) + text + value.slice(end);
    onChange(next);
    const caret = start + text.length;
    requestAnimationFrame(() => {
      const e = el();
      if (!e) return;
      e.focus();
      e.setSelectionRange(caret, caret);
    });
  };

  const insertVar = (name: string) => {
    const e = el();
    const start = e?.selectionStart ?? value.length;
    const end = e?.selectionEnd ?? value.length;
    insertAt(start, end, `{${name}}`);
  };

  const pick = (name: string) => {
    if (!suggest) return;
    const e = el();
    const caret = e?.selectionStart ?? value.length;
    // Replace "{query" (the brace at suggest.at) with "{name}".
    insertAt(suggest.at, caret, `{${name}}`);
    setSuggest(null);
  };

  const onInput = (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const next = e.target.value;
    const caret = e.target.selectionStart ?? next.length;
    onChange(next);
    // Open or update the suggestions while typing "{name" right after a single brace.
    const before = next.slice(0, caret);
    const m = /\{([a-z0-9_]*)$/.exec(before);
    if (m && before[m.index - 1] !== "{") {
      setSuggest({ at: m.index, query: m[1] ?? "" });
      setActive(0);
    } else setSuggest(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (!suggest || matches.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % matches.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a - 1 + matches.length) % matches.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      const v = matches[active];
      if (v) {
        e.preventDefault();
        pick(v.name);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      setSuggest(null);
    }
  };

  const shownError = error ?? (unknown.length > 0 ? `Unknown: ${unknown.map((n) => `{${n}}`).join(", ")}` : undefined);
  const common = {
    id,
    value,
    placeholder,
    invalid: Boolean(shownError),
    "aria-invalid": Boolean(shownError) || undefined,
    "aria-describedby": `${id}-help`,
    onChange: onInput,
    onKeyDown,
    onBlur: () => setTimeout(() => setSuggest(null), 120),
  };

  return (
    <div className={styles.root}>
      <div className={styles.head}>
        <label htmlFor={id} className={styles.label} data-tip="Type {name} to use a variable; it is replaced with the real value for each file">
          {label}
        </label>
        <MenuButton
          label="Insert variable"
          size="sm"
          variant="ghost"
          icon="braces"
          emptyLabel="No variables here"
          items={() => vars.map((v) => ({ id: v.name, label: `${v.label}  {${v.name}}`, onSelect: () => insertVar(v.name) }))}
        />
      </div>
      <div className={styles.fieldWrap}>
        {multiline ? (
          <TextArea ref={areaRef} mono minRows={minRows} maxRows={14} {...common} />
        ) : (
          <TextField ref={inputRef} mono {...common} />
        )}
        {suggest && matches.length > 0 && (
          <ul className={styles.suggest} role="listbox" aria-label="Variables">
            {matches.map((v, i) => (
              <li
                key={v.name}
                role="option"
                aria-selected={i === active}
                data-tip={`Insert {${v.name}}`}
                className={cx(styles.option, i === active && styles.active)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(v.name);
                }}
              >
                <span className={styles.optName}>{`{${v.name}}`}</span>
                <span className={styles.optLabel}>{v.label}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div id={`${id}-help`} className={styles.help}>
        {used.length > 0 && (
          <span className={styles.chips}>
            {[...new Set(used.map((p) => p.text))].map((n) => (
              <span key={n} data-tip={known.has(n) ? "A variable used in this text" : "No such variable here; check the spelling"} className={cx(styles.chip, !known.has(n) && styles.bad)}>{`{${n}}`}</span>
            ))}
          </span>
        )}
        {shownError && <span className={styles.error}>{shownError}</span>}
      </div>
    </div>
  );
}
