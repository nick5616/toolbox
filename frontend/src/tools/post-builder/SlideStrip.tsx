import { useCallback, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { cx, Icon, IconButton, MenuButton, type MenuItem } from "@/components";
import type { PostIssue, PostSlide, ProjectInfo } from "@/lib/api";
import { FramedMedia } from "./FramedMedia";
import { indexAtY, isPending, worstLevel } from "./logic";
import { stripDrop, type StripDrop } from "./pool";
import { useSourceDropTarget, type SourceDropInfo } from "@/blocks/sources/sourceDrag";
import { useSlideVisual } from "./useSlideVisual";
import styles from "./SlideStrip.module.css";

export const KIND_ICON: Record<string, string> = { photo: "image", clip: "film", composition: "layers", video: "clapperboard" };
export const KIND_LABEL: Record<string, string> = { photo: "Photo", clip: "Clip", composition: "Composition", video: "Video" };

export interface SlideStripProps {
  slides: PostSlide[];
  selectedId: string;
  aspect: string;
  issues: Map<string, PostIssue[]>;
  projects: Map<string, ProjectInfo>;
  addItems: () => MenuItem[];
  onSelect: (id: string) => void;
  onReorder: (from: number, to: number) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  maxSlides: number;
  /** Sources dropped on the strip: insert at an index, or replace a photo/clip slide's source. */
  onSourceDrop?: (paths: string[], drop: StripDrop) => void;
}

function SlideThumb({ slide, aspect, project }: { slide: PostSlide; aspect: string; project: ProjectInfo | undefined }) {
  const v = useSlideVisual(slide, project, 240);
  return (
    <FramedMedia
      url={v.url}
      aspect={aspect}
      framing={slide.kind === "video" ? { zoom: 1, panX: 0, panY: 0, rotation: 0 } : slide}
      placeholderIcon={KIND_ICON[slide.kind] ?? "image"}
      loading={v.status === "loading"}
      className={styles.thumb}
    />
  );
}

export function SlideStrip({ slides, selectedId, aspect, issues, projects, addItems, onSelect, onReorder, onDelete, onDuplicate, maxSlides, onSourceDrop }: SlideStripProps) {
  const list = useRef<HTMLOListElement>(null);
  const root = useRef<HTMLElement>(null);
  const slidesRef = useRef(slides);
  slidesRef.current = slides;
  const dropSources = useCallback(
    (info: SourceDropInfo) => {
      const tiles = Array.from(root.current?.querySelectorAll<HTMLElement>("[data-slide-tile]") ?? []);
      const rects = tiles.map((t) => t.getBoundingClientRect());
      onSourceDrop?.(info.paths, stripDrop(rects, slidesRef.current.map((x) => x.kind), info.y));
    },
    [onSourceDrop],
  );
  useSourceDropTarget(root, dropSources);
  const [drag, setDrag] = useState<{ id: string; from: number; over: number } | null>(null);
  const dragRef = useRef<{ id: string; from: number; over: number; startY: number; active: boolean; pointer: number } | null>(null);

  const centers = (): number[] => {
    const items = Array.from(list.current?.querySelectorAll<HTMLElement>("[data-slide-tile]") ?? []);
    return items.map((el) => {
      const r = el.getBoundingClientRect();
      return r.top + r.height / 2;
    });
  };

  const down = (e: RPointerEvent<HTMLLIElement>, id: string, index: number) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    dragRef.current = { id, from: index, over: index, startY: e.clientY, active: false, pointer: e.pointerId };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const move = (e: RPointerEvent<HTMLLIElement>) => {
    const d = dragRef.current;
    if (!d || d.pointer !== e.pointerId) return;
    if (!d.active && Math.abs(e.clientY - d.startY) < 5) return;
    d.active = true;
    d.over = indexAtY(centers(), e.clientY);
    setDrag({ id: d.id, from: d.from, over: d.over });
  };
  const up = (e: RPointerEvent<HTMLLIElement>) => {
    const d = dragRef.current;
    if (!d || d.pointer !== e.pointerId) return;
    dragRef.current = null;
    setDrag(null);
    if (d.active && d.over !== d.from) onReorder(d.from, d.over);
  };

  return (
    <section ref={root} className={styles.root} aria-label="Slides">
      <header className={styles.head}>
        <h2 className={styles.title}>
          Slides <span className={styles.count} data-tip="Slides in the post / the most Instagram allows for this format">{slides.length}/{maxSlides}</span>
        </h2>
        <span data-tip="Add a slide: photos and clips, or a composition or video" style={{ display: "contents" }}><MenuButton label="Add" icon="plus" size="sm" items={addItems} /></span>
      </header>
      {slides.length === 0 ? (
        <p className={styles.empty} data-tip="Use Add or drop files onto this list">No slides yet. Add photos and clips, or drop them here.</p>
      ) : (
        <ol ref={list} className={styles.list}>
          {slides.map((s, i) => {
            const level = worstLevel(issues.get(s.id) ?? []);
            const selected = s.id === selectedId;
            return (
              <li
                key={s.id}
                data-slide-tile=""
                className={cx(styles.tile, selected && styles.selected, drag?.id === s.id && styles.dragging, drag && drag.over === i && drag.id !== s.id && styles.dropTarget)}
                onPointerDown={(e) => down(e, s.id, i)}
                onPointerMove={move}
                onPointerUp={up}
                onPointerCancel={up}
              >
                <button type="button" className={styles.select} onClick={() => onSelect(s.id)} aria-label={`Slide ${i + 1}, ${KIND_LABEL[s.kind] ?? s.kind}`} data-tip="Select this slide; drag a slide up or down to change the order" aria-current={selected || undefined}>
                  <span className={styles.thumbWrap}>
                    <SlideThumb slide={s} aspect={aspect} project={projects.get(s.projectId)} />
                  </span>
                  <span className={styles.badge} data-tip="Position in the post">{i + 1}</span>
                  <span className={styles.kind} title={KIND_LABEL[s.kind]}>
                    <Icon name={KIND_ICON[s.kind] ?? "image"} size={12} />
                  </span>
                  {(level === "error" || level === "warning") && (
                    <span className={cx(styles.warn, level === "error" && styles.warnError)} title={(issues.get(s.id) ?? []).map((x) => x.message).join("\n")} data-testid={`issue-${s.id}`}>
                      <Icon name="triangle-alert" size={12} />
                    </span>
                  )}
                  {isPending(s) && <span className={styles.pending} data-tip="Open it to make the picture or video for this slide">Not made yet</span>}
                </button>
                {selected && (
                  <span className={styles.actions}>
                    <IconButton size="sm" icon="chevron-up" label="Move earlier" data-tip="Move this slide one place earlier in the post" disabled={i === 0} onClick={() => onReorder(i, i - 1)} />
                    <IconButton size="sm" icon="chevron-down" label="Move later" data-tip="Move this slide one place later in the post" disabled={i === slides.length - 1} onClick={() => onReorder(i, i + 1)} />
                    <IconButton size="sm" icon="copy" label="Duplicate slide" data-tip={slides.length >= maxSlides ? "The post is full" : "Add a copy of this slide right after it"} disabled={slides.length >= maxSlides} onClick={() => onDuplicate(s.id)} />
                    <IconButton size="sm" icon="trash-2" label="Delete slide" data-tip="Remove this slide from the post; the file is not deleted" variant="danger" onClick={() => onDelete(s.id)} />
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
