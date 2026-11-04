import { useEffect, useState } from "react";
import { Badge, Button, Icon, MenuButton, cx } from "@/components";
import { FilesService, type ProjectInfo } from "@/lib/api";
import styles from "./ProjectsStrip.module.css";

export interface ProjectsStripProps {
  projects: readonly ProjectInfo[];
  openId: string | null;
  onOpen: (id: string) => void;
  onNew: () => void;
  onDuplicate: (info: ProjectInfo) => void;
  onRename: (info: ProjectInfo) => void;
  onDelete: (info: ProjectInfo) => void;
}

const thumbCache = new Map<string, string>();

function ProjectThumb({ info }: { info: ProjectInfo }) {
  const key = `${info.thumb}|${info.updatedAt}`;
  const [src, setSrc] = useState(() => thumbCache.get(key) ?? "");
  useEffect(() => {
    if (!info.thumb) {
      setSrc("");
      return;
    }
    const hit = thumbCache.get(key);
    if (hit) {
      setSrc(hit);
      return;
    }
    let off = false;
    FilesService.ImageThumb(info.thumb, 240)
      .then((url) => {
        thumbCache.set(key, url);
        if (!off) setSrc(url);
      })
      .catch(() => undefined);
    return () => {
      off = true;
    };
  }, [info.thumb, key]);
  return <span className={styles.thumb}>{src ? <img src={src} alt="" draggable={false} /> : <Icon name="layers" size={22} />}</span>;
}

/** Recent compositions: open, duplicate, rename or delete one, or start a new one. */
export function ProjectsStrip({ projects, openId, onOpen, onNew, onDuplicate, onRename, onDelete }: ProjectsStripProps) {
  return (
    <div className={styles.strip} role="list" aria-label="Compositions">
      <Button variant="secondary" icon="plus" data-tip="Start a new composition" onClick={onNew} className={styles.new}>
        New
      </Button>
      {projects.map((p) => (
        <div key={p.id} role="listitem" className={cx(styles.card, p.id === openId && styles.open)}>
          <button type="button" className={styles.open_btn} onClick={() => onOpen(p.id)} aria-label={`Open ${p.name}`} data-tip="Open this composition">
            <ProjectThumb info={p} />
            <span className={styles.name}>{p.name}</span>
            <span className={styles.meta}>
              {p.items} {p.items === 1 ? "layer" : "layers"}
              {p.missing > 0 && (
                <Badge tone="warn" mono tip="Some photos were moved or deleted; open the composition to see which">
                  {p.missing} missing
                </Badge>
              )}
            </span>
          </button>
          <span className={styles.menu} data-tip="Rename, duplicate or delete this composition">
            <MenuButton
              size="sm"
              variant="ghost"
              icon="ellipsis"
              label={`More actions for ${p.name}`}
              items={() => [
                { id: "rename", label: "Rename…", tip: "Change the name of this composition", icon: "pencil", onSelect: () => onRename(p) },
                { id: "duplicate", label: "Duplicate", tip: "Make a copy to experiment on", icon: "copy", onSelect: () => onDuplicate(p) },
                { id: "delete", label: "Delete…", tip: "Remove this composition; your original photos are not touched", icon: "trash-2", onSelect: () => onDelete(p) },
              ]}
            />
          </span>
        </div>
      ))}
    </div>
  );
}
