import { useState } from "react";
import { Modal, SegmentedControl, Switch } from "@/components";
import { CaptionField, CaptionNamePattern, type CaptionWriteOptions } from "@/lib/api";
import { baseName, extOf, isVideoPath, statusOf, type ItemView } from "./options";
import styles from "./captions.module.css";

export interface WriteDialogProps {
  initial: CaptionWriteOptions;
  /** Number of images and videos that will get a copy. */
  images: number;
  videos: number;
  onWrite: (w: CaptionWriteOptions) => void;
  onClose: () => void;
}

/** "Write into copies…": which fields go into the copies' metadata. */
export function WriteDialog({ initial, images, videos, onWrite, onClose }: WriteDialogProps) {
  const [w, setW] = useState<CaptionWriteOptions>(initial);
  const set = (patch: Partial<CaptionWriteOptions>) => setW((cur) => ({ ...cur, ...patch }));
  const any = w.alt || w.description || w.caption || w.title || w.keywords;
  return (
    <Modal title="Write into copies" confirmLabel="Write copies" confirmDisabled={!any} onConfirm={() => onWrite(w)} onClose={onClose}>
      <div className={styles.dialog}>
        <p className={styles.help}>
          Makes a copy of {images + videos} {images + videos === 1 ? "file" : "files"} in the batch folder (With captions) and writes the text into the copy's metadata. Your originals are never touched.
          {videos > 0 ? " Videos get the title and description (WebM only the title)." : ""}
        </p>
        <Switch checked={w.alt} onChange={(alt) => set({ alt })} label="Alt text" tip="Stored as the picture's accessibility alt text" />
        <Switch checked={w.description} onChange={(description) => set({ description })} label="Description" tip="Stored as the picture's extended accessibility description" />
        <Switch checked={w.caption} onChange={(caption) => set({ caption })} label="Caption" tip="Stored as the standard caption/description that photo apps show" />
        {w.caption && (
          <div className={styles.row}>
            <span className={styles.label}>Caption from</span>
            <SegmentedControl<CaptionField>
              size="sm"
              aria-label="Caption field from"
              value={w.captionFrom}
              onChange={(captionFrom) => set({ captionFrom })}
              options={[
                { value: CaptionField.FieldCaption, label: "Caption", tip: "Write the caption text into the caption metadata" },
                { value: CaptionField.FieldDescription, label: "Description", tip: "Write the longer description into the caption metadata" },
              ]}
            />
          </div>
        )}
        <Switch checked={w.title} onChange={(title) => set({ title })} label="Title" tip="Stored as the title" />
        <Switch checked={w.keywords} onChange={(keywords) => set({ keywords })} label="Keywords" tip="Stored as the keywords/subject" />
        <Switch
          checked={w.keepLocation}
          onChange={(keepLocation) => set({ keepLocation })}
          label="Keep location data"
          tip="Off by default: the copies lose the GPS position of where the photo was taken"
        />
      </div>
    </Modal>
  );
}

export interface RenameDialogProps {
  items: ItemView[];
  pattern: CaptionNamePattern;
  onRename: () => void;
  onClose: () => void;
}

/** What a renamed copy will probably be called (dates and numbers are added when the copies are made). */
export function previewName(item: ItemView, index: number, pattern: CaptionNamePattern): string {
  const ext = extOf(item.input);
  const stem = item.fields.name || baseName(item.input).replace(/\.[^.]+$/, "");
  switch (pattern) {
    case CaptionNamePattern.NameNumber:
      return `${String(index + 1).padStart(2, "0")} ${stem}${ext}`;
    case CaptionNamePattern.NameDate:
      return `yyyy-mm-dd ${stem}${ext}`;
    default:
      return `${stem}${ext}`;
  }
}

/** "Rename copies…": a before → after list first. */
export function RenameDialog({ items, pattern, onRename, onClose }: RenameDialogProps) {
  const rows = items.map((it, i) => ({ it, i })).filter(({ it }) => statusOf(it) === "done" && it.fields.name !== "");
  return (
    <Modal title="Rename copies" confirmLabel={`Make ${rows.length} renamed ${rows.length === 1 ? "copy" : "copies"}`} confirmDisabled={rows.length === 0} onConfirm={onRename} onClose={onClose} wide>
      <div className={styles.dialog}>
        <p className={styles.help}>Copies go to the batch folder (Renamed). Your originals keep their names.</p>
        {rows.length === 0 ? (
          <p className={styles.help}>No file has a name yet. Write with the Rename or Everything preset first.</p>
        ) : (
          <ul className={styles.renameList} aria-label="Renames">
            {rows.map(({ it, i }) => (
              <li key={it.input} className={styles.renameRow}>
                <span className={styles.renameFrom} data-tip={it.input}>
                  {baseName(it.input)}
                </span>
                <span aria-hidden="true">→</span>
                <span className={styles.renameTo}>{previewName(it, i, pattern)}</span>
              </li>
            ))}
          </ul>
        )}
        {pattern !== CaptionNamePattern.NameOnly && <p className={styles.help}>Dates and numbers are filled in when the copies are made.</p>}
        {rows.some(({ it }) => isVideoPath(it.input)) && <p className={styles.help}>Videos are renamed too.</p>}
      </div>
    </Modal>
  );
}
