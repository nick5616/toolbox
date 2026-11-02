import { useState } from "react";
import { Button, Field, Icon, SegmentedControl, Select, TextField, cx } from "@/components";
import type { ProjectInfo } from "@/lib/api";
import { CAROUSEL_ASPECTS, FORMAT_LABELS, defaultPostName, type PostFormat } from "./logic";
import { Modal } from "./Modal";
import { ProjectThumb } from "./ProjectThumb";
import styles from "./dialogs.module.css";

const FORMAT_OPTIONS = (Object.keys(FORMAT_LABELS) as PostFormat[]).map((value) => ({ value, label: FORMAT_LABELS[value] }));

export interface NewPostDialogProps {
  /** Files that will become the first slides. */
  fileCount: number;
  onPickFiles: () => void;
  onCreate: (name: string, format: PostFormat, aspect: string) => void;
  onClose: () => void;
}

export function NewPostDialog({ fileCount, onPickFiles, onCreate, onClose }: NewPostDialogProps) {
  const [format, setFormat] = useState<PostFormat>("carousel");
  const [aspect, setAspect] = useState("4:5");
  const [name, setName] = useState(() => defaultPostName("carousel"));
  const [touched, setTouched] = useState(false);
  const trimmed = name.trim();

  const pickFormat = (f: PostFormat) => {
    setFormat(f);
    if (!touched) setName(defaultPostName(f));
  };

  return (
    <Modal title="New post" confirmLabel="Create" confirmDisabled={!trimmed} onConfirm={() => onCreate(trimmed, format, format === "carousel" ? aspect : "9:16")} onClose={onClose}>
      <Field label="Name">
        {(c) => (
          <TextField
            {...c}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setTouched(true);
            }}
          />
        )}
      </Field>
      <Field label="Format">
        <SegmentedControl value={format} onChange={pickFormat} options={FORMAT_OPTIONS} aria-label="Format" />
      </Field>
      {format === "carousel" ? (
        <Field label="Shape" hint="The first slide's shape applies to every slide.">
          {(c) => <Select id={c.id} value={aspect} onChange={setAspect} options={CAROUSEL_ASPECTS.map((a) => ({ value: a.value, label: a.label }))} />}
        </Field>
      ) : (
        <p className={styles.note}>{format === "reel" ? "A reel is one 9:16 video, up to 3 minutes." : "Stories are 9:16 slides; a video slide can run up to 60 seconds."}</p>
      )}
      <div className={styles.files}>
        <Button size="sm" variant="secondary" icon="plus" onClick={onPickFiles}>
          Add photos and clips…
        </Button>
        {fileCount > 0 && (
          <span className={styles.note}>
            {fileCount} {fileCount === 1 ? "file" : "files"} will be added as slides.
          </span>
        )}
      </div>
    </Modal>
  );
}

export interface NameDialogProps {
  title: string;
  initial: string;
  confirmLabel: string;
  onConfirm: (name: string) => void;
  onClose: () => void;
}

export function NameDialog({ title, initial, confirmLabel, onConfirm, onClose }: NameDialogProps) {
  const [name, setName] = useState(initial);
  const trimmed = name.trim();
  return (
    <Modal title={title} confirmLabel={confirmLabel} confirmDisabled={!trimmed} onConfirm={() => onConfirm(trimmed)} onClose={onClose}>
      <Field label="Name">{(c) => <TextField {...c} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
    </Modal>
  );
}

export interface ProjectPickerProps {
  title: string;
  projects: ProjectInfo[];
  emptyText: string;
  onPick: (p: ProjectInfo) => void;
  onClose: () => void;
}

/** Choose one saved project (composition or video) for a slide. */
export function ProjectPickerDialog({ title, projects, emptyText, onPick, onClose }: ProjectPickerProps) {
  return (
    <Modal title={title} onClose={onClose} wide>
      {projects.length === 0 ? (
        <p className={styles.note}>{emptyText}</p>
      ) : (
        <ul className={styles.grid} aria-label={title}>
          {projects.map((p) => (
            <li key={p.id}>
              <button type="button" className={styles.card} onClick={() => onPick(p)} aria-label={p.name}>
                <ProjectThumb project={p} className={styles.cardThumb} />
                <span className={styles.cardName}>{p.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

export interface PostChoiceProps {
  posts: ProjectInfo[];
  value: string;
  onChange: (id: string) => void;
}

/** "New post" plus the saved posts, as a single-choice list. */
export function PostChoice({ posts, value, onChange }: PostChoiceProps) {
  const rows: { id: string; name: string; sub: string; icon: string }[] = [
    { id: "new", name: "New post", sub: "Start a post with these files", icon: "plus" },
    ...posts.map((p) => ({ id: p.id, name: p.name, sub: `${p.items} ${p.items === 1 ? "slide" : "slides"}`, icon: "gallery-horizontal-end" })),
  ];
  return (
    <div role="radiogroup" aria-label="Post" className={styles.choices}>
      {rows.map((r) => (
        <button
          key={r.id}
          type="button"
          role="radio"
          aria-checked={value === r.id}
          className={cx(styles.choice, value === r.id && styles.choiceOn)}
          onClick={() => onChange(r.id)}
        >
          <Icon name={r.icon} size={14} />
          <span className={styles.choiceName}>{r.name}</span>
          <span className={styles.choiceSub}>{r.sub}</span>
        </button>
      ))}
    </div>
  );
}
