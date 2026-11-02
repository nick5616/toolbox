import { Badge, Button, cx, MenuButton } from "@/components";
import type { ProjectInfo } from "@/lib/api";
import { ProjectThumb } from "./ProjectThumb";
import styles from "./PostsStrip.module.css";

export interface PostsStripProps {
  posts: ProjectInfo[];
  currentId: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDuplicate: (id: string) => void;
  onRename: (id: string) => void;
  onDelete: (id: string) => void;
}

export function PostsStrip({ posts, currentId, onSelect, onNew, onDuplicate, onRename, onDelete }: PostsStripProps) {
  return (
    <nav className={styles.strip} aria-label="Posts">
      <Button icon="plus" size="sm" variant="primary" onClick={onNew}>
        New post
      </Button>
      <ul className={styles.list}>
        {posts.map((p) => (
          <li key={p.id} className={cx(styles.item, p.id === currentId && styles.current)}>
            <button type="button" className={styles.open} onClick={() => onSelect(p.id)} aria-current={p.id === currentId || undefined} aria-label={`Open ${p.name}`}>
              <ProjectThumb project={p} className={styles.thumb} />
              <span className={styles.text}>
                <span className={styles.name}>{p.name}</span>
                <span className={styles.meta}>
                  {p.items} {p.items === 1 ? "slide" : "slides"}
                  {p.missing > 0 && (
                    <Badge tone="danger" mono>
                      {p.missing} missing
                    </Badge>
                  )}
                </span>
              </span>
            </button>
            <MenuButton
              label={`More for ${p.name}`}
              icon="ellipsis"
              size="sm"
              items={() => [
                { id: "duplicate", label: "Duplicate", icon: "copy", onSelect: () => onDuplicate(p.id) },
                { id: "rename", label: "Rename…", icon: "pencil", onSelect: () => onRename(p.id) },
                { id: "delete", label: "Delete…", icon: "trash-2", onSelect: () => onDelete(p.id) },
              ]}
            />
          </li>
        ))}
      </ul>
    </nav>
  );
}
