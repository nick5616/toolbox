import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as RKeyboardEvent } from "react";
import { Button, IconButton, MenuButton, Spinner, TextField, toast } from "@/components";
import {
  ComposerService,
  FilesService,
  LibraryService,
  PostsService,
  type ComposerBackground,
  type ComposerLayer,
  type Composition,
  type ProjectInfo,
} from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { revealLabel } from "@/lib/platform";
import { useHistory } from "@/composer/history";
import { applyLayout, LAYOUTS, type LayoutKind } from "@/composer/layouts";
import { loadImage, loadImages } from "@/composer/loadImages";
import {
  addLayer,
  deleteLayer,
  duplicateLayer,
  findLayer,
  layerList,
  MAX_LAYERS,
  MAX_TEXT_CHARS,
  moveLayer,
  newImageLayer,
  newTextLayer,
  reorderLayer,
  setLayerSource,
  updateLayer,
  type MoveDirection,
} from "@/composer/model";
import { imagePaths, imageSize, layerSize } from "@/composer/render";
import { useJobs } from "@/state/jobs";
import { useModules } from "@/state/modules";
import type { PostSlideSeed } from "@/state/ui";
import { BackgroundPanel } from "./BackgroundPanel";
import { CropDialog } from "./CropDialog";
import { LayersPanel } from "./LayersPanel";
import { nudge } from "./logic";
import { PropertiesPanel } from "./PropertiesPanel";
import { Stage } from "./Stage";
import { useAutosave, type SaveState } from "./useAutosave";
import styles from "./Editor.module.css";

export const IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".tif", ".tiff", ".heic", ".heif"];

export interface EditorProps {
  project: ProjectInfo;
  initialDoc: Composition;
  /** Set when opened from a post. */
  postSlide: PostSlideSeed | null;
  /** Photos to add as layers (a Library/drop handoff); each id is consumed once. */
  incoming: { id: number; paths: string[] } | null;
  /** Back to the projects list (after saving). */
  onClose: () => void;
  /** A save returned fresh project info. */
  onInfo: (info: ProjectInfo) => void;
  onBackToPost: (slide: PostSlideSeed) => void;
  /** The project was renamed from the projects strip; n makes repeats distinct. */
  renameTo?: { name: string; n: number } | null;
}

const SAVE_LABEL: Record<SaveState, string> = {
  idle: "",
  dirty: "Unsaved changes",
  saving: "Saving…",
  saved: "Saved",
  error: "Couldn't save",
};

const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p;

function toastError(title: string, e: unknown): void {
  const err = toAppError(e);
  toast({ title, description: err.hint ? `${err.message} ${err.hint}` : err.message, tone: "danger" });
}

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable;
}

interface Pending {
  jobId: string;
  /** The path the job was started on. */
  from: string;
}

/** The open composition: toolbar, stage, layers and properties. */
export function Editor({ project, initialDoc, postSlide, incoming, onClose, onInfo, onBackToPost, renameTo }: EditorProps) {
  const hist = useHistory<Composition>(initialDoc);
  const [live, setLive] = useState<Composition | null>(null);
  const committed = useRef(hist.value);
  committed.current = hist.value;
  const doc = live ?? hist.value;
  const [name, setName] = useState(project.name);
  const renameSeen = useRef(renameTo?.n ?? 0);
  useEffect(() => {
    if (renameTo && renameTo.n !== renameSeen.current) {
      renameSeen.current = renameTo.n;
      setName(renameTo.name);
    }
  }, [renameTo]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adjustBg, setAdjustBg] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [cropId, setCropId] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, Pending>>({});
  const [exporting, setExporting] = useState(false);
  const [images, setImages] = useState<ReadonlyMap<string, ImageBitmap>>(() => new Map());
  const exts = useModules((s) => s.byId["photo-composer"]?.accepts.extensions);
  const root = useRef<HTMLDivElement>(null);

  const edit = useCallback(
    (fn: (d: Composition) => Composition, opts: { merge?: boolean } = {}) => {
      const next = fn(committed.current);
      if (next === committed.current) return;
      if (!opts.merge) hist.checkpoint();
      committed.current = next;
      hist.set(next);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hist.set, hist.checkpoint],
  );

  // ---- post link ----
  const linked = useRef(!postSlide || !!postSlide.projectId);
  const linking = useRef<Promise<void>>(Promise.resolve());
  const linkToPost = useCallback(
    (projectId: string): Promise<void> => {
      if (!postSlide || linked.current) return linking.current;
      linked.current = true;
      linking.current = (async () => {
        try {
          const post = await PostsService.Get(postSlide.postId);
          const list = (await PostsService.List()) ?? [];
          const info = list.find((p) => p.id === postSlide.postId);
          if (!info) throw new Error("The post no longer exists.");
          const slides = (post.slides ?? []).map((s) => (s.id === postSlide.slideId ? { ...s, kind: "composition", projectId } : s));
          await PostsService.Save(postSlide.postId, info.name, { ...post, slides });
        } catch (e) {
          linked.current = false;
          toastError("Couldn't link this composition to the post", e);
        }
      })();
      return linking.current;
    },
    [postSlide],
  );

  const autosave = useAutosave({
    projectId: project.id,
    name,
    doc: hist.value,
    onSaved: (info, first) => {
      onInfo(info);
      if (first) void linkToPost(info.id);
    },
  });

  // ---- images ----
  const reported = useRef(new Set<string>());
  const pathsKey = useMemo(() => imagePaths(hist.value).join("\n"), [hist.value]);
  useEffect(() => {
    const need = pathsKey ? pathsKey.split("\n") : [];
    let off = false;
    void loadImages(need).then((r) => {
      if (off) return;
      setImages((prev) => {
        let same = prev.size === r.images.size;
        if (same) for (const [k, v] of r.images) if (prev.get(k) !== v) same = false;
        return same ? prev : new Map(r.images);
      });
      for (const [p, msg] of r.failed) {
        if (reported.current.has(p)) continue;
        reported.current.add(p);
        toast({ title: `Couldn't load ${baseName(p)}`, description: msg, tone: "warn" });
      }
    });
    return () => {
      off = true;
    };
  }, [pathsKey]);

  const sizerFor = useCallback((d: Composition) => (l: ComposerLayer) => layerSize(d, l, images), [images]);

  // ---- adding things ----
  const addPhotos = useCallback(
    async (paths: string[]) => {
      for (const path of paths) {
        if (layerList(committed.current).length >= MAX_LAYERS) {
          toast({ title: `At most ${MAX_LAYERS} layers`, tone: "warn" });
          return;
        }
        try {
          const bmp = await loadImage(path);
          const { w, h } = imageSize(bmp);
          const layer = newImageLayer(path, w, h, committed.current);
          edit((d) => addLayer(d, layer));
          setSelectedId(layer.id);
        } catch (e) {
          toastError(`Couldn't add ${baseName(path)}`, e);
        }
      }
    },
    [edit],
  );

  const lastIncoming = useRef(0);
  useEffect(() => {
    if (!incoming || incoming.id === lastIncoming.current) return;
    lastIncoming.current = incoming.id;
    void addPhotos(incoming.paths);
  }, [incoming, addPhotos]);

  const pickPhotos = useCallback(async () => {
    try {
      const paths = (await FilesService.PickWith("Add photos", exts && exts.length > 0 ? exts : IMAGE_EXTS, true)) ?? [];
      if (paths.length > 0) await addPhotos(paths);
    } catch (e) {
      toastError("Couldn't open the file picker", e);
    }
  }, [exts, addPhotos]);

  const addText = useCallback(() => {
    const layer = newTextLayer(committed.current);
    edit((d) => addLayer(d, layer));
    setSelectedId(layer.id);
    setEditingId(layer.id);
  }, [edit]);

  const chooseBackground = useCallback(async () => {
    try {
      const paths = (await FilesService.PickWith("Choose a background photo", exts && exts.length > 0 ? exts : IMAGE_EXTS, false)) ?? [];
      const path = paths[0];
      if (!path) return;
      edit((d) => ({
        ...d,
        background: { ...d.background, kind: "image", image: { path, original: "" }, panX: 0, panY: 0, zoom: 1 },
      }));
    } catch (e) {
      toastError("Couldn't open the file picker", e);
    }
  }, [exts, edit]);

  // ---- layer edits ----
  const patchLayer = useCallback((id: string, patch: Partial<ComposerLayer>) => edit((d) => updateLayer(d, id, patch)), [edit]);
  const deleteById = useCallback(
    (id: string) => {
      edit((d) => deleteLayer(d, id));
      setSelectedId((s) => (s === id ? null : s));
      setEditingId((s) => (s === id ? null : s));
    },
    [edit],
  );
  const duplicateById = useCallback(
    (id: string) => {
      const r = duplicateLayer(committed.current, id);
      if (!r.id) {
        toast({ title: `At most ${MAX_LAYERS} layers`, tone: "warn" });
        return;
      }
      edit(() => r.doc);
      setSelectedId(r.id);
    },
    [edit],
  );
  const setBackground = useCallback((bg: ComposerBackground) => edit((d) => ({ ...d, background: bg })), [edit]);

  const selected = selectedId ? findLayer(doc, selectedId) : undefined;

  // ---- layouts ----
  const layoutKind = useRef<LayoutKind>("scatter");
  const layoutSeed = useRef(Date.now() % 100000);
  const doLayout = useCallback(
    (kind: LayoutKind) => {
      layoutKind.current = kind;
      layoutSeed.current += 1;
      const before = committed.current;
      edit((d) => applyLayout(d, kind, layoutSeed.current, undefined, sizerFor(d)));
      if (committed.current === before) toast({ title: "Add some photos first", tone: "neutral" });
    },
    [edit, sizerFor],
  );

  // ---- remove background ----
  const removeBackground = useCallback(
    async (layer: ComposerLayer) => {
      const path = layer.image?.ref.path;
      if (!path || pending[layer.id]) return;
      try {
        const job = await ComposerService.RemoveBackground(path);
        useJobs.getState().upsert(job);
        setPending((p) => ({ ...p, [layer.id]: { jobId: job.id, from: path } }));
      } catch (e) {
        toastError("Couldn't remove the background", e);
      }
    },
    [pending],
  );

  const jobsById = useJobs((s) => s.byId);
  useEffect(() => {
    const entries = Object.entries(pending);
    if (entries.length === 0) return;
    const finished: string[] = [];
    for (const [layerId, p] of entries) {
      const job = jobsById[p.jobId];
      if (!job) continue;
      if (job.status === "done") {
        finished.push(layerId);
        const out = job.outputs[0]?.path;
        if (out) {
          edit((d) => {
            const l = findLayer(d, layerId);
            if (!l?.image) return d;
            return setLayerSource(d, layerId, out, l.image.ref.original || p.from);
          });
        } else {
          toast({ title: "Background removal produced no file", tone: "warn" });
        }
      } else if (job.status === "failed") {
        finished.push(layerId);
        toast({
          title: "Couldn't remove the background",
          description: [job.error, job.errorHint].filter(Boolean).join(" "),
          tone: "danger",
        });
      } else if (job.status === "cancelled") {
        finished.push(layerId);
      }
    }
    if (finished.length > 0) {
      setPending((cur) => {
        const next = { ...cur };
        for (const id of finished) delete next[id];
        return next;
      });
    }
  }, [jobsById, pending, edit]);

  const busyIds = useMemo(() => new Set(Object.keys(pending)), [pending]);

  const restoreOriginal = useCallback(
    (layer: ComposerLayer) => {
      const original = layer.image?.ref.original;
      if (!original) return;
      edit((d) => setLayerSource(d, layer.id, original, ""));
    },
    [edit],
  );

  // ---- export ----
  const exportAs = useCallback(
    async (format: "jpg" | "png") => {
      if (exporting) return;
      setExporting(true);
      try {
        edit((d) => (d.format === format ? d : { ...d, format }));
        await autosave.flush(true);
        const out = await ComposerService.Export(project.id);
        toast({
          title: "Exported",
          description: out.name,
          tone: "success",
          action: { label: revealLabel, onClick: () => void LibraryService.Reveal(out.id).catch((e) => toastError("Couldn't reveal the file", e)) },
        });
      } catch (e) {
        toastError("Couldn't export", e);
      } finally {
        setExporting(false);
      }
    },
    [exporting, edit, autosave, project.id],
  );

  // ---- navigation ----
  const closeEditor = useCallback(async () => {
    await autosave.flush();
    onClose();
  }, [autosave, onClose]);

  const backToPost = useCallback(async () => {
    if (!postSlide) return;
    await autosave.flush(true);
    await linkToPost(project.id);
    onBackToPost({ ...postSlide, projectId: project.id });
  }, [postSlide, autosave, linkToPost, project.id, onBackToPost]);

  // ---- keyboard ----
  const onKeyDown = (e: RKeyboardEvent<HTMLDivElement>) => {
    if (isTyping(e.target)) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === "z") {
      e.preventDefault();
      if (e.shiftKey) hist.redo();
      else hist.undo();
    } else if (mod && key === "y") {
      e.preventDefault();
      hist.redo();
    } else if (mod && key === "d" && selected) {
      e.preventDefault();
      duplicateById(selected.id);
    } else if ((e.key === "Delete" || e.key === "Backspace") && selected) {
      e.preventDefault();
      deleteById(selected.id);
    } else if (e.key === "Escape") {
      setSelectedId(null);
    } else if (e.key.startsWith("Arrow") && selected && !selected.locked) {
      const patch = nudge(committed.current, selected, e.key, e.shiftKey);
      if (patch) {
        e.preventDefault();
        edit((d) => updateLayer(d, selected.id, patch), { merge: true });
      }
    }
  };

  const cropLayer = cropId ? findLayer(doc, cropId) : undefined;
  const canRemove = selected?.kind === "image" && !busyIds.has(selected.id);
  const hasBgPhoto = doc.background.kind === "image" && !!doc.background.image?.path;

  return (
    <div ref={root} className={styles.editor} onKeyDown={onKeyDown}>
      <div className={styles.toolbar} role="toolbar" aria-label="Composer tools">
        <IconButton icon="arrow-left" label="Back to projects" onClick={() => void closeEditor()} />
        <TextField
          size="sm"
          aria-label="Project name"
          wrapperClassName={styles.name}
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
        />
        <span className={styles.sep} />
        <Button size="sm" variant="secondary" icon="image" onClick={() => void pickPhotos()}>
          Add photo
        </Button>
        <Button size="sm" variant="secondary" icon="type" onClick={addText}>
          Add text
        </Button>
        <MenuButton
          size="sm"
          label="Layouts"
          icon="grid-3x3"
          items={() => [
            ...LAYOUTS.map((l) => ({ id: l.id, label: `${l.label} - ${l.hint}`, onSelect: () => doLayout(l.id) })),
            { id: "shuffle", label: "Shuffle (same layout, new arrangement)", icon: "refresh-cw", onSelect: () => doLayout(layoutKind.current) },
          ]}
        />
        <Button
          size="sm"
          variant="secondary"
          icon="wand-sparkles"
          disabled={!canRemove}
          loading={!!selected && busyIds.has(selected.id)}
          onClick={() => selected && void removeBackground(selected)}
        >
          Remove background
        </Button>
        <span className={styles.sep} />
        <IconButton icon="undo-2" label="Undo" kbd="Ctrl+Z" disabled={!hist.canUndo} onClick={hist.undo} />
        <IconButton icon="redo-2" label="Redo" kbd="Ctrl+Shift+Z" disabled={!hist.canRedo} onClick={hist.redo} />
        <IconButton icon="maximize-2" label="Zoom to fit" onClick={() => setZoom(1)} />
        <span className={styles.grow} />
        <span className={styles.status} role="status" data-state={autosave.state}>
          {SAVE_LABEL[autosave.state]}
        </span>
        {exporting && <Spinner size={14} label="Exporting" />}
        {postSlide && (
          <Button size="sm" variant="secondary" icon="arrow-left" onClick={() => void backToPost()}>
            Back to post
          </Button>
        )}
        <MenuButton
          size="sm"
          label="Export"
          icon="download"
          items={() => [
            { id: "jpg", label: "Export as JPG", onSelect: () => void exportAs("jpg") },
            { id: "png", label: "Export as PNG", onSelect: () => void exportAs("png") },
          ]}
        />
      </div>

      <div className={styles.main}>
        <Stage
          doc={doc}
          images={images}
          selectedId={selectedId}
          onSelect={(id) => {
            setSelectedId(id);
            if (id) setAdjustBg(false);
          }}
          onLive={setLive}
          onCommit={(d, opts) => {
            setLive(null);
            edit(() => d, opts);
          }}
          editingId={editingId}
          onEditing={setEditingId}
          onTextChange={(id, text) =>
            edit((d) => {
              const l = findLayer(d, id);
              return l?.text ? updateLayer(d, id, { text: { ...l.text, text: Array.from(text).slice(0, MAX_TEXT_CHARS).join("") } }) : d;
            }, { merge: true })
          }
          adjustBg={adjustBg && hasBgPhoto && !selected}
          busyIds={busyIds}
          zoom={zoom}
          onZoom={setZoom}
        />
        <aside className={styles.side} aria-label="Layers and properties">
          <div className={styles.layers}>
            <h2 className={styles.sideTitle}>Layers</h2>
            <LayersPanel
              layers={layerList(doc)}
              selectedId={selectedId}
              busyIds={busyIds}
              onSelect={(id) => {
                setSelectedId(id);
                setAdjustBg(false);
              }}
              onPatch={patchLayer}
              onDuplicate={duplicateById}
              onDelete={deleteById}
              onReorder={(id, index) => edit((d) => reorderLayer(d, id, index))}
            />
          </div>
          <div className={styles.props}>
            {selected ? (
              <PropertiesPanel
                layer={selected}
                docWidth={doc.width}
                docHeight={doc.height}
                busy={busyIds.has(selected.id)}
                onPatch={(patch) => patchLayer(selected.id, patch)}
                onArrange={(dir: MoveDirection) => edit((d) => moveLayer(d, selected.id, dir))}
                onCrop={() => setCropId(selected.id)}
                onRemoveBackground={() => void removeBackground(selected)}
                onRestoreOriginal={() => restoreOriginal(selected)}
              />
            ) : (
              <BackgroundPanel
                background={doc.background}
                adjust={adjustBg}
                onAdjust={setAdjustBg}
                onChange={setBackground}
                onChoosePhoto={() => void chooseBackground()}
              />
            )}
          </div>
        </aside>
      </div>

      {cropLayer?.image && (
        <CropDialog
          layer={cropLayer}
          onCancel={() => setCropId(null)}
          onApply={(crop) => {
            const im = cropLayer.image;
            if (im) patchLayer(cropLayer.id, { image: { ...im, crop } });
            setCropId(null);
          }}
        />
      )}
    </div>
  );
}
