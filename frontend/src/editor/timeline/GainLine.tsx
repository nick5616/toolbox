/**
 * The volume line on a clip (Phase 21 SPEC §B2): the clip's `Gain` as a line
 * over its waveform. Drag the line to set the gain (the whole clip when it
 * has no keys, else the nearest key, or a new one); Ctrl+click adds a key;
 * Alt+click on a key removes it; the circles at the top corners are the fades.
 */
import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { EditClip } from "@/lib/api";
import { withClip } from "@/editor/doc";
import { useEditStudio } from "@/editor/store";
import { collapseDrag, commit } from "./actions";
import {
  clampFade,
  gainKeys,
  gainPolyline,
  nearestKey,
  parseGain,
  removeGainKey,
  serializeGain,
  setGainFlat,
  setGainKey,
  moveGainKey,
  yToDb,
  dbToY,
} from "./gain";
import type { EditParam } from "@/viz/edit/types";
import styles from "./Timeline.module.css";

const KEY_GRAB_PX = 10;
let seq = 0;

export interface GainLineProps {
  clip: EditClip;
  widthPx: number;
  heightPx: number;
  pps: number;
  locked: boolean;
}

export function GainLine({ clip, widthPx, heightPx, pps, locked }: GainLineProps) {
  const svg = useRef<SVGSVGElement>(null);
  const [readout, setReadout] = useState<string | null>(null);
  const param = parseGain(clip.gain);
  const keys = gainKeys(param);
  const len = clip.endMs - clip.startMs;
  const pts = gainPolyline(param, len, pps, heightPx);
  const fadeIn = clip.fadeInMs ?? 0;
  const fadeOut = clip.fadeOutMs ?? 0;

  /** A drag that records one undo step; `apply` gets the pointer in clip-relative ms and dB. */
  const drag = (e: ReactPointerEvent<Element>, apply: (base: EditParam, tMs: number, db: number) => EditParam | null) => {
    e.stopPropagation();
    e.preventDefault();
    if (e.button !== 0 || locked) return;
    const st = useEditStudio.getState();
    const baseDoc = st.history?.present;
    const baseClip = baseDoc?.tracks.flatMap((t) => t.clips).find((c) => c.id === clip.id);
    const el = svg.current;
    if (!baseDoc || !baseClip || !el) return;
    st.select({ kind: "clips", ids: [clip.id] });
    const key = `gain-${++seq}`;
    const startPast = st.history?.past.length ?? 0;
    const at = (ev: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect();
      const tMs = ((ev.clientX - r.left) * 1000) / useEditStudio.getState().pps;
      return { tMs: Math.max(0, Math.min(len, tMs)), db: yToDb(ev.clientY - r.top, r.height || heightPx) };
    };
    const run = (ev: { clientX: number; clientY: number }) => {
      const p = at(ev);
      const next = apply(parseGain(baseClip.gain), p.tMs, p.db);
      if (!next) return;
      setReadout(`${p.db > 0 ? "+" : ""}${p.db.toFixed(1)} dB`);
      const cur = useEditStudio.getState().history?.present;
      if (cur) useEditStudio.getState().edit(withClip(cur, clip.id, { gain: serializeGain(next) }), key);
    };
    run(e);
    const move = (ev: PointerEvent) => run(ev);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setReadout(null);
      collapseDrag(startPast, baseDoc);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  /** Makes a key where the drag starts, then keeps moving that key. */
  const dragNewKey = (e: ReactPointerEvent<SVGElement>) => {
    let seed: EditParam | null = null;
    let index = -1;
    drag(e, (p0, t, db) => {
      if (!seed) {
        seed = setGainKey(p0, t, db, len);
        index = gainKeys(seed).findIndex((k) => Math.abs(k.t - Math.round(t)) < 1);
        return seed;
      }
      return index >= 0 ? moveGainKey(seed, index, t, db, len) : seed;
    });
  };

  const onLineDown = (e: ReactPointerEvent<SVGElement>) => {
    const base = parseGain(clip.gain);
    if (e.ctrlKey || e.metaKey) {
      dragNewKey(e); // Ctrl+click: a key at the pointer (and drag it)
      return;
    }
    if (!gainKeys(base).length) {
      drag(e, (p0, _t, db) => setGainFlat(p0, db));
      return;
    }
    // With keys: grab the nearest one, else make one here.
    const r = svg.current?.getBoundingClientRect();
    const tAt = r ? ((e.clientX - r.left) * 1000) / pps : 0;
    const near = nearestKey(base, tAt, (KEY_GRAB_PX * 1000) / pps);
    if (near >= 0) drag(e, (p0, t, db) => moveGainKey(p0, near, t, db, len));
    else dragNewKey(e);
  };

  const onKeyDown = (e: ReactPointerEvent<SVGElement>, index: number) => {
    if (e.altKey) {
      e.stopPropagation();
      e.preventDefault();
      if (locked || e.button !== 0) return;
      const t = gainKeys(param)[index]?.t;
      const doc = useEditStudio.getState().history?.present;
      if (t !== undefined && doc) commit(withClip(doc, clip.id, { gain: serializeGain(removeGainKey(param, t)) }));
      return;
    }
    drag(e, (p0, t, db) => moveGainKey(p0, index, t, db, len));
  };

  const onFadeDown = (e: ReactPointerEvent<SVGElement>, side: "in" | "out") => {
    e.stopPropagation();
    e.preventDefault();
    if (e.button !== 0 || locked) return;
    const st = useEditStudio.getState();
    const baseDoc = st.history?.present;
    const el = svg.current;
    if (!baseDoc || !el) return;
    st.select({ kind: "clips", ids: [clip.id] });
    const key = `fade-${++seq}`;
    const startPast = st.history?.past.length ?? 0;
    const run = (ev: { clientX: number }) => {
      const r = el.getBoundingClientRect();
      const x = Math.max(0, Math.min(r.width, ev.clientX - r.left));
      const ms = side === "in" ? (x * 1000) / useEditStudio.getState().pps : ((r.width - x) * 1000) / useEditStudio.getState().pps;
      const cur = useEditStudio.getState().history?.present;
      if (!cur) return;
      const patch = side === "in" ? { fadeInMs: clampFade(ms, len, fadeOut) } : { fadeOutMs: clampFade(ms, len, fadeIn) };
      useEditStudio.getState().edit(withClip(cur, clip.id, patch), key);
      setReadout(`${(((side === "in" ? patch.fadeInMs : patch.fadeOutMs) ?? 0) / 1000).toFixed(2)} s fade`);
    };
    const move = (ev: PointerEvent) => run(ev);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setReadout(null);
      collapseDrag(startPast, baseDoc);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const points = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const fadeX = (ms: number): number => (ms * pps) / 1000;
  const zeroY = dbToY(0, heightPx);
  return (
    <svg
      ref={svg}
      className={styles.gain}
      width={widthPx}
      height={heightPx}
      aria-hidden="false"
      data-gain-line={clip.id}
    >
      {fadeIn > 0 && <polygon className={styles.fadeShape} points={`0,0 ${fadeX(fadeIn)},0 0,${heightPx}`} />}
      {fadeOut > 0 && <polygon className={styles.fadeShape} points={`${widthPx},0 ${widthPx - fadeX(fadeOut)},0 ${widthPx},${heightPx}`} />}
      <line className={styles.gainZero} x1={0} x2={widthPx} y1={zeroY} y2={zeroY} />
      <polyline className={styles.gainLine} points={points} />
      <polyline
        className={styles.gainHit}
        points={points}
        data-tip="Volume line: drag to set the volume (the whole clip, or the nearest key), Ctrl+click adds a key, Alt+click on a key removes it"
        onPointerDown={onLineDown}
      />
      {keys.map((k, i) => (
        <circle
          key={`${k.t}-${i}`}
          className={styles.gainKey}
          cx={(k.t * pps) / 1000}
          cy={dbToY(k.v, heightPx)}
          r={4}
          data-tip="Volume key: drag to move it, Alt+click to remove it"
          onPointerDown={(e) => onKeyDown(e, i)}
        />
      ))}
      <circle
        className={styles.fadeHandle}
        cx={Math.max(6, fadeX(fadeIn))}
        cy={5}
        r={4}
        data-tip="Fade in: drag to set how long the sound takes to come up"
        onPointerDown={(e) => onFadeDown(e, "in")}
      />
      <circle
        className={styles.fadeHandle}
        cx={Math.min(widthPx - 6, widthPx - fadeX(fadeOut))}
        cy={5}
        r={4}
        data-tip="Fade out: drag to set how long the sound takes to die away"
        onPointerDown={(e) => onFadeDown(e, "out")}
      />
      {readout && (
        <text className={styles.gainReadout} x={Math.min(widthPx - 4, 36)} y={heightPx - 4} role="status">
          {readout}
        </text>
      )}
    </svg>
  );
}
