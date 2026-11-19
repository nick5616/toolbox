import { useState } from "react";
import { Button, Icon, IconButton, TextArea, TextField, cx } from "@/components";
import { CaptionField } from "@/lib/api";
import { copyText } from "@/lib/copy";
import { startPathsDrag } from "@/lib/fileDrag";
import { useThumbState, useInView } from "@/lib/thumbs";
import {
  ALT_SOFT_LIMIT,
  FIELD_LABEL,
  FIELD_TIP,
  baseName,
  countChars,
  isVideoPath,
  statusOf,
  toHashtag,
  toKeyword,
  type ItemView,
} from "./options";
import styles from "./captions.module.css";

function Thumb({ path }: { path: string }) {
  const [ref, seen] = useInView<HTMLDivElement>();
  const video = isVideoPath(path);
  const t = useThumbState(video ? "" : path, 240, seen && !video);
  return (
    <div ref={ref} className={styles.thumb} data-tip={path}>
      {t.status === "ok" ? <img src={t.src} alt="" className={styles.thumbImg} draggable={false} /> : <Icon name="file" size={20} className={styles.thumbIcon} />}
    </div>
  );
}

function CopyButton({ text, what }: { text: string; what: string }) {
  return (
    <IconButton size="sm" icon="copy" label={`Copy ${what}`} data-tip={text ? `Copy the ${what}` : `Nothing to copy yet`} disabled={text === ""} onClick={() => void copyText(text, { what })} />
  );
}

/** Tags you can add to and remove from (hashtags and keywords). */
function Chips({ field, value, onChange }: { field: CaptionField; value: string[]; onChange: (next: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const normalise = field === CaptionField.FieldHashtags ? toHashtag : toKeyword;
  const label = FIELD_LABEL[field] ?? field;
  const add = () => {
    const parts = draft.split(/[,\s]+/).map(normalise).filter((x) => x !== "");
    if (parts.length === 0) {
      setDraft("");
      return;
    }
    const next = [...value];
    for (const p of parts) if (!next.some((x) => x.toLowerCase() === p.toLowerCase())) next.push(p);
    setDraft("");
    if (next.length !== value.length) onChange(next);
  };
  return (
    <div className={styles.chips} role="group" aria-label={label}>
      {value.map((c) => (
        <span key={c} className={styles.chip}>
          {c}
          <button type="button" className={styles.chipX} aria-label={`Remove ${c}`} data-tip={`Remove ${c}`} onClick={() => onChange(value.filter((x) => x !== c))}>
            <Icon name="x" size={10} />
          </button>
        </span>
      ))}
      <input
        className={styles.chipInput}
        value={draft}
        aria-label={`Add ${field === CaptionField.FieldHashtags ? "hashtag" : "keyword"}`}
        data-tip={field === CaptionField.FieldHashtags ? "Type a hashtag and press Enter" : "Type a keyword and press Enter"}
        placeholder={field === CaptionField.FieldHashtags ? "#add" : "add"}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={add}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add();
          } else if (e.key === "Backspace" && draft === "" && value.length > 0) {
            onChange(value.slice(0, -1));
          }
        }}
      />
    </div>
  );
}

export interface CaptionCardProps {
  item: ItemView;
  index: number;
  fields: CaptionField[];
  busy: boolean;
  /** Embedded in another tool: compact, with Use. */
  compact?: boolean;
  /** Label of the Use button when embedded ("" = no Use). */
  useLabel?: string;
  /** Regenerate and notes need a saved batch. */
  canRegenerate: boolean;
  onEdit: (index: number, field: CaptionField, value: string | string[]) => void;
  onNote: (index: number, note: string) => void;
  onRegenerate: (index: number, all: boolean) => void;
  onUse?: (index: number) => void;
  onRetry?: (index: number) => void;
}

export function CaptionCard({ item, index, fields, busy, compact, useLabel, canRegenerate, onEdit, onNote, onRegenerate, onUse, onRetry }: CaptionCardProps) {
  const [noteOpen, setNoteOpen] = useState(item.note !== "");
  const status = statusOf(item);
  const name = baseName(item.input);
  const f = item.fields;

  return (
    <article
      className={cx(styles.card, compact && styles.compact)}
      aria-label={name}
      aria-busy={status === "pending" || busy}
      draggable
      onDragStart={(e) => {
        if ((e.target as HTMLElement).closest("input, textarea, button")) {
          e.preventDefault();
          return;
        }
        startPathsDrag(e, [item.input]);
      }}
    >
      <Thumb path={item.input} />
      <div className={styles.body}>
        <header className={styles.cardHead}>
          <span className={styles.fileName} data-tip={item.input}>
            {name}
          </span>
          <span className={styles.cardActions}>
            {status === "done" && onUse && useLabel && (
              <Button size="sm" variant="primary" data-tip="Send this text back to the tool that opened Caption Writer" onClick={() => onUse(index)}>
                {useLabel}
              </Button>
            )}
            {status !== "pending" && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  icon="rotate-cw"
                  loading={busy}
                  disabled={!canRegenerate || busy}
                  data-tip={canRegenerate ? "Write new text with a new seed; the fields you edited stay" : "Regenerate works once the batch is saved"}
                  onClick={() => onRegenerate(index, false)}
                >
                  Regenerate
                </Button>
                <IconButton
                  size="sm"
                  icon="refresh-cw"
                  label="Regenerate all fields"
                  data-tip={canRegenerate ? "Write every field again, including the ones you edited" : "Regenerate works once the batch is saved"}
                  disabled={!canRegenerate || busy}
                  onClick={() => onRegenerate(index, true)}
                />
                <IconButton
                  size="sm"
                  icon="pencil"
                  label="Note for this file…"
                  data-tip="Tell the writer something only you know about this file (a name, a place). It is used the next time this file is written"
                  aria-pressed={noteOpen}
                  onClick={() => setNoteOpen((o) => !o)}
                />
              </>
            )}
          </span>
        </header>

        {status === "pending" && (
          <div className={styles.skeleton} role="status" aria-label={`Writing for ${name}`}>
            <span className={styles.skLine} />
            <span className={styles.skLine} />
            <span className={cx(styles.skLine, styles.skShort)} />
          </div>
        )}

        {status === "failed" && (
          <div className={styles.failed} role="alert">
            <Icon name="circle-alert" size={14} />
            <span className={styles.reason}>{item.reason || "This file couldn't be read"}</span>
            {onRetry && (
              <Button size="sm" variant="secondary" icon="rotate-cw" loading={busy} disabled={!canRegenerate || busy} data-tip="Try this file again" onClick={() => onRetry(index)}>
                Retry
              </Button>
            )}
          </div>
        )}

        {status === "done" && (
          <div className={styles.fields}>
            {fields.map((field) => {
              const label = FIELD_LABEL[field] ?? field;
              const tip = FIELD_TIP[field] ?? label;
              const edited = item.edited[field] === true;
              let editor: React.ReactNode;
              let copy = "";
              let counter: React.ReactNode = null;
              switch (field) {
                case CaptionField.FieldHashtags:
                  editor = <Chips field={field} value={f.hashtags} onChange={(v) => onEdit(index, field, v)} />;
                  copy = f.hashtags.join(" ");
                  break;
                case CaptionField.FieldKeywords:
                  editor = <Chips field={field} value={f.keywords} onChange={(v) => onEdit(index, field, v)} />;
                  copy = f.keywords.join(", ");
                  break;
                case CaptionField.FieldTitle:
                case CaptionField.FieldName: {
                  const v = f[field];
                  copy = v;
                  editor = <TextField size="sm" aria-label={label} data-tip={tip} value={v} onChange={(e) => onEdit(index, field, e.target.value)} />;
                  break;
                }
                default: {
                  const v = f[field as "alt" | "description" | "caption"];
                  copy = v;
                  if (field === CaptionField.FieldAlt) {
                    const n = countChars(v);
                    counter = (
                      <span className={cx(styles.counter, n > ALT_SOFT_LIMIT && styles.over)} data-tip="Characters used; alt text reads best at 125 or fewer" data-testid="alt-count">
                        {n} / {ALT_SOFT_LIMIT}
                      </span>
                    );
                  }
                  editor = (
                    <TextArea
                      aria-label={label}
                      data-tip={tip}
                      minRows={field === CaptionField.FieldAlt ? 2 : compact ? 2 : 3}
                      maxRows={8}
                      value={v}
                      invalid={field === CaptionField.FieldAlt && countChars(v) > ALT_SOFT_LIMIT * 2}
                      onChange={(e) => onEdit(index, field, e.target.value)}
                    />
                  );
                }
              }
              return (
                <div key={field} className={styles.field}>
                  <div className={styles.fieldHead}>
                    <span className={styles.fieldLabel} data-tip={tip}>
                      {label}
                      {edited && (
                        <span className={styles.editedDot} data-tip="You edited this; Regenerate keeps it">
                          edited
                        </span>
                      )}
                    </span>
                    {counter}
                    <CopyButton text={copy} what={label.toLowerCase()} />
                  </div>
                  {editor}
                </div>
              );
            })}
          </div>
        )}

        {noteOpen && status !== "pending" && (
          <TextField
            size="sm"
            aria-label="Note for this file"
            data-tip="Used for this file the next time it is written or regenerated"
            placeholder="Note for this file, e.g. “Max at the beach”"
            value={item.note}
            onChange={(e) => onNote(index, e.target.value)}
          />
        )}
      </div>
    </article>
  );
}
