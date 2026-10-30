/**
 * Signals (SPEC.md §6.3): every reactive input, as a per-frame 0..1 series
 * computed once from the analysis, plus cached attack/release envelopes and
 * the modulation formula. Pure and deterministic: every time can be sampled.
 */
import { Analysis, type Event2 } from "./analysis";
import type { MixGroup, ModShape, Param, SignalId } from "./types";

export interface SignalMeta {
  id: SignalId;
  label: string;
  group: "Instruments" | "Rhythm" | "Song" | "Voice" | "Words & mood" | "Drift" | "Whole song";
  mix: MixGroup | null;
}

const M = (id: SignalId, label: string, group: SignalMeta["group"], mix: MixGroup | null = null): SignalMeta => ({ id, label, group, mix });

export const SIGNALS: readonly SignalMeta[] = [
  M("mix.level", "Whole song", "Whole song"),
  M("mix.onset", "Hits", "Whole song"),
  M("mix.brightness", "Brightness", "Whole song"),
  M("mix.balance", "Left/right", "Whole song"),
  M("mix.sub", "Sub", "Whole song"),
  M("mix.bass", "Bass band", "Whole song"),
  M("mix.lowmid", "Low mids", "Whole song"),
  M("mix.mid", "Mids", "Whole song"),
  M("mix.highmid", "High mids", "Whole song"),
  M("mix.presence", "Presence", "Whole song"),
  M("mix.brilliance", "Brilliance", "Whole song"),
  M("mix.air", "Air", "Whole song"),
  M("kick", "Kick", "Instruments", "drums"),
  M("snare", "Snare", "Instruments", "drums"),
  M("hats", "Hi-hats", "Instruments", "drums"),
  M("drums.level", "Drums", "Instruments", "drums"),
  M("bass.level", "Bass", "Instruments", "bass"),
  M("vocals.level", "Vocals", "Instruments", "vocals"),
  M("other.level", "Other instruments", "Instruments", "other"),
  M("bass.onset", "Bass hits", "Instruments", "bass"),
  M("vocals.onset", "Vocal hits", "Instruments", "vocals"),
  M("other.onset", "Other hits", "Instruments", "other"),
  M("vocals.pitch", "Vocal pitch", "Voice", "vocals"),
  M("vocals.voiced", "Singing", "Voice", "vocals"),
  M("vocals.held", "Held note", "Voice", "vocals"),
  M("beat.pulse", "Beat", "Rhythm"),
  M("beat.phase", "Beat position", "Rhythm"),
  M("bar.pulse", "Bar", "Rhythm"),
  M("bar.phase", "Bar position", "Rhythm"),
  M("section.energy", "Section energy", "Song"),
  M("section.progress", "Section progress", "Song"),
  M("song.progress", "Song progress", "Song"),
  M("lift.pulse", "Build-up", "Song"),
  M("drop.pulse", "Drop", "Song"),
  M("break.pulse", "Break", "Song"),
  M("chord.change", "Chord change", "Song"),
  M("chord.hue", "Chord colour", "Song"),
  M("key.minor", "Minor key", "Song"),
  M("word.pulse", "Words", "Words & mood", "words"),
  M("word.emphasis", "Emphasised words", "Words & mood", "words"),
  M("line.progress", "Line progress", "Words & mood", "words"),
  M("line.active", "Singing a line", "Words & mood", "words"),
  M("mood.valence", "Mood (bright ↔ dark)", "Words & mood", "mood"),
  M("mood.energy", "Mood energy", "Words & mood", "mood"),
  M("lfo.slow", "Slow drift", "Drift"),
  M("lfo.mid", "Sway", "Drift"),
  M("time", "Time", "Drift"),
];

export const SIGNAL_META = new Map<SignalId, SignalMeta>(SIGNALS.map((s) => [s.id, s]));

/** Circle-of-fifths position of a pitch class, 0..1. */
export function fifthsHue(root: number): number {
  return root < 0 ? 0 : ((root * 7) % 12) / 12;
}

export const DEFAULT_ATTACK_MS = 10;
export const DEFAULT_RELEASE_MS = 180;

export function shape(x: number, s: ModShape): number {
  switch (s) {
    case "ease":
      return x * x * (3 - 2 * x);
    case "exp":
      return x * x;
    case "gate":
      return x > 0.5 ? 1 : 0;
    default:
      return x;
  }
}

/** Per-frame series and envelopes over one analysis. */
export class Signals {
  private readonly series = new Map<string, Float32Array>();
  private readonly envs = new Map<string, Float32Array>();
  readonly fps: number;
  readonly frames: number;

  constructor(readonly analysis: Analysis) {
    this.fps = analysis.fps;
    this.frames = analysis.frames;
  }

  /** Impulses at events with an exponential decay (tau ms), strength 0..1. */
  private pulses(times: ReadonlyArray<Event2 | [number, number]>, tauMs: number, unit = false): Float32Array {
    const out = new Float32Array(this.frames);
    const k = Math.exp(-1000 / (this.fps * tauMs));
    let ei = 0;
    let v = 0;
    for (let i = 0; i < this.frames; i++) {
      const t = (i / this.fps) * 1000;
      v *= k;
      while (ei < times.length && (times[ei] as Event2)[0] <= t) {
        const e = times[ei] as Event2;
        const s = unit ? 1 : e[1] / 255;
        const age = t - e[0];
        v = Math.max(v, s * Math.exp(-age / tauMs));
        ei++;
      }
      out[i] = v;
    }
    return out;
  }

  private fromFn(fn: (tMs: number) => number): Float32Array {
    const out = new Float32Array(this.frames);
    for (let i = 0; i < this.frames; i++) out[i] = fn((i / this.fps) * 1000);
    return out;
  }

  private build(id: SignalId): Float32Array {
    const a = this.analysis;
    const ch = (name: string, fallback?: string) => a.channel(name) ?? (fallback ? a.channel(fallback) : null) ?? new Float32Array(this.frames);
    const ms = (arr: number[]) => arr.map((t) => [t, 255] as Event2);
    switch (id) {
      case "kick":
        return this.pulses(a.events("kick"), 90);
      case "snare":
        return this.pulses(a.events("snare"), 110);
      case "hats":
        return this.pulses(a.events("hats"), 60);
      case "drums.level":
        return ch("drums.level", "mix.onset");
      case "bass.level":
        return ch("bass.level", "mix.bass");
      case "vocals.level":
        return ch("vocals.level", "mix.presence");
      case "other.level":
        return ch("other.level", "mix.mid");
      case "bass.onset":
        return this.pulses(a.events("bass"), 120);
      case "vocals.onset":
        return this.pulses(a.events("vocals"), 120);
      case "other.onset":
        return this.pulses(a.events("other"), 120);
      case "vocals.pitch":
        return ch("vocals.pitch");
      case "vocals.voiced":
        return ch("vocals.voiced");
      case "vocals.held": {
        const held = a.held();
        return this.fromFn((t) => {
          let v = 0;
          for (const [s, e] of held) {
            if (t < s - 150 || t > e + 150) continue;
            v = Math.max(v, Math.min(1, (t - s + 150) / 150, (e + 150 - t) / 150));
          }
          return v;
        });
      }
      case "beat.pulse":
        return this.pulses(ms(a.audio.beats), 120, true);
      case "beat.phase":
        return this.fromFn((t) => a.beatAt(t).phase);
      case "bar.pulse":
        return this.pulses(ms(a.audio.downbeats), 300, true);
      case "bar.phase":
        return this.fromFn((t) => a.barAt(t).phase);
      case "section.energy":
        return this.fromFn((t) => a.sectionAt(t)?.section.energy ?? 0.5);
      case "section.progress":
        return this.fromFn((t) => {
          const s = a.sectionAt(t)?.section;
          return s ? Math.max(0, Math.min(1, (t - s.startMs) / Math.max(1, s.endMs - s.startMs))) : 0;
        });
      case "song.progress":
        return this.fromFn((t) => Math.max(0, Math.min(1, t / Math.max(1, a.durationMs))));
      case "lift.pulse": {
        const lifts = a.events("lift");
        const barMs = a.audio.tempo > 0 ? (60000 / a.audio.tempo) * a.audio.beatsPerBar : 2000;
        return this.fromFn((t) => {
          let v = 0;
          for (const [e, s] of lifts) {
            const st = s / 255;
            if (t >= e - 2 * barMs && t < e) v = Math.max(v, st * ((t - (e - 2 * barMs)) / (2 * barMs)));
            else if (t >= e) v = Math.max(v, st * Math.exp(-(t - e) / 2000));
          }
          return v;
        });
      }
      case "drop.pulse":
        return this.pulses(a.events("drop"), 1200);
      case "break.pulse":
        return this.pulses(a.events("break"), 800);
      case "chord.change":
        return this.pulses(a.audio.chords.filter((c) => c.root >= 0).map((c) => [c.startMs, 255] as Event2), 250);
      case "chord.hue":
        return this.fromFn((t) => fifthsHue(a.chordAt(t)?.root ?? -1));
      case "key.minor":
        return this.fromFn(() => (a.audio.key.minor ? 1 : 0));
      case "word.pulse":
        return this.pulses(a.allWords().map((w) => [w.startMs, 255] as Event2), 150);
      case "word.emphasis":
        return this.pulses(a.allWords().filter((w) => w.emphasis).map((w) => [w.startMs, 255] as Event2), 400);
      case "line.progress":
        return this.fromFn((t) => {
          const l = a.lineAt(t)?.line;
          return l ? (t - l.startMs) / Math.max(1, l.endMs - l.startMs) : 0;
        });
      case "line.active":
        return this.fromFn((t) => (a.lineAt(t) ? 1 : 0));
      case "mood.valence":
        return this.fromFn((t) => (a.moodAt(t).valence + 1) / 2);
      case "mood.energy":
        return this.fromFn((t) => a.moodAt(t).energy);
      case "lfo.slow":
        return this.fromFn((t) => 0.5 + 0.5 * Math.sin((t / 1000) * Math.PI * 2 * 0.03));
      case "lfo.mid":
        return this.fromFn((t) => 0.5 + 0.5 * Math.sin((t / 1000) * Math.PI * 2 * 0.2));
      case "time":
        return this.fromFn((t) => t / 1000);
      default:
        return ch(id); // mix.* channels
    }
  }

  /** The raw per-frame series of a signal. */
  get(id: SignalId): Float32Array {
    let s = this.series.get(id);
    if (!s) {
      s = this.build(id);
      this.series.set(id, s);
    }
    return s;
  }

  /** A one-pole attack/release envelope of a signal, cached per (id, attack, release). */
  envelope(id: SignalId, attackMs = DEFAULT_ATTACK_MS, releaseMs = DEFAULT_RELEASE_MS): Float32Array {
    const key = `${id}|${attackMs}|${releaseMs}`;
    let e = this.envs.get(key);
    if (e) return e;
    const src = this.get(id);
    e = new Float32Array(src.length);
    if (id === "time" || id === "beat.phase" || id === "bar.phase") {
      e.set(src); // phases and time are never smoothed
    } else {
      const ka = Math.exp(-1000 / (this.fps * Math.max(1, attackMs)));
      const kr = Math.exp(-1000 / (this.fps * Math.max(1, releaseMs)));
      let v = src[0] ?? 0;
      for (let i = 0; i < src.length; i++) {
        const x = src[i] ?? 0;
        const k = x > v ? ka : kr;
        v = x + (v - x) * k;
        e[i] = v;
      }
    }
    this.envs.set(key, e);
    return e;
  }

  value(id: SignalId, tMs: number, attackMs?: number, releaseMs?: number): number {
    const arr = attackMs === undefined && releaseMs === undefined ? this.get(id) : this.envelope(id, attackMs, releaseMs);
    return Analysis.interp(arr, this.analysis.frameAt(tMs));
  }
}

export interface ModContext {
  signals: Signals;
  mix: Record<MixGroup, number>;
  reactivity: number;
}

/**
 * Resolves a parameter at tMs: base + Σ amount·shape(env(signal))·mixGain·reactivity,
 * where amount is a fraction of the parameter's range (max − min), clamped to [min, max].
 */
export function evalParam(p: Param, min: number, max: number, tMs: number, c: ModContext): number {
  if (typeof p === "number") return Math.max(min, Math.min(max, p));
  let v = p.base;
  const range = max - min;
  for (const m of p.mods) {
    const meta = SIGNAL_META.get(m.signal);
    if (!meta) continue;
    const x = c.signals.value(m.signal, tMs, m.attackMs ?? DEFAULT_ATTACK_MS, m.releaseMs ?? DEFAULT_RELEASE_MS);
    const gain = meta.mix ? (c.mix[meta.mix] ?? 1) : 1;
    v += m.amount * range * shape(Math.max(0, Math.min(1, x)), m.shape) * gain * c.reactivity;
  }
  return Math.max(min, Math.min(max, v));
}
