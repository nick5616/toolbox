import { useMemo } from "react";
import { Button, EmptyState, Icon } from "@/components";
import type { LibraryFolder } from "@/lib/api";
import type { CardSize } from "@/state/library";
import { GridView } from "./GridView";
import type { ItemHandlers } from "./ItemCard";
import { dirOf, type LibItem } from "./items";
import { Places } from "./Places";
import styles from "./Library.module.css";

/** Items shown per tool before "Show all". */
export const SECTION_LIMIT = 12;

export interface ToolGroup {
  moduleId: string;
  items: LibItem[];
}

/** Items grouped by tool, the tool with the newest file first; each group newest first. */
export function groupByTool(items: readonly LibItem[]): ToolGroup[] {
  const m = new Map<string, LibItem[]>();
  for (const it of items) {
    if (it.isDir) continue;
    const key = it.moduleId || "other";
    const g = m.get(key);
    if (g) g.push(it);
    else m.set(key, [it]);
  }
  return [...m.entries()]
    .map(([moduleId, list]) => ({ moduleId, items: list.slice().sort((a, b) => b.at - a.at) }))
    .sort((a, b) => (b.items[0]?.at ?? 0) - (a.items[0]?.at ?? 0));
}

/** The library folder a tool writes to, from the tree (`moduleIds`), else the folder of its newest file. */
export function toolFolder(root: LibraryFolder | null, g: ToolGroup): { name: string; path: string; rel: string } {
  const walk = (f: LibraryFolder): LibraryFolder | undefined => {
    if ((f.moduleIds ?? []).includes(g.moduleId) && f.rel !== "") return f;
    for (const c of f.children ?? []) {
      const hit = walk(c);
      if (hit) return hit;
    }
    return undefined;
  };
  const hit = root ? walk(root) : undefined;
  if (hit) return { name: hit.name, path: hit.path, rel: hit.rel };
  const dir = dirOf(g.items[0]?.path ?? "");
  const name = dir.replace(/\\/g, "/").split("/").pop() ?? "";
  return { name, path: dir, rel: "" };
}

export interface ByToolViewProps extends ItemHandlers {
  items: LibItem[];
  root: LibraryFolder | null;
  size: CardSize;
  moduleIcon: (id: string) => string;
  onShowAll: (moduleId: string) => void;
  onOpenFolder: (moduleId: string, folder: { path: string; rel: string }) => void;
  onOpenTool: (moduleId: string) => void;
  onFolder: (rel: string) => void;
  /** Tool ids that exist (a section for an unknown id has no "Open tool"). */
  isTool: (id: string) => boolean;
}

/** One section per tool, newest first: icon, name, folder, Open folder, Open tool, the first 12 files and Show all. */
export function ByToolView({ items, root, size, moduleIcon, onShowAll, onOpenFolder, onOpenTool, onFolder, isTool, ...handlers }: ByToolViewProps) {
  const groups = useMemo(() => groupByTool(items), [items]);
  if (groups.length === 0) return <EmptyState icon="history" title="Nothing here yet." />;
  return (
    <div className={styles.byTool}>
      {groups.map((g) => {
        const folder = toolFolder(root, g);
        const name = handlers.moduleName(g.moduleId);
        const shown = g.items.slice(0, SECTION_LIMIT);
        return (
          <section key={g.moduleId} className={styles.toolSection} aria-label={name}>
            <header className={styles.toolHead}>
              <Icon name={moduleIcon(g.moduleId)} size={16} />
              <h3 className={styles.toolName}>{name}</h3>
              <span className={styles.toolFolder} data-tip={folder.path}>
                {folder.name}
              </span>
              <span className={styles.spacer} />
              <Button size="sm" variant="ghost" icon="folder-open" data-tip="Open this tool's folder in your file manager" onClick={() => onOpenFolder(g.moduleId, folder)}>
                Open folder
              </Button>
              {isTool(g.moduleId) ? (
                <Button size="sm" variant="ghost" icon="external-link" data-tip={`Open ${name}`} onClick={() => onOpenTool(g.moduleId)}>
                  Open tool
                </Button>
              ) : null}
            </header>
            <GridView items={shown} size={size} label={`${name} files`} {...handlers} />
            {g.items.length > SECTION_LIMIT ? (
              <Button size="sm" variant="secondary" className={styles.showAll} data-tip={`Every file ${name} made`} onClick={() => onShowAll(g.moduleId)}>
                Show all {g.items.length}
              </Button>
            ) : null}
          </section>
        );
      })}
      <Places root={root} onFolder={onFolder} />
    </div>
  );
}
