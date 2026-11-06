import { useCallback, useEffect, useState } from "react";
import { Button, ClickIn, Field, IconButton, TextField, toast } from "@/components";
import { EraserService, type EraserSavedMask } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import styles from "./SavedMasks.module.css";

export interface SavedMasksProps {
  /** True when there is something painted to save. */
  canSave: boolean;
  /** The current mask as a PNG data URL ("" when it can't be read). */
  getMaskPNG: () => string;
  /** The photo's name, offered as the mask's name. */
  suggestName?: string;
  /** Draws a saved mask onto the canvas as the starting mask (resolves false when it couldn't). */
  onLoad?: (m: EraserSavedMask) => Promise<boolean>;
  /** True when there is a photo to load a mask onto. */
  canLoad?: boolean;
}

export function summarizeMasks(n: number): string {
  return n === 0 ? "None saved" : n === 1 ? "1 saved" : `${n} saved`;
}

/**
 * Saved masks (Phase 14): paint once, save the mask under a
 * name, then a pipeline's Object Eraser step erases that same area from every
 * photo of the same shape. Lists the saved masks, with Delete.
 */
export function SavedMasks({ canSave, getMaskPNG, suggestName = "", onLoad, canLoad = true }: SavedMasksProps) {
  const [masks, setMasks] = useState<EraserSavedMask[]>([]);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [loadingId, setLoadingId] = useState("");

  const reload = useCallback(async () => {
    try {
      setMasks((await Promise.resolve().then(() => EraserService.SavedMasks())) ?? []);
    } catch {
      /* the list just stays as it was */
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const startNaming = () => {
    setName(suggestName ? `${suggestName} mask` : "");
    setNaming(true);
  };

  const save = async () => {
    const clean = name.trim();
    if (!clean || saving) return;
    const png = getMaskPNG();
    if (!png) {
      toast({ title: "Couldn't read the mask from the canvas", tone: "danger" });
      return;
    }
    setSaving(true);
    try {
      const saved = await EraserService.SaveMask(clean, png);
      setMasks((m) => [saved, ...m.filter((x) => x.id !== saved.id)]);
      setNaming(false);
      toast({ title: `Saved “${saved.name}”`, tone: "success" });
    } catch (e) {
      toast({ title: "Couldn't save the mask", description: toAppError(e).message, tone: "danger" });
    } finally {
      setSaving(false);
    }
  };

  const load = async (m: EraserSavedMask) => {
    if (!onLoad || loadingId) return;
    setLoadingId(m.id);
    try {
      await onLoad(m);
    } finally {
      setLoadingId("");
    }
  };

  const remove = async (m: EraserSavedMask) => {
    try {
      await EraserService.DeleteMask(m.id);
      setMasks((list) => list.filter((x) => x.id !== m.id));
    } catch (e) {
      toast({ title: "Couldn't delete the mask", description: toAppError(e).message, tone: "danger" });
    }
  };

  return (
    <ClickIn
      icon="workflow"
      title="Saved masks"
      summary={summarizeMasks(masks.length)}
      tip="Masks you kept: load one onto this photo as a starting point, or let a pipeline erase the same area from every photo of the same shape"
      width={340}
    >
      <div className={styles.stack}>
        {naming ? (
          <form
            className={styles.stack}
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <Field label="Mask name">
              {(c) => <TextField {...c} size="sm" autoFocus maxLength={60} value={name} placeholder="e.g. Watermark corner" onChange={(e) => setName(e.target.value)} />}
            </Field>
            <div className={styles.row}>
              <Button type="submit" size="sm" variant="primary" loading={saving} disabled={name.trim() === ""} data-tip="Keep this mask under that name">
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setNaming(false)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            disabled={!canSave}
            data-tip={canSave ? "Keep the mask you painted so you can load it onto other photos later (pipelines can use it too)" : "Paint over what to erase first"}
            onClick={startNaming}
          >
            Save mask…
          </Button>
        )}
        {masks.length === 0 ? (
          <p className={styles.hint}>No saved masks yet.</p>
        ) : (
          <ul className={styles.list} aria-label="Saved masks">
            {masks.map((m) => (
              <li key={m.id} className={styles.item}>
                <span className={styles.name} data-tip={`${m.width} × ${m.height}`}>
                  {m.name}
                </span>
                <span className={styles.size}>
                  {m.width}×{m.height}
                </span>
                {onLoad && (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={loadingId === m.id}
                    disabled={!canLoad || (loadingId !== "" && loadingId !== m.id)}
                    data-tip={canLoad ? "Draw this mask on the photo as your starting mask; you can still paint, unpaint and undo" : "Open a photo first"}
                    aria-label={`Load ${m.name}`}
                    onClick={() => void load(m)}
                  >
                    Load
                  </Button>
                )}
                <IconButton size="sm" icon="trash-2" label={`Delete ${m.name}`} data-tip="Delete this saved mask. Pipelines that use it stop working" onClick={() => void remove(m)} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </ClickIn>
  );
}
