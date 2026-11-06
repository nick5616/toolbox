/**
 * The projects home (Phase 9 SPEC §14.1, Phase 10 §5.4): a card grid of edits.
 * The Video Editor's profile (`homeFilter: "all"`) lists every edit, opens the
 * New video dialog and links to the older sequence projects; Edit Studio's
 * (`"music-edit"`) lists music edits first, the rest folded away. With no
 * profile it behaves as Edit Studio did before Phase 10.
 */
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, ConfirmDialog, DropZone, EmptyState, Icon, MenuButton, TextField, toast } from "@/components";
import { EditStudioService, FilesService, SettingsService, VideoEditorService, type ProjectInfo } from "@/lib/api";
import { useCommands } from "@/lib/commands";
import { toAppError } from "@/lib/errors";
import { formatRelativeTime } from "@/lib/format";
import { useUI } from "@/state/ui";
import { normalizeProject } from "@/viz/edit/defaults";
import { discardedEdits } from "@/editor/useEditAutosave";
import type { EditorProfile } from "@/editor/profile";
import { NewEditDialog } from "./NewEditDialog";
import { NewVideoDialog } from "./NewVideoDialog";
import { useNewEditRequest, type NewEditRequest } from "./newEditRequest";
import styles from "./Home.module.css";

export interface ProjectsHomeProps {
  moduleId: string;
  /** The tool's composition profile (Phase 10 §5.4: which projects, which "New" dialog). Absent = Edit Studio's behaviour. */
  profile?: EditorProfile;
  /** Opens a project (the view loads it). */
  onOpen(id: string): void;
}

/** The older sequence editor's module ID. */
export const SEQUENCE_EDITOR_ID = "video-editor";

/** Project flag of an edit with an analysed song (modules/editstudio/base.go). */
export const FLAG_MUSIC_EDIT = "music-edit";

/**
 * Sends the user to the older Sequence Editor: it reads its module state when it
 * opens, so `lastProjectId` opens a project and `quickVlog` opens the Quick vlog dialog.
 */
export async function openSequenceEditor(patch: { lastProjectId?: string; quickVlog?: boolean }): Promise<void> {
  let state: Record<string, unknown> = {};
  try {
    const raw = await SettingsService.ModuleState(SEQUENCE_EDITOR_ID);
    if (raw) state = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // start from nothing
  }
  await SettingsService.SetModuleState(SEQUENCE_EDITOR_ID, JSON.stringify({ ...state, ...patch })).catch(() => undefined);
  useUI.getState().navigate(SEQUENCE_EDITOR_ID);
}

function Thumb({ path, icon }: { path: string; icon: "audio-waveform" | "clapperboard" }) {
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
      <Icon name={icon} size={22} />
    </div>
  );
}

export function ProjectsHome({ moduleId, profile, onOpen }: ProjectsHomeProps) {
  const video = profile?.homeFilter === "all";
  const split = profile?.homeFilter === "music-edit";
  const noun = video ? "video" : "edit";
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [older, setOlder] = useState<ProjectInfo[]>([]);
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

  // The older sequence projects (Video Editor only); a failure just hides the section.
  useEffect(() => {
    if (!video) return;
    let live = true;
    VideoEditorService.List().then(
      (l) => live && setOlder(l ?? []),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [video]);

  // A handoff, drop or palette command asked for the dialog.
  useEffect(() => {
    if (!pending) return;
    setCreating(pending);
    useNewEditRequest.getState().clear();
  }, [pending]);

  useCommands([{ id: video ? "video-studio.new" : "edit-studio.new", title: video ? "New video" : "New edit", section: video ? "Video Editor" : "Edit Studio", icon: "plus", run: () => setCreating({}) }]);

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

  const card = (pr: ProjectInfo) => (
    <li key={pr.id} className={styles.card}>
      <button type="button" className={styles.cardMain} onClick={() => onOpen(pr.id)} aria-label={`Open ${pr.name}`} data-tip={`Open this ${noun} and carry on where you left off (${pr.items} ${pr.items === 1 ? "clip" : "clips"})`}>
        <Thumb path={pr.thumb} icon={video ? "clapperboard" : "audio-waveform"} />
        <span className={styles.cardName}>{pr.name}</span>
        <span className={styles.cardMeta}>
          {pr.items} {pr.items === 1 ? "clip" : "clips"}
          {video && (pr.flags ?? []).includes(FLAG_MUSIC_EDIT) && <Badge tip="Cut to a song's beats in Edit Studio">Music edit</Badge>}
          {pr.missing > 0 && <Badge tone="warn" tip={`Source files this ${noun} uses that can no longer be found; open it to relink them`}>{pr.missing} missing</Badge>}
          <span data-tip={`When this ${noun} was last saved`}>{formatRelativeTime(pr.updatedAt)}</span>
        </span>
      </button>
      <div className={styles.cardMenu}>
        <MenuButton
          label={`Actions for ${pr.name}`}
          icon="ellipsis"
          variant="ghost"
          size="sm"
          items={() => [
            { id: "open", label: "Open", icon: "folder-open", tip: `Open this ${noun} in the editor`, onSelect: () => onOpen(pr.id) },
            { id: "dup", label: "Duplicate", icon: "copy", tip: "Make a copy to try a different cut without touching this one", onSelect: () => void duplicate(pr.id) },
            {
              id: "rename",
              label: "Rename",
              icon: "pencil",
              tip: `Give this ${noun} another name`,
              onSelect: () => {
                setRenaming(pr);
                setDraft(pr.name);
              },
            },
            { id: "delete", label: "Delete", icon: "trash-2", tip: `Remove this ${noun} from the app; your songs, clips and exports stay`, onSelect: () => setDeleting(pr) },
          ]}
        />
      </div>
    </li>
  );

  // Edit Studio's main group: projects with a song (analysed or not yet: a fresh edit is analysed in Setup).
  const isMusicEdit = (pr: ProjectInfo) => (pr.flags ?? []).includes(FLAG_MUSIC_EDIT) || (pr.flags ?? []).includes("music");
  const main = split ? projects.filter(isMusicEdit) : projects;
  const folded = split ? projects.filter((p) => !isMusicEdit(p)) : [];
  const nothing = projects.length === 0 && !loading;
  const emptyMain = main.length === 0 && !loading;

  return (
    <div className={styles.home}>
      <div className={styles.homeBar}>
        <Button variant="primary" icon="plus" data-tip={video ? "Start a new video: pick a shape and a frame rate, and add clips if you have them" : "Start a new edit: pick a song, a shape and a frame rate"} onClick={() => setCreating({})}>
          {video ? "New video" : "New edit"}
        </Button>
      </div>
      {emptyMain && (!split || nothing) ? (
        <>
          {video ? (
            <EmptyState icon="clapperboard" title="No videos yet" body="Arrange clips and photos on a timeline, add text, effects and music, and export." />
          ) : (
            <EmptyState icon="audio-waveform" title="No edits yet" body="Pick a song and cut your clips to its beat: kicks, snares and drops become the places to cut." />
          )}
          <div data-tip={video ? "Drop clips, photos or music to start a new video with them" : "Drop a song (and any clips or photos) to start a new edit with them"}>
            <DropZone
              id={`tool-drop:${moduleId}`}
              label={video ? "Drop clips to start a video" : "Drop a song to start an edit"}
              hint={video ? "Clips and photos are placed one after another; an audio file becomes the music" : "Clips and photos dropped with it are added as sources"}
            />
          </div>
        </>
      ) : (
        <>
          {main.length > 0 && (
            <ul className={styles.cards} aria-label={video ? "Videos" : "Edits"}>
              {main.map(card)}
            </ul>
          )}
          {split && main.length === 0 && <EmptyState icon="audio-waveform" title="No music edits yet" body="Pick a song and cut your clips to its beat." />}
        </>
      )}
      {folded.length > 0 && (
        <details className={styles.fold}>
          <summary>
            Videos without a song analysis ({folded.length})
          </summary>
          <ul className={styles.cards} aria-label="Videos without a song analysis">
            {folded.map(card)}
          </ul>
        </details>
      )}
      {video && (
        <section className={styles.section} aria-label="Older sequence projects">
          <div className={styles.sectionHead}>
            <h3 className={styles.sectionTitle}>Older sequence projects</h3>
            <Button size="sm" icon="wand-sparkles" data-tip="Pick clips and a song and get a first-draft video cut for you, in the older sequence editor" onClick={() => void openSequenceEditor({ quickVlog: true })}>
              Quick vlog…
            </Button>
          </div>
          {older.length > 0 && (
            <ul className={styles.older}>
              {older.map((pr) => (
                <li key={pr.id} className={styles.olderRow}>
                  <span className={styles.olderName}>{pr.name}</span>
                  <Button size="sm" variant="ghost" aria-label={`Open ${pr.name} in the sequence editor`} data-tip="Open this project in the older sequence editor" onClick={() => void openSequenceEditor({ lastProjectId: pr.id })}>
                    Open
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {video ? (
        <NewVideoDialog
          open={!!creating}
          files={[...(creating?.files ?? []), ...(creating?.song ? [creating.song] : []), ...(creating?.sources ?? [])]}
          onCreated={(id) => {
            setCreating(null);
            void refresh();
            onOpen(id);
          }}
          onCancel={() => setCreating(null)}
        />
      ) : (
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
      )}
      <ConfirmDialog
        open={!!renaming}
        title={`Rename ${noun}`}
        confirmLabel="Rename"
        body={<TextField aria-label="Name" data-tip={`A name for this ${noun}`} value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus />}
        onConfirm={() => {
          if (renaming && draft.trim()) void rename(renaming.id, draft.trim());
          setRenaming(null);
        }}
        onCancel={() => setRenaming(null)}
      />
      <ConfirmDialog
        open={!!deleting}
        title={`Delete this ${noun}?`}
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
