import { useEffect, useRef, useState } from "react";
import { Icon, IconButton, cx } from "@/components";
import { FilesService, type FileInfo } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { basename } from "./options";
import type { Infos } from "./usePdfInfos";
import { usePdfThumb, useSeen } from "./useThumb";
import styles from "./OrderedList.module.css";

function PdfThumb({ path, password }: { path: string; password: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const seen = useSeen(ref);
  const src = usePdfThumb(path, 1, 96, password, seen);
  return (
    <span ref={ref} className={styles.thumb}>
      {src ? <img src={src} alt="" /> : <Icon name="file-text" size={16} />}
    </span>
  );
}

function ImageThumb({ path }: { path: string }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    let cancelled = false;
    FilesService.ImageThumb(path, 96).then(
      (u) => !cancelled && setSrc(u),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [path]);
  return <span className={styles.thumb}>{src ? <img src={src} alt="" /> : <Icon name="image" size={16} />}</span>;
}

export interface OrderedListProps {
  files: FileInfo[];
  kind: "pdf" | "image";
  infos: Infos;
  password: string;
  onMove: (from: number, to: number) => void;
  onRemove: (path: string) => void;
  inputErrors?: Record<string, string>;
}

/** Ordered file list with drag handles, up/down buttons and first-page thumbnails. */
export function OrderedList({ files, kind, infos, password, onMove, onRemove, inputErrors }: OrderedListProps) {
  const dragFrom = useRef(-1);
  const [over, setOver] = useState(-1);
  return (
    <ol className={styles.list} aria-label={kind === "pdf" ? "PDFs to merge, in order" : "Images, in page order"}>
      {files.map((f, i) => {
        const name = basename(f.path);
        const pages = infos[f.path]?.info?.pages;
        const err = inputErrors?.[f.path];
        return (
          <li
            key={f.path}
            draggable
            className={cx(styles.row, over === i && styles.over)}
            onDragStart={() => {
              dragFrom.current = i;
            }}
            onDragOver={(e) => {
              if (dragFrom.current < 0) return;
              e.preventDefault();
              setOver(i);
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragFrom.current >= 0 && dragFrom.current !== i) onMove(dragFrom.current, i);
              dragFrom.current = -1;
              setOver(-1);
            }}
            onDragEnd={() => {
              dragFrom.current = -1;
              setOver(-1);
            }}
          >
            <span className={styles.handle} aria-hidden="true">
              <Icon name="grip-vertical" size={14} />
            </span>
            <span className={styles.index}>{i + 1}</span>
            {kind === "pdf" ? <PdfThumb path={f.path} password={password} /> : <ImageThumb path={f.path} />}
            <span className={styles.name} title={f.path}>
              {name}
            </span>
            {err && (
              <span className={styles.error} role="alert">
                {err}
              </span>
            )}
            <span className={styles.meta}>
              {pages ? `${pages} ${pages === 1 ? "page" : "pages"} · ` : ""}
              {formatBytes(f.sizeBytes)}
            </span>
            <IconButton size="sm" icon="chevron-up" label={`Move ${name} up`} disabled={i === 0} onClick={() => onMove(i, i - 1)} />
            <IconButton
              size="sm"
              icon="chevron-down"
              label={`Move ${name} down`}
              disabled={i === files.length - 1}
              onClick={() => onMove(i, i + 1)}
            />
            <IconButton size="sm" icon="x" label={`Remove ${name}`} onClick={() => onRemove(f.path)} />
          </li>
        );
      })}
    </ol>
  );
}
