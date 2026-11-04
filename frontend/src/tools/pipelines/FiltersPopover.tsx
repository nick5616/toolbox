import { useEffect, useRef, useState } from "react";
import { Button, TextField, cx } from "@/components";
import { OutputKind } from "@/lib/api";
import type { Filter } from "./editorModel";
import styles from "./FiltersPopover.module.css";

export interface FiltersPopoverProps {
  filter: Filter;
  onChange: (next: Filter) => void;
}

const KINDS: Array<{ value: OutputKind; label: string }> = [
  { value: OutputKind.KindAudio, label: "Audio" },
  { value: OutputKind.KindVideo, label: "Video" },
  { value: OutputKind.KindImage, label: "Images" },
  { value: OutputKind.KindDocument, label: "Documents" },
  { value: OutputKind.KindOther, label: "Other" },
];

/** ".MP3, wav" → [".mp3", ".wav"] */
export function parseExts(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const t = raw.trim().toLowerCase();
    if (!t || t === ".") continue;
    const e = t.startsWith(".") ? t : `.${t}`;
    if (!out.includes(e)) out.push(e);
  }
  return out;
}

/** "More filters…": kinds, extensions and a name-contains field (SPEC.md §11.4). */
export function FiltersPopover({ filter, onChange }: FiltersPopoverProps) {
  const [open, setOpen] = useState(false);
  const [exts, setExts] = useState(filter.exts.join(", "));
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const toggleKind = (k: OutputKind) => {
    const kinds = filter.kinds.includes(k) ? filter.kinds.filter((x) => x !== k) : [...filter.kinds, k];
    onChange({ ...filter, kinds });
  };

  const active = filter.kinds.length + filter.exts.length + (filter.name.trim() ? 1 : 0);

  return (
    <span ref={rootRef} className={styles.root}>
      <Button
        size="sm"
        variant="ghost"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-tip="Limit this step by kind of file, file extension or part of the name"
        onClick={() => {
          setExts(filter.exts.join(", "));
          setOpen(!open);
        }}
      >
        {active > 0 ? `More filters (${active})` : "More filters…"}
      </Button>
      {open && (
        <div
          className={styles.panel}
          role="dialog"
          aria-label="More filters"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setOpen(false);
            }
          }}
        >
          <div className={styles.group}>
            <span className={styles.label} data-tip="Only take files of these kinds; none ticked means all kinds">Kinds</span>
            <div className={styles.chips}>
              {KINDS.map((k) => (
                <button
                  key={k.value}
                  type="button"
                  className={cx(styles.chip, filter.kinds.includes(k.value) && styles.on)}
                  aria-pressed={filter.kinds.includes(k.value)}
                  data-tip={filter.kinds.includes(k.value) ? `Stop limiting to ${k.label.toLowerCase()}` : `Only take ${k.label.toLowerCase()} files`}
                  onClick={() => toggleKind(k.value)}
                >
                  {k.label}
                </button>
              ))}
            </div>
          </div>
          <label className={styles.group}>
            <span className={styles.label} data-tip="Only take files that end like this">Extensions</span>
            <TextField
              size="sm"
              mono
              placeholder=".png, .jpg"
              aria-label="Extensions"
              data-tip="File endings separated by commas, e.g. .png, .jpg; leave empty for any"
              value={exts}
              onChange={(e) => {
                setExts(e.target.value);
                onChange({ ...filter, exts: parseExts(e.target.value) });
              }}
            />
          </label>
          <label className={styles.group}>
            <span className={styles.label} data-tip="Only take files whose name includes this text">Name contains</span>
            <TextField
              size="sm"
              placeholder="e.g. final"
              aria-label="Name contains"
              data-tip="Part of the file name, ignoring upper and lower case; leave empty for any"
              value={filter.name}
              onChange={(e) => onChange({ ...filter, name: e.target.value })}
            />
          </label>
        </div>
      )}
    </span>
  );
}
