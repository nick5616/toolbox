import { useEffect, useRef, useState } from "react";
import { Icon, IconButton, Spinner } from "@/components";
import { MediaPlayer, useMediaSource } from "@/components/media";
import type { MediaPlayerHandle } from "@/components/media/types";
import { FilesService, PdfService } from "@/lib/api";
import { releaseImageUrl, wholeImageUrl } from "@/lib/wholeImage";
import { TextActions } from "@/tools/_kit/TextActions";
import { baseOf, itemIcon, previewKind, type LibItem } from "./items";
import { useInView } from "./previews/loader";
import styles from "./Library.module.css";

export const MAX_PDF_PAGES = 40;
const ZOOMS = [1, 1.5, 2, 3, 4];

function ImagePreview({ path }: { path: string }) {
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(0);
  useEffect(() => {
    let alive = true;
    let made = "";
    setUrl("");
    setFailed(false);
    setZoom(0);
    wholeImageUrl(path)
      .then((u) => {
        made = u;
        if (alive) setUrl(u);
        else releaseImageUrl(u);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
      if (made) releaseImageUrl(made);
    };
  }, [path]);
  if (failed) return <div className={styles.bigEmpty}>This picture can't be shown here.</div>;
  if (!url) return <div className={styles.bigEmpty}><Spinner /></div>;
  const scale = ZOOMS[zoom] ?? 1;
  return (
    <div className={styles.bigImage}>
      <div className={styles.zoomBar} role="group" aria-label="Zoom">
        <IconButton size="sm" icon="minus" label="Zoom out" disabled={zoom === 0} onClick={() => setZoom((z) => Math.max(0, z - 1))} />
        <span className={styles.mono}>{Math.round(scale * 100)}%</span>
        <IconButton size="sm" icon="plus" label="Zoom in" disabled={zoom >= ZOOMS.length - 1} onClick={() => setZoom((z) => Math.min(ZOOMS.length - 1, z + 1))} />
      </div>
      <div className={styles.zoomPane}>
        <img src={url} alt={baseOf(path)} style={{ width: `${scale * 100}%` }} draggable={false} />
      </div>
    </div>
  );
}

/** A position to jump to: ms for video/audio, a 0-based page for a PDF. `nonce` makes the same position jump again. */
export interface SeekTo {
  pos: number;
  nonce: number;
}

function MediaPreview({ path, kind, seek }: { path: string; kind: "video" | "audio"; seek?: SeekTo }) {
  const src = useMediaSource(path);
  const player = useRef<MediaPlayerHandle>(null);
  const ready = src.status === "ready" && !!src.source;
  useEffect(() => {
    if (ready && seek && seek.pos >= 0) player.current?.seek(seek.pos);
  }, [ready, seek?.pos, seek?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps
  if (src.status === "error") return <div className={styles.bigEmpty}>{src.error?.message ?? "This file can't be played here."}</div>;
  if (src.status !== "ready" || !src.source) return <div className={styles.bigEmpty}><Spinner /></div>;
  return <MediaPlayer ref={player} source={src.source} kind={kind} path={path} className={styles.player} />;
}

function PdfPage({ path, page }: { path: string; page: number }) {
  const [ref, seen] = useInView<HTMLDivElement>();
  const [src, setSrc] = useState("");
  useEffect(() => {
    if (!seen) return;
    let alive = true;
    PdfService.Thumbnail(path, page, 720, "")
      .then((s) => alive && setSrc(s))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [seen, path, page]);
  return (
    <div ref={ref} className={styles.pdfPage} data-page={page}>
      {src ? <img src={src} alt={`Page ${page}`} draggable={false} /> : <Spinner />}
    </div>
  );
}

function PdfPreview({ path, seek }: { path: string; seek?: SeekTo }) {
  const [pages, setPages] = useState<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setPages(null);
    setFailed(false);
    PdfService.Info(path, "")
      .then((i) => alive && setPages(i.pages))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [path]);
  // Open on the page a search hit or a line of text points at (`pos` is 0-based).
  useEffect(() => {
    if (pages === null || !seek || seek.pos < 0) return;
    scroller.current?.querySelector<HTMLElement>(`[data-page="${seek.pos + 1}"]`)?.scrollIntoView?.({ block: "start" });
  }, [pages, seek?.pos, seek?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps
  if (failed) return <div className={styles.bigEmpty}>This PDF can't be previewed (it may need a password).</div>;
  if (pages === null) return <div className={styles.bigEmpty}><Spinner /></div>;
  const n = Math.min(pages, MAX_PDF_PAGES);
  return (
    <div ref={scroller} className={styles.pdfScroll} data-testid="pdf-pages">
      {Array.from({ length: n }, (_, i) => (
        <PdfPage key={i} path={path} page={i + 1} />
      ))}
      {pages > n ? <p className={styles.note}>Showing the first {n} of {pages} pages. Open the file for the rest.</p> : null}
    </div>
  );
}

function TextPreview({ path }: { path: string }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setText(null);
    setFailed(false);
    FilesService.ReadText(path, 64 * 1024)
      .then((t) => alive && setText(t))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [path]);
  if (failed) return <div className={styles.bigEmpty}>This text can't be shown here.</div>;
  if (text === null) return <div className={styles.bigEmpty}><Spinner /></div>;
  return (
    <div className={styles.bigText}>
      <div className={styles.textTools}>
        <TextActions text={text} filename={baseOf(path)} what="text" />
      </div>
      <pre>{text}</pre>
    </div>
  );
}

/** The detail panel's large preview: zoomable image, media player, scrolling PDF pages or text. */
export function BigPreview({ item, seek }: { item: LibItem; seek?: SeekTo }) {
  if (item.missing) return <div className={styles.bigEmpty}>This file was moved or deleted outside the app.</div>;
  switch (previewKind(item)) {
    case "image":
      return <ImagePreview path={item.path} />;
    case "video":
      return <MediaPreview path={item.path} kind="video" seek={seek} />;
    case "audio":
      return <MediaPreview path={item.path} kind="audio" seek={seek} />;
    case "pdf":
      return <PdfPreview path={item.path} seek={seek} />;
    case "text":
      return <TextPreview path={item.path} />;
    default:
      return (
        <div className={styles.bigEmpty}>
          <Icon name={itemIcon(item)} size={32} />
          <span>No preview for this kind of file.</span>
        </div>
      );
  }
}
