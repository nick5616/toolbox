/** The projects home (Phase 9 SPEC §14.1): a card grid of edits; New edit opens the dialog. */
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, ConfirmDialog, DropZone, EmptyState, Icon, MenuButton, TextField, toast } from "@/components";
import { EditStudioService, FilesService, type ProjectInfo } from "@/lib/api";
import { useCommands } from "@/lib/commands";
import { toAppError } from "@/lib/errors";
import { formatRelativeTime } from "@/lib/format";
import { normalizeProject } from "@/viz/edit/defaults";
import { discardedEdits } from "../useEditAutosave";
import { NewEditDialog } from "./NewEditDialog";
import { useNewEditRequest, type NewEditRequest } from "./newEditRequest";
import styles from "./Home.module.css";

export interface ProjectsHomeProps {
  moduleId: string;
  /** Opens a project (the view loads it). */
  onOpen(id: string): void;
}

function Thumb({ path }: { path: string }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    FilesService.ImageThumb(path, 240).then(
      (u) => !cancelled && setUrl(u),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [path]);
  return url ? <img className={styles.cardThumb} src={url} alt="" /> : (
    <div className={styles.cardThumb}>
      <Icon name="audio-waveform" size={22} />
    </div>
  );
}

export function ProjectsHome({ moduleId, onOpen }: ProjectsHomeProps) {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [renaming, setRenaming] = useState<ProjectInfo | null>(null);
  const [draft, setDraft] = useState("");
  const [deleting, setDeleting] = useState<ProjectInfo | null>(null);
  const [creating, setCreating] = useState<NewEditRequest | null>(null);
  const pending = useNewEditRequest((s) => s.pending);

  const refresh = useCallback(async () => {
    try {
      setProjects((await EditStudioService.List()) ?? []);
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A handoff, drop or palette command asked for the dialog.
  useEffect(() => {
    if (!pending) return;
    setCreating(pending);
    useNewEditRequest.getState().clear();
  }, [pending]);

  useCommands([{ id: "edit-studio.new", title: "New edit", section: "Edit Studio", icon: "plus", run: () => setCreating({}) }]);

  const duplicate = async (id: string) => {
    try {
      await EditStudioService.Duplicate(id);
      await refresh();
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    }
  };
  const rename = async (id: string, name: string) => {
    try {
      const doc = normalizeProject(await EditStudioService.Get(id));
      await EditStudioService.Save(id, name, doc);
      await refresh();
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    }
  };
  const remove = async (id: string) => {
    discardedEdits.add(id);
    try {
      await EditStudioService.Delete(id);
      await refresh();
    } catch (e) {
      discardedEdits.delete(id);
      toast({ title: toAppError(e).message, tone: "danger" });
    }
  };

  return (
    <div className={styles.home}>
      <div className={styles.homeBar}>
        <Button variant="primary" icon="plus" onClick={() => setCreating({})}>
          New edit
        </Button>
      </div>
      {projects.length === 0 && !loading ? (
        <>
          <EmptyState icon="audio-waveform" title="No edits yet" body="Pick a song and cut your clips to its beat: kicks, snares and drops become the places to cut." />
          <DropZone id={`tool-drop:${moduleId}`} label="Drop a song to start an edit" hint="Clips and photos dropped with it are added as sources" />
        </>
      ) : (
        <ul className={styles.cards} aria-label="Edits">
          {projects.map((pr) => (
            <li key={pr.id} className={styles.card}>
              <button type="button" className={styles.cardMain} onClick={() => onOpen(pr.id)} aria-label={`Open ${pr.name}`}>
                <Thumb path={pr.thumb} />
                <span className={styles.cardName}>{pr.name}</span>
                <span className={styles.cardMeta}>
                  {pr.items} {pr.items === 1 ? "clip" : "clips"}
                  {pr.missing > 0 && <Badge tone="warn">{pr.missing} missing</Badge>}
                  <span>{formatRelativeTime(pr.updatedAt)}</span>
                </span>
              </button>
              <div className={styles.cardMenu}>
                <MenuButton
                  label={`Actions for ${pr.name}`}
                  icon="ellipsis"
                  variant="ghost"
                  size="sm"
                  items={() => [
                    { id: "open", label: "Open", icon: "folder-open", onSelect: () => onOpen(pr.id) },
                    { id: "dup", label: "Duplicate", icon: "copy", onSelect: () => void duplicate(pr.id) },
                    {
                      id: "rename",
                      label: "Rename",
                      icon: "pencil",
                      onSelect: () => {
                        setRenaming(pr);
                        setDraft(pr.name);
                      },
                    },
                    { id: "delete", label: "Delete", icon: "trash-2", onSelect: () => setDeleting(pr) },
                  ]}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
      <NewEditDialog
        open={!!creating}
        {...(creating?.song ? { song: creating.song } : {})}
        {...(creating?.sources ? { sources: creating.sources } : {})}
        onCreated={(id) => {
          setCreating(null);
          void refresh();
          onOpen(id);
        }}
        onCancel={() => setCreating(null)}
      />
      <ConfirmDialog
        open={!!renaming}
        title="Rename edit"
        confirmLabel="Rename"
        body={<TextField aria-label="Name" value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus />}
        onConfirm={() => {
          if (renaming && draft.trim()) void rename(renaming.id, draft.trim());
          setRenaming(null);
        }}
        onCancel={() => setRenaming(null)}
      />
      <ConfirmDialog
        open={!!deleting}
        title="Delete this edit?"
        tone="danger"
        confirmLabel="Delete"
        body={deleting ? `"${deleting.name}" is removed from the app. Your songs, clips, photos and exported files are not touched.` : null}
        onConfirm={() => {
          if (deleting) void remove(deleting.id);
          setDeleting(null);
        }}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
