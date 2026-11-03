/**
 * An effect stack (§14.8): Add (templates or any offered type), reorder by
 * dragging the grip (or arrow keys on it), enable, remove, and each effect's
 * parameters. Used for clips, adjustment clips and the project Look.
 */
import { useRef, useState, type KeyboardEvent as RKeyboardEvent, type PointerEvent as RPointerEvent } from "react";
import { ColorSwatchPicker, IconButton, Section, Select, Switch, toast } from "@/components";
import { MAX_EFFECTS } from "@/viz/edit/schema";
import type { EditParam, EditPost } from "@/viz/edit/types";
import "@/viz/post";
import { postDef } from "@/viz/post/registry";
import type { PostType } from "@/viz/types";
import { newId } from "../doc";
import { EditParamEditor } from "./EditParamEditor";
import { EFFECT_CATALOG } from "./effectCatalog";
import { EffectPicker } from "./EffectPicker";
import { moveItem, targetIndex } from "./reorder";
import styles from "./inspector.module.css";

export function effectLabel(type: PostType): string {
  return postDef(type)?.label ?? EFFECT_CATALOG[type]?.label ?? type;
}

/** A new effect with every parameter at its default. */
export function newEffect(type: PostType): EditPost {
  const params: EditPost["params"] = {};
  for (const [k, spec] of Object.entries(postDef(type)?.params ?? {})) params[k] = spec.default;
  return { id: newId("fx"), type, enabled: true, params };
}

const optionLabel = (o: string): string => (o === "amount" ? "Its Amount (use reactions)" : o);

export interface EffectsStackProps {
  posts: readonly EditPost[];
  /** `key` is stable while one field is edited ("" for one-off changes). */
  onChange(next: EditPost[], key: string): void;
  types: readonly PostType[];
  /** The playhead in the clip's time (0 for the Look). */
  clipTimeMs: number;
  allowKeys: boolean;
  templates: boolean;
  label?: string;
}

export function EffectsStack({ posts, onChange, types, clipTimeMs, allowKeys, templates, label = "Effects" }: EffectsStackProps) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [drag, setDrag] = useState<{ id: string; to: number } | null>(null);
  const refs = useRef(new Map<string, HTMLDivElement>());
  const full = posts.length >= MAX_EFFECTS;

  const toggleOpen = (id: string) =>
    setOpen((cur) => {
      const n = new Set(cur);
      if (!n.delete(id)) n.add(id);
      return n;
    });
  const addAll = (added: EditPost[], skipped: number) => {
    if (added.length) {
      onChange([...posts, ...added], "");
      setOpen((cur) => new Set([...cur, ...added.map((p) => p.id)]));
    }
    if (skipped > 0) {
      toast({
        title: added.length ? `Added ${added.length} of ${added.length + skipped} effects` : "No room for more effects",
        description: `An effect stack holds at most ${MAX_EFFECTS} effects.`,
        tone: "warn",
      });
    }
  };
  const patch = (id: string, fn: (p: EditPost) => EditPost, key: string) => onChange(posts.map((p) => (p.id === id ? fn(p) : p)), key);
  const setParam = (id: string, name: string, value: EditParam | string | boolean, key: string) => patch(id, (p) => ({ ...p, params: { ...p.params, [name]: value } }), key);

  // Dragging by the grip: pointer capture, the drop index follows the pointer over the items.
  const onGripDown = (e: RPointerEvent<HTMLElement>, id: string) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDrag({ id, to: posts.findIndex((p) => p.id === id) });
  };
  const onGripMove = (e: RPointerEvent<HTMLElement>) => {
    if (!drag) return;
    const from = posts.findIndex((p) => p.id === drag.id);
    const rects = posts.map((p) => refs.current.get(p.id)?.getBoundingClientRect() ?? { top: 0, height: 0 });
    const to = targetIndex(rects, from, e.clientY);
    if (to !== drag.to) setDrag({ id: drag.id, to });
  };
  const onGripUp = (e: RPointerEvent<HTMLElement>) => {
    if (!drag) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    const from = posts.findIndex((p) => p.id === drag.id);
    if (from >= 0 && drag.to !== from) onChange(moveItem(posts, from, drag.to), "");
    setDrag(null);
  };
  const onGripKey = (e: RKeyboardEvent<HTMLElement>, i: number) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const to = i + (e.key === "ArrowUp" ? -1 : 1);
    if (to >= 0 && to < posts.length) onChange(moveItem(posts, i, to), "");
  };

  const dropMark = (i: number): "before" | "after" | undefined => {
    if (!drag) return undefined;
    const from = posts.findIndex((p) => p.id === drag.id);
    if (i !== drag.to || from === drag.to) return undefined;
    return drag.to < from ? "before" : "after";
  };

  return (
    <Section label={label} action={<EffectPicker types={types} stacks={templates} room={MAX_EFFECTS - posts.length} label={effectLabel} makeEffect={newEffect} onAdd={addAll} />}>
      <div className={styles.stack}>
        {posts.length === 0 && <p className={styles.hint}>No effects yet. Add one, or start from a template that reacts to markers.</p>}
        {posts.map((p, i) => {
          const def = postDef(p.type);
          const expanded = open.has(p.id);
          return (
            <div
              key={p.id}
              ref={(el) => {
                if (el) refs.current.set(p.id, el);
                else refs.current.delete(p.id);
              }}
              className={styles.item}
              data-testid="effect"
              data-dragging={drag?.id === p.id || undefined}
              data-drop={dropMark(i)}
            >
              <div className={styles.itemHead}>
                <button
                  type="button"
                  className={styles.grip}
                  aria-label={`Reorder ${effectLabel(p.type)}`}
                  onPointerDown={(e) => onGripDown(e, p.id)}
                  onPointerMove={onGripMove}
                  onPointerUp={onGripUp}
                  onPointerCancel={() => setDrag(null)}
                  onKeyDown={(e) => onGripKey(e, i)}
                >
                  <GripGlyph />
                </button>
                <button type="button" className={styles.itemName} aria-expanded={expanded} onClick={() => toggleOpen(p.id)}>
                  {effectLabel(p.type)}
                </button>
                <Switch aria-label={`Enable ${effectLabel(p.type)}`} checked={p.enabled} onChange={(enabled) => patch(p.id, (x) => ({ ...x, enabled }), "")} />
                <IconButton size="sm" icon="trash-2" label={`Remove ${effectLabel(p.type)}`} onClick={() => onChange(posts.filter((x) => x.id !== p.id), "")} />
              </div>
              {expanded && (
                <div className={styles.itemBody}>
                  {!def && <p className={styles.warn}>This effect isn&apos;t available in this build.</p>}
                  {def &&
                    Object.entries(def.params).map(([name, spec]) => {
                      const v = p.params[name];
                      if (spec.kind === "number") {
                        const value: EditParam = typeof v === "number" || (typeof v === "object" && v !== null) ? v : spec.default;
                        return (
                          <EditParamEditor
                            key={name}
                            spec={{ min: spec.min, max: spec.max, step: spec.step, label: spec.label }}
                            value={value}
                            clipTimeMs={clipTimeMs}
                            allowKeys={allowKeys}
                            allowMods
                            onChange={(next, key) => setParam(p.id, name, next, key)}
                          />
                        );
                      }
                      if (spec.kind === "enum") {
                        return (
                          <div key={name} className={styles.row}>
                            <span className={styles.label}>{spec.label}</span>
                            <Select
                              size="sm"
                              aria-label={spec.label}
                              value={typeof v === "string" ? v : spec.default}
                              onChange={(o) => setParam(p.id, name, o, "")}
                              options={spec.options.map((o) => ({ value: o, label: optionLabel(o) }))}
                            />
                          </div>
                        );
                      }
                      if (spec.kind === "bool") {
                        return <Switch key={name} label={spec.label} checked={typeof v === "boolean" ? v : spec.default} onChange={(b) => setParam(p.id, name, b, "")} />;
                      }
                      const color = typeof v === "string" && v.startsWith("#") ? v : spec.default.startsWith("#") ? spec.default : "#ffffff";
                      return (
                        <div key={name} className={styles.colorRow}>
                          <span className={styles.label}>{spec.label}</span>
                          <ColorSwatchPicker aria-label={spec.label} value={color} onChange={(c) => setParam(p.id, name, c, "ep:color")} />
                        </div>
                      );
                    })}
                </div>
              )}
            </div>
          );
        })}
        {full && <p className={styles.hint}>An effect stack holds at most {MAX_EFFECTS} effects.</p>}
      </div>
    </Section>
  );
}

function GripGlyph() {
  return (
    <svg width="10" height="14" viewBox="0 0 10 14" aria-hidden="true" focusable="false">
      {[2, 7, 12].map((y) =>
        [2, 8].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.2" fill="currentColor" />),
      )}
    </svg>
  );
}
