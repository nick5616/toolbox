import { useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { cx, Icon, IconButton, MenuButton, type MenuItem } from "@/components";
import type { PostIssue, PostSlide, ProjectInfo } from "@/lib/api";
import { FramedMedia } from "./FramedMedia";
import { indexAtY, isPending, worstLevel } from "./logic";
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

export function SlideStrip({ slides, selectedId, aspect, issues, projects, addItems, onSelect, onReorder, onDelete, onDuplicate, maxSlides }: SlideStripProps) {
  const list = useRef<HTMLOListElement>(null);
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
    <section className={styles.root} aria-label="Slides">
      <header className={styles.head}>
        <h2 className={styles.title}>
          Slides <span className={styles.count}>{slides.length}/{maxSlides}</span>
        </h2>
        <MenuButton label="Add" icon="plus" size="sm" items={addItems} />
      </header>
      {slides.length === 0 ? (
        <p className={styles.empty}>No slides yet. Add photos and clips, or drop them here.</p>
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
                <button type="button" className={styles.select} onClick={() => onSelect(s.id)} aria-label={`Slide ${i + 1}, ${KIND_LABEL[s.kind] ?? s.kind}`} aria-current={selected || undefined}>
                  <span className={styles.thumbWrap}>
                    <SlideThumb slide={s} aspect={aspect} project={projects.get(s.projectId)} />
                  </span>
                  <span className={styles.badge}>{i + 1}</span>
                  <span className={styles.kind} title={KIND_LABEL[s.kind]}>
                    <Icon name={KIND_ICON[s.kind] ?? "image"} size={12} />
                  </span>
                  {(level === "error" || level === "warning") && (
                    <span className={cx(styles.warn, level === "error" && styles.warnError)} title={(issues.get(s.id) ?? []).map((x) => x.message).join("\n")} data-testid={`issue-${s.id}`}>
                      <Icon name="triangle-alert" size={12} />
                    </span>
                  )}
                  {isPending(s) && <span className={styles.pending}>Not made yet</span>}
                </button>
                {selected && (
                  <span className={styles.actions}>
                    <IconButton size="sm" icon="chevron-up" label="Move earlier" disabled={i === 0} onClick={() => onReorder(i, i - 1)} />
                    <IconButton size="sm" icon="chevron-down" label="Move later" disabled={i === slides.length - 1} onClick={() => onReorder(i, i + 1)} />
                    <IconButton size="sm" icon="copy" label="Duplicate slide" disabled={slides.length >= maxSlides} onClick={() => onDuplicate(s.id)} />
                    <IconButton size="sm" icon="trash-2" label="Delete slide" variant="danger" onClick={() => onDelete(s.id)} />
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
