/**
 * The start screen (SPEC §1.6): New canvas presets (16:9 first), Open image,
 * project cards with thumbnails, Recent exports, and a drop zone over the
 * whole gallery (the root is a `data-file-drop-target`; drops arrive as
 * hand-offs in PaintView).
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "@/components/toast";
import { FilesService, LibraryService, PaintService, type ProjectInfo } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { formatResultDate, RecentResults } from "../_kit";
import { PRESETS, MAX_PIXELS, MAX_SIDE, sizeProblem, type CanvasPreset } from "./limits";
import type { OpenImages } from "./useOpenImages";
import { Dialog, FieldRow, IconButton, MenuButton, PaintIcon, Segmented, Stepper, TextButton, Toggle, item, sep } from "./ui";
import { markPaper } from "./paper";
import styles from "./gallery.module.css";

const thumbCache = new Map<string, string>();

function Thumb({ info }: { info: ProjectInfo }) {
  const key = `${info.thumb}|${info.updatedAt}`;
  const [src, setSrc] = useState(() => thumbCache.get(key) ?? "");
  useEffect(() => {
    if (!info.thumb) return;
    const hit = thumbCache.get(key);
    if (hit) {
      setSrc(hit);
      return;
    }
    let off = false;
    FilesService.ImageThumb(info.thumb, 480).then(
      (url) => {
        thumbCache.set(key, url);
        if (!off) setSrc(url);
      },
      () => undefined,
    );
    return () => {
      off = true;
    };
  }, [info.thumb, key]);
  return <div className={styles.thumb}>{src ? <img src={src} alt="" draggable={false} /> : <PaintIcon name="brush" size={28} />}</div>;
}

type Bg = "paper" | "transparent" | "color";

function NewCanvasDialog({ preset, bg, color, texture, onClose, onCreated }: { preset: { w: number; h: number }; bg: Bg; color: string; texture: boolean; onClose(): void; onCreated(id: string): void }) {
  const [w, setW] = useState(preset.w);
  const [h, setH] = useState(preset.h);
  const [name, setName] = useState("Untitled");
  const [busy, setBusy] = useState(false);
  const problem = sizeProblem(w, h);
  const create = async () => {
    setBusy(true);
    try {
      const id = await PaintService.Create(name.trim() || "Untitled", w, h, bg === "transparent" ? "transparent" : bg === "color" ? color : "#ffffff");
      if (texture && bg !== "transparent") markPaper(id);
      onCreated(id);
    } catch (e) {
      toast({ title: "Couldn't make the canvas", description: toAppError(e).message, tone: "danger" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Custom canvas"
      onClose={onClose}
      actions={
        <>
          <TextButton tip="Close without making a canvas" onClick={onClose}>
            Cancel
          </TextButton>
          <TextButton primary tip="Make the canvas and start painting" disabled={!!problem || busy} reason={problem || "Creating…"} onClick={() => void create()}>
            Create
          </TextButton>
        </>
      }
    >
      <FieldRow label="Name">
        <input className={styles.field} style={{ width: 200 }} aria-label="Painting name" data-tip="Name of the painting" value={name} onChange={(e) => setName(e.target.value)} />
      </FieldRow>
      <FieldRow label="Width">
        <Stepper label="Width" value={w} min={1} max={MAX_SIDE} step={10} unit="px" onChange={setW} />
      </FieldRow>
      <FieldRow label="Height">
        <Stepper label="Height" value={h} min={1} max={MAX_SIDE} step={10} unit="px" onChange={setH} />
      </FieldRow>
      <p style={{ margin: 0, color: problem ? "var(--p-warn)" : undefined }} role={problem ? "alert" : undefined}>
        {problem || `${((w * h) / 1e6).toFixed(1)} megapixels. Limits: ${MAX_SIDE} px per side, ${MAX_PIXELS / 1e6} megapixels.`}
      </p>
    </Dialog>
  );
}

export interface GalleryProps {
  openImages: OpenImages;
  onOpen(id: string): void;
  studio: boolean;
  onToggleStudio(): void;
  compact: boolean;
}

export default function Gallery({ openImages, onOpen, studio, onToggleStudio, compact }: GalleryProps) {
  const [projects, setProjects] = useState<ProjectInfo[] | null>(null);
  const [bg, setBg] = useState<Bg>("paper");
  const [texture, setTexture] = useState(false);
  const [color, setColor] = useState("#f5f1ea");
  const [custom, setCustom] = useState(false);
  const [renaming, setRenaming] = useState<{ info: ProjectInfo; name: string } | null>(null);
  const [deleting, setDeleting] = useState<ProjectInfo | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = (await PaintService.Projects()) ?? [];
      setProjects([...list].sort((a, b) => b.updatedAt - a.updatedAt));
    } catch (e) {
      setProjects([]);
      toast({ title: "Couldn't list your paintings", description: toAppError(e).message, tone: "danger" });
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = async (p: CanvasPreset) => {
    try {
      const id = await PaintService.Create("Untitled", p.w, p.h, bg === "transparent" ? "transparent" : bg === "color" ? color : "#ffffff");
      if (texture && bg !== "transparent") markPaper(id);
      onOpen(id);
    } catch (e) {
      toast({ title: "Couldn't make the canvas", description: toAppError(e).message, tone: "danger" });
    }
  };
  const openPicked = async () => {
    const ids = await openImages.pick();
    if (ids[0]) onOpen(ids[0]);
    else if (ids.length === 0) void refresh();
  };

  const act = async (fn: () => Promise<unknown>, fail: string) => {
    try {
      await fn();
      await refresh();
    } catch (e) {
      toast({ title: fail, description: toAppError(e).message, tone: "danger" });
    }
  };

  return (
    <section className={styles.root} data-design="paint" data-compact={compact ? "true" : "false"} data-testid="paint-gallery" aria-label="Paint+ gallery" data-file-drop-target>
      <div className={styles.inner}>
        <div className={styles.top}>
          <div>
            <h2 className={styles.title}>Paint+</h2>
            {projects && projects.length === 0 ? <p className={styles.tagline}>Layers, pen pressure and brushes with character. Start a canvas or open a picture.</p> : null}
          </div>
          <span className={styles.spacer} />
          <IconButton icon={studio ? "shrink" : "expand"} label={studio ? "Leave Studio mode" : "Studio mode"} kbd="F" pressed={studio} onClick={onToggleStudio} />
        </div>

        <div>
          <h3 className={styles.h}>New canvas</h3>
          <div className={styles.presets} role="list" aria-label="Canvas sizes">
            {PRESETS.map((p, i) => (
              <div role="listitem" key={p.id} style={{ display: "contents" }}>
                <button type="button" className={`${styles.tile} ${i === 0 ? styles.tileFirst : ""}`} data-tip={`Start a ${p.w} × ${p.h} px canvas`} onClick={() => void create(p)}>
                  <span className={styles.shape} aria-hidden="true">
                    <span style={{ aspectRatio: `${p.w} / ${p.h}`, height: p.h > p.w ? "100%" : undefined, width: p.h > p.w ? undefined : "70%" }} />
                  </span>
                  <span className={styles.tileName}>
                    {p.label} {p.note ? `· ${p.note}` : ""}
                  </span>
                  <span className={styles.tileDims}>
                    {p.w} × {p.h}
                  </span>
                </button>
              </div>
            ))}
            <button type="button" className={styles.tile} data-tip={`Pick your own size (up to ${MAX_SIDE} px per side and ${MAX_PIXELS / 1e6} megapixels)`} onClick={() => setCustom(true)}>
              <span className={styles.shape} aria-hidden="true">
                <PaintIcon name="plus" size={28} />
              </span>
              <span className={styles.tileName}>Custom…</span>
              <span className={styles.tileDims}>Up to {MAX_SIDE} px</span>
            </button>
            <button type="button" className={styles.tile} data-tip="Open a picture, a Paint+ painting's OpenRaster file or a photo to paint on" onClick={() => void openPicked()}>
              <span className={styles.shape} aria-hidden="true">
                <PaintIcon name="image" size={28} />
              </span>
              <span className={styles.tileName}>Open image…</span>
              <span className={styles.tileDims}>Photo, PNG, ORA</span>
            </button>
          </div>
          <div className={styles.options}>
            <span>Background</span>
            <Segmented<Bg>
              label="Background"
              value={bg}
              options={[
                { value: "paper", label: "Paper white", tip: "A white canvas" },
                { value: "transparent", label: "Transparent", tip: "No background" },
                { value: "color", label: "Colour", tip: "A flat colour" },
              ]}
              onChange={setBg}
            />
            {bg === "color" ? <input type="color" className={styles.swatchInput} aria-label="Background colour" data-tip="Background colour" value={color} onChange={(e) => setColor(e.target.value)} /> : null}
            {bg !== "transparent" ? <Toggle label="Paper texture" tip="Bake a paper grain into a locked bottom layer" checked={texture} onChange={setTexture} /> : null}
          </div>
        </div>

        <div>
          <h3 className={styles.h}>Your paintings</h3>
          {projects === null ? <p className={styles.tagline}>Loading…</p> : null}
          {projects && projects.length > 0 ? (
            <div className={styles.grid} role="list" aria-label="Paintings">
              {projects.map((p) => (
                <div key={p.id} role="listitem" className={styles.card} data-testid={`project-${p.id}`}>
                  <button type="button" className={styles.open} aria-label={`Open ${p.name}`} data-tip={`Open ${p.name}`} onClick={() => onOpen(p.id)} />
                  <Thumb info={p} />
                  <div className={styles.cardInfo}>
                    <span className={styles.cardName}>{p.name}</span>
                    <span className={styles.cardMeta}>
                      {p.items} {p.items === 1 ? "layer" : "layers"} · {formatResultDate(p.updatedAt)}
                    </span>
                    <span className={styles.cardMenu}>
                      <MenuButton
                        icon="more"
                        label={`More for ${p.name}`}
                        title={p.name}
                        size="sm"
                        placement="below-end"
                        entries={[
                          item("rename", "Rename…", () => setRenaming({ info: p, name: p.name }), { icon: "rename" }),
                          item("dup", "Duplicate", () => void act(() => PaintService.Duplicate(p.id), "Couldn't duplicate"), { icon: "duplicate" }),
                          item("reveal", "Reveal render", () => void LibraryService.RevealPath(p.thumb.replace(/thumb\.jpg$/i, "render.png")).catch((e) => toast({ title: toAppError(e).message, tone: "danger" })), { icon: "image", disabled: !p.thumb, reason: "Nothing has been rendered yet" }),
                          sep(),
                          item("del", "Delete…", () => setDeleting(p), { icon: "trash", danger: true }),
                        ]}
                      />
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
          {projects && projects.length === 0 ? <p className={styles.tagline}>No paintings yet.</p> : null}
        </div>

        <div className={styles.kit} data-testid="recent-exports">
          <RecentResults moduleId="paint" limit={5} label="Recent exports" icon="image" tip="Pictures you exported from Paint+, newest first" />
        </div>
        <p className={styles.dropHint}>Drop pictures anywhere here to start a new canvas from each.</p>
      </div>

      {custom ? <NewCanvasDialog preset={{ w: 1920, h: 1080 }} bg={bg} color={color} texture={texture} onClose={() => setCustom(false)} onCreated={(id) => { setCustom(false); onOpen(id); }} /> : null}
      {renaming ? (
        <Dialog
          title="Rename painting"
          onClose={() => setRenaming(null)}
          actions={
            <>
              <TextButton tip="Close without renaming" onClick={() => setRenaming(null)}>
                Cancel
              </TextButton>
              <TextButton
                primary
                tip="Save the new name"
                disabled={!renaming.name.trim()}
                reason="A painting needs a name"
                onClick={() => {
                  const r = renaming;
                  setRenaming(null);
                  void act(() => PaintService.Rename(r.info.id, r.name.trim()), "Couldn't rename");
                }}
              >
                Rename
              </TextButton>
            </>
          }
        >
          <input className={styles.field} aria-label="New name" data-tip="New name" value={renaming.name} onChange={(e) => setRenaming({ ...renaming, name: e.target.value })} onKeyDown={(e) => e.key === "Enter" && renaming.name.trim() && (setRenaming(null), void act(() => PaintService.Rename(renaming.info.id, renaming.name.trim()), "Couldn't rename"))} />
        </Dialog>
      ) : null}
      {deleting ? (
        <Dialog
          title={`Delete “${deleting.name}”?`}
          onClose={() => setDeleting(null)}
          actions={
            <>
              <TextButton tip="Keep the painting" onClick={() => setDeleting(null)}>
                Keep
              </TextButton>
              <TextButton
                primary
                danger
                tip="Delete the painting and its layers; files you exported stay in your library"
                onClick={() => {
                  const d = deleting;
                  setDeleting(null);
                  void act(() => PaintService.Delete(d.id), "Couldn't delete");
                }}
              >
                Delete
              </TextButton>
            </>
          }
        >
          <p style={{ margin: 0 }}>The painting and all its layers are removed. Pictures you exported stay in your library, and the original photo it was made from is never touched.</p>
        </Dialog>
      ) : null}
    </section>
  );
}
