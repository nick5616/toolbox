/** Layers (SPEC.md §8.3, Advanced): scenes, the layer stack, params with reactions, and post effects. */
import { useEffect, useMemo, useState } from "react";
import { Button, Icon, IconButton, SegmentedControl, Select, Slider, cx } from "@/components";
import { layerDef, layerDefs, type LayerDef } from "@/viz/layers/registry";
import { postDef, postDefs } from "@/viz/post/registry";
import type { Blend, LayerConfig, PostConfig, PostType, Show } from "@/viz/types";
import { MAX_LAYERS_PER_SCENE } from "@/viz/types";
import { ParamEditor } from "./controls";
import {
  addLayer,
  addPost,
  canAddLayer,
  deleteLayer,
  duplicateLayer,
  moveLayer,
  postList,
  removePost,
  setLayerBlend,
  setLayerOpacity,
  setLayerParam,
  setPostParam,
  togglePost,
  toggleLayer,
  type PostScope,
} from "./model";
import type { TabProps } from "./ReactionsTab";
import styles from "./designer.module.css";

const GROUPS: Array<{ id: LayerDef["group"]; label: string }> = [
  { id: "background", label: "Backgrounds" },
  { id: "shape", label: "Shapes" },
  { id: "particles", label: "Particles" },
  { id: "accent", label: "Accents" },
  { id: "highway", label: "Highway" },
  { id: "motif", label: "Motifs" },
];

const BLENDS: Array<{ value: Blend; label: string }> = [
  { value: "normal", label: "Normal" },
  { value: "add", label: "Add" },
  { value: "screen", label: "Screen" },
  { value: "multiply", label: "Multiply" },
];

function PostEditor({ show, scope, onChange }: { show: Show; scope: PostScope; onChange(show: Show): void }) {
  const list = postList(show, scope);
  const [adding, setAdding] = useState<PostType | "">("");
  const [openId, setOpenId] = useState("");
  const free = postDefs().filter((d) => !list.some((p) => p.type === d.type));
  return (
    <div className={styles.postBox}>
      {list.length === 0 && <p className={styles.hint}>No effects here.</p>}
      {list.map((pc: PostConfig) => {
        const def = postDef(pc.type);
        const open = openId === pc.id;
        return (
          <div key={pc.id} className={styles.postRow}>
            <div className={styles.layerRow}>
              <IconButton size="sm" icon={pc.enabled ? "eye" : "eye-off"} label={`${pc.enabled ? "Turn off" : "Turn on"} ${def?.label ?? pc.type}`} onClick={() => onChange(togglePost(show, scope, pc.id))} />
              <button type="button" className={styles.layerName} aria-expanded={open} onClick={() => setOpenId(open ? "" : pc.id)}>
                {def?.label ?? pc.type}
              </button>
              <IconButton size="sm" icon="trash-2" label={`Remove ${def?.label ?? pc.type}`} onClick={() => onChange(removePost(show, scope, pc.id))} />
            </div>
            {open && def && (
              <div className={styles.layerParams}>
                {Object.entries(def.params).map(([k, spec]) => (
                  <ParamEditor key={k} spec={spec} value={pc.params[k]} onChange={(v) => onChange(setPostParam(show, scope, pc.id, k, v))} />
                ))}
              </div>
            )}
          </div>
        );
      })}
      {free.length > 0 && (
        <div className={styles.addRow}>
          <Select size="sm" aria-label="Effect" value={adding} onChange={(v) => setAdding(v as PostType | "")} options={[{ value: "", label: "Add an effect…" }, ...free.map((d) => ({ value: d.type, label: d.label }))]} />
          <Button
            size="sm"
            icon="plus"
            disabled={!adding}
            onClick={() => {
              if (adding) onChange(addPost(show, scope, adding));
              setAdding("");
            }}
          >
            Add
          </Button>
        </div>
      )}
    </div>
  );
}

export function LayersTab({ show, onChange }: TabProps) {
  const [sceneId, setSceneId] = useState(show.scenes[0]?.id ?? "");
  const [selected, setSelected] = useState("");
  const [catalogue, setCatalogue] = useState(false);
  const [dragFrom, setDragFrom] = useState<number | null>(null);

  const scene = show.scenes.find((s) => s.id === sceneId) ?? show.scenes[0];
  useEffect(() => {
    if (scene && scene.id !== sceneId) setSceneId(scene.id);
  }, [scene, sceneId]);

  const defs = useMemo(() => layerDefs(), []);
  if (!scene) return null;
  const n = scene.layers.length;
  // The stack reads top-down like a layer panel: the last layer draws on top.
  const rows = scene.layers.map((l, i) => ({ l, i })).reverse();
  const sel: LayerConfig | undefined = scene.layers.find((l) => l.id === selected);
  const selDef = sel ? layerDef(sel.type) : undefined;
  const full = !canAddLayer(show, scene.id);

  return (
    <div className={styles.tabBody}>
      <SegmentedControl
        size="sm"
        aria-label="Scene"
        value={scene.id}
        onChange={(id) => {
          setSceneId(id);
          setSelected("");
        }}
        options={show.scenes.map((s) => ({ value: s.id, label: s.name || s.id }))}
      />

      <div className={styles.stackHead}>
        <span className={styles.paramLabel}>
          Layers <span className={styles.count}>{n}/{MAX_LAYERS_PER_SCENE}</span>
        </span>
        <Button size="sm" icon="plus" variant="secondary" aria-expanded={catalogue} disabled={full} onClick={() => setCatalogue((c) => !c)}>
          Add layer
        </Button>
      </div>

      {catalogue && !full && (
        <div className={styles.catalogue} role="group" aria-label="Layer catalogue">
          {GROUPS.map((g) => {
            const items = defs.filter((d) => d.group === g.id);
            if (items.length === 0) return null;
            return (
              <div key={g.id} className={styles.catGroup}>
                <div className={styles.catTitle}>{g.label}</div>
                <div className={styles.catItems}>
                  {items.map((d) => (
                    <button
                      key={d.type}
                      type="button"
                      className={styles.catItem}
                      onClick={() => {
                        onChange(addLayer(show, scene.id, d.type));
                        setCatalogue(false);
                      }}
                    >
                      <Icon name={d.icon} size={14} />
                      <span>{d.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ul className={styles.stack} aria-label="Layer stack">
        {rows.map(({ l, i }) => {
          const def = layerDef(l.type);
          return (
            <li
              key={l.id}
              className={cx(styles.layerItem, selected === l.id && styles.layerSelected, !l.enabled && styles.layerOff)}
              draggable
              onDragStart={(e) => {
                setDragFrom(i);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => {
                if (dragFrom !== null) e.preventDefault();
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragFrom !== null && dragFrom !== i) onChange(moveLayer(show, scene.id, dragFrom, i));
                setDragFrom(null);
              }}
              onDragEnd={() => setDragFrom(null)}
            >
              <div className={styles.layerRow}>
                <Icon name="grip-vertical" size={14} className={styles.grip} />
                <IconButton size="sm" icon={l.enabled ? "eye" : "eye-off"} label={`${l.enabled ? "Hide" : "Show"} ${def?.label ?? l.type} (${l.id})`} onClick={() => onChange(toggleLayer(show, scene.id, l.id))} />
                <button type="button" className={styles.layerName} aria-pressed={selected === l.id} onClick={() => setSelected(selected === l.id ? "" : l.id)}>
                  <Icon name={def?.icon ?? "box"} size={14} />
                  <span>{def?.label ?? l.type}</span>
                  {l.id !== l.type && <span className={styles.layerId}>{l.id}</span>}
                </button>
                <IconButton size="sm" icon="chevron-up" label={`Move ${l.id} up`} disabled={i === n - 1} onClick={() => onChange(moveLayer(show, scene.id, i, i + 1))} />
                <IconButton size="sm" icon="chevron-down" label={`Move ${l.id} down`} disabled={i === 0} onClick={() => onChange(moveLayer(show, scene.id, i, i - 1))} />
                <IconButton size="sm" icon="copy" label={`Duplicate ${l.id}`} disabled={full} onClick={() => onChange(duplicateLayer(show, scene.id, l.id))} />
                <IconButton
                  size="sm"
                  icon="trash-2"
                  label={`Delete ${l.id}`}
                  onClick={() => {
                    if (selected === l.id) setSelected("");
                    onChange(deleteLayer(show, scene.id, l.id));
                  }}
                />
              </div>
            </li>
          );
        })}
      </ul>

      {sel && selDef && (
        <div className={styles.layerParams} role="group" aria-label={`${selDef.label} settings`}>
          <label className={styles.inline}>
            <span className={styles.paramLabel}>Blend</span>
            <Select size="sm" aria-label="Blend" value={sel.blend} onChange={(b) => onChange(setLayerBlend(show, scene.id, sel.id, b))} options={BLENDS} />
          </label>
          <ParamEditor spec={{ kind: "number", label: "Opacity", min: 0, max: 1, default: 1 }} value={sel.opacity} onChange={(v) => onChange(setLayerOpacity(show, scene.id, sel.id, v as number))} />
          {Object.entries(selDef.params).map(([k, spec]) => (
            <ParamEditor key={k} spec={spec} value={sel.params[k]} onChange={(v) => onChange(setLayerParam(show, scene.id, sel.id, k, v))} />
          ))}
        </div>
      )}

      <div className={styles.divider} />
      <div className={styles.paramLabel}>Effects in {scene.name || scene.id}</div>
      <PostEditor show={show} scope={scene.id} onChange={onChange} />
      <div className={styles.paramLabel}>Effects on everything</div>
      <PostEditor show={show} scope="global" onChange={onChange} />
    </div>
  );
}
