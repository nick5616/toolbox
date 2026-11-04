/** The Inspector for an adjustment clip: effects, opacity, masks (§14.8). */
import { useMemo } from "react";
import { Section } from "@/components";
import type { EditClip } from "@/lib/api";
import { CLIP_POST_TYPES, parseEffects, parseMasks, parseTransform, serializeEffects, serializeTransform, TRANSFORM_RULES } from "@/viz/edit/schema";
import type { EditParam } from "@/viz/edit/types";
import { EffectsStack } from "./EffectsStack";
import { EditParamEditor } from "./EditParamEditor";
import { patchClip, useClipTime } from "./inspectorState";
import { MasksSection } from "./MasksSection";
import { isKeyed, paramKeys } from "./paramOps";
import styles from "./inspector.module.css";

export function AdjustInspector({ clip }: { clip: EditClip }) {
  const transform = useMemo(() => parseTransform(clip.transform).value, [clip.transform]);
  const effects = useMemo(() => parseEffects(clip.effects).value, [clip.effects]);
  const live =
    isKeyed(transform.opacity) ||
    effects.some((e) => Object.values(e.params).some((v) => typeof v === "object" && paramKeys(v).length > 0)) ||
    parseMasks(clip.masks).value.some((m) => [m.x, m.y, m.w, m.h, m.rotation].some((p) => isKeyed(p)));
  const clipTimeMs = useClipTime(clip.startMs, live);
  const scoped = (key: string) => (key ? `${clip.id}:${key}` : "");
  const commit = (patch: Partial<EditClip>, key: string) => patchClip(clip.id, patch, key);
  const r = TRANSFORM_RULES.opacity;

  return (
    <div className={styles.root} aria-label="Adjustment clip inspector">
      <div className={styles.head}>
        <h2 className={styles.title}>Adjustment clip</h2>
      </div>
      <p className={styles.hint}>Its effects change everything on the tracks below it, for as long as it lasts.</p>
      <EffectsStack
        posts={effects}
        types={CLIP_POST_TYPES}
        templates
        allowKeys
        clipTimeMs={clipTimeMs}
        onChange={(next, key) => commit({ effects: serializeEffects(next) }, scoped(key))}
      />
      <Section label="Opacity" tip="How strongly this clip's effects apply to the tracks below, 0 to 100%">
        <EditParamEditor
          spec={{ min: r.min, max: r.max, step: 0.01, label: "Opacity" }}
          value={transform.opacity as EditParam}
          clipTimeMs={clipTimeMs}
          allowKeys
          allowMods
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(next, key) => commit({ transform: serializeTransform({ ...transform, opacity: next }) }, scoped(key))}
        />
      </Section>
      <MasksSection clipId={clip.id} raw={clip.masks} clipTimeMs={clipTimeMs} onChange={(raw, key) => commit({ masks: raw }, scoped(key))} />
    </div>
  );
}
