// The project list: open, create, duplicate, rename and delete video projects.
import { useEffect, useState } from "react";
import { Badge, Button, ConfirmDialog, DropZone, EmptyState, Icon, MenuButton, TextField, type MenuItem } from "@/components";
import { FilesService, type ProjectInfo } from "@/lib/api";
import { ASPECTS } from "./edit";
import styles from "./VideoEditorView.module.css";

export interface ProjectsHomeProps {
  projects: ProjectInfo[];
  loading: boolean;
  onOpen: (id: string) => void;
  onNew: (aspect: string) => void;
  onQuickVlog: () => void;
  onDuplicate: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
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
  return url ? <img className={styles.cardThumb} src={url} alt="" /> : <div className={styles.cardThumb}><Icon name="clapperboard" size={22} /></div>;
}

export function ProjectsHome(p: ProjectsHomeProps) {
  const [renaming, setRenaming] = useState<ProjectInfo | null>(null);
  const [draft, setDraft] = useState("");
  const [deleting, setDeleting] = useState<ProjectInfo | null>(null);
  const newItems = (): MenuItem[] =>
    ASPECTS.map((a) => ({ id: a, label: a, icon: "clapperboard", onSelect: () => p.onNew(a) }));

  return (
    <div className={styles.home}>
      <div className={styles.homeBar}>
        <MenuButton label="New video" icon="plus" items={newItems} />
        <Button icon="wand-sparkles" onClick={p.onQuickVlog}>
          Quick vlog…
        </Button>
      </div>
      {p.projects.length === 0 && !p.loading ? (
        <>
          <EmptyState icon="clapperboard" title="No videos yet" body="Start from scratch, or give Quick vlog some clips and a song and it cuts a first draft for you." />
          <DropZone id="tool-drop:video-editor" label="Drop clips and photos here" hint="They become a new video" />
        </>
      ) : (
        <ul className={styles.cards} aria-label="Video projects">
          {p.projects.map((pr) => (
            <li key={pr.id} className={styles.card}>
              <button type="button" className={styles.cardMain} onClick={() => p.onOpen(pr.id)} aria-label={`Open ${pr.name}`}>
                <Thumb path={pr.thumb} />
                <span className={styles.cardName}>{pr.name}</span>
                <span className={styles.cardMeta}>
                  {pr.items} {pr.items === 1 ? "clip" : "clips"}
                  {pr.missing > 0 && <Badge tone="warn">{pr.missing} missing</Badge>}
                </span>
              </button>
              <div className={styles.cardMenu}>
                <MenuButton
                  label={`Actions for ${pr.name}`}
                  icon="ellipsis"
                  variant="ghost"
                  size="sm"
                  items={() => [
                    { id: "dup", label: "Duplicate", icon: "copy", onSelect: () => p.onDuplicate(pr.id) },
                    { id: "rename", label: "Rename", icon: "pencil", onSelect: () => { setRenaming(pr); setDraft(pr.name); } },
                    { id: "delete", label: "Delete", icon: "trash-2", onSelect: () => setDeleting(pr) },
                  ]}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={!!renaming}
        title="Rename video"
        confirmLabel="Rename"
        body={<TextField aria-label="Name" value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus />}
        onConfirm={() => {
          if (renaming && draft.trim()) p.onRename(renaming.id, draft.trim());
          setRenaming(null);
        }}
        onCancel={() => setRenaming(null)}
      />
      <ConfirmDialog
        open={!!deleting}
        title="Delete this video?"
        tone="danger"
        confirmLabel="Delete"
        body={deleting ? `"${deleting.name}" is removed from the app. Your clips and exported files are not touched.` : null}
        onConfirm={() => {
          if (deleting) p.onDelete(deleting.id);
          setDeleting(null);
        }}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
