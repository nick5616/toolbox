/**
 * A grid of design cards with live thumbnails reacting to the file (SPEC.md
 * §8.3, §9.1): one hidden Engine renders each visible card at 320×180 at
 * `timeMs` every 500 ms (one card per animation frame, so the UI never
 * stalls). Used by the designer's Presets tab and the VisualsPicker.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/Badge";
import { MenuButton } from "@/components/MenuButton";
import { TextField } from "@/components/TextField";
import { cx } from "@/components/cx";
import type { Analysis } from "@/viz/analysis";
import { Engine } from "@/viz/engine";
import { buildFixture } from "@/viz/fixture";
import type { Show } from "@/viz/types";
import { drawOverlay, loudestWindow, thumbSize } from "./host";
import styles from "./PresetThumbs.module.css";

export interface ThumbItem {
  id: string;
  name: string;
  description: string;
  show: Show;
  /** "mine" = a saved design, shown first with a badge. */
  kind: "preset" | "mine" | "custom";
}

export interface PresetThumbsProps {
  items: ThumbItem[];
  analysis: Analysis | null;
  /** The time the thumbnails show; null = loop the loudest 8 s. */
  timeMs: number | null;
  aspect: number;
  mode: "opaque" | "overlay";
  selectedId: string | null;
  onSelect(item: ThumbItem): void;
  /** Card menu for saved designs (rename/delete); omitted = no menu. */
  onRename?(item: ThumbItem, name: string): void;
  onDelete?(item: ThumbItem): void;
  className?: string;
}

const TICK_MS = 500;
const LOOP_MS = 8000;

let stillAnalysis: Analysis | null = null;
/** A small synthetic analysis for cards while the real one is still being made. */
function fallbackAnalysis(): Analysis {
  stillAnalysis ??= buildFixture({ durationMs: 30_000, fps: 30 });
  return stillAnalysis;
}

/** Saved designs first, otherwise the given order. */
export function orderThumbs(items: ThumbItem[]): ThumbItem[] {
  return [...items.filter((i) => i.kind === "mine"), ...items.filter((i) => i.kind !== "mine")];
}

export function PresetThumbs({ items, analysis, timeMs, aspect, mode, selectedId, onSelect, onRename, onDelete, className }: PresetThumbsProps) {
  const ordered = useMemo(() => orderThumbs(items), [items]);
  const { w, h } = useMemo(() => thumbSize(aspect), [aspect]);
  const canvases = useRef(new Map<string, HTMLCanvasElement>());
  const visible = useRef(new Set<string>());
  const engineRef = useRef<Engine | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [engineGen, setEngineGen] = useState(0);

  const live = analysis ?? null;
  const src = useMemo(() => live ?? fallbackAnalysis(), [live]);
  const loopStart = useMemo(() => loudestWindow(src, LOOP_MS), [src]);

  // Latest values for the timer without restarting it.
  const latest = useRef({ ordered, timeMs, src, loopStart, w, h, mode });
  latest.current = { ordered, timeMs, src, loopStart, w, h, mode };
  const tick = useRef(0);
  const queue = useRef<string[]>([]);
  const raf = useRef(0);
  const shown = useRef({ analysis: null as Analysis | null, show: null as Show | null });

  // One hidden engine per mode.
  useEffect(() => {
    const canvas = document.createElement("canvas");
    let engine: Engine;
    try {
      const s = latest.current;
      engine = new Engine(canvas, { width: s.w, height: s.h, mode, quality: "draft", seed: 1, fps: 15, inWorker: false });
    } catch {
      setUnavailable(true);
      return;
    }
    setUnavailable(false);
    engineRef.current = engine;
    shown.current = { analysis: null, show: null };
    setEngineGen((g) => g + 1);
    return () => {
      cancelAnimationFrame(raf.current);
      queue.current = [];
      engineRef.current = null;
      engine.dispose();
    };
  }, [mode]);

  const drawOne = useCallback(() => {
    raf.current = 0;
    const engine = engineRef.current;
    const id = queue.current.shift();
    if (queue.current.length > 0) raf.current = requestAnimationFrame(drawOne);
    if (!engine || id === undefined) return;
    const target = canvases.current.get(id);
    const item = latest.current.ordered.find((i) => i.id === id);
    if (!target || !item) return;
    const l = latest.current;
    try {
      if (engine.options.width !== l.w || engine.options.height !== l.h) engine.resize(l.w, l.h);
      if (shown.current.analysis !== l.src) {
        engine.setAnalysis(l.src);
        shown.current.analysis = l.src;
        shown.current.show = null;
      }
      engine.setShow(item.show);
      shown.current.show = item.show;
      const t = l.timeMs !== null ? l.timeMs : l.loopStart + ((tick.current * TICK_MS) % LOOP_MS);
      engine.render(Math.max(0, t));
      const ctx = target.getContext("2d");
      if (!ctx) return;
      if (l.mode === "overlay") {
        ctx.clearRect(0, 0, l.w, l.h);
        drawOverlay(engine.canvas as HTMLCanvasElement, ctx, l.w, l.h);
      } else {
        ctx.drawImage(engine.canvas as HTMLCanvasElement, 0, 0, l.w, l.h);
      }
    } catch (e) {
      console.warn("thumbnail render", e);
    }
  }, []);

  const pass = useCallback(() => {
    if (!engineRef.current) return;
    const ids = latest.current.ordered.map((i) => i.id).filter((id) => visible.current.has(id));
    if (ids.length === 0) return;
    queue.current = ids;
    if (!raf.current) raf.current = requestAnimationFrame(drawOne);
  }, [drawOne]);

  // Redraw on any input change, then every 500 ms.
  useEffect(() => {
    pass();
  }, [pass, ordered, src, timeMs, w, h, engineGen]);
  useEffect(() => {
    const id = window.setInterval(() => {
      tick.current++;
      pass();
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [pass]);

  // Only visible cards render.
  const observer = useRef<IntersectionObserver | null>(null);
  const idOf = useRef(new WeakMap<Element, string>());
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      let added = false;
      for (const e of entries) {
        const id = idOf.current.get(e.target);
        if (id === undefined) continue;
        if (e.isIntersecting) {
          if (!visible.current.has(id)) added = true;
          visible.current.add(id);
        } else visible.current.delete(id);
      }
      if (added) pass();
    });
    observer.current = io;
    for (const [id, el] of canvases.current) {
      idOf.current.set(el, id);
      io.observe(el);
    }
    return () => {
      io.disconnect();
      observer.current = null;
    };
  }, [pass]);

  const setCanvas = useCallback(
    (id: string) => (el: HTMLCanvasElement | null) => {
      const old = canvases.current.get(id);
      if (old && old !== el) {
        observer.current?.unobserve(old);
        visible.current.delete(id);
      }
      if (!el) {
        canvases.current.delete(id);
        return;
      }
      canvases.current.set(id, el);
      idOf.current.set(el, id);
      if (observer.current) observer.current.observe(el);
      else visible.current.add(id); // no IntersectionObserver: everything counts as visible
    },
    [],
  );

  const commitRename = (item: ThumbItem, value: string) => {
    setRenaming(null);
    const name = value.trim();
    if (name && name !== item.name) onRename?.(item, name);
  };

  return (
    <div className={cx(styles.grid, className)} role="group" aria-label="Designs">
      {unavailable && <p className={styles.note}>This computer&apos;s graphics can&apos;t draw live previews, so the cards show names only.</p>}
      {ordered.map((item) => {
        const selected = item.id === selectedId;
        const hasMenu = item.kind === "mine" && (onRename || onDelete);
        return (
          <div key={item.id} className={cx(styles.card, selected && styles.selected)}>
            <button type="button" className={styles.pick} aria-pressed={selected} aria-label={item.name} onClick={() => onSelect(item)}>
              <span className={styles.thumb} style={{ aspectRatio: `${w} / ${h}` }}>
                <canvas ref={setCanvas(item.id)} width={w} height={h} className={styles.canvas} />
              </span>
              <span className={styles.name}>
                {item.name}
                {item.kind === "mine" && (
                  <Badge tone="accent" className={styles.badge}>
                    Mine
                  </Badge>
                )}
              </span>
              <span className={styles.desc}>{item.description}</span>
            </button>
            {hasMenu && (
              <span className={styles.menu}>
                <MenuButton
                  label={`${item.name} options`}
                  icon="ellipsis"
                  variant="ghost"
                  size="sm"
                  items={() => [
                    ...(onRename ? [{ id: "rename", label: "Rename", icon: "pencil", onSelect: () => setRenaming(item.id) }] : []),
                    ...(onDelete ? [{ id: "delete", label: "Delete", icon: "trash-2", onSelect: () => onDelete(item) }] : []),
                  ]}
                />
              </span>
            )}
            {renaming === item.id && (
              <TextField
                autoFocus
                size="sm"
                aria-label="Design name"
                defaultValue={item.name}
                wrapperClassName={styles.rename}
                onBlur={(e) => commitRename(item, e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename(item, e.currentTarget.value);
                  else if (e.key === "Escape") setRenaming(null);
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
