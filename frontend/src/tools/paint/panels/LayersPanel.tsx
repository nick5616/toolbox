import { useEffect, useState } from "react";
import type { PaintLayer } from "@/lib/api";
import type { PaintEngine } from "@/paint/engine/types";
import { useEditor, useEngineEvents } from "../context";
import { HSlider, IconButton, MenuButton, TextButton, item, sep, type MenuEntry } from "../ui";
import styles from "./panels.module.css";

export const BLEND_MODES: Array<{ value: string; label: string }> = [
  ["normal", "Normal"],
  ["multiply", "Multiply"],
  ["screen", "Screen"],
  ["overlay", "Overlay"],
  ["add", "Add"],
  ["darken", "Darken"],
  ["lighten", "Lighten"],
  ["color-dodge", "Colour dodge"],
  ["color-burn", "Colour burn"],
  ["soft-light", "Soft light"],
  ["hard-light", "Hard light"],
  ["difference", "Difference"],
  ["hue", "Hue"],
  ["saturation", "Saturation"],
  ["color", "Colour"],
  ["luminosity", "Luminosity"],
].map(([value, label]) => ({ value: value as string, label: label as string }));

export const MAX_LAYERS = 64;

/** Layer thumbnail: the engine may offer `layerThumb(id, maxDim)` (a data URL); otherwise a chequer. */
function useLayerThumb(engine: PaintEngine, id: string, version: number): string {
  const [src, setSrc] = useState("");
  useEffect(() => {
    const fn = (engine as { layerThumb?: (id: string, maxDim: number) => Promise<string> | string }).layerThumb;
    if (!fn) return;
    let off = false;
    const t = setTimeout(() => {
      void Promise.resolve(fn.call(engine, id, 88)).then((s) => !off && setSrc(s), () => undefined);
    }, 300);
    return () => {
      off = true;
      clearTimeout(t);
    };
  }, [engine, id, version]);
  return src;
}

function Row({ layer, index, count, selected, dropOn, onDragStart, onDragOver, onDropRow }: { layer: PaintLayer; index: number; count: number; selected: boolean; dropOn: boolean; onDragStart(): void; onDragOver(): void; onDropRow(): void }) {
  const { engine } = useEditor();
  const [renaming, setRenaming] = useState<string | null>(null);
  const v = useEngineEvents(engine, ["history"]);
  const thumb = useLayerThumb(engine, layer.id, v);
  const set = (p: Parameters<PaintEngine["setLayer"]>[1]) => engine.setLayer(layer.id, p);
  const entries: MenuEntry[] = [
    item("rename", "Rename", () => setRenaming(layer.name), { icon: "rename" }),
    item("dup", "Duplicate", () => engine.duplicateLayer(layer.id), { icon: "duplicate", kbd: "Ctrl+J", disabled: count >= MAX_LAYERS, reason: `A painting can have ${MAX_LAYERS} layers` }),
    item("del", "Delete", () => engine.removeLayer(layer.id), { icon: "trash", danger: true, disabled: count <= 1, reason: "The last layer can't be deleted" }),
    sep(),
    item("clip", "Clipping mask", () => set({ clip: !layer.clip }), { icon: "clip", checked: layer.clip }),
    item("alpha", "Alpha lock", () => set({ alphaLock: !layer.alphaLock }), { icon: "alphaLock", checked: layer.alphaLock }),
    item("ref", "Reference", () => set({ reference: !layer.reference }), { icon: "reference", checked: layer.reference }),
    item("lock", "Lock", () => set({ locked: !layer.locked }), { icon: "lock", checked: layer.locked }),
    item("hide", "Hide", () => set({ hidden: !layer.hidden }), { icon: "eyeOff", checked: layer.hidden }),
    sep(),
    item("merge", "Merge down", () => engine.mergeDown(layer.id), { icon: "merge", kbd: "Ctrl+E", disabled: index === 0, reason: "There's no layer below" }),
    item("flat", "Flatten", () => engine.flatten(), { icon: "flatten", disabled: count < 2, reason: "Nothing to flatten" }),
  ];
  return (
    <div
      className={styles.layerRow}
      role="option"
      aria-selected={selected}
      tabIndex={0}
      data-hidden={layer.hidden ? "true" : undefined}
      data-drop={dropOn ? "true" : undefined}
      data-testid={`layer-${layer.id}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("application/x-paint-layer", layer.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        onDragOver();
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDropRow();
      }}
      onClick={() => engine.setActive(layer.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          engine.setActive(layer.id);
        }
      }}
    >
      {thumb ? <img className={styles.thumb} src={thumb} alt="" draggable={false} /> : <span className={styles.thumb} aria-hidden="true" />}
      <span className={styles.layerName}>
        {renaming !== null ? (
          <input
            aria-label="Layer name"
            data-tip="Layer name; Enter to keep it"
            autoFocus
            value={renaming}
            onChange={(e) => setRenaming(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={() => {
              if (renaming.trim()) set({ name: renaming.trim() });
              setRenaming(null);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setRenaming(null);
            }}
          />
        ) : (
          <span>{layer.name}</span>
        )}
        <span className={styles.layerMeta}>
          {Math.round(layer.opacity * 100)}% · {BLEND_MODES.find((b) => b.value === layer.blend)?.label ?? layer.blend}
          {layer.clip ? " · clip" : ""}
          {layer.alphaLock ? " · α" : ""}
          {layer.reference ? " · ref" : ""}
          {layer.locked ? " · locked" : ""}
        </span>
      </span>
      <span className={styles.row} onClick={(e) => e.stopPropagation()}>
        <IconButton icon={layer.hidden ? "eyeOff" : "eye"} label={layer.hidden ? `Show ${layer.name}` : `Hide ${layer.name}`} size="sm" pressed={layer.hidden} onClick={() => set({ hidden: !layer.hidden })} />
        <MenuButton icon="more" label={`${layer.name} options`} title={`${layer.name}`} size="sm" entries={entries} placement="below-end" />
      </span>
    </div>
  );
}

/** Layers: thumbnails, drag to reorder, blend and opacity of the active layer, per-layer menu. */
export function LayersPanel() {
  const { engine } = useEditor();
  useEngineEvents(engine, ["layers"]);
  const layers = [...(engine.doc.layers ?? [])].reverse(); // top first
  const n = layers.length;
  const active = layers.find((l) => l.id === engine.doc.active);
  const [over, setOver] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const dropOn = (target: PaintLayer) => {
    if (dragId && dragId !== target.id) {
      const at = (engine.doc.layers ?? []).findIndex((l) => l.id === target.id);
      if (at >= 0) engine.moveLayer(dragId, at);
    }
    setDragId(null);
    setOver(null);
  };
  return (
    <div className={styles.stack} data-testid="layers-panel">
      <div className={styles.row}>
        <TextButton
          icon="plus"
          tip="Add a layer above the selected one"
          disabled={n >= MAX_LAYERS}
          reason={`A painting can have ${MAX_LAYERS} layers`}
          onClick={() => {
            const i = (engine.doc.layers ?? []).findIndex((l) => l.id === engine.doc.active);
            engine.addLayer({}, i < 0 ? undefined : i + 1);
          }}
        >
          Layer
        </TextButton>
        <span className={styles.grow} />
        <span className={styles.layerMeta} data-tip="Layers in this painting; the limit depends on memory">
          {n} / {MAX_LAYERS}
        </span>
      </div>
      {active ? (
        <div className={styles.section}>
          <select className={styles.select} aria-label="Blend mode" data-tip="How the selected layer mixes with the ones below" value={active.blend} onChange={(e) => engine.setLayer(active.id, { blend: e.target.value as PaintLayer["blend"] })}>
            {BLEND_MODES.map((b) => (
              <option key={b.value} value={b.value}>
                {b.label}
              </option>
            ))}
          </select>
          <HSlider label="Opacity" min={0} max={100} step={1} value={Math.round(active.opacity * 100)} onChange={(v) => engine.setLayer(active.id, { opacity: v / 100 })} />
        </div>
      ) : null}
      <div className={styles.layers} role="listbox" aria-label="Layers" onDragLeave={() => setOver(null)}>
        {layers.map((l, i) => (
          <Row
            key={l.id}
            layer={l}
            index={n - 1 - i}
            count={n}
            selected={l.id === engine.doc.active}
            dropOn={over === l.id}
            onDragOver={() => setOver(l.id)}
            onDragStart={() => setDragId(l.id)}
            onDropRow={() => dropOn(l)}
          />
        ))}
      </div>
      <p className={styles.layerMeta}>Drag a layer to reorder it</p>
    </div>
  );
}
