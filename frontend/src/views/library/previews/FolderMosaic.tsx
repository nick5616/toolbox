import { useEffect, useState } from "react";
import { Icon } from "@/components";
import { FilesService, LibraryService, OutputKind } from "@/lib/api";
import { fromEntry, type LibItem } from "../items";
import { useInView } from "./loader";
import styles from "./ItemThumb.module.css";

const cache = new Map<string, string[]>();

/** A folder's face: up to four of its picture children as a 2×2 mosaic (the folder icon when it has none). */
export function FolderMosaic({ item }: { item: LibItem }) {
  const [ref, seen] = useInView<HTMLDivElement>();
  const [srcs, setSrcs] = useState<string[]>(() => cache.get(item.rel) ?? []);
  useEffect(() => {
    if (!seen || cache.has(item.rel)) return;
    let alive = true;
    void (async () => {
      try {
        const listing = await LibraryService.ListDir(item.rel, 24);
        const pics = (listing.entries ?? []).map(fromEntry).filter((e) => !e.isDir && e.kind === OutputKind.KindImage).slice(0, 4);
        const urls = (await Promise.all(pics.map((p) => FilesService.ImageThumb(p.path, 120).catch(() => "")))).filter(Boolean);
        cache.set(item.rel, urls);
        if (alive) setSrcs(urls);
      } catch {
        cache.set(item.rel, []);
      }
    })();
    return () => {
      alive = false;
    };
  }, [seen, item.rel]);
  return (
    <div ref={ref} className={styles.thumb} data-kind="folder">
      {srcs.length > 0 ? (
        <div className={styles.mosaic}>
          {srcs.map((s, i) => (
            <img key={i} src={s} alt="" draggable={false} />
          ))}
        </div>
      ) : (
        <Icon name="folder" size={32} className={styles.icon} />
      )}
    </div>
  );
}
