import { useEffect, useMemo, useState } from "react";
import { Button, IconButton, Select, Spinner, TextField, Tooltip, toast } from "@/components";
import { FilesService, PostsService, type PostSlide, type PostSourceFile } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import type { SlideBuild } from "@/state/ui";
import { CollageDialog, StitchDialog } from "./buildDialogs";
import { LibraryPickerDialog, poolKey } from "./LibraryPickerDialog";
import { usePostBuilder } from "./postStore";
import type { PostDoc } from "./logic";
import {
  DEFAULT_SOURCE_VIEW,
  addExtras,
  fileName,
  folderBaseName,
  hideFromPool,
  poolSignature,
  slideNumberMap,
  slideSourcePaths,
  viewSources,
  type SourceFilter,
  type SourceSort,
  type SourceView,
} from "./pool";
import { SourceGrid } from "@/blocks/sources/SourceGrid";
import styles from "./SourcesPanel.module.css";

export const MEDIA_EXTS = [".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff", ".heic", ".heif", ".mp4", ".mov", ".mkv", ".webm", ".m4v"];

const SORTS: { value: SourceSort; label: string }[] = [
  { value: "taken", label: "Date taken" },
  { value: "name", label: "Name" },
];
const FILTERS: { value: SourceFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "photos", label: "Photos" },
  { value: "clips", label: "Clips" },
  { value: "unused", label: "Unused" },
];

export interface SourcesPanelProps {
  postId: string;
  doc: PostDoc;
  format: string;
  /** The post is saved: the pool is listed from the stored document. */
  saved: boolean;
  selectedSlide: PostSlide | undefined;
  update: (fn: (d: PostDoc) => PostDoc) => void;
  /** One slide per path. */
  onAddSlides: (paths: string[]) => void;
  /** Make a composition / video slide from these paths, then open its editor. */
  onBuild: (inputs: string[], build: SlideBuild) => void;
}

export function SourcesPanel({ postId, doc, format, saved, selectedSlide, update, onAddSlides, onBuild }: SourcesPanelProps) {
  const [sources, setSources] = useState<PostSourceFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ message: string; hint: string } | null>(null);
  const [tick, setTick] = useState(0);
  const [view, setView] = useState<SourceView>(DEFAULT_SOURCE_VIEW);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [showHidden, setShowHidden] = useState(false);
  const [dialog, setDialog] = useState<"collage" | "stitch" | "library" | null>(null);
  const compositions = usePostBuilder((s) => s.comps);

  const sig = poolSignature(doc);
  const hasPool = doc.folder !== "" || doc.extra.length > 0;

  // List the pool whenever it (or its usage) may have changed, once saved.
  useEffect(() => {
    if (!postId || !saved) return;
    if (!hasPool) {
      setSources([]);
      setError(null);
      return;
    }
    let off = false;
    setLoading(true);
    PostsService.Sources(postId).then(
      (list) => {
        if (off) return;
        setSources(list ?? []);
        setError(null);
        setLoading(false);
      },
      (e) => {
        if (off) return;
        const err = toAppError(e);
        setSources([]);
        setError({ message: err.message, hint: err.hint ?? "" });
        setLoading(false);
      },
    );
    return () => {
      off = true;
    };
    // sig covers everything in the document the listing depends on.
  }, [postId, sig, saved, tick, hasPool]);

  // Selection only keeps sources that still exist.
  useEffect(() => {
    setSelected((cur) => {
      const have = new Set(sources.map((s) => s.path));
      const next = [...cur].filter((p) => have.has(p));
      return next.length === cur.size ? cur : new Set(next);
    });
  }, [sources]);

  const shown = useMemo(() => viewSources(sources, view), [sources, view]);
  const numbers = useMemo(() => slideNumberMap(doc.slides), [doc.slides]);
  const highlighted = useMemo(() => slideSourcePaths(selectedSlide, sources), [selectedSlide, sources]);
  const byPath = useMemo(() => new Map(sources.map((s) => [s.path, s])), [sources]);

  /** Selected sources in grid order (what "Add as slides" uses). */
  const selectedInGrid = shown.filter((s) => selected.has(s.path) && !s.missing);
  /** Selected sources in the order they were selected (what a build uses). */
  const selectedInOrder = [...selected].map((p) => byPath.get(p)).filter((s): s is PostSourceFile => !!s && !s.missing);
  const photos = selectedInOrder.filter((s) => s.kind === "photo");

  const fail = (e: unknown) => {
    const err = toAppError(e);
    toast({ tone: "danger", title: err.message, description: err.hint });
  };

  const changeFolder = async () => {
    try {
      const picked = await FilesService.PickFolder("Choose the folder with your photos and clips");
      if (picked) update((d) => ({ ...d, folder: picked, hidden: [] }));
    } catch (e) {
      fail(e);
    }
  };

  const addFiles = async () => {
    try {
      const picked = (await FilesService.PickWith("Add photos and clips", MEDIA_EXTS, true)) ?? [];
      if (picked.length > 0) update((d) => ({ ...d, extra: addExtras(d.extra, picked) }));
    } catch (e) {
      fail(e);
    }
  };

  const openLibrary = () => {
    void usePostBuilder.getState().refreshProjects();
    setDialog("library");
  };

  const addFromLibrary = (paths: string[]) => {
    const picked = new Set(paths.map(poolKey));
    update((d) => ({ ...d, extra: addExtras(d.extra, paths), hidden: d.hidden.filter((p) => !picked.has(poolKey(p))) }));
  };

  const inPool = useMemo(() => new Set(sources.map((s) => poolKey(s.path))), [sources]);

  const hide = () => {
    const paths = selectedInGrid.map((s) => s.path);
    if (paths.length === 0) return;
    update((d) => ({ ...d, ...hideFromPool(d, sources, paths) }));
    setSelected(new Set());
  };

  const restore = (path: string) => update((d) => ({ ...d, hidden: d.hidden.filter((p) => p !== path) }));

  const collageWhy = format === "reel" ? "A reel is one video" : photos.length < 2 ? "Select at least two photos" : "";
  const stitchWhy = selectedInOrder.length < 2 ? "Select at least two clips or photos" : "";
  const canAdd = selectedInGrid.length > 0;

  return (
    <div className={styles.root} aria-label="Sources">
      <header className={styles.head}>
        <span className={styles.count} data-tip="Number of photos and clips in this pool">
          {sources.length} {sources.length === 1 ? "source" : "sources"}
        </span>
        {loading && <Spinner />}
        <span className={styles.spacer} />
        <IconButton icon="refresh-cw" label="Refresh sources" data-tip="Look in the folder again for new or changed files" size="sm" onClick={() => setTick((t) => t + 1)} />
      </header>

      <div className={styles.folder}>
        {doc.folder ? (
          <span className={styles.path} title={doc.folder}>
            {folderBaseName(doc.folder)}
            {doc.subfolders ? " (with subfolders)" : ""}
          </span>
        ) : (
          <span className={styles.path} data-tip="Choose a folder to list its photos and clips here">No folder</span>
        )}
      </div>
      <div className={styles.row}>
        <Button size="sm" variant="secondary" icon="folder-open" data-tip="Choose the folder whose photos and clips fill this panel; files are not moved or changed" onClick={() => void changeFolder()}>
          {doc.folder ? "Change folder…" : "Choose folder…"}
        </Button>
        <Button size="sm" variant="secondary" icon="plus" data-tip="Add individual photos or clips that are not in the folder" onClick={() => void addFiles()}>
          Add files…
        </Button>
        <Button size="sm" variant="secondary" icon="history" data-tip="Add pictures and videos Toolbox already made (Library outputs and your compositions)" onClick={openLibrary}>
          From Library…
        </Button>
      </div>

      {error && (
        <div className={styles.error} role="alert">
          <strong>{error.message}</strong>
          {error.hint && <span>{error.hint}</span>}
        </div>
      )}

      <div className={styles.controls}>
        <TextField placeholder="Search" aria-label="Search sources" data-tip="Type part of a file name to filter the sources" value={view.search} onChange={(e) => setView({ ...view, search: e.target.value })} />
        <div className={styles.row}>
          <Select size="sm" aria-label="Sort sources" data-tip={view.sort === "taken" ? "Sorted by when each photo or clip was taken" : "Sorted by file name"} value={view.sort} onChange={(sort) => setView({ ...view, sort })} options={SORTS} />
          <Select size="sm" aria-label="Show sources" data-tip="Show all sources, only photos, only clips, or only those not used in a slide yet" value={view.filter} onChange={(filter) => setView({ ...view, filter })} options={FILTERS} />
        </div>
      </div>

      <div className={styles.actions}>
        <Button size="sm" variant="primary" data-tip={canAdd ? "Add each selected source to the post as its own slide" : "Select photos or clips in the grid first"} disabled={!canAdd} onClick={() => onAddSlides(selectedInGrid.map((s) => s.path))}>
          Add as slides{canAdd ? ` (${selectedInGrid.length})` : ""}
        </Button>
        <Tooltip label={collageWhy || "Put the selected photos in one composition"}>
          <span>
            <Button size="sm" variant="secondary" icon="layers" disabled={!!collageWhy} onClick={() => setDialog("collage")}>
              Make a collage…
            </Button>
          </span>
        </Tooltip>
        <Tooltip label={stitchWhy || "Cut the selected clips and photos into one video"}>
          <span>
            <Button size="sm" variant="secondary" icon="clapperboard" disabled={!!stitchWhy} onClick={() => setDialog("stitch")}>
              Stitch into a video…
            </Button>
          </span>
        </Tooltip>
        <Button size="sm" variant="ghost" icon="eye-off" data-tip={canAdd ? "Hide the selected sources from this panel; files are untouched and can be shown again" : "Select photos or clips in the grid first"} disabled={!canAdd} onClick={hide}>
          Hide
        </Button>
      </div>

      <div className={styles.gridWrap}>
        <SourceGrid
          sources={shown}
          selected={selected}
          onSelectionChange={(next) => setSelected(next)}
          highlighted={highlighted}
          slideNumbers={numbers}
          onActivate={(p) => onAddSlides([p])}
          emptyLabel={!hasPool ? "Choose a folder or add files to fill this pool." : sources.length > 0 ? "Nothing matches." : error ? "" : "No photos or clips here."}
        />
      </div>

      {doc.hidden.length > 0 && (
        <div className={styles.hidden}>
          <button type="button" className={styles.link} aria-expanded={showHidden} data-tip="Sources you hid from this panel" onClick={() => setShowHidden((v) => !v)}>
            {showHidden ? "Hide the hidden list" : `Show hidden (${doc.hidden.length})`}
          </button>
          {showHidden && (
            <ul className={styles.hiddenList} aria-label="Hidden sources">
              {doc.hidden.map((p) => (
                <li key={p}>
                  <span title={p}>{fileName(p)}</span>
                  <Button size="sm" variant="ghost" data-tip="Put this source back in the panel" onClick={() => restore(p)} aria-label={`Show ${fileName(p)}`}>
                    Show
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {dialog === "collage" && (
        <CollageDialog
          photos={photos.map((p) => ({ path: p.path, name: p.name }))}
          onClose={() => setDialog(null)}
          onConfirm={(build) => {
            setDialog(null);
            onBuild(
              photos.map((p) => p.path),
              build,
            );
          }}
        />
      )}
      {dialog === "library" && <LibraryPickerDialog exts={MEDIA_EXTS} have={inPool} compositions={compositions} onAdd={addFromLibrary} onClose={() => setDialog(null)} />}
      {dialog === "stitch" && (
        <StitchDialog
          count={selectedInOrder.length}
          onClose={() => setDialog(null)}
          onConfirm={(build) => {
            setDialog(null);
            onBuild(
              selectedInOrder.map((p) => p.path),
              build,
            );
          }}
        />
      )}
    </div>
  );
}
