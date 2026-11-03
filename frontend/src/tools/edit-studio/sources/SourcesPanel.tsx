/**
 * The Sources panel (Phase 9 SPEC §14.6): the project's photos and videos as
 * tiles with status, tags and a use count; add files, drag them onto tracks,
 * double-click to insert at the playhead.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Button, ConfirmDialog, DropZone, IconButton, TextField, cx } from "@/components";
import { useJobs } from "@/state/jobs";
import type { NormalProject } from "@/viz/edit/defaults";
import { SongReplaceDialog } from "../home/SongReplaceDialog";
import { useEditStudio, useMarkers, useProject } from "../store";
import { commit, insertAtPlayhead } from "../timeline/actions";
import { addSourcePaths, pickAndAddSources, pickFolderAndAddSources, prepare, relinkSource, watchPrepareJobs } from "./actions";
import { startSourcesDrag } from "./dragSource";
import { useSourceSelection } from "./selection";
import { SourceTile } from "./SourceTile";
import { allTags, filterSources, MAX_SOURCES, normalizeTag, setSourceTags, toggleTag, usedCounts } from "./tags";
import styles from "./SourcesPanel.module.css";

export function SourcesPanel() {
  const project = useProject();
  if (!project) return null;
  return (
    <>
      <Sources project={project} />
      <SongReplaceDialog />
    </>
  );
}

function Sources({ project }: { project: NormalProject }) {
  const projectId = useEditStudio((s) => s.projectId);
  const states = useEditStudio((s) => s.sources);
  const prepareJob = useEditStudio((s) => s.jobs.prepare);
  const progress = useJobs((s) => (prepareJob ? (s.byId[prepareJob]?.progress ?? -1) : -1));
  const selected = useSourceSelection((s) => s.paths);
  const markers = useMarkers();
  const [filter, setFilter] = useState<string[]>([]);
  const [newTag, setNewTag] = useState<{ path: string; text: string } | null>(null);

  const live = useRef({ project, markers });
  live.current = { project, markers };

  useEffect(() => watchPrepareJobs(), []);
  useEffect(() => {
    useSourceSelection.getState().clear();
    setFilter([]);
  }, [projectId]);

  // A changed fps needs new edit streams: prepare everything again.
  const fps = project.fps;
  const lastFps = useRef(fps);
  useEffect(() => {
    if (lastFps.current === fps) return;
    lastFps.current = fps;
    const paths = live.current.project.sources.map((s) => s.path);
    if (paths.length) void prepare(paths);
  }, [fps]);

  const tags = useMemo(() => allTags(project.sources), [project.sources]);
  const used = useMemo(() => usedCounts(project), [project]);
  const shown = useMemo(() => filterSources(project.sources, filter), [project.sources, filter]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>, path: string) => {
    if (e.button !== 0) return;
    const sel = useSourceSelection.getState();
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      sel.toggle(path);
      return;
    }
    if (!sel.paths.includes(path)) sel.set([path]);
    startSourcesDrag(sel.paths.includes(path) ? sel.paths : [path], e);
  }, []);
  const onClick = useCallback((e: ReactMouseEvent<HTMLDivElement>, path: string) => {
    if (e.shiftKey || e.ctrlKey || e.metaKey) return;
    const sel = useSourceSelection.getState();
    if (sel.paths.length > 1 && sel.paths.includes(path)) sel.set([path]);
  }, []);
  const onDoubleClick = useCallback((path: string) => {
    const sel = useSourceSelection.getState().paths;
    insertAtPlayhead(sel.includes(path) ? sel : [path], live.current.markers);
  }, []);
  const onTags = useCallback((path: string, next: string[]) => {
    commit(setSourceTags(live.current.project, path, next), `tags-${path}`);
  }, []);
  const onNewTag = useCallback((path: string) => setNewTag({ path, text: "" }), []);
  const onRelink = useCallback((path: string) => void relinkSource(path), []);
  const onPrepare = useCallback((path: string) => void prepare([path]), []);

  const confirmTag = () => {
    if (!newTag) return;
    const t = normalizeTag(newTag.text);
    const cur = live.current.project.sources.find((s) => s.path === newTag.path);
    if (t && cur) {
      const next = toggleTag(cur.tags ?? [], t);
      if (next && !(cur.tags ?? []).includes(t)) onTags(newTag.path, next);
    }
    setNewTag(null);
  };

  return (
    <div className={styles.panel}>
      <div className={styles.bar}>
        <span className={styles.title}>Sources</span>
        <span className={styles.count}>
          {project.sources.length} / {MAX_SOURCES}
        </span>
        <Button size="sm" icon="plus" onClick={() => void pickAndAddSources()} disabled={project.sources.length >= MAX_SOURCES}>
          Add
        </Button>
        <IconButton size="sm" icon="folder-plus" label="Add a folder" onClick={() => void pickFolderAndAddSources()} disabled={project.sources.length >= MAX_SOURCES} />
      </div>
      {project.sources.length > 0 && (
        <div className={styles.filters} role="group" aria-label="Filter by tag">
          {tags.map((t) => (
            <button
              key={t}
              type="button"
              className={cx(styles.filterChip, filter.includes(t) && styles.filterOn)}
              aria-pressed={filter.includes(t)}
              onClick={() => setFilter((f) => (f.includes(t) ? f.filter((x) => x !== t) : [...f, t]))}
            >
              {t}
            </button>
          ))}
        </div>
      )}
      {project.sources.length === 0 ? (
        <DropZone id="tool-drop:edit-studio" label="Drop clips and photos here" hint="Or use Add. They're prepared for the editor." />
      ) : (
        <div className={styles.grid} role="list" aria-label="Sources">
          {shown.map((s) => (
            <SourceTile
              key={s.path}
              path={s.path}
              tags={s.tags ?? []}
              state={states[s.path]}
              used={used.get(s.path) ?? 0}
              selected={selectedSet.has(s.path)}
              progress={states[s.path]?.preparing ? progress : -1}
              onPointerDown={onPointerDown}
              onClick={onClick}
              onDoubleClick={onDoubleClick}
              onTags={onTags}
              onNewTag={onNewTag}
              onRelink={onRelink}
              onPrepare={onPrepare}
            />
          ))}
          {shown.length === 0 && <p className={styles.none}>No sources with those tags.</p>}
        </div>
      )}
      <ConfirmDialog
        open={!!newTag}
        title="New tag"
        confirmLabel="Add tag"
        body={
          <TextField
            aria-label="Tag"
            placeholder="e.g. night"
            value={newTag?.text ?? ""}
            maxLength={24}
            onChange={(e) => setNewTag((n) => (n ? { ...n, text: e.target.value } : n))}
            autoFocus
          />
        }
        onConfirm={confirmTag}
        onCancel={() => setNewTag(null)}
      />
    </div>
  );
}

export { addSourcePaths };
