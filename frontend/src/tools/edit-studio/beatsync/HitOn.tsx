/** "Hits on" row of an effect card: off / always on / on every Nth beat, downbeat, kick, snare… */
import { Select, Slider } from "@/components";
import type { EditPost } from "@/viz/edit/types";
import { postDef } from "@/viz/post/registry";
import { HIT_DECAYS, HIT_LANES, HIT_LANE_TIPS, readHit, writeHit, type HitMode, type HitState } from "./hits";
import styles from "./beatsync.module.css";

const MODES: ReadonlyArray<{ value: HitMode; label: string }> = [{ value: "off", label: "Off" }, { value: "on", label: "Always on" }, ...HIT_LANES];
const EVERY = [1, 2, 4, 8].map((n) => ({ value: String(n), label: n === 1 ? "every one" : `every ${n}` }));

export function HitOn({ post, onChange }: { post: EditPost; onChange(next: EditPost, key: string): void }) {
  const specs = postDef(post.type)?.params;
  if (!specs) return null;
  const h = readHit(post, specs);
  if (!h) return null;
  const set = (patch: Partial<HitState>, key = "") => onChange(writeHit(post, specs, { ...h, ...patch }), key);
  const lane = h.mode !== "off" && h.mode !== "on";
  return (
    <div className={styles.hit} data-tip="Make this effect hit on the music: choose which beats or drum hits trigger it">
      <div className={styles.hitRow}>
        <span className={styles.hitLabel}>Hits on</span>
        <Select size="sm" data-tip={h.mode === "off" ? "Off: the effect doesn't react to the music" : h.mode === "on" ? "Always on: the effect stays at full strength" : `Hit on: ${HIT_LANE_TIPS[h.mode].toLowerCase()}`} aria-label="Hits on" value={h.mode} onChange={(mode) => set({ mode: mode as HitMode })} options={MODES.map((m) => ({ value: m.value, label: m.label }))} />
        {lane && <Select size="sm" data-tip="Hit on every marker, or only every 2nd, 4th or 8th one" aria-label="How often" value={String(h.every)} onChange={(v) => set({ every: Number(v) })} options={EVERY} />}
      </div>
      {h.mode !== "off" && (
        <div className={styles.hitRow}>
          <span className={styles.hitLabel}>Strength</span>
          <Slider data-tip="How hard each hit pushes the effect, as a share of its full range" aria-label="Strength" min={0.05} max={1} step={0.05} value={h.strength} onChange={(strength) => set({ strength }, `${post.id}:hit-strength`)} format={(v) => `${Math.round(v * 100)}%`} />
          {lane && (
            <Select size="sm" data-tip="How long each hit lasts: snappy is short and sharp, long fades out slowly" aria-label="Feel" value={String(h.decayMs)} onChange={(v) => set({ decayMs: Number(v) })} options={[...HIT_DECAYS.map((d) => ({ value: String(d.value), label: d.label })), ...(HIT_DECAYS.some((d) => d.value === h.decayMs) ? [] : [{ value: String(h.decayMs), label: `${h.decayMs} ms` }])]} />
          )}
        </div>
      )}
    </div>
  );
}
