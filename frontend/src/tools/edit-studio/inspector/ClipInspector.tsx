/** The Inspector for one video, image or colour clip (§14.8). */
import { useMemo } from "react";
import { MenuButton, Section, Select, Switch } from "@/components";
import type { EditClip } from "@/lib/api";
import {
  CLIP_POST_TYPES,
  parseEffects,
  parseMasks,
  parseSpeed,
  parseTransform,
  parseTransition,
  serializeEffects,
  serializeTransform,
  serializeTransition,
  TRANSFORM_RULES,
} from "@/viz/edit/schema";
import type { ClipTransform, EditParam } from "@/viz/edit/types";
import { CutoutSection } from "../matte/CutoutSection";
import { useEditStudio, useMarkers } from "../store";
import { EffectsStack } from "./EffectsStack";
import { EditParamEditor } from "./EditParamEditor";
import { LANE_LABELS } from "./EditSignalSelect";
import { useClipTime, patchClip } from "./inspectorState";
import { kenBurns, markersInClip } from "./kenBurns";
import { MasksSection } from "./MasksSection";
import { isKeyed, paramKeys } from "./paramOps";
import { baseName, SourceSection } from "./SourceSection";
import { TransitionField } from "./TransitionField";
import styles from "./inspector.module.css";

const TRANSFORM_LABELS: Record<keyof ClipTransform, { label: string; step: number; format(v: number): string }> = {
  x: { label: "Position x", step: 0.005, format: (v) => `${(v * 100).toFixed(1)}%` },
  y: { label: "Position y", step: 0.005, format: (v) => `${(v * 100).toFixed(1)}%` },
  scale: { label: "Scale", step: 0.01, format: (v) => `${v.toFixed(2)}×` },
  rotation: { label: "Rotation", step: 0.5, format: (v) => `${v.toFixed(1)}°` },
  opacity: { label: "Opacity", step: 0.01, format: (v) => `${Math.round(v * 100)}%` },
};
const TRANSFORM_ORDER: Array<keyof ClipTransform> = ["x", "y", "scale", "rotation", "opacity"];

const FX_TARGETS = [
  { value: "clip", label: "Whole clip" },
  { value: "subject", label: "Subject only" },
  { value: "background", label: "Background only" },
];

/** Whether any param of the clip has keys (then the Inspector follows the playhead). */
function anyKeys(clip: EditClip, transform: ClipTransform): boolean {
  if (isKeyed(parseSpeed(clip.speed).value)) return true;
  if (Object.values(transform).some((p) => isKeyed(p))) return true;
  if (parseEffects(clip.effects).value.some((e) => Object.values(e.params).some((v) => typeof v === "object" && paramKeys(v).length > 0))) return true;
  return parseMasks(clip.masks).value.some((m) => [m.x, m.y, m.w, m.h, m.rotation].some((p) => isKeyed(p)));
}

export function ClipInspector({ clip }: { clip: EditClip }) {
  const fps = useEditStudio((s) => s.history?.present.fps ?? 30);
  const activeLane = useEditStudio((s) => s.activeLane);
  const mattes = useEditStudio((s) => s.mattes);
  const markers = useMarkers();
  const transform = useMemo(() => parseTransform(clip.transform).value, [clip.transform]);
  const effects = useMemo(() => parseEffects(clip.effects).value, [clip.effects]);
  const transition = useMemo(() => parseTransition(clip.in).value, [clip.in]);
  const clipTimeMs = useClipTime(clip.startMs, anyKeys(clip, transform));
  const hasSource = clip.kind === "video" || clip.kind === "image";
  const matteReady = !!clip.matte && mattes[clip.matte.id]?.ready === true;
  const scoped = (key: string) => (key ? `${clip.id}:${key}` : "");
  const commit = (patch: Partial<EditClip>, key: string) => patchClip(clip.id, patch, key);
  const setTransform = (k: keyof ClipTransform, next: EditParam, key: string) => commit({ transform: serializeTransform({ ...transform, [k]: next }) }, scoped(key));

  const title = clip.kind === "color" ? "Colour clip" : baseName(clip.path) || "Clip";
  const kbCount = markersInClip(markers, activeLane, clip.startMs, clip.endMs).length;
  const menu = () => [
    {
      id: "ken-burns",
      label: `Ken Burns on ${LANE_LABELS[activeLane].toLowerCase()}`,
      disabled: kbCount === 0,
      onSelect: () => {
        const next = kenBurns(transform, markers, activeLane, clip);
        if (next) commit({ transform: serializeTransform(next) }, "");
      },
    },
    { id: "reset-transform", label: "Reset transform", disabled: clip.transform === "", onSelect: () => commit({ transform: "" }, "") },
  ];

  return (
    <div className={styles.root} aria-label="Clip inspector">
      <div className={styles.head}>
        <h2 className={styles.title} title={clip.path || undefined}>
          {title}
        </h2>
        <MenuButton label="Clip actions" icon="ellipsis" variant="ghost" size="sm" items={menu} />
      </div>

      <SourceSection clip={clip} fps={fps} clipTimeMs={clipTimeMs} onChange={(patch, key) => commit(patch, scoped(key))} />

      <Section label="Transform">
        <div className={styles.stack}>
          {TRANSFORM_ORDER.map((k) => {
            const r = TRANSFORM_RULES[k];
            const t = TRANSFORM_LABELS[k];
            return (
              <EditParamEditor
                key={k}
                spec={{ min: r.min, max: r.max, step: t.step, label: t.label }}
                value={transform[k]}
                clipTimeMs={clipTimeMs}
                allowKeys
                allowMods
                format={t.format}
                onChange={(next, key) => setTransform(k, next, key)}
              />
            );
          })}
        </div>
      </Section>

      <EffectsStack
        posts={effects}
        types={CLIP_POST_TYPES}
        templates
        allowKeys
        clipTimeMs={clipTimeMs}
        onChange={(next, key) => commit({ effects: serializeEffects(next) }, scoped(key))}
      />
      {hasSource && effects.length > 0 && (
        <div className={styles.stack}>
          <div className={styles.row}>
            <span className={styles.label}>Effects apply to</span>
            <Select size="sm" aria-label="Effects apply to" value={clip.fxTarget || "clip"} onChange={(fxTarget) => commit({ fxTarget }, "")} options={FX_TARGETS} />
          </div>
          {(clip.fxTarget === "subject" || clip.fxTarget === "background") && !matteReady && (
            <p className={styles.warn}>This clip has no cut-out yet, so the effects apply to the whole clip.</p>
          )}
        </div>
      )}

      <TransitionField value={transition} onChange={(next, key) => commit({ in: serializeTransition(next) }, scoped(key))} />

      {hasSource && <CutoutSection clipId={clip.id} />}

      <MasksSection clipId={clip.id} raw={clip.masks} clipTimeMs={clipTimeMs} onChange={(raw, key) => commit({ masks: raw }, scoped(key))} />

      <Section label="Auto-fill">
        <Switch label="Pinned" checked={clip.pinned} onChange={(pinned) => commit({ pinned }, "")} />
        <p className={styles.hint}>Auto-fill never moves, replaces or removes a pinned clip.</p>
      </Section>
    </div>
  );
}
