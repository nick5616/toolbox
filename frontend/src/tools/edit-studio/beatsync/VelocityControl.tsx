/**
 * Velocity in the clip inspector: slow on the hit, fast between, in one
 * click. Applies to every selected video clip. The ramp is ordinary speed
 * keys; "Off" goes back to normal speed.
 */
import { create } from "zustand";
import { Select, Slider } from "@/components";
import type { EditClip } from "@/lib/api";
import { editDoc } from "../inspector/inspectorState";
import { useEditStudio, useMarkers } from "../store";
import { withVelocity } from "./applyVelocity";
import { DEFAULT_VELOCITY, VELOCITY_HITS, VELOCITY_SHAPES, type VelocitySettings } from "./velocityRamp";
import styles from "./beatsync.module.css";

/** The last velocity settings per clip (this session), so the controls show what was applied. */
const useVelocityMemo = create<{ byClip: Record<string, VelocitySettings | null>; set(ids: string[], v: VelocitySettings | null): void }>((set) => ({
  byClip: {},
  set: (ids, v) => set((st) => ({ byClip: { ...st.byClip, ...Object.fromEntries(ids.map((id) => [id, v])) } })),
}));

export function VelocityControl({ clip }: { clip: EditClip }) {
  const markers = useMarkers();
  const selection = useEditStudio((s) => s.selection);
  const memo = useVelocityMemo((s) => s.byClip[clip.id]);
  const ids = selection?.kind === "clips" && selection.ids.includes(clip.id) ? selection.ids : [clip.id];
  const current: VelocitySettings | null = memo === undefined ? null : memo;
  const keyed = clip.speed.includes("keys");

  const apply = (v: VelocitySettings | null, key = "") => {
    const sources = useEditStudio.getState().sources;
    useVelocityMemo.getState().set(ids, v);
    const want = new Set(ids);
    editDoc((p) => ({ ...p, tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (want.has(c.id) ? withVelocity(c, v, markers, sources) : c)) })) }), key);
  };
  const v = current ?? DEFAULT_VELOCITY;
  const many = ids.length > 1 ? ` (${ids.length} clips)` : "";
  return (
    <div className={styles.velocity} data-tip="Velocity: the clip slows right on the hit and speeds up between hits, without running out of footage">
      <div className={styles.hitRow}>
        <span className={styles.hitLabel}>Velocity</span>
        <Select
          size="sm"
          aria-label="Velocity"
          data-tip={`How the speed moves with the music${many}`}
          value={current ? current.shape : keyed ? "custom" : "off"}
          onChange={(shape) => apply(shape === "off" ? null : { ...v, shape: shape as VelocitySettings["shape"] })}
          options={[
            { value: "off", label: "Off (normal speed)" },
            ...VELOCITY_SHAPES.map((s) => ({ value: s.value, label: s.label })),
            ...(keyed && !current ? [{ value: "custom", label: "Your own speed keys" }] : []),
          ]}
        />
      </div>
      {current && (
        <>
          <div className={styles.hitRow}>
            <span className={styles.hitLabel}>Slow on</span>
            <Select size="sm" aria-label="Slow on" data-tip="Where the slow moments land: the cut, or every beat, kick… inside the clip" value={v.hits} onChange={(hits) => apply({ ...v, hits: hits as VelocitySettings["hits"] })} options={VELOCITY_HITS.map((h) => ({ value: h.value, label: h.label }))} />
          </div>
          <div className={styles.hitRow}>
            <span className={styles.hitLabel}>Intensity</span>
            <Slider aria-label="Intensity" data-tip="How extreme the ramp is: a gentle sway to a hard slow-mo snap" min={0.1} max={1} step={0.05} value={v.intensity} onChange={(intensity) => apply({ ...v, intensity }, `${clip.id}:velocity`)} format={(x) => `${Math.round(x * 100)}%`} />
          </div>
          <p className={styles.note}>The clip plays as much footage as before: the ramp only changes the feel. Fine-tune the speed keys below.</p>
        </>
      )}
    </div>
  );
}
