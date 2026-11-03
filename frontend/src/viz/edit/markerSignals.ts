/**
 * Marker signals `marker.<lane>` (Phase 9 SPEC §5.5): per-frame series on the
 * analysis grid built from derived markers, cached by (lane, every, sections),
 * with the attack/release envelope of `Signals.envelope`.
 */
import { Analysis } from "../analysis";
import { DEFAULT_ATTACK_MS, DEFAULT_RELEASE_MS } from "../signals";
import type { SectionLabel } from "../types";
import type { Marker, MarkerLane } from "./types";

export interface MarkerFilter {
  every?: number; // 1..16
  sections?: SectionLabel[];
}

/** Decay time constants of the impulse lanes (ms). */
export const MARKER_TAU: Readonly<Record<MarkerLane, number>> = {
  beat: 120,
  downbeat: 300,
  kick: 90,
  snare: 110,
  hats: 60,
  bass: 120,
  vocals: 120,
  other: 120,
  section: 600,
  drop: 1200,
  lift: 2000,
  break: 800,
  stop: 0,
  phrase: 400,
  word: 150,
  custom: 150,
};

/** Lanes whose pulses always peak at 1, whatever the marker strength. */
const UNIT: ReadonlySet<MarkerLane> = new Set<MarkerLane>(["beat", "downbeat", "custom"]);

export class MarkerSignals {
  private readonly byLane = new Map<MarkerLane, Marker[]>();
  private readonly series = new Map<string, Float32Array>();
  private readonly envs = new Map<string, Float32Array>();

  /**
   * @param markers deriveMarkers(...) output (timeline ms)
   * @param songStartMs the range start, so song ms = timeline ms + songStartMs
   */
  constructor(
    readonly analysis: Analysis,
    readonly markers: readonly Marker[],
    readonly songStartMs: number,
  ) {
    for (const m of markers) {
      const l = this.byLane.get(m.lane);
      if (l) l.push(m);
      else this.byLane.set(m.lane, [m]);
    }
    for (const l of this.byLane.values()) l.sort((a, b) => a.ms - b.ms);
  }

  /** The lane's markers after the `every` and `sections` filters (timeline ms). */
  filtered(lane: MarkerLane, filter: MarkerFilter): Marker[] {
    let list = this.byLane.get(lane) ?? [];
    const every = Math.max(1, Math.min(16, Math.round(filter.every ?? 1)));
    if (every > 1) list = list.filter((_, i) => i % every === 0);
    const secs = filter.sections;
    if (secs && secs.length) {
      list = list.filter((m) => {
        const s = this.analysis.sectionAt(m.ms + this.songStartMs)?.section;
        return !!s && secs.includes(s.label);
      });
    }
    return list;
  }

  private key(lane: MarkerLane, filter: MarkerFilter): string {
    const every = Math.max(1, Math.min(16, Math.round(filter.every ?? 1)));
    const secs = filter.sections && filter.sections.length ? [...filter.sections].sort().join(",") : "";
    return `${lane}|${every}|${secs}`;
  }

  /** The raw per-frame series of a lane. */
  get(lane: MarkerLane, filter: MarkerFilter = {}): Float32Array {
    const key = this.key(lane, filter);
    let s = this.series.get(key);
    if (!s) {
      s = this.build(lane, this.filtered(lane, filter));
      this.series.set(key, s);
    }
    return s;
  }

  private build(lane: MarkerLane, list: readonly Marker[]): Float32Array {
    const { frames, fps } = this.analysis;
    const out = new Float32Array(frames);
    if (!list.length || frames === 0) return out;
    const at = (m: Marker) => m.ms + this.songStartMs;
    if (lane === "stop") {
      for (const m of list) {
        const a = Math.max(0, Math.ceil(((at(m)) * fps) / 1000));
        const b = Math.min(frames, Math.ceil((((m.endMs ?? m.ms) + this.songStartMs) * fps) / 1000));
        for (let i = a; i < b; i++) out[i] = 1;
      }
      return out;
    }
    if (lane === "lift") {
      const a = this.analysis.audio;
      const barMs = a.tempo > 0 ? (60000 / a.tempo) * a.beatsPerBar : 2000;
      for (const m of list) {
        const e = at(m);
        const s = m.strength;
        const from = Math.max(0, Math.floor(((e - 2 * barMs) * fps) / 1000));
        const to = Math.min(frames - 1, Math.ceil(((e + 6 * 2000) * fps) / 1000));
        for (let i = from; i <= to; i++) {
          const t = (i / fps) * 1000;
          let v = 0;
          if (t >= e - 2 * barMs && t < e) v = s * ((t - (e - 2 * barMs)) / (2 * barMs));
          else if (t >= e) v = s * Math.exp(-(t - e) / 2000);
          if (v > (out[i] as number)) out[i] = v;
        }
      }
      return out;
    }
    const tau = MARKER_TAU[lane];
    const k = Math.exp(-1000 / (fps * tau));
    let ei = 0;
    let v = 0;
    for (let i = 0; i < frames; i++) {
      const t = (i / fps) * 1000;
      v *= k;
      while (ei < list.length && at(list[ei] as Marker) <= t) {
        const m = list[ei] as Marker;
        const s = UNIT.has(lane) ? 1 : m.strength;
        v = Math.max(v, s * Math.exp(-(t - at(m)) / tau));
        ei++;
      }
      out[i] = v;
    }
    return out;
  }

  /** The attack/release envelope of a lane's series, cached per (lane, every, sections, attack, release). */
  envelope(lane: MarkerLane, filter: MarkerFilter, attackMs = DEFAULT_ATTACK_MS, releaseMs = DEFAULT_RELEASE_MS): Float32Array {
    const key = `${this.key(lane, filter)}|${attackMs}|${releaseMs}`;
    let e = this.envs.get(key);
    if (e) return e;
    const src = this.get(lane, filter);
    e = new Float32Array(src.length);
    const fps = this.analysis.fps;
    const ka = Math.exp(-1000 / (fps * Math.max(1, attackMs)));
    const kr = Math.exp(-1000 / (fps * Math.max(1, releaseMs)));
    let v = src[0] ?? 0;
    for (let i = 0; i < src.length; i++) {
      const x = src[i] ?? 0;
      const kk = x > v ? ka : kr;
      v = x + (v - x) * kk;
      e[i] = v;
    }
    this.envs.set(key, e);
    return e;
  }

  /** The lane's pulse envelope at song ms (0..1), attack/release as Signals.envelope. */
  value(lane: MarkerLane, filter: MarkerFilter, songMs: number, attackMs?: number, releaseMs?: number): number {
    if (!this.byLane.has(lane)) return 0;
    const arr = attackMs === undefined && releaseMs === undefined ? this.get(lane, filter) : this.envelope(lane, filter, attackMs, releaseMs);
    return Analysis.interp(arr, this.analysis.frameAt(songMs));
  }
}
