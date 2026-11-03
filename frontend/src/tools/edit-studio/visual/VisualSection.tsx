/** The Inspector section of a visual clip: the layer, the palette and every layer parameter (Part B, FX5). */
import { Icon, Section, Select, Switch, ColorSwatchPicker, cx } from "@/components";
import type { EditClip } from "@/lib/api";
import { mergeVisualParams } from "@/viz/edit/visualClip";
import { parseVisualClip, serializeVisualClip } from "@/viz/edit/schema";
import type { EditParam } from "@/viz/edit/types";
import { layerDef, type LayerDef } from "@/viz/layers/registry";
import type { LayerType, PaletteId } from "@/viz/types";
import { EditParamEditor } from "../inspector/EditParamEditor";
import { currentClip, patchClip, useClipTime } from "../inspector/inspectorState";
import { isKeyed } from "../inspector/paramOps";
import { PALETTE_OPTIONS, offeredGroups, suggestedLayers } from "./visualInfo";
import styles from "./visual.module.css";

const COLOR_REFS = ["c0", "c1", "c2", "c3", "accent", "glow", "bg"] as const;
const COLOR_REF_LABEL: Record<string, string> = { c0: "Palette 1", c1: "Palette 2", c2: "Palette 3", c3: "Palette 4", accent: "Accent", glow: "Glow", bg: "Background", custom: "Custom colour" };
const optionLabel = (o: string) => (o ? o.charAt(0).toUpperCase() + o.slice(1).replace(/[-_]/g, " ") : o);

function LayerButton({ def, current, onPick, scope }: { def: LayerDef; current: LayerType; onPick: (t: LayerType) => void; scope: string }) {
  return (
    <button type="button" className={cx(styles.layer, def.type === current && styles.layerOn)} aria-pressed={def.type === current} aria-label={`${scope}: ${def.label}`} onClick={() => onPick(def.type)}>
      <Icon name={def.icon} size={14} />
      <span>{def.label}</span>
    </button>
  );
}

export function VisualSection({ clip }: { clip: EditClip }) {
  const visual = parseVisualClip(clip.visual).value;
  const def = layerDef(visual.layer);
  const merged = def ? mergeVisualParams(def.params, visual.params) : {};
  const keyed = Object.values(merged).some((v) => typeof v !== "string" && typeof v !== "boolean" && isKeyed(v));
  const clipTimeMs = useClipTime(clip.startMs, keyed);

  const write = (next: typeof visual, key: string) => patchClip(clip.id, { visual: serializeVisualClip(next) }, key);
  /** Edits from the freshest clip state (a drag fires many changes between renders). */
  const edit = (fn: (v: typeof visual) => typeof visual, key = "") => {
    const c = currentClip(clip.id);
    write(fn(parseVisualClip(c ? c.visual : clip.visual).value), key);
  };
  const setParam = (name: string, value: EditParam | string | boolean, key = "") => edit((v) => ({ ...v, params: { ...v.params, [name]: value } }), key);

  const groups = offeredGroups();
  const suggested = suggestedLayers();
  const pick = (layer: LayerType) => {
    if (layer !== visual.layer) edit((v) => ({ ...v, layer, params: {} }));
  };

  return (
    <Section label="Visual">
      <div className={styles.stack}>
        {suggested.length > 0 && (
          <div className={styles.stack} role="group" aria-label="Suggested layers">
            <p className={styles.groupLabel}>Suggested</p>
            <div className={styles.grid}>
              {suggested.map((d) => (
                <LayerButton key={d.type} def={d} current={visual.layer} onPick={pick} scope="Suggested" />
              ))}
            </div>
          </div>
        )}
        {groups.map((g) => (
          <div key={g.group} className={styles.stack} role="group" aria-label={g.label}>
            <p className={styles.groupLabel}>{g.label}</p>
            <div className={styles.grid}>
              {g.layers.map((d) => (
                <LayerButton key={d.type} def={d} current={visual.layer} onPick={pick} scope={g.label} />
              ))}
            </div>
          </div>
        ))}
        <div className={styles.row}>
          <span className={styles.label}>Palette</span>
          <Select size="sm" aria-label="Palette" value={visual.palette} onChange={(palette: PaletteId) => edit((v) => ({ ...v, palette }))} options={PALETTE_OPTIONS} />
        </div>
        {def &&
          Object.entries(def.params).map(([name, spec]) => {
            const v = merged[name];
            if (spec.kind === "number") {
              const value: EditParam = v !== undefined && typeof v !== "string" && typeof v !== "boolean" ? v : spec.default;
              return (
                <EditParamEditor
                  key={`${visual.layer}:${name}`}
                  spec={{ min: spec.min, max: spec.max, step: spec.step, label: spec.label }}
                  value={value}
                  clipTimeMs={clipTimeMs}
                  allowKeys
                  allowMods
                  onChange={(next, key) => setParam(name, next, key)}
                />
              );
            }
            if (spec.kind === "enum") {
              return (
                <div key={`${visual.layer}:${name}`} className={styles.row}>
                  <span className={styles.label}>{spec.label}</span>
                  <Select
                    size="sm"
                    aria-label={spec.label}
                    value={typeof v === "string" ? v : spec.default}
                    onChange={(o) => setParam(name, o)}
                    options={spec.options.map((o) => ({ value: o, label: optionLabel(o) }))}
                  />
                </div>
              );
            }
            if (spec.kind === "bool") {
              return <Switch key={`${visual.layer}:${name}`} label={spec.label} checked={typeof v === "boolean" ? v : spec.default} onChange={(b) => setParam(name, b)} />;
            }
            const str = typeof v === "string" ? v : spec.default;
            const isRef = (COLOR_REFS as readonly string[]).includes(str);
            const hex = /^#[0-9a-f]{6}$/i.test(str) ? str : "#ffffff";
            return (
              <div key={`${visual.layer}:${name}`} className={styles.colorRow} role="group" aria-label={spec.label}>
                <div className={styles.row}>
                  <span className={styles.label}>{spec.label}</span>
                  <Select
                    size="sm"
                    aria-label={`${spec.label} source`}
                    value={isRef ? str : "custom"}
                    onChange={(o) => setParam(name, o === "custom" ? hex : o)}
                    options={[...COLOR_REFS, "custom"].map((o) => ({ value: o, label: COLOR_REF_LABEL[o] ?? o }))}
                  />
                </div>
                {!isRef && <ColorSwatchPicker aria-label={`${spec.label} colour`} value={hex} onChange={(c) => setParam(name, c, `vc:${name}`)} />}
              </div>
            );
          })}
      </div>
    </Section>
  );
}
