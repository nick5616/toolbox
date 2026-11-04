/** Masks of a clip (§14.8): add rect / ellipse / path; shape params, feather, invert, op. The selected mask shows handles on the preview. */
import { IconButton, MenuButton, Section, Select, Slider, Switch } from "@/components";
import { MAX_MASKS, newMask, parseMasks, serializeMasks } from "@/viz/edit/schema";
import type { EditParam, Mask } from "@/viz/edit/types";
import { newId } from "../doc";
import { EditParamEditor, type ParamRange } from "./EditParamEditor";
import { useMaskSelection } from "./inspectorState";
import styles from "./inspector.module.css";

export const MASK_RANGES: Record<"x" | "y" | "w" | "h" | "rotation", ParamRange> = {
  x: { min: -1, max: 2, step: 0.01, label: "Centre x" },
  y: { min: -1, max: 2, step: 0.01, label: "Centre y" },
  w: { min: 0, max: 2, step: 0.01, label: "Width" },
  h: { min: 0, max: 2, step: 0.01, label: "Height" },
  rotation: { min: -3600, max: 3600, step: 1, label: "Rotation" },
};

const SHAPE_LABELS: Record<Mask["shape"], string> = { rect: "Rectangle", ellipse: "Ellipse", path: "Path" };

export interface MasksSectionProps {
  clipId: string;
  /** The clip's `masks` JSON. */
  raw: string;
  clipTimeMs: number;
  onChange(raw: string, key: string): void;
}

export function MasksSection({ clipId, raw, clipTimeMs, onChange }: MasksSectionProps) {
  const masks = parseMasks(raw).value;
  const selId = useMaskSelection((s) => (s.clipId === clipId ? s.maskId : null));
  const select = useMaskSelection((s) => s.select);
  const commit = (next: Mask[], key: string) => onChange(serializeMasks(next), key);
  const patch = (id: string, p: Partial<Mask>, key: string) => commit(masks.map((m) => (m.id === id ? { ...m, ...p } : m)), key);
  const add = (shape: Mask["shape"]) => {
    const m = newMask(newId("mk"), shape);
    commit([...masks, m], "");
    select(clipId, m.id);
  };
  const full = masks.length >= MAX_MASKS;
  const items = () => (["rect", "ellipse", "path"] as const).map((s) => ({ id: s, label: SHAPE_LABELS[s], disabled: full, onSelect: () => add(s) }));

  return (
    <Section label="Masks" tip="Show or hide only part of the clip using a shape" action={<MenuButton data-tip="Add a rectangle, ellipse or free-drawn path mask" label="Add mask" icon="plus" variant="ghost" size="sm" items={items} />}>
      <div className={styles.stack}>
        {masks.length === 0 && <p className={styles.hint}>A mask keeps only part of the clip (or hides it). Add a rectangle, ellipse or path.</p>}
        {masks.map((m, i) => {
          const selected = selId === m.id;
          const field = (k: "x" | "y" | "w" | "h" | "rotation", label?: string) => (
            <EditParamEditor
              key={k}
              spec={{ ...MASK_RANGES[k], label: label ?? MASK_RANGES[k].label }}
              value={m[k]}
              clipTimeMs={clipTimeMs}
              allowKeys
              allowMods
              onChange={(next: EditParam, key) => patch(m.id, { [k]: next }, key)}
            />
          );
          return (
            <div key={m.id} className={styles.item} data-testid="mask">
              <div className={styles.itemHead}>
                <button type="button" data-tip="Select this mask to edit it and see its handles on the preview" className={styles.itemName} aria-pressed={selected} onClick={() => select(clipId, selected ? null : m.id)}>
                  {`${i + 1}. ${SHAPE_LABELS[m.shape]}`}
                </button>
                <IconButton
                  size="sm"
                  icon="trash-2"
                  label={`Remove mask ${i + 1}`}
                  data-tip="Delete this mask"
                  onClick={() => {
                    if (selected) select(clipId, null);
                    commit(masks.filter((x) => x.id !== m.id), "");
                  }}
                />
              </div>
              {selected && (
                <div className={styles.itemBody}>
                  {field("x")}
                  {field("y")}
                  {field("w", m.shape === "path" ? "Scale x" : "Width")}
                  {field("h", m.shape === "path" ? "Scale y" : "Height")}
                  {field("rotation")}
                  {m.shape === "path" && (
                    <>
                      <Switch tip="Round the path into a curve instead of straight edges" label="Smooth curve" checked={m.smooth === true} onChange={(smooth) => patch(m.id, { smooth }, "")} />
                      <p className={styles.hint}>Drag the points on the preview. Double-click an edge to add a point, Alt-click a point to remove it.</p>
                    </>
                  )}
                  <div className={styles.stack}>
                    <span className={styles.label}>Feather</span>
                    <Slider
                      data-tip="Soften the mask edge; 0% is a hard edge"
                      aria-label="Feather"
                      min={0}
                      max={0.5}
                      step={0.005}
                      value={m.feather}
                      onChange={(feather) => patch(m.id, { feather }, `mask-feather:${m.id}`)}
                      format={(v) => `${Math.round(v * 100)}%`}
                    />
                  </div>
                  <Switch tip="Keep what is outside the shape and hide what is inside" label="Invert" checked={m.invert} onChange={(invert) => patch(m.id, { invert }, "")} />
                  <div className={styles.row} data-tip="How this mask combines with the masks above it: add, subtract or keep only the overlap">
                    <span className={styles.label}>Combine</span>
                    <Select
                      size="sm"
                      aria-label="Mask operation"
                      value={m.op}
                      onChange={(op) => patch(m.id, { op }, "")}
                      options={[
                        { value: "add", label: "Add" },
                        { value: "subtract", label: "Subtract" },
                        { value: "intersect", label: "Intersect" },
                      ]}
                    />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Section>
  );
}
