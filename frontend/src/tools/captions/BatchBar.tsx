import { useState } from "react";
import { Button, IconButton, MenuButton, toast, type MenuItem } from "@/components";
import { CaptionService, LibraryService } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { useElementSize } from "@/lib/useElementSize";
import { saveTextAs } from "@/lib/saveText";
import { copyText } from "@/lib/copy";
import { ResultRow } from "@/tools/_kit";
import { baseName, statusOf, type BatchView } from "./options";
import { useOutputId } from "./useOutputId";
import styles from "./captions.module.css";

/** Where one text per file goes when it is copied: files with nothing yet are skipped. */
export function collect(batch: BatchView, pick: (i: BatchView["items"][number]) => string): string {
  return batch.items
    .filter((i) => statusOf(i) === "done")
    .map(pick)
    .filter((s) => s.trim() !== "")
    .join("\n\n");
}

export function captionLine(i: BatchView["items"][number]): string {
  const tags = i.fields.hashtags.join(" ");
  return [i.fields.caption, tags].filter((s) => s !== "").join("\n\n");
}

const csvCell = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
export function batchCsv(batch: BatchView): string {
  const head = ["file", "alt", "description", "caption", "hashtags", "title", "keywords", "name"];
  const rows = batch.items.filter((i) => statusOf(i) === "done").map((i) => [baseName(i.input), i.fields.alt, i.fields.description, i.fields.caption, i.fields.hashtags.join(" "), i.fields.title, i.fields.keywords.join(", "), i.fields.name]);
  return [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}

async function run(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    toast({ title: toAppError(e).message, tone: "danger" });
  }
}

export interface BatchBarProps {
  batch: BatchView;
  busy: boolean;
  exifTool: boolean;
  /** The batch's images or videos can't be written until FFmpeg is installed. */
  onWrite: () => void;
  onRename: () => void;
  /** Embedded: "Use first". */
  onUseFirst?: () => void;
  useLabel?: string;
}

/** The batch row: folder, files, copy, export, write and rename. One line; extras move into "More…" when narrow. */
export function BatchBar({ batch, busy, exifTool, onWrite, onRename, onUseFirst, useLabel }: BatchBarProps) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const { width } = useElementSize(el);
  const narrow = width > 0 && width < 720;
  const csvPath = `${batch.dir.replace(/[\\/]+$/, "")}${batch.dir.includes("\\") ? "\\" : "/"}captions.csv`;
  const done = batch.items.filter((i) => statusOf(i) === "done").length;
  const hasDone = done > 0;
  const folder = baseName(batch.dir.replace(/[\\/]+$/, ""));

  const copyItems = (): MenuItem[] => [
    { id: "captions", label: "Captions", tip: "Every caption with its hashtags, one after another", disabled: !hasDone, onSelect: () => void copyText(collect(batch, captionLine), { what: "captions" }) },
    { id: "alts", label: "Alt texts", tip: "Every alt text, one after another", disabled: !hasDone, onSelect: () => void copyText(collect(batch, (i) => i.fields.alt), { what: "alt texts" }) },
    { id: "csv", label: "As CSV", tip: "All fields as a table you can paste into a spreadsheet", disabled: !hasDone, onSelect: () => void copyText(batchCsv(batch), { what: "the table" }) },
  ];
  const exportItems = (): MenuItem[] => [
    {
      id: "md",
      label: "One Markdown file",
      tip: "One .md with every file's text, saved in the batch folder",
      disabled: !hasDone,
      onSelect: () =>
        void run(
          CaptionService.ExportText(batch.dir, "md").then((paths) => {
            const n = paths?.length ?? 0;
            toast({ title: n > 0 ? `Wrote ${baseName(paths?.[0] ?? "")}` : "Nothing to write", tone: n > 0 ? "success" : "warn" });
          }),
        ),
    },
    {
      id: "txt",
      label: "A .txt per file",
      tip: "One text file per picture, next to the batch file",
      disabled: !hasDone,
      onSelect: () =>
        void run(
          CaptionService.ExportText(batch.dir, "txt").then((paths) => {
            const n = paths?.length ?? 0;
            toast({ title: n > 0 ? `Wrote ${n} text ${n === 1 ? "file" : "files"}` : "Nothing to write", tone: n > 0 ? "success" : "warn" });
          }),
        ),
    },
    { id: "save", label: "Save table as…", tip: "Choose where to save the table (CSV)", disabled: !hasDone, onSelect: () => void saveTextAs(batchCsv(batch), `${folder || "captions"}.csv`) },
  ];

  const writeDisabled = busy || !hasDone || !exifTool;
  const writeTip = !exifTool ? "ExifTool isn't installed; install the Caption Writer pack to write into copies" : !hasDone ? "Nothing written yet" : "Make copies of your files with this text written into them";

  return (
    <div ref={setEl} className={styles.batchBar} role="toolbar" aria-label="Batch">
      <span className={styles.batchName} data-tip={batch.dir}>
        {folder || "New batch"}
      </span>
      <span className={styles.batchCount}>{done} written</span>
      <IconButton size="sm" icon="folder-open" label="Show batch folder" data-tip="Show the batch folder in your file manager" disabled={batch.dir === ""} onClick={() => void run(LibraryService.RevealPath(csvPath))} />
      <span className={styles.spacer} />
      {onUseFirst && useLabel && (
        <Button size="sm" variant="primary" disabled={!hasDone} data-tip="Send the first file's text back to the tool that opened Caption Writer" onClick={onUseFirst}>
          {`${useLabel} (first)`}
        </Button>
      )}
      <MenuButton size="sm" variant="ghost" icon="copy" label="Copy all" tip="Copy every caption, alt text or the whole table" items={copyItems} />
      {!narrow && <MenuButton size="sm" variant="ghost" icon="download" label="Export" tip="Export the text as Markdown, text files or a table" items={exportItems} />}
      <Button size="sm" variant="secondary" icon="file-text" disabled={writeDisabled} data-tip={writeTip} onClick={onWrite}>
        Write into copies…
      </Button>
      <Button size="sm" variant="secondary" icon="pencil" disabled={busy || !hasDone} data-tip="Make copies named after what is in them; the originals keep their names" onClick={onRename}>
        Rename copies…
      </Button>
      {narrow && (
        <MenuButton
          size="sm"
          variant="ghost"
          icon="ellipsis"
          label="More…"
          tip="Export and more"
          items={exportItems}
        />
      )}
    </div>
  );
}

/** The batch's saved table, as a result row: Reveal, Open and Save a copy always on hand. */
export function BatchFiles({ batch }: { batch: BatchView }) {
  const sep = batch.dir.includes("\\") ? "\\" : "/";
  const base = batch.dir.replace(/[\\/]+$/, "");
  return (
    <div className={styles.files}>
      <BatchFile path={`${base}${sep}captions.csv`} />
      <BatchFile path={`${base}${sep}captions.json`} />
    </div>
  );
}

function BatchFile({ path }: { path: string }) {
  const id = useOutputId(path);
  return <ResultRow path={path} outputId={id || undefined} moduleId="captions" icon="file-text" />;
}

