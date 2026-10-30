/**
 * A deterministic synthetic analysis (120 bpm, intro/verse/chorus/drop/outro,
 * Am–F–C–G, timed lines). Used by tests and VizLab so visuals can be built
 * and checked without analysing a real song.
 */
import { Analysis, type AudioDoc, type Block, type Event2, type TextDoc, type TextLine } from "./analysis";
import type { Emotion, Motif, SectionLabel } from "./types";

export interface FixtureOptions {
  durationMs?: number;
  fps?: number;
  stems?: boolean;
  words?: boolean;
}

const SCALARS_MIX = ["mix.level", "mix.onset", "mix.brightness", "mix.balance", "mix.sub", "mix.bass", "mix.lowmid", "mix.mid", "mix.highmid", "mix.presence", "mix.brilliance", "mix.air"];
const SCALARS_STEMS = ["drums.level", "drums.onset", "drums.kick", "drums.snare", "drums.hats", "bass.level", "bass.onset", "vocals.level", "vocals.onset", "other.level", "other.onset"];

/** The fixture's section plan for a duration (fractions of the song). */
const PLAN: Array<[number, SectionLabel, string, number]> = [
  [0, "intro", "A", 0.2],
  [0.14, "verse", "B", 0.5],
  [0.4, "chorus", "C", 0.85],
  [0.66, "drop", "D", 1],
  [0.8, "outro", "A", 0.25],
];

const LYRICS: Array<[string, Emotion, Motif[]]> = [
  ["Quiet streets before the morning", "calm", ["city"]],
  ["I can hear the city breathing", "awe", ["city"]],
  ["We were burning like a wildfire", "joy", ["fire"]],
  ["Every heartbeat pulling higher", "love", ["hearts"]],
  ["Rain is falling on the window", "sadness", ["rain"]],
  ["Stars above us, hold on tighter", "hope", ["stars"]],
  ["Thunder rolling through the night", "fear", ["storm", "night"]],
  ["We are golden in the light", "joy", ["sun"]],
];

function rand(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildFixture(o: FixtureOptions = {}): Analysis {
  const durationMs = o.durationMs ?? 60_000;
  const fps = o.fps ?? 60;
  const stems = o.stems ?? true;
  const words = o.words ?? true;
  const frames = Math.round((durationMs / 1000) * fps);
  const beat = 500;
  const r = rand(7);

  const sections = PLAN.map(([f, label, group, energy], i) => ({
    startMs: Math.round((f * durationMs) / 2000) * 2000,
    endMs: i + 1 < PLAN.length ? Math.round(((PLAN[i + 1] as [number, SectionLabel, string, number])[0] * durationMs) / 2000) * 2000 : durationMs,
    label,
    group,
    energy,
  }));
  const energyAt = (t: number) => sections.find((s) => t >= s.startMs && t < s.endMs)?.energy ?? 0.3;

  const beats: number[] = [];
  const downbeats: number[] = [];
  for (let t = 0, i = 0; t < durationMs; t += beat, i++) {
    beats.push(t);
    if (i % 4 === 0) downbeats.push(t);
  }
  const ev = (every: number, offset: number, strength: (t: number) => number): Event2[] => {
    const out: Event2[] = [];
    for (let t = offset; t < durationMs; t += every) out.push([t, Math.max(1, Math.min(255, Math.round(strength(t) * 255)))]);
    return out;
  };
  const kick = ev(beat, 0, (t) => 0.5 + energyAt(t) * 0.5);
  const snare = ev(beat * 2, beat, (t) => 0.4 + energyAt(t) * 0.6);
  const hats = ev(beat / 2, beat / 4, (t) => (energyAt(t) > 0.4 ? 0.3 + r() * 0.4 : 0));
  const pulseAt = (events: Event2[], t: number, tau: number) => {
    let v = 0;
    for (const [ms, s] of events) {
      if (ms > t) break;
      if (t - ms < tau * 6) v = Math.max(v, (s / 255) * Math.exp(-(t - ms) / tau));
    }
    return v;
  };

  const scalarIds = stems ? [...SCALARS_MIX, ...SCALARS_STEMS, "vocals.pitch", "vocals.voiced"] : [...SCALARS_MIX, "vocals.pitch", "vocals.voiced"];
  const blocks: Block[] = [];
  let offset = 0;
  for (const id of scalarIds) {
    blocks.push({ id, kind: "scalar", offset, width: 1 });
    offset += frames;
  }
  for (const id of ["spectrum", "wave"]) {
    blocks.push({ id, kind: "vector", offset, width: 64 });
    offset += frames * 64;
  }
  const bytes = new Uint8Array(offset);
  const put = (id: string, i: number, v: number) => {
    const b = blocks.find((x) => x.id === id);
    if (b) bytes[b.offset + i] = Math.max(0, Math.min(255, Math.round(v * 255)));
  };

  const lines: TextLine[] = [];
  if (words) {
    const lineMs = 4000;
    for (let i = 0, t = sections[1]?.startMs ?? 4000; t + lineMs <= durationMs - 4000; i++, t += lineMs) {
      const [text, emotion, motifs] = LYRICS[i % LYRICS.length] as [string, Emotion, Motif[]];
      const ws = text.split(" ");
      const span = lineMs - 600;
      const wordsOut = ws.map((w, k) => ({
        startMs: t + Math.round((k * span) / ws.length),
        endMs: t + Math.round(((k + 1) * span) / ws.length) - 40,
        text: w,
        emphasis: k === ws.length - 1,
      }));
      const val: Record<Emotion, number> = { joy: 0.8, love: 0.7, sadness: -0.7, anger: -0.6, fear: -0.6, calm: 0.3, hope: 0.6, awe: 0.5 };
      lines.push({ startMs: t, endMs: t + span, text, words: wordsOut, meaning: { valence: val[emotion], energy: energyAt(t), emotion, confidence: 0.7, motifs } });
    }
  }
  const singing = (t: number) => lines.some((l) => t >= l.startMs && t < l.endMs);

  for (let i = 0; i < frames; i++) {
    const t = (i / fps) * 1000;
    const e = energyAt(t);
    const k = pulseAt(kick, t, 90);
    const s = pulseAt(snare, t, 110);
    const h = pulseAt(hats, t, 60);
    const sing = singing(t) ? 1 : 0;
    const wob = 0.5 + 0.5 * Math.sin(t / 900);
    put("mix.level", i, 0.15 + e * 0.6 + k * 0.2);
    put("mix.onset", i, Math.max(k, s * 0.8, h * 0.5));
    put("mix.brightness", i, 0.3 + e * 0.4 + h * 0.2);
    put("mix.balance", i, 0.5 + 0.15 * Math.sin(t / 2300));
    put("mix.sub", i, k * (0.4 + e * 0.6));
    put("mix.bass", i, 0.2 + e * 0.5 + k * 0.3);
    put("mix.lowmid", i, 0.2 + e * 0.4 + wob * 0.1);
    put("mix.mid", i, 0.2 + e * 0.4 + sing * 0.2);
    put("mix.highmid", i, 0.15 + e * 0.4 + s * 0.3);
    put("mix.presence", i, 0.1 + sing * 0.5 + s * 0.2);
    put("mix.brilliance", i, 0.1 + h * 0.6 + e * 0.2);
    put("mix.air", i, 0.05 + h * 0.4);
    put("drums.level", i, 0.1 + e * 0.5 + k * 0.4);
    put("drums.onset", i, Math.max(k, s, h * 0.6));
    put("drums.kick", i, k);
    put("drums.snare", i, s);
    put("drums.hats", i, h);
    put("bass.level", i, 0.2 + e * 0.6 + k * 0.2);
    put("bass.onset", i, k * 0.8);
    put("vocals.level", i, sing * (0.5 + 0.3 * wob));
    put("vocals.onset", i, 0);
    put("other.level", i, 0.2 + e * 0.5);
    put("other.onset", i, s * 0.4);
    put("vocals.pitch", i, sing ? 0.4 + 0.25 * Math.sin(t / 700) : 0.4);
    put("vocals.voiced", i, sing);
    const spec = blocks.find((b) => b.id === "spectrum") as Block;
    const wave = blocks.find((b) => b.id === "wave") as Block;
    for (let b = 0; b < 64; b++) {
      const low = Math.exp(-b / 10) * (0.3 + k * 0.7);
      const mid = Math.exp(-((b - 28) ** 2) / 120) * (0.2 + e * 0.5 + sing * 0.2);
      const hi = b > 44 ? h * 0.6 : 0;
      bytes[spec.offset + i * 64 + b] = Math.round(Math.min(1, (low + mid + hi) * (0.7 + e * 0.3)) * 255);
      const wv = Math.sin((b / 64) * Math.PI * 2 * (3 + 4 * e) + t / 30) * (0.3 + e * 0.6);
      bytes[wave.offset + i * 64 + b] = Math.round(128 + wv * 127);
    }
  }

  const audio: AudioDoc = {
    version: 1,
    durationMs,
    fps,
    frames,
    stems,
    tempo: 120,
    beatsPerBar: 4,
    beats,
    downbeats,
    key: { name: "A minor", camelot: "8A", minor: true },
    chords: downbeats.map((t, i) => {
      const c = [
        ["Am", 9, true],
        ["F", 5, false],
        ["C", 0, false],
        ["G", 7, false],
      ][i % 4] as [string, number, boolean];
      return { startMs: t, endMs: t + 4 * beat, name: c[0], root: c[1], minor: c[2] };
    }),
    sections,
    events: {
      kick,
      snare,
      hats: hats.filter((h) => h[1] > 1),
      bass: kick.map(([t, s]) => [t, Math.round(s * 0.8)] as Event2),
      vocals: lines.flatMap((l) => l.words.map((w) => [w.startMs, 180] as Event2)),
      other: snare,
      mix: kick,
      lift: [],
      drop: sections.filter((s) => s.label === "drop").map((s) => [s.startMs, 255] as Event2),
      break: [],
      held: lines.map((l) => [l.endMs - 900, l.endMs, 64] as [number, number, number]),
    },
    blocks,
    features: "fixture.bin",
  };
  const text: TextDoc | null = words
    ? {
        version: 1,
        source: "given",
        language: "en",
        matched: 1,
        moodSource: "reader",
        lines,
        mood: lines.map((l) => ({ ms: l.startMs, valence: l.meaning?.valence ?? 0, energy: l.meaning?.energy ?? 0.5, emotion: l.meaning?.emotion ?? "calm" })),
      }
    : null;
  return new Analysis(audio, bytes, text);
}
