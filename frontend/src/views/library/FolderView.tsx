import { useState } from "react";
import { Banner, EmptyState, Icon, cx } from "@/components";
import type { LibraryFolder } from "@/lib/api";
import type { CardSize } from "@/state/library";
import { GridView } from "./GridView";
import type { ItemHandlers } from "./ItemCard";
import type { LibItem } from "./items";
import { Places } from "./Places";
import styles from "./Library.module.css";

/** Total files under a folder, itself included. */
export function totalFiles(f: LibraryFolder): number {
  return f.files + (f.children ?? []).reduce((n, c) => n + totalFiles(c), 0);
}

/** The folders from the root down to `rel` (the root first). */
export function folderPath(root: LibraryFolder, rel: string): LibraryFolder[] {
  const out: LibraryFolder[] = [root];
  if (!rel) return out;
  let cur = root;
  for (const part of rel.split("/")) {
    const next = (cur.children ?? []).find((c) => c.name === part || c.rel.split("/").pop() === part);
    if (!next) break;
    out.push(next);
    cur = next;
  }
  return out;
}

function Node({ node, selected, onSelect, depth, open, toggle }: { node: LibraryFolder; selected: string; onSelect: (rel: string) => void; depth: number; open: ReadonlySet<string>; toggle: (rel: string) => void }) {
  const kids = node.children ?? [];
  const isOpen = open.has(node.rel) || selected === node.rel || selected.startsWith(node.rel ? `${node.rel}/` : "");
  return (
    <li role="none">
      <div className={cx(styles.treeRow, selected === node.rel && styles.treeSelected)} style={{ paddingLeft: `calc(${depth} * var(--space-3) + var(--space-1))` }}>
        {kids.length > 0 ? (
          <button type="button" className={styles.treeToggle} aria-label={isOpen ? `Collapse ${node.name}` : `Expand ${node.name}`} onClick={() => toggle(node.rel)}>
            <Icon name={isOpen ? "chevron-down" : "chevron-right"} size={12} />
          </button>
        ) : (
          <span className={styles.treeToggle} />
        )}
        <button type="button" role="treeitem" aria-selected={selected === node.rel} className={styles.treeLabel} data-tip={node.path} onClick={() => onSelect(node.rel)}>
          <Icon name="folder" size={14} />
          <span className={styles.treeName}>{node.name}</span>
          <span className={styles.treeCount} data-tip={`${node.registered} made by tools of ${node.files} files`}>
            {node.files}
          </span>
        </button>
      </div>
      {kids.length > 0 && isOpen ? (
        <ul role="group" className={styles.treeList}>
          {kids.map((c) => (
            <Node key={c.rel} node={c} selected={selected} onSelect={onSelect} depth={depth + 1} open={open} toggle={toggle} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export interface FolderViewProps extends ItemHandlers {
  root: LibraryFolder | null;
  unavailable: boolean;
  /** The selected folder (library-relative). */
  folder: string;
  onFolder: (rel: string) => void;
  items: LibItem[];
  truncated: boolean;
  loading: boolean;
  size: CardSize;
  /** Narrow window: the tree becomes a breadcrumb. */
  narrow: boolean;
}

/** The library folder tree on the left (a breadcrumb when narrow), the selected folder's files as a grid on the right. */
export function FolderView({ root, unavailable, folder, onFolder, items, truncated, loading, size, narrow, ...handlers }: FolderViewProps) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set([""]));
  const toggle = (rel: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(rel)) n.delete(rel);
      else n.add(rel);
      return n;
    });
  if (unavailable) {
    return <EmptyState icon="folder-tree" title="The folder view isn't available yet" body="The library's folder scan isn't part of this build. Grid and List still show everything Toolbox made." />;
  }
  const crumbs = root ? folderPath(root, folder) : [];
  const files = items.filter((i) => !i.isDir);
  return (
    <div className={cx(styles.folders, narrow && styles.foldersNarrow)}>
      {narrow ? (
        <nav className={styles.crumbs} aria-label="Folder path">
          {crumbs.map((c, i) => (
            <span key={c.rel} className={styles.crumb}>
              {i > 0 ? <Icon name="chevron-right" size={12} /> : null}
              <button type="button" className={styles.crumbBtn} aria-current={i === crumbs.length - 1 ? "page" : undefined} onClick={() => onFolder(c.rel)}>
                {c.name}
              </button>
            </span>
          ))}
        </nav>
      ) : (
        <nav className={styles.tree} aria-label="Folders">
          {root ? (
            <ul role="tree" className={styles.treeList}>
              <Node node={root} selected={folder} onSelect={onFolder} depth={0} open={open} toggle={toggle} />
            </ul>
          ) : null}
        </nav>
      )}
      <div className={styles.folderMain}>
        {truncated ? (
          <Banner tone="info">This folder has more than 5000 entries. Showing the first 5000.</Banner>
        ) : null}
        {items.length === 0 ? (
          <EmptyState icon="folder" title={loading ? "Reading the folder…" : "This folder is empty."} />
        ) : (
          <GridView items={items} size={size} label="Folder contents" {...handlers} />
        )}
        {files.length > 0 && files.some((f) => !f.registered) ? (
          <p className={styles.note}>Files with a dim dot weren't made by a tool; they're in your library folder.</p>
        ) : null}
        <Places root={root} onFolder={onFolder} />
      </div>
    </div>
  );
}
