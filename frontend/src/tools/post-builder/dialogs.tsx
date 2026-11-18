import { useState } from "react";
import { Button, Field, Icon, SegmentedControl, Select, Switch, TextField, cx, toast } from "@/components";
import { FilesService, type ProjectInfo } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { CAROUSEL_ASPECTS, FORMAT_LABELS, FORMAT_TIPS, defaultPostName, type PostFormat } from "./logic";
import { folderBaseName } from "./pool";
import { Modal } from "@/components";
import { ProjectThumb } from "./ProjectThumb";
import styles from "./dialogs.module.css";

const FORMAT_OPTIONS = (Object.keys(FORMAT_LABELS) as PostFormat[]).map((value) => ({ value, label: FORMAT_LABELS[value], tip: FORMAT_TIPS[value] }));

export interface NewPostDialogProps {
  /** Files that will become the first slides of an empty post. */
  fileCount: number;
  onPickFiles: () => void;
  onCreate: (name: string, format: PostFormat, aspect: string) => void;
  /** A post whose source pool is a folder (SPEC.md §B13.4). */
  onCreateFromFolder: (name: string, format: PostFormat, aspect: string, folder: string, subfolders: boolean) => void;
  onClose: () => void;
}

export function NewPostDialog({ fileCount, onPickFiles, onCreate, onCreateFromFolder, onClose }: NewPostDialogProps) {
  const [mode, setMode] = useState<"folder" | "empty">("folder");
  const [folder, setFolder] = useState("");
  const [subfolders, setSubfolders] = useState(false);
  const [format, setFormat] = useState<PostFormat>("carousel");
  const [aspect, setAspect] = useState("4:5");
  const [name, setName] = useState(() => defaultPostName("carousel"));
  const [touched, setTouched] = useState(false);
  const trimmed = name.trim();

  const pickFormat = (f: PostFormat) => {
    setFormat(f);
    if (!touched) setName(defaultPostName(f));
  };

  const pickFolder = async () => {
    try {
      const picked = await FilesService.PickFolder("Choose the folder with your photos and clips");
      if (!picked) return;
      setFolder(picked);
      if (!touched) setName(folderBaseName(picked) || defaultPostName(format));
    } catch (e) {
      toast({ tone: "danger", title: toAppError(e).message });
    }
  };

  const fromFolder = mode === "folder";
  const shape = format === "carousel" ? aspect : "9:16";
  return (
    <Modal
      title="New post"
      confirmLabel="Create"
      confirmDisabled={!trimmed || (fromFolder && !folder)}
      onConfirm={() => (fromFolder ? onCreateFromFolder(trimmed, format, shape, folder, subfolders) : onCreate(trimmed, format, shape))}
      onClose={onClose}
    >
      <SegmentedControl
        value={mode}
        onChange={setMode}
        aria-label="Start from"
        options={[
          { value: "folder", label: "From a folder", tip: "Use every photo and clip in a folder as the pool to build slides from" },
          { value: "empty", label: "Empty post", tip: "Start with no slides and add them yourself" },
        ]}
      />
      {fromFolder ? (
        <div className={styles.files}>
          <Button size="sm" variant="primary" icon="folder-open" data-tip="Choose the folder with your photos and clips" onClick={() => void pickFolder()}>
            {folder ? "Change folder…" : "From a folder…"}
          </Button>
          {folder ? (
            <span className={styles.note} title={folder}>
              {folder}
            </span>
          ) : (
            <span className={styles.note}>Every photo and clip in the folder becomes a source you can use in any slide. Your files are not changed.</span>
          )}
          <Switch checked={subfolders} onChange={setSubfolders} label="Include subfolders" aria-label="Include subfolders" tip="Also list photos and clips inside folders within the chosen folder" />
        </div>
      ) : (
        <div className={styles.files}>
          <Button size="sm" variant="secondary" icon="plus" data-tip="Pick photos and clips to start the post with, one slide each" onClick={onPickFiles}>
            Add photos and clips…
          </Button>
          {fileCount > 0 && (
            <span className={styles.note}>
              {fileCount} {fileCount === 1 ? "file" : "files"} will be added as slides.
            </span>
          )}
        </div>
      )}
      <Field label="Name">
        {(c) => (
          <TextField
            {...c}
            data-tip="A name for you to recognise this post by; it is not posted to Instagram"
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
          {(c) => <Select id={c.id} data-tip="Frame shape for every slide: 4:5 portrait is the tallest feed shape, 1:1 square, 1.91:1 landscape" value={aspect} onChange={setAspect} options={CAROUSEL_ASPECTS.map((a) => ({ value: a.value, label: a.label }))} />}
        </Field>
      ) : (
        <p className={styles.note}>{format === "reel" ? "A reel is one 9:16 video, up to 3 minutes." : "Stories are 9:16 slides; a video slide can run up to 60 seconds."}</p>
      )}
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
      <Field label="Name">{(c) => <TextField {...c} data-tip="New name for this post" value={name} onChange={(e) => setName(e.target.value)} />}</Field>
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
              <button type="button" className={styles.card} onClick={() => onPick(p)} aria-label={p.name} data-tip="Use this project as a slide">
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
          data-tip={r.id === "new" ? "Start a new post containing these files" : "Add these files to this post"}
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
