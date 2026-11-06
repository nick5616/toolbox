/** The Clip inspector's Moments section (§24.3): footage moments and song accents in the clip, each with a Use toggle and an effect. */
import { useMemo, useState } from "react";
import { Button, Section, Select, Slider, Spinner, Switch, toast } from "@/components";
import type { EditClip } from "@/lib/api";
import { parseEffects, parseSpeed, serializeEffects, serializeSpeed } from "@/viz/edit/schema";
import { useEditStudio, useMarkers } from "@/editor/store";
import { patchClip } from "@/editor/inspector/inspectorState";
import styles from "./moments.module.css";
import {
  accentMoments,
  applyUnuse,
  applyUse,
  beatLengthMs,
  clipMoments,
  DEFAULT_EFFECT,
  EFFECT_CHOICES,
  effectChoice,
  footageMoments,
  formatMoment,
  KIND_LABELS,
  momentTip,
  usedEffect,
  type ClipFx,
  type ClipMoment,
  type MomentEffect,
} from "./logic";
import { useFootageMoments, useMoments } from "./store";

const EFFECT_OPTIONS = EFFECT_CHOICES.map((e) => ({ value: e.id, label: e.label }));

export function MomentsSection({ clip }: { clip: EditClip }) {
  const fps = useEditStudio((s) => s.history?.present.fps ?? 30);
  const markers = useMarkers();
  const strength = useMoments((s) => s.strength);
  const footage = useFootageMoments(clip.kind === "video" ? clip.path : "", fps);
  const [choice, setChoice] = useState<Record<string, MomentEffect>>({});

  const fx = useMemo<ClipFx>(() => ({ effects: parseEffects(clip.effects).value, speed: parseSpeed(clip.speed).value }), [clip.effects, clip.speed]);
  const rows = useMemo(() => {
    const f = footageMoments(clip, fps, fx.speed, footage.moments);
    return clipMoments(f, accentMoments(clip, markers));
  }, [clip, fps, fx.speed, footage.moments, markers]);
  const lenMs = clip.endMs - clip.startMs;

  const ctxFor = (m: ClipMoment, s = strength) => ({ fps, beatMs: beatLengthMs(markers, m.timelineMs), lenMs, strength: s });
  const effectOf = (m: ClipMoment): MomentEffect => usedEffect(fx, m.clipMs, fps) ?? choice[m.id] ?? DEFAULT_EFFECT[m.kind];

  const commit = (next: ClipFx, key: string) => patchClip(clip.id, { effects: serializeEffects(next.effects), speed: serializeSpeed(next.speed) }, key);

  const toggle = (m: ClipMoment, on: boolean, effect: MomentEffect) => {
    if (!on) {
      commit(applyUnuse(fx, m.clipMs, ctxFor(m)), "");
      return;
    }
    const next = applyUse(fx, m.clipMs, m.strength, effect, ctxFor(m));
    if (next) commit(next, "");
    else toast({ title: "No room for that effect here: too many keyframes or effects, or the clip is too short", tone: "warn" });
  };

  const useAll = () => {
    let cur = fx;
    let skipped = 0;
    for (const m of rows) {
      if (usedEffect(cur, m.clipMs, fps)) continue;
      const next = applyUse(cur, m.clipMs, m.strength, effectOf(m), ctxFor(m));
      if (next) cur = next;
      else skipped++;
    }
    commit(cur, "");
    if (skipped) toast({ title: `${skipped} moment${skipped === 1 ? "" : "s"} skipped: a parameter can hold at most 64 keyframes`, tone: "warn" });
  };

  const clearAll = () => {
    let cur = fx;
    for (const m of rows) cur = applyUnuse(cur, m.clipMs, ctxFor(m));
    commit(cur, "");
  };

  // Rewrites every used moment at a new strength (one undo step while the slider moves).
  const setStrength = (s: number) => {
    useMoments.getState().setStrength(s);
    let cur = fx;
    for (const m of rows) {
      const e = usedEffect(cur, m.clipMs, fps);
      if (!e || e === "freeze") continue;
      const next = applyUse(cur, m.clipMs, m.strength, e, ctxFor(m, s));
      if (next) cur = next;
    }
    if (cur !== fx) commit(cur, `${clip.id}:moments-strength`);
  };

  const used = rows.filter((m) => usedEffect(fx, m.clipMs, fps) !== null).length;

  return (
    <Section label="Moments" tip="Stand-out instants in this clip: shot changes and bursts of movement in the footage, and the song's accents. Use puts keyframes there that you can edit afterwards" action={footage.state === "loading" ? <Spinner size={14} /> : undefined}>
      <div className={styles.root} data-testid="moments">
        {footage.state === "error" && (
          <p className={styles.warn}>
            Couldn&apos;t read this footage&apos;s moments{footage.error ? `: ${footage.error}` : ""}.{" "}
            <Button size="sm" variant="ghost" data-tip="Try reading the footage's moments again" onClick={() => useMoments.getState().ensure(clip.path, fps, true)}>
              Retry
            </Button>
          </p>
        )}
        {footage.state === "loading" && <p className={styles.hint}>Looking for shot changes and bursts of movement…</p>}
        {rows.length === 0 && footage.state !== "loading" && <p className={styles.hint}>No stand-out moments in this clip.</p>}
        {rows.length > 0 && (
          <>
            <div className={styles.bar}>
              <Button size="sm" icon="sparkles" data-tip="Put an effect on every moment below, using each row's effect" onClick={useAll}>
                Use all
              </Button>
              <Button size="sm" variant="ghost" disabled={used === 0} data-tip="Remove the keyframes Use wrote for every moment" onClick={clearAll}>
                Clear
              </Button>
              <span className={styles.count} data-tip="Moments in use out of all moments in this clip">
                {used} of {rows.length} in use
              </span>
            </div>
            <div className={styles.strength}>
              <span className={styles.label}>Strength</span>
              <Slider aria-label="Moment strength" data-tip="How hard the pulses hit; stronger moments hit harder still. Changing it updates the moments in use" min={0} max={1} step={0.05} value={strength} format={(v) => `${Math.round(v * 100)}%`} onChange={setStrength} />
            </div>
            <ul className={styles.list} aria-label="Moments in this clip">
              {rows.map((m) => {
                const e = effectOf(m);
                const on = usedEffect(fx, m.clipMs, fps) !== null;
                const label = `${KIND_LABELS[m.kind]} at ${formatMoment(m.clipMs)}`;
                return (
                  <li key={m.id} className={styles.row} data-kind={m.kind} data-used={on || undefined}>
                    <span className={styles.dot} data-kind={m.kind} aria-hidden="true" />
                    <span className={styles.what} data-tip={momentTip(m.kind, m.clipMs, m.strength)}>
                      <span className={styles.time}>{formatMoment(m.clipMs)}</span>
                      <span className={styles.kind}>{KIND_LABELS[m.kind]}</span>
                    </span>
                    <Select
                      size="sm"
                      aria-label={`Effect for ${label}`}
                      data-tip={`${effectChoice(e).tip}. Pick another to change what this moment does`}
                      value={e}
                      options={EFFECT_OPTIONS}
                      onChange={(next) => {
                        setChoice((c) => ({ ...c, [m.id]: next }));
                        if (on) toggle(m, true, next);
                      }}
                    />
                    <Switch aria-label={`Use ${label}`} tip="Put this effect on the moment (adds keyframes); turn off to remove them" checked={on} onChange={(v) => toggle(m, v, e)} />
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </Section>
  );
}
