import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as RKeyboardEvent } from "react";
import { Button, IconButton, MenuButton, Spinner, TextField, toast, useClickIn } from "@/components";
import { ComposerService, PostsService, type ComposerLayer, type Composition, type ProjectInfo } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { useBeforePopOut } from "@/lib/popout";
import { applyLayout } from "@/composer/layouts";
import { loadImage } from "@/composer/loadImages";
import { addLayer, findLayer, layerList, MAX_LAYERS, newImageLayer, setLayerSource } from "@/composer/model";
import { imageSize, layerSize } from "@/composer/render";
import { useCompositionInputs } from "@/state/composition";
import { useShallow } from "zustand/react/shallow";
import { useJobs, type JobView } from "@/state/jobs";
import type { PostSlideSeed } from "@/state/ui";
import { LastExport } from "@/editor/export/LastExport";
import { StudioLayout, Spacer, WorkspacePreviewFrame, WorkspaceRail } from "@/workspace";
import { ComposerStage } from "./canvas";
import { CropDialog } from "./CropDialog";
import { composerImages, imageFailed, useComposerImages, useLoadComposerImages } from "./images";
import { backgroundSummary, layersSummary, nudge, slotsLine } from "./logic";
import { SelectionBar } from "./SelectionBar";
import { MODULE_ID, resetFailureToasts, toastError, toastFailureOnce, useComposer, useDoc, useSelectedLayers, type Pending } from "./store";
import { useAutosave, type SaveState } from "./useAutosave";
import { composerWorkspace as ws } from "./workspace";
import styles from "./Editor.module.css";

export { IMAGE_EXTS } from "./store";

export interface EditorProps {
  project: ProjectInfo;
  /** The document the store was opened with (the autosave's baseline). */
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

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable;
}

const sameLabels = (a: Record<string, string>, b: Record<string, string>): boolean => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};

/**
 * Remove background: jobs finishing, and the busy labels. A component of its own so only it
 * re-renders on job progress (it selects just this project's pending jobs), not the whole editor.
 */
function PendingJobs() {
  const st = useComposer.getState;
  const pending = useComposer((s) => s.pending);
  const jobList = useJobs(useShallow((s) => Object.values(pending).map((p) => s.byId[p.jobId])));
  const jobsById = useMemo(() => {
    const m: Record<string, JobView> = {};
    for (const j of jobList) if (j) m[j.id] = j;
    return m;
  }, [jobList]);

  useEffect(() => {
    const entries = Object.entries(pending);
    if (entries.length === 0) {
      resetFailureToasts();
      return;
    }
    const finished: string[] = [];
    for (const [layerId, p] of entries) {
      const job = jobsById[p.jobId];
      if (!job) continue;
      if (job.status === "done") {
        finished.push(layerId);
        const out = job.outputs[0]?.path;
        if (out) {
          st().edit((d) => {
            const l = findLayer(d, layerId);
            if (!l?.image) return d;
            return setLayerSource(d, layerId, out, l.image.ref.original || p.from);
          });
        } else {
          toast({ title: "Background removal produced no file", tone: "warn" });
        }
      } else if (job.status === "failed") {
        finished.push(layerId);
        toastFailureOnce("Couldn't remove the background", [job.error, job.errorHint].filter(Boolean).join(" "));
      } else if (job.status === "cancelled") {
        finished.push(layerId);
      }
    }
    if (finished.length > 0) {
      const next: Record<string, Pending> = { ...st().pending };
      for (const id of finished) delete next[id];
      st().setPending(next);
    }
  }, [jobsById, pending, st]);

  useEffect(() => {
    const out: Record<string, string> = {};
    for (const [layerId, p] of Object.entries(pending)) {
      const job = jobsById[p.jobId];
      if (!job) continue;
      out[layerId] = job.status === "queued" ? "queued" : job.progress > 0 && job.progress <= 1 ? `${Math.round(job.progress * 100)}%` : "";
    }
    if (!sameLabels(out, st().busyLabels)) st().setBusyLabels(out);
  }, [pending, jobsById, st]);

  return null;
}

/**
 * The open composition: header, rail, canvas and the selection bar. This
 * component is the host's logic (autosave, jobs, the collage build, keys); the
 * state is in `useComposer` and the panels/preview are the workspace's.
 */
export function Editor({ project, initialDoc, postSlide, incoming, onClose, onInfo, onBackToPost, renameTo }: EditorProps) {
  const st = useComposer.getState;
  const recorded = useComposer((s) => s.history?.present ?? null);
  const doc = useDoc();
  const name = useComposer((s) => s.name);
  const saveState = useComposer((s) => s.saveState);
  const exporting = useComposer((s) => s.exporting);
  const undoable = useComposer((s) => (s.history?.past.length ?? 0) > 0);
  const redoable = useComposer((s) => (s.history?.future.length ?? 0) > 0);
  const pending = useComposer((s) => s.pending);
  const phase = useComposer((s) => s.phase);
  const cropId = useComposer((s) => s.cropId);
  const selected = useSelectedLayers();
  const images = useComposerImages((s) => s.images);
  const clickIn = useClickIn();

  const renameSeen = useRef(renameTo?.n ?? 0);
  useEffect(() => {
    if (renameTo && renameTo.n !== renameSeen.current) {
      renameSeen.current = renameTo.n;
      st().setName(renameTo.name);
    }
  }, [renameTo, st]);

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
    doc: recorded ?? initialDoc,
    onSaved: (info, first) => {
      onInfo(info);
      if (first) void linkToPost(info.id);
    },
  });
  useEffect(() => {
    st().setSaveState(autosave.state);
  }, [autosave.state, st]);
  useBeforePopOut(MODULE_ID, () => autosave.flush());

  // ---- images (this window's own bitmaps) ----
  useLoadComposerImages(recorded, true);

  // ---- what the constituents get ----
  const photoPath = selected.length === 1 && selected[0]?.kind === "image" ? (selected[0].image?.ref.path ?? "") : "";
  const photoInputs = useMemo(() => (photoPath ? [photoPath] : []), [photoPath]);
  useCompositionInputs(MODULE_ID, { "bg-remover": photoInputs, "object-eraser": photoInputs, upscaler: photoInputs });

  // ---- collage build (SPEC.md §B13.5) ----
  const build = postSlide?.build?.kind === "collage" ? postSlide.build : null;
  const buildIds = useRef<string[]>([]);
  const buildStarted = useRef(false);
  const buildSeed = useRef(Date.now() % 100000);

  const lastIncoming = useRef(0);
  useEffect(() => {
    if (!incoming || incoming.id === lastIncoming.current) return;
    lastIncoming.current = incoming.id;
    if (build && !buildStarted.current) {
      buildStarted.current = true;
      void startBuild(build, incoming.paths);
    } else {
      void st().addPhotos(incoming.paths);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming]);

  /** Background and layers go in at once; the layout and cut-outs follow as the phases advance. */
  async function startBuild(b: NonNullable<typeof build>, paths: string[]) {
    st().setPhase("adding");
    st().edit(
      (d) => ({
        ...d,
        background: b.background
          ? { ...d.background, kind: "image", image: { path: b.background, original: "" }, panX: 0, panY: 0, zoom: 1 }
          : { ...d.background, kind: "color", color: b.color || d.background.color, image: null },
      }),
      { internal: true },
    );
    const layers: ComposerLayer[] = [];
    // Photos decode in parallel (in the original order, in rounds of at most the free slots, so a
    // failed photo is replaced by the next one exactly as before); layers are added in that order.
    const candidates = paths.filter((path) => path !== b.background);
    for (let next = 0; next < candidates.length && layers.length < MAX_LAYERS; ) {
      const round = candidates.slice(next, next + (MAX_LAYERS - layers.length));
      next += round.length;
      const loaded = await Promise.allSettled(round.map((path) => loadImage(path)));
      const cur = st().history?.present;
      if (!cur) return;
      loaded.forEach((r, i) => {
        const path = round[i] as string;
        if (r.status === "fulfilled") {
          const { w, h } = imageSize(r.value);
          layers.push(newImageLayer(path, w, h, cur));
        } else {
          toastFailureOnce(`Couldn't add ${baseName(path)}`, toAppError(r.reason).message, "warn");
        }
      });
    }
    st().edit((d) => layers.reduce(addLayer, d), { internal: true });
    buildIds.current = layers.map((l) => l.id);
    st().setLayoutKind(b.layout);
    st().setPhase("layout1");
  }

  const buildLayout = useCallback(() => {
    if (!build || st().touched) return;
    st().edit((d) => applyLayout(d, build.layout, buildSeed.current, buildIds.current, (l) => layerSize(d, l, composerImages())), { internal: true });
  }, [build, st]);

  // The images behind the build's layers (or their failure) are known.
  const imagesReady = useMemo(
    () =>
      buildIds.current.every((id) => {
        const p = recorded ? findLayer(recorded, id)?.image?.ref.path : undefined;
        return !p || images.has(p) || imageFailed(p);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [recorded, images],
  );

  useEffect(() => {
    if (!build) return;
    if (phase === "layout1" && imagesReady) {
      buildLayout();
      if (build.cutouts && buildIds.current.length > 0) {
        st().setPhase("submitting");
        void st()
          .removeBackgrounds(buildIds.current)
          .then(() => st().setPhase("cutting"));
      } else {
        st().setPhase("done");
      }
    } else if (phase === "cutting" && Object.keys(pending).length === 0) {
      st().setPhase("layout2");
    } else if (phase === "layout2" && imagesReady) {
      buildLayout();
      st().setPhase("done");
    }
  }, [build, phase, imagesReady, pending, buildLayout, st]);

  // ---- export ----
  const [lastExport, setLastExport] = useState<{ id: string; path: string; missing: boolean } | null>(null);
  const exportAs = useCallback(
    async (format: "jpg" | "png") => {
      if (st().exporting) return;
      st().setExporting(true);
      try {
        const changed = st().history?.present.format !== format;
        st().setCanvas({ format });
        // The autosave reads the document the view last rendered.
        if (changed) await new Promise((r) => setTimeout(r, 0));
        await autosave.flush(true);
        const out = await ComposerService.Export(project.id);
        setLastExport({ id: out.id, path: out.path, missing: out.missing });
      } catch (e) {
        toastError("Couldn't export", e);
      } finally {
        st().setExporting(false);
      }
    },
    [st, autosave, project.id],
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
    const s = st();
    const one = s.multi.length > 1 ? undefined : s.selectedId && s.history ? findLayer(s.history.present, s.selectedId) : undefined;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === "z") {
      e.preventDefault();
      if (e.shiftKey) s.redo();
      else s.undo();
    } else if (mod && key === "y") {
      e.preventDefault();
      s.redo();
    } else if (mod && key === "d" && one) {
      e.preventDefault();
      s.duplicateLayer(one.id);
    } else if ((e.key === "Delete" || e.key === "Backspace") && one) {
      e.preventDefault();
      s.deleteLayers([one.id]);
    } else if ((e.key === "Delete" || e.key === "Backspace") && s.multi.length > 1) {
      e.preventDefault();
      s.deleteLayers([...s.multi]);
    } else if (e.key === "Escape") {
      if (clickIn.openId) return;
      s.select(null);
    } else if (e.key.startsWith("Arrow") && one && !one.locked && s.history) {
      const patch = nudge(s.history.present, one, e.key, e.shiftKey);
      if (patch) {
        e.preventDefault();
        s.patchLayer(one.id, patch, `nudge:${one.id}`);
      }
    }
  };

  if (!doc) return null;

  const cropLayer = cropId ? findLayer(doc, cropId) : undefined;
  const single = selected.length === 1 ? selected[0] : undefined;
  const layerCount = layerList(doc).length;

  const summaries = {
    sources: "Photos in this post",
    layers: layersSummary(layerCount),
    layouts: "Arrange the photos",
    background: backgroundSummary(doc.background),
    canvas: `${doc.aspect} · ${doc.width}×${doc.height}`,
  };

  const header = (
    <div className={styles.headerBar} role="toolbar" aria-label="Composer tools">
      <Button size="sm" variant="ghost" icon="chevron-left" data-tip="Save and go back to your list of compositions" onClick={() => void closeEditor()}>
        Projects
      </Button>
      <TextField
        size="sm"
        aria-label="Project name"
        data-tip="Name of this composition (shown in the list and used for the exported file)"
        wrapperClassName={styles.name}
        value={name}
        maxLength={120}
        onChange={(e) => st().setName(e.target.value)}
      />
      <span className={styles.status} role="status" data-state={saveState} data-tip="Changes are saved automatically as you work">
        {SAVE_LABEL[saveState]}
      </span>
      <Spacer />
      {exporting && <Spinner size={14} label="Exporting" />}
      {postSlide && (
        <Button size="sm" variant="secondary" icon="arrow-left" collapsible data-tip="Save and return to the post this composition belongs to" onClick={() => void backToPost()}>
          Back to post
        </Button>
      )}
      <IconButton icon="undo-2" label="Undo" data-tip="Undo the last change" kbd="Ctrl+Z" disabled={!undoable} onClick={() => st().undo()} />
      <IconButton icon="redo-2" label="Redo" data-tip="Redo the change you just undid" kbd="Ctrl+Shift+Z" disabled={!redoable} onClick={() => st().redo()} />
      <MenuButton
        size="sm"
        variant="ghost"
        label="More actions"
        icon="ellipsis"
        data-tip="Add photos or text, zoom, duplicate"
        items={() => [
          { id: "photo", label: "Add photo", icon: "image", tip: "Add photos from your computer as new layers", onSelect: () => void st().pickPhotos() },
          { id: "photo-lib", label: "Add photo from Library", icon: "history", tip: "Add photos Toolbox already made, or saved compositions, as new layers", onSelect: () => void st().pickPhotosFromLibrary() },
          { id: "text", label: "Add text", icon: "type", tip: "Add a text layer you can type into, style and move", onSelect: () => st().addText() },
          { id: "fit", label: "Zoom to fit", icon: "maximize-2", tip: "Reset the canvas zoom so the whole picture fits", onSelect: () => st().setZoom(1) },
          { id: "slots", label: slotsLine(layerList(doc)), icon: "layers", tip: "How many photos a pipeline's Fill a template step puts into this composition. Mark photo layers as Template slot in the Layer panel", disabled: true, onSelect: () => undefined },
          { id: "duplicate", label: "Duplicate layer", icon: "copy", tip: "Copy the selected layer", disabled: !single, onSelect: () => single && st().duplicateLayer(single.id) },
        ]}
      />
      <MenuButton
        size="sm"
        label="Export"
        icon="download"
        collapsible
        data-tip="Render the finished picture into your library"
        items={() => [
          { id: "jpg", label: "Export as JPG", tip: "Smaller file, best for photos and Instagram", onSelect: () => void exportAs("jpg") },
          { id: "png", label: "Export as PNG", tip: "Lossless file, keeps transparency; larger", onSelect: () => void exportAs("png") },
        ]}
      />
    </div>
  );

  return (
    <div className={styles.editor} onKeyDown={onKeyDown}>
      <PendingJobs />
      <StudioLayout
        header={header}
        rail={<WorkspaceRail ws={ws} panels={postSlide ? ["sources", "layers", "layouts", "background", "canvas"] : ["layers", "layouts", "background", "canvas"]} summaries={summaries} />}
        stage={
          <WorkspacePreviewFrame ws={ws}>
            <ComposerStage />
          </WorkspacePreviewFrame>
        }
        bottom={
          <>
            {lastExport && (
              <LastExport
                path={lastExport.path}
                outputId={lastExport.id}
                missing={lastExport.missing}
                moduleId={MODULE_ID}
                onDismiss={() => setLastExport(null)}
              />
            )}
            <SelectionBar />
          </>
        }
      />
      {cropLayer?.image && (
        <CropDialog
          layer={cropLayer}
          onCancel={() => st().setCropId(null)}
          onApply={(crop) => {
            const im = cropLayer.image;
            if (im) st().patchLayer(cropLayer.id, { image: { ...im, crop } });
            st().setCropId(null);
          }}
        />
      )}
    </div>
  );
}
