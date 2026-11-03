/** The New edit dialog (Phase 9 SPEC §14.1): name, song, shape and frame rate. */
import { useEffect, useState } from "react";
import { Button, ConfirmDialog, Field, IconButton, SegmentedControl, TextField, cx, toast } from "@/components";
import { FilesService } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { ASPECTS } from "@/viz/edit/types";
import { SONG_EXTENSIONS } from "../transport/logic";
import { baseName, createEdit } from "./createEdit";
import styles from "./Home.module.css";

export interface NewEditDialogProps {
  open: boolean;
  /** Prefilled song (a drop or handoff). */
  song?: string;
  /** Clips and photos queued as the edit's Sources. */
  sources?: string[];
  /** Called with the new edit's ID once it is created and saved. */
  onCreated(id: string): void;
  onCancel(): void;
}

const SHAPE: Record<string, { w: number; h: number }> = { "9:16": { w: 9, h: 16 }, "4:5": { w: 4, h: 5 }, "1:1": { w: 1, h: 1 }, "16:9": { w: 16, h: 9 } };

export function NewEditDialog({ open, song: songIn = "", sources: sourcesIn = [], onCreated, onCancel }: NewEditDialogProps) {
  const [name, setName] = useState("");
  const [named, setNamed] = useState(false);
  const [song, setSong] = useState(songIn);
  const [sources, setSources] = useState<string[]>(sourcesIn);
  const [aspect, setAspect] = useState<string>("9:16");
  const [fps, setFps] = useState("30");
  const [busy, setBusy] = useState(false);

  // Each time it opens, start from what was handed in.
  useEffect(() => {
    if (!open) return;
    setSong(songIn);
    setSources(sourcesIn);
    setName(songIn ? baseName(songIn) : "");
    setNamed(false);
    setAspect("9:16");
    setFps("30");
    setBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset on open only
  }, [open]);

  const pickSong = async () => {
    try {
      const picked = (await FilesService.PickWith("Pick a song", SONG_EXTENSIONS, false)) ?? [];
      const p = picked[0];
      if (!p) return;
      setSong(p);
      if (!named) setName(baseName(p));
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    }
  };

  const create = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const id = await createEdit({ name, aspect, fps: Number(fps), song, sources });
      onCreated(id);
    } catch (e) {
      toast({ title: "Couldn't create the edit", description: toAppError(e).message, tone: "danger" });
      setBusy(false);
    }
  };

  return (
    <ConfirmDialog
      open={open}
      title="New edit"
      confirmLabel={busy ? "Creating…" : "Create"}
      onConfirm={() => void create()}
      onCancel={onCancel}
      body={
        <div className={styles.form}>
          <Field label="Name">
            {(c) => (
              <TextField
                {...c}
                value={name}
                placeholder={song ? baseName(song) : "Untitled edit"}
                maxLength={80}
                onChange={(e) => {
                  setName(e.target.value);
                  setNamed(true);
                }}
              />
            )}
          </Field>
          <Field label="Song" hint="Audio or a video's sound. Up to 10 minutes are used.">
            <div className={styles.row}>
              <Button size="sm" icon="music" onClick={() => void pickSong()}>
                {song ? "Change song" : "Pick a song"}
              </Button>
              {song && (
                <>
                  <span className={styles.muted} title={song}>
                    {song.split(/[\\/]/).pop()}
                  </span>
                  <IconButton size="sm" icon="x" label="Remove the song" onClick={() => setSong("")} />
                </>
              )}
            </div>
          </Field>
          <Field label="Shape">
            <div className={styles.shapes} role="radiogroup" aria-label="Shape">
              {ASPECTS.map((a) => {
                const s = SHAPE[a] ?? { w: 1, h: 1 };
                const k = 18 / Math.max(s.w, s.h);
                return (
                  <button key={a} type="button" role="radio" aria-checked={aspect === a} className={cx(styles.shape, aspect === a && styles.shapeOn)} onClick={() => setAspect(a)}>
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
                { value: "30", label: "30 fps" },
                { value: "60", label: "60 fps" },
              ]}
              onChange={setFps}
            />
          </Field>
          {sources.length > 0 && (
            <div className={styles.row}>
              <span className={styles.muted}>
                {sources.length} {sources.length === 1 ? "clip or photo" : "clips and photos"} will be added to Sources.
              </span>
              <IconButton size="sm" icon="x" label="Don't add them" onClick={() => setSources([])} />
            </div>
          )}
        </div>
      }
    />
  );
}
