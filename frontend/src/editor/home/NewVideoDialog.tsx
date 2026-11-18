/** The Video Editor's New video dialog (Phase 10 SPEC §5.4): name, shape, frame rate and optional files. No song needed. */
import { useEffect, useState } from "react";
import { FromLibraryButton } from "@/blocks/library-picker";
import { Button, ConfirmDialog, Field, IconButton, SegmentedControl, TextField, cx, toast } from "@/components";
import { FilesService } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { ASPECTS } from "@/viz/edit/types";
import { MEDIA_EXTENSIONS } from "../sources/actions";
import { AUDIO_EXTENSIONS } from "../transport/logic";
import { baseName } from "./createEdit";
import { createVideo } from "./newVideo";
import styles from "./Home.module.css";

export interface NewVideoDialogProps {
  open: boolean;
  /** Prefilled files (a drop or handoff). */
  files?: string[];
  /** Called with the new video's ID once it is created and saved. */
  onCreated(id: string): void;
  onCancel(): void;
}

const SHAPE_TIPS: Record<string, string> = {
  "9:16": "Tall: Reels, TikTok and Shorts",
  "4:5": "Portrait: Instagram feed posts",
  "1:1": "Square: works anywhere",
  "16:9": "Wide: YouTube and TV",
};
const SHAPE: Record<string, { w: number; h: number }> = { "9:16": { w: 9, h: 16 }, "4:5": { w: 4, h: 5 }, "1:1": { w: 1, h: 1 }, "16:9": { w: 16, h: 9 } };
const EXTENSIONS = [...MEDIA_EXTENSIONS, ...AUDIO_EXTENSIONS];

export function NewVideoDialog({ open, files: filesIn = [], onCreated, onCancel }: NewVideoDialogProps) {
  const [name, setName] = useState("");
  const [files, setFiles] = useState<string[]>(filesIn);
  const [aspect, setAspect] = useState<string>("9:16");
  const [fps, setFps] = useState("30");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setFiles(filesIn);
    setName("");
    setAspect("9:16");
    setFps("30");
    setBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset on open only
  }, [open]);

  const useFiles = (picked: string[]) => setFiles((cur) => [...cur, ...picked.filter((p) => !cur.includes(p))]);
  const addFiles = async () => {
    try {
      useFiles((await FilesService.PickWith("Add clips, photos and music", EXTENSIONS, true)) ?? []);
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    }
  };

  const create = async () => {
    if (busy) return;
    setBusy(true);
    try {
      onCreated(await createVideo({ name, aspect, fps: Number(fps), files }));
    } catch (e) {
      toast({ title: "Couldn't create the video", description: toAppError(e).message, tone: "danger" });
      setBusy(false);
    }
  };

  const first = files[0];
  return (
    <ConfirmDialog
      open={open}
      title="New video"
      confirmLabel={busy ? "Creating…" : "Create"}
      onConfirm={() => void create()}
      onCancel={onCancel}
      body={
        <div className={styles.form}>
          <Field label="Name">
            {(c) => <TextField {...c} data-tip="What this video is called (up to 80 characters)" value={name} placeholder={first ? baseName(first) : "Untitled video"} maxLength={80} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <Field label="Shape">
            <div className={styles.shapes} role="radiogroup" aria-label="Shape" data-tip="The picture shape of the finished video">
              {ASPECTS.map((a) => {
                const s = SHAPE[a] ?? { w: 1, h: 1 };
                const k = 18 / Math.max(s.w, s.h);
                return (
                  <button key={a} type="button" role="radio" aria-checked={aspect === a} data-tip={SHAPE_TIPS[a] ?? `${a} video`} className={cx(styles.shape, aspect === a && styles.shapeOn)} onClick={() => setAspect(a)}>
                    <span className={styles.shapeBox} style={{ width: s.w * k, height: s.h * k }} aria-hidden="true" />
                    {a}
                  </button>
                );
              })}
            </div>
          </Field>
          <Field label="Frame rate">
            <SegmentedControl
              aria-label="Frame rate"
              size="sm"
              value={fps}
              options={[
                { value: "30", label: "30 fps", tip: "30 frames per second: standard, smaller files and faster exports" },
                { value: "60", label: "60 fps", tip: "60 frames per second: smoother motion, but exports take longer" },
              ]}
              onChange={setFps}
            />
          </Field>
          <Field label="Files" hint="Optional. Clips and photos are placed one after another (photos 3 s each); an audio file becomes the music.">
            <div className={styles.row}>
              <Button size="sm" icon="plus" data-tip="Choose clips, photos and music to start the video with" onClick={() => void addFiles()}>
                Add files
              </Button>
              <FromLibraryButton exts={EXTENSIONS} multiple title="Add clips, photos and music from Library" have={files} onPick={useFiles} />
              {files.length > 0 && (
                <>
                  <span className={styles.muted}>
                    {files.length} {files.length === 1 ? "file" : "files"}
                  </span>
                  <IconButton size="sm" icon="x" label="Clear the files" data-tip="Start with an empty video instead" onClick={() => setFiles([])} />
                </>
              )}
            </div>
          </Field>
        </div>
      }
    />
  );
}
