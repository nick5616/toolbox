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
  /** A vertical list (the Posts panel) instead of a row. */
  column?: boolean;
}

export function PostsStrip({ posts, currentId, onSelect, onNew, onDuplicate, onRename, onDelete, column }: PostsStripProps) {
  return (
    <nav className={cx(styles.strip, column && styles.stripColumn)} aria-label="Posts">
      <Button icon="plus" size="sm" variant="primary" data-tip="Start a new post: a carousel, a reel or a story" onClick={onNew}>
        New post
      </Button>
      <ul className={cx(styles.list, column && styles.listColumn)}>
        {posts.map((p) => (
          <li key={p.id} className={cx(styles.item, p.id === currentId && styles.current)}>
            <button type="button" className={styles.open} onClick={() => onSelect(p.id)} aria-current={p.id === currentId || undefined} aria-label={`Open ${p.name}`} data-tip="Open this post">
              <ProjectThumb project={p} className={styles.thumb} />
              <span className={styles.text}>
                <span className={styles.name}>{p.name}</span>
                <span className={styles.meta}>
                  {p.items} {p.items === 1 ? "slide" : "slides"}
                  {p.missing > 0 && (
                    <Badge tone="danger" mono tip="Some files in this post were moved or deleted">
                      {p.missing} missing
                    </Badge>
                  )}
                </span>
              </span>
            </button>
            <span style={{ display: "contents" }}>
            <MenuButton
              label={`More for ${p.name}`}
              tip={`More for ${p.name}`}
              icon="ellipsis"
              variant="ghost"
              size="sm"
              items={() => [
                { id: "duplicate", label: "Duplicate", tip: "Make a copy of this post to try another version", icon: "copy", onSelect: () => onDuplicate(p.id) },
                { id: "rename", label: "Rename…", tip: "Change the name of this post", icon: "pencil", onSelect: () => onRename(p.id) },
                { id: "delete", label: "Delete…", tip: "Remove this post; photos, compositions and exports stay", icon: "trash-2", onSelect: () => onDelete(p.id) },
              ]}
            />
            </span>
          </li>
        ))}
      </ul>
    </nav>
  );
}
