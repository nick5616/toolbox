import { useCallback, useEffect, useRef, useState } from "react";
import { FromLibraryButton } from "@/blocks/library-picker";
import { Button, ClickInHost, ConfirmDialog, EmptyState, Field, Select, TextField, toast } from "@/components";
import { ComposerService, FilesService, SettingsService, type ComposerAspect, type Composition, type ProjectInfo } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { ASPECTS, sanitizeComposition } from "@/composer/model";
import { closeWindow, currentWindow } from "@/lib/windows";
import { useModules } from "@/state/modules";
import { useToolHandoff } from "@/lib/embed";
import { useUI, type PostSlideSeed } from "@/state/ui";
import type { ToolViewProps } from "../index";
import { Editor } from "./Editor";
import { Modal } from "./Modal";
import { ProjectsStrip } from "./ProjectsStrip";
import { IMAGE_EXTS, MODULE_ID, useComposer } from "./store";
import { discardedProjects } from "./useAutosave";
import { composerWorkspace as ws } from "./workspace";
import styles from "./PhotoComposerView.module.css";

const DEFAULT_NAME = "Untitled composition";

interface Open {
  info: ProjectInfo;
  doc: Composition;
  postSlide: PostSlideSeed | null;
}

function toastError(title: string, e: unknown): void {
  const err = toAppError(e);
  toast({ title, description: err.hint ? `${err.message} ${err.hint}` : err.message, tone: "danger" });
}

const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p;

interface NewDialogProps {
  aspects: readonly ComposerAspect[];
  initialAspect: string;
  exts: readonly string[];
  onCreate: (name: string, aspect: string, background: string) => void;
  onCancel: () => void;
}

function NewDialog({ aspects, initialAspect, exts, onCreate, onCancel }: NewDialogProps) {
  const [name, setName] = useState(DEFAULT_NAME);
  const [aspect, setAspect] = useState(initialAspect);
  const [bg, setBg] = useState("");
  const pickLib = (paths: string[]) => {
    if (paths[0]) setBg(paths[0]);
  };
  const pick = async () => {
    try {
      const paths = (await FilesService.PickWith("Choose a background photo", [...exts], false)) ?? [];
      pickLib(paths);
    } catch (e) {
      toastError("Couldn't open the file picker", e);
    }
  };
  return (
    <Modal title="New composition" confirmLabel="Create" confirmDisabled={!name.trim()} onConfirm={() => onCreate(name.trim(), aspect, bg)} onCancel={onCancel}>
      <Field label="Name">{(c) => <TextField {...c} data-tip="What to call this composition (up to 120 characters)" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />}</Field>
      <Field label="Shape">
        {(c) => (
          <Select
            {...c}
            data-tip="Canvas shape and size in pixels, for example 4:5 portrait or a 9:16 story"
            value={aspect}
            options={aspects.map((a) => ({ value: a.id, label: `${a.label} (${a.width}×${a.height})` }))}
            onChange={setAspect}
          />
        )}
      </Field>
      <Field label="Background photo" hint="Optional. You can change it later.">
        {() => (
          <div className={styles.bgPick}>
            <Button size="sm" variant="secondary" icon="image" data-tip="Pick a photo to fill the canvas background" onClick={() => void pick()}>
              {bg ? "Replace…" : "Choose photo…"}
            </Button>
            <FromLibraryButton title="Choose a background photo from Library" exts={exts} multiple={false} have={bg ? [bg] : undefined} onPick={pickLib} />
            {bg && <span className={styles.bgName} data-tip={bg}>{baseName(bg)}</span>}
            {bg && (
              <Button size="sm" variant="ghost" data-tip="Use a plain colour background instead" onClick={() => setBg("")}>
                Clear
              </Button>
            )}
          </div>
        )}
      </Field>
    </Modal>
  );
}

/** Photo Composer: a strip of compositions and the editor for the open one. */
export default function PhotoComposerView({ moduleId }: ToolViewProps) {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState<Open | null>(null);
  const [incoming, setIncoming] = useState<{ id: number; paths: string[] } | null>(null);
  const [renameTo, setRenameTo] = useState<{ name: string; n: number } | null>(null);
  const [aspects, setAspects] = useState<readonly ComposerAspect[]>(ASPECTS);
  const [newOpen, setNewOpen] = useState<{ aspect: string } | null>(null);
  const [renaming, setRenaming] = useState<{ info: ProjectInfo; name: string } | null>(null);
  const [deleting, setDeleting] = useState<ProjectInfo | null>(null);
  const exts = useModules((s) => s.byId[MODULE_ID]?.accepts.extensions);
  const imageExts = exts && exts.length > 0 ? exts : IMAGE_EXTS;
  const counter = useRef(0);
  const took = useRef(false);

  // While a composition is open this window hosts its store for popped-out panels and the preview.
  ws.useHost();
  const closeOpen = useCallback(() => {
    useComposer.getState().close();
    setOpen(null);
  }, []);
  useEffect(() => () => useComposer.getState().close(), []);

  const refresh = useCallback(async (): Promise<ProjectInfo[]> => {
    try {
      const list = (await ComposerService.List()) ?? [];
      setProjects(list);
      return list;
    } catch (e) {
      toastError("Couldn't load your compositions", e);
      return [];
    }
  }, []);

  const remember = useCallback((id: string) => {
    SettingsService.SetModuleState(MODULE_ID, JSON.stringify({ lastProjectId: id })).catch(() => undefined);
  }, []);

  const queuePhotos = useCallback((paths: string[]) => {
    if (paths.length > 0) setIncoming({ id: ++counter.current, paths });
  }, []);

  const openProject = useCallback(
    async (id: string, postSlide: PostSlideSeed | null = null, photos: string[] = []): Promise<boolean> => {
      try {
        const raw = await ComposerService.Get(id);
        const list = await refresh();
        const info = list.find((p) => p.id === id);
        if (!info) throw new Error("This composition no longer exists.");
        const doc = sanitizeComposition(raw);
        useComposer.getState().open({ id, name: info.name, doc, postSlide });
        setOpen({ info, doc, postSlide });
        queuePhotos(photos);
        remember(id);
        return true;
      } catch (e) {
        toastError("Couldn't open the composition", e);
        return false;
      }
    },
    [refresh, queuePhotos, remember],
  );

  const createProject = useCallback(
    async (name: string, aspect: string, background: string, postSlide: PostSlideSeed | null = null, photos: string[] = []) => {
      try {
        const info = await ComposerService.Create(name, aspect, background);
        await openProject(info.id, postSlide, photos);
      } catch (e) {
        toastError("Couldn't create the composition", e);
      }
    },
    [openProject],
  );

  // Handoffs: photos from the Library / a drop, or a post slide to make or edit.
  useToolHandoff(moduleId, (h) => {
    took.current = true;
    const slide = h.postSlide;
    if (slide) {
      void (async () => {
        // A build only makes new compositions; an existing one opens as it is.
        if (slide.projectId && (await openProject(slide.projectId, { ...slide, build: undefined }, slide.build ? [] : h.inputs))) return;
        const bg = slide.build?.kind === "collage" ? slide.build.background : "";
        await createProject(DEFAULT_NAME, slide.aspect || "4:5", bg, { ...slide, projectId: "" }, h.inputs);
      })();
    } else if (h.inputs.length > 0) {
      if (open) queuePhotos(h.inputs);
      else void createProject(DEFAULT_NAME, "4:5", "", null, h.inputs);
    }
  });

  // First load: the list, the aspects, and the project that was open last time.
  useEffect(() => {
    let off = false;
    void (async () => {
      const list = await refresh();
      ComposerService.Aspects()
        .then((a) => !off && a && a.length > 0 && setAspects(a))
        .catch(() => undefined);
      let last = "";
      try {
        const raw = await SettingsService.ModuleState(MODULE_ID);
        if (raw) last = (JSON.parse(raw) as { lastProjectId?: string }).lastProjectId ?? "";
      } catch {
        // No saved state.
      }
      if (off) return;
      setLoaded(true);
      if (!took.current && last && list.some((p) => p.id === last)) await openProject(last);
    })();
    return () => {
      off = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onInfo = useCallback((info: ProjectInfo) => {
    setProjects((cur) => (cur.some((p) => p.id === info.id) ? cur.map((p) => (p.id === info.id ? info : p)) : [info, ...cur]));
  }, []);

  const duplicate = async (info: ProjectInfo) => {
    try {
      await ComposerService.Duplicate(info.id);
      await refresh();
      toast({ title: "Duplicated", description: info.name, tone: "success" });
    } catch (e) {
      toastError("Couldn't duplicate", e);
    }
  };

  const rename = async () => {
    if (!renaming) return;
    const { info, name } = renaming;
    setRenaming(null);
    const next = name.trim();
    if (!next || next === info.name) return;
    try {
      if (open?.info.id === info.id) {
        setRenameTo({ name: next, n: Date.now() });
        setProjects((cur) => cur.map((p) => (p.id === info.id ? { ...p, name: next } : p)));
      } else {
        const doc = await ComposerService.Get(info.id);
        await ComposerService.Save(info.id, next, doc);
        await refresh();
      }
    } catch (e) {
      toastError("Couldn't rename", e);
    }
  };

  const remove = async () => {
    const info = deleting;
    if (!info) return;
    setDeleting(null);
    discardedProjects.add(info.id);
    if (open?.info.id === info.id) closeOpen();
    try {
      await ComposerService.Delete(info.id);
      await refresh();
    } catch (e) {
      discardedProjects.delete(info.id);
      toastError("Couldn't delete", e);
    }
  };

  const backToPost = useCallback((slide: PostSlideSeed) => {
    // In its own window there is no Post Builder here: closing returns to the post, which refreshes itself.
    const w = currentWindow();
    if (w.kind !== "main") {
      void closeWindow(w.key).catch(() => undefined);
      return;
    }
    closeOpen();
    useUI.getState().handOff({ moduleId: "post-builder", inputs: [], postSlide: slide });
  }, []);

  const startNew = () => setNewOpen({ aspect: open?.doc.aspect ?? "4:5" });

  return (
    <ClickInHost className={styles.view}>
      {projects.length > 0 && !open && (
        <ProjectsStrip
          projects={projects}
          openId={null}
          onOpen={(id) => void openProject(id)}
          onNew={startNew}
          onDuplicate={(i) => void duplicate(i)}
          onRename={(info) => setRenaming({ info, name: info.name })}
          onDelete={setDeleting}
        />
      )}
      {open ? (
        <Editor
          key={open.info.id}
          project={open.info}
          initialDoc={open.doc}
          postSlide={open.postSlide}
          incoming={incoming}
          renameTo={renameTo}
          onClose={() => {
            closeOpen();
            void refresh();
          }}
          onInfo={onInfo}
          onBackToPost={backToPost}
        />
      ) : loaded ? (
        <div className={styles.empty}>
          <EmptyState
            icon="layers"
            title={projects.length === 0 ? "Make your first composition" : "Open a composition"}
            body="Arrange photos and text on a canvas shaped for Instagram, cut out subjects, and export a finished picture."
            action={
              <Button variant="primary" icon="plus" data-tip="Start a new composition: pick a name, shape and optional background photo" onClick={startNew}>
                New composition
              </Button>
            }
          />
        </div>
      ) : null}

      {newOpen && (
        <NewDialog
          aspects={aspects}
          initialAspect={newOpen.aspect}
          exts={imageExts}
          onCancel={() => setNewOpen(null)}
          onCreate={(name, aspect, bg) => {
            setNewOpen(null);
            void createProject(name, aspect, bg);
          }}
        />
      )}
      {renaming && (
        <Modal title="Rename composition" confirmLabel="Rename" confirmDisabled={!renaming.name.trim()} onConfirm={() => void rename()} onCancel={() => setRenaming(null)}>
          <Field label="Name">
            {(c) => (
              <TextField
                {...c}
                autoFocus
                data-tip="New name for this composition"
                value={renaming.name}
                maxLength={120}
                onChange={(e) => setRenaming({ ...renaming, name: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void rename();
                }}
              />
            )}
          </Field>
        </Modal>
      )}
      <ConfirmDialog
        open={!!deleting}
        title="Delete this composition?"
        body={deleting ? `"${deleting.name}" and its saved picture will be deleted. Your original photos are not touched.` : undefined}
        confirmLabel="Delete"
        tone="danger"
        onConfirm={() => void remove()}
        onCancel={() => setDeleting(null)}
      />
    </ClickInHost>
  );
}
