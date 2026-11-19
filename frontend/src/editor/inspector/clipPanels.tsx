/**
 * The selected clip's constituent panels (Phase 10 SPEC §5.5): what the old
 * Inspector showed in one long column, one panel per constituent. Each reads
 * the selected clip from the store (no props), so it renders the same in a
 * click-in drawer and in its own window.
 */
import { useMemo, useState, type ReactNode } from "react";
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
  serializeSpeed,
  serializeTransform,
  serializeTransition,
  CROP_RULES,
  TRANSFORM_RULES,
} from "@/viz/edit/schema";
import type { ClipCrop, ClipTransform, EditParam } from "@/viz/edit/types";
import { drawnSize } from "../overlays/overlayGeometry";
import { sourceSize } from "../overlays/overlayContext";
import { frameOfAspect, PIP_PRESETS, pipValues, type PipPresetId } from "./pip";
import { findClip } from "@/editor/doc";
import { useEditStudio, useMarkers } from "@/editor/store";
import { CutoutSection } from "../matte/CutoutSection";
import { useEditorProfile } from "../profileContext";
import { TextSection } from "../text/TextSection";
import { VisualSection } from "../visual/VisualSection";
import { EditParamEditor } from "./EditParamEditor";
import { EffectsStack } from "./EffectsStack";
import { LANE_LABELS } from "./EditSignalSelect";
import { patchClip, useClipTime } from "./inspectorState";
import { kenBurns, markersInClip } from "./kenBurns";
import { MasksSection } from "./MasksSection";
import { isKeyed, paramKeys, writeValue } from "./paramOps";
import { SourceSection } from "./SourceSection";
import { TransitionField } from "./TransitionField";
import { velocitySpeed, VELOCITY_PRESETS } from "./velocity";
import styles from "./inspector.module.css";

const TRANSFORM_LABELS: Record<Exclude<keyof ClipTransform, "edges" | "crop">, { label: string; step: number; format(v: number): string }> = {
  x: { label: "Position x", step: 0.005, format: (v) => `${(v * 100).toFixed(1)}%` },
  y: { label: "Position y", step: 0.005, format: (v) => `${(v * 100).toFixed(1)}%` },
  scale: { label: "Scale", step: 0.01, format: (v) => `${v.toFixed(2)}×` },
  rotation: { label: "Rotation", step: 0.5, format: (v) => `${v.toFixed(1)}°` },
  opacity: { label: "Opacity", step: 0.01, format: (v) => `${Math.round(v * 100)}%` },
};
const TRANSFORM_ORDER: Array<Exclude<keyof ClipTransform, "edges" | "crop">> = ["x", "y", "scale", "rotation", "opacity"];

const CROP_EDGES: Array<{ key: keyof ClipCrop; label: string }> = [
  { key: "l", label: "Crop left" },
  { key: "r", label: "Crop right" },
  { key: "t", label: "Crop top" },
  { key: "b", label: "Crop bottom" },
];
const ZERO_CROP: ClipCrop = { l: 0, r: 0, t: 0, b: 0 };
const cropIsEmpty = (c: ClipCrop | undefined): boolean => !c || CROP_EDGES.every((e) => c[e.key] === 0);

const FX_TARGETS = [
  { value: "clip", label: "Whole clip" },
  { value: "subject", label: "Subject only" },
  { value: "background", label: "Background only" },
];

/** The one selected clip, or null (none, several, or another kind of selection). */
export function useSelectedClip(): EditClip | null {
  return useEditStudio((s) => {
    const sel = s.selection;
    const doc = s.history?.present;
    if (!doc || sel?.kind !== "clips" || sel.ids.length !== 1) return null;
    return findClip(doc, sel.ids[0] as string)?.clip ?? null;
  });
}

/** Whether any param of the clip has keys (then a panel follows the playhead). */
export function anyKeys(clip: EditClip, transform: ClipTransform): boolean {
  if (isKeyed(parseSpeed(clip.speed).value)) return true;
  if (([transform.x, transform.y, transform.scale, transform.rotation, transform.opacity] as EditParam[]).some((p) => isKeyed(p))) return true;
  if (transform.crop && Object.values(transform.crop).some((p) => isKeyed(p))) return true;
  if (parseEffects(clip.effects).value.some((e) => Object.values(e.params).some((v) => typeof v === "object" && paramKeys(v).length > 0))) return true;
  return parseMasks(clip.masks).value.some((m) => [m.x, m.y, m.w, m.h, m.rotation].some((p) => isKeyed(p)));
}

/** Common state of a clip panel: the commit helpers and the clip-time of the playhead. */
function useClipEdit(clip: EditClip) {
  const transform = useMemo(() => parseTransform(clip.transform).value, [clip.transform]);
  const clipTimeMs = useClipTime(clip.startMs, anyKeys(clip, transform));
  const scoped = (key: string) => (key ? `${clip.id}:${key}` : "");
  const commit = (patch: Partial<EditClip>, key: string) => patchClip(clip.id, patch, key);
  return { transform, clipTimeMs, scoped, commit };
}

function ForClip({ label, accepts, children }: { label: string; accepts?: (c: EditClip) => boolean; children: (clip: EditClip) => ReactNode }) {
  const clip = useSelectedClip();
  if (!clip) return <p className={styles.empty}>Select one clip on the timeline to edit its {label.toLowerCase()}.</p>;
  if (accepts && !accepts(clip)) return <p className={styles.empty}>{`This kind of clip has no ${label.toLowerCase()}.`}</p>;
  // Keyed by clip: local state (like an open editor) never carries over.
  return (
    <div className={styles.root} aria-label={`Clip ${label.toLowerCase()}`} key={clip.id}>
      {children(clip)}
    </div>
  );
}

const hasSource = (c: EditClip) => c.kind === "video" || c.kind === "image";

/** Transform, flip and blend; an adjustment clip has only its opacity. */
export function ClipTransformPanel() {
  return <ForClip label="Transform">{(clip) => <TransformBody clip={clip} />}</ForClip>;
}

function TransformBody({ clip }: { clip: EditClip }) {
  const profile = useEditorProfile();
  const fps = useEditStudio((s) => s.history?.present.fps ?? 30);
  const activeLane = useEditStudio((s) => s.activeLane);
  const markers = useMarkers();
  const { transform, clipTimeMs, scoped, commit } = useClipEdit(clip);
  const setTransform = (k: keyof ClipTransform, next: EditParam, key: string) => commit({ transform: serializeTransform({ ...transform, [k]: next }) }, scoped(key));
  const sources = useEditStudio((s) => s.sources);
  const aspect = useEditStudio((s) => s.history?.present.aspect ?? "16:9");
  const [cropOpen, setCropOpen] = useState(false);
  const setCrop = (edge: keyof ClipCrop, next: EditParam, key: string) => {
    const crop: ClipCrop = { ...(transform.crop ?? ZERO_CROP), [edge]: next };
    commit({ transform: serializeTransform({ ...transform, crop: cropIsEmpty(crop) ? undefined : crop }) }, scoped(key));
  };
  // A preset sets x, y and scale: keys at the playhead where the property is keyed, else the base.
  const applyPip = (id: PipPresetId) => {
    const frame = frameOfAspect(aspect);
    const img = drawnSize(clip.fit, sourceSize(clip, clip.path ? sources[clip.path] : undefined), frame);
    const v = pipValues(id, frame, img);
    const next: ClipTransform = { ...transform };
    for (const k of ["x", "y", "scale"] as const) {
      const r = TRANSFORM_RULES[k];
      next[k] = writeValue(transform[k], v[k], r.min, r.max, clipTimeMs);
    }
    commit({ transform: serializeTransform(next) }, "");
  };

  if (clip.kind === "adjust") {
    const r = TRANSFORM_RULES.opacity;
    return (
      <Section label="Opacity" tip="How strongly this clip's effects apply to the tracks below, 0 to 100%">
        <EditParamEditor
          spec={{ min: r.min, max: r.max, step: 0.01, label: "Opacity" }}
          value={transform.opacity as EditParam}
          clipTimeMs={clipTimeMs}
          allowKeys
          allowMods
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(next, key) => setTransform("opacity", next, key)}
        />
      </Section>
    );
  }

  const kbCount = markersInClip(markers, activeLane, clip.startMs, clip.endMs).length;
  // Ken Burns and velocity presets follow the song's markers: only where the profile has markers.
  const menu = () => [
    ...(profile.markerSignals
      ? [
          {
            id: "ken-burns",
            label: `Ken Burns on ${LANE_LABELS[activeLane].toLowerCase()}`,
            disabled: kbCount === 0,
            onSelect: () => {
              const next = kenBurns(transform, markers, activeLane, clip);
              if (next) commit({ transform: serializeTransform(next) }, "");
            },
          },
        ]
      : []),
    ...(clip.kind === "video" && profile.markerSignals
      ? VELOCITY_PRESETS.map((v) => {
          const speed = velocitySpeed(v.id, markers, clip);
          return {
            id: `velocity:${v.id}`,
            label: `Velocity: ${v.label}`,
            disabled: speed === null,
            onSelect: () => {
              if (speed !== null) commit({ speed: serializeSpeed(speed) }, "");
            },
          };
        })
      : []),
    { id: "reset-transform", label: "Reset transform", disabled: clip.transform === "", onSelect: () => commit({ transform: "" }, "") },
  ];

  return (
    <>
      <Section
        label="Transform"
        tip="Move, scale, rotate and fade the clip; diamonds add keyframes, the wave button adds music reactions"
        action={<MenuButton data-tip={profile.markerSignals ? "Ken Burns, velocity presets and reset transform" : "Reset transform"} label="Clip actions" icon="ellipsis" variant="ghost" size="sm" items={menu} />}
      >
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
          {hasSource(clip) && (
            <MenuButton
              data-tip="Put the clip in a corner, the centre or one half of the frame: sets position and scale (at the playhead where they are keyed)"
              label="Picture-in-picture"
              icon="layout-grid"
              variant="ghost"
              size="sm"
              items={() => PIP_PRESETS.map((p) => ({ id: `pip:${p.id}`, label: p.label, onSelect: () => applyPip(p.id) }))}
            />
          )}
          {hasSource(clip) && (
            <button
              type="button"
              className={styles.linkBtn}
              aria-expanded={cropOpen || !cropIsEmpty(transform.crop)}
              data-tip="Cut off the edges of the picture before it is moved and scaled; drag the edges on the preview with the Crop button"
              onClick={() => setCropOpen((o) => !o)}
            >
              {cropIsEmpty(transform.crop) ? "Crop…" : "Crop (on)"}
            </button>
          )}
          {hasSource(clip) &&
            (cropOpen || !cropIsEmpty(transform.crop)) &&
            CROP_EDGES.map((e) => (
              <EditParamEditor
                key={e.key}
                spec={{ min: CROP_RULES.min, max: CROP_RULES.max, step: 0.005, label: e.label }}
                value={(transform.crop ?? ZERO_CROP)[e.key]}
                clipTimeMs={clipTimeMs}
                allowKeys
                allowMods={false}
                format={(v) => `${(v * 100).toFixed(1)}%`}
                onChange={(next, key) => setCrop(e.key, next, key)}
              />
            ))}
          <Switch
            label="Mirror past the edges"
            tip="When the clip is moved or scaled down, mirror its edges instead of showing empty space"
            checked={transform.edges === "mirror"}
            onChange={(on) => commit({ transform: serializeTransform({ ...transform, edges: on ? "mirror" : undefined }) }, "")}
          />
        </div>
      </Section>
      <SourceSection part="frame" clip={clip} fps={fps} clipTimeMs={clipTimeMs} onChange={(patch, key) => commit(patch, scoped(key))} />
    </>
  );
}

export function ClipEffectsPanel() {
  return <ForClip label="Effects">{(clip) => <EffectsBody clip={clip} />}</ForClip>;
}

function EffectsBody({ clip }: { clip: EditClip }) {
  const mattes = useEditStudio((s) => s.mattes);
  const effects = useMemo(() => parseEffects(clip.effects).value, [clip.effects]);
  const { clipTimeMs, scoped, commit } = useClipEdit(clip);
  const matteReady = !!clip.matte && mattes[clip.matte.id]?.ready === true;
  return (
    <>
      {clip.kind === "adjust" && <p className={styles.hint}>Its effects change everything on the tracks below it, for as long as it lasts.</p>}
      <EffectsStack posts={effects} types={CLIP_POST_TYPES} templates allowKeys clipTimeMs={clipTimeMs} onChange={(next, key) => commit({ effects: serializeEffects(next) }, scoped(key))} />
      {hasSource(clip) && effects.length > 0 && (
        <div className={styles.stack}>
          <div className={styles.row}>
            <span className={styles.label}>Effects apply to</span>
            <Select size="sm" data-tip="Apply effects to the whole clip, only the cut-out subject, or only the background" aria-label="Effects apply to" value={clip.fxTarget || "clip"} onChange={(fxTarget) => commit({ fxTarget }, "")} options={FX_TARGETS} />
          </div>
          {(clip.fxTarget === "subject" || clip.fxTarget === "background") && !matteReady && (
            <p className={styles.warn}>This clip has no cut-out yet, so the effects apply to the whole clip.</p>
          )}
        </div>
      )}
    </>
  );
}

export function ClipMasksPanel() {
  return <ForClip label="Masks">{(clip) => <MasksBody clip={clip} />}</ForClip>;
}

function MasksBody({ clip }: { clip: EditClip }) {
  const { clipTimeMs, scoped, commit } = useClipEdit(clip);
  return <MasksSection clipId={clip.id} raw={clip.masks} clipTimeMs={clipTimeMs} onChange={(raw, key) => commit({ masks: raw }, scoped(key))} />;
}

export function ClipCutoutPanel() {
  return (
    <ForClip label="Cut-out" accepts={hasSource}>
      {(clip) => <CutoutSection clipId={clip.id} />}
    </ForClip>
  );
}

export function ClipSpeedPanel() {
  return (
    <ForClip label="Speed" accepts={(c) => c.kind === "video"}>
      {(clip) => <SpeedBody clip={clip} />}
    </ForClip>
  );
}

function SpeedBody({ clip }: { clip: EditClip }) {
  const fps = useEditStudio((s) => s.history?.present.fps ?? 30);
  const { clipTimeMs, scoped, commit } = useClipEdit(clip);
  return <SourceSection part="timing" clip={clip} fps={fps} clipTimeMs={clipTimeMs} onChange={(patch, key) => commit(patch, scoped(key))} />;
}

export function ClipTransitionPanel() {
  return (
    <ForClip label="Transition" accepts={(c) => c.kind !== "adjust"}>
      {(clip) => <TransitionBody clip={clip} />}
    </ForClip>
  );
}

function TransitionBody({ clip }: { clip: EditClip }) {
  const transition = useMemo(() => parseTransition(clip.in).value, [clip.in]);
  const { scoped, commit } = useClipEdit(clip);
  return <TransitionField value={transition} onChange={(next, key) => commit({ in: serializeTransition(next) }, scoped(key))} />;
}

export function ClipTextPanel() {
  return (
    <ForClip label="Text" accepts={(c) => c.kind === "text"}>
      {(clip) => <TextSection clip={clip} />}
    </ForClip>
  );
}

export function ClipVisualPanel() {
  return (
    <ForClip label="Visual" accepts={(c) => c.kind === "visual"}>
      {(clip) => <VisualSection clip={clip} />}
    </ForClip>
  );
}
