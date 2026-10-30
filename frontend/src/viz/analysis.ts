/**
 * Song analysis loading and queries (SPEC.md §5.5, §6.2). Pure TypeScript:
 * the engine, director and UI all read the analysis through this class.
 */
import type { Emotion, Motif, SectionLabel } from "./types";

export interface Chord {
  startMs: number;
  endMs: number;
  name: string; // "Am", "N" = no chord
  root: number; // 0..11 (C = 0), -1 for N
  minor: boolean;
}
export interface Section {
  startMs: number;
  endMs: number;
  label: SectionLabel;
  group: string;
  energy: number; // 0..1
}
export interface Block {
  id: string;
  kind: "scalar" | "vector";
  offset: number;
  width: number;
}
/** [ms, strength 0–255]; held notes are [startMs, endMs, midi]. */
export type Event2 = [number, number];
export type Held = [number, number, number];

export interface AudioDoc {
  version: 1;
  durationMs: number;
  fps: number;
  frames: number;
  stems: boolean;
  tempo: number;
  beatsPerBar: number;
  beats: number[];
  downbeats: number[];
  key: { name: string; camelot: string; minor: boolean };
  chords: Chord[];
  sections: Section[];
  /** Event lists by id; "held" holds [startMs, endMs, midi] triples. */
  events: Record<string, Array<Event2 | Held>>;
  blocks: Block[];
  features: string;
}

export interface TextWord {
  startMs: number;
  endMs: number;
  text: string;
  emphasis?: boolean;
}
export interface Meaning {
  valence: number; // -1..1
  energy: number; // 0..1
  emotion: Emotion;
  confidence?: number;
  motifs: Motif[];
}
export interface TextLine {
  startMs: number;
  endMs: number;
  text: string;
  words: TextWord[];
  meaning?: Meaning;
}
export interface MoodKey {
  ms: number;
  valence: number;
  energy: number;
  emotion: Emotion;
}
export interface TextDoc {
  version: 1;
  source: string;
  language: string;
  matched: number;
  moodSource?: string;
  lines: TextLine[];
  mood: MoodKey[];
}

export interface AnalysisUrls {
  audioJsonUrl: string;
  featuresUrl: string;
  textJsonUrl?: string;
}

const RANGE = 4 * 1024 * 1024;

/** Fetches a whole file through the media route, which answers ≤ 4 MiB per response. */
export async function fetchAll(url: string, fetchImpl: typeof fetch = fetch): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let start = 0;
  let total = -1;
  for (;;) {
    const res = await fetchImpl(url, { headers: { Range: `bytes=${start}-${start + RANGE - 1}` } });
    if (res.status === 416 && start > 0) break;
    if (!res.ok) throw new Error(`Couldn't read ${url} (${res.status})`);
    const buf = new Uint8Array(await res.arrayBuffer());
    parts.push(buf);
    if (res.status === 200) {
      total = buf.length;
      break;
    }
    const cr = res.headers.get("Content-Range") ?? "";
    const m = /\/(\d+)\s*$/.exec(cr);
    if (m?.[1]) total = Number(m[1]);
    start += buf.length;
    if (buf.length === 0 || (total >= 0 && start >= total)) break;
  }
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function fetchJSON<T>(url: string, fetchImpl: typeof fetch): Promise<T> {
  const bytes = await fetchAll(url, fetchImpl);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

export async function loadAnalysis(urls: AnalysisUrls, fetchImpl: typeof fetch = fetch): Promise<Analysis> {
  const [audio, bytes, text] = await Promise.all([
    fetchJSON<AudioDoc>(urls.audioJsonUrl, fetchImpl),
    fetchAll(urls.featuresUrl, fetchImpl),
    urls.textJsonUrl ? fetchJSON<TextDoc>(urls.textJsonUrl, fetchImpl) : Promise.resolve(null),
  ]);
  return new Analysis(audio, bytes, text);
}

/** Index of the last element with key(el) <= t, or -1. */
function lastAtOrBefore<T>(arr: readonly T[], t: number, key: (el: T) => number): number {
  let lo = 0;
  let hi = arr.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (key(arr[mid] as T) <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export class Analysis {
  readonly fps: number;
  readonly frames: number;
  readonly durationMs: number;
  private readonly blocks = new Map<string, Block>();
  private readonly scalars = new Map<string, Float32Array>();
  private readonly cums = new Map<string, Float64Array>();

  constructor(
    readonly audio: AudioDoc,
    private readonly bytes: Uint8Array,
    readonly text: TextDoc | null,
  ) {
    if (audio.version !== 1) throw new Error(`Unsupported analysis version ${String(audio.version)}`);
    this.fps = audio.fps;
    this.frames = audio.frames;
    this.durationMs = audio.durationMs;
    for (const b of audio.blocks) {
      const len = b.kind === "scalar" ? this.frames : this.frames * b.width;
      if (b.offset < 0 || b.offset + len > bytes.length) throw new Error(`Analysis block ${b.id} is out of range`);
      this.blocks.set(b.id, b);
    }
  }

  has(id: string): boolean {
    return this.blocks.has(id);
  }

  /** A scalar channel as 0..1 floats (null when absent). */
  channel(id: string): Float32Array | null {
    const hit = this.scalars.get(id);
    if (hit) return hit;
    const b = this.blocks.get(id);
    if (!b || b.kind !== "scalar") return null;
    const out = new Float32Array(this.frames);
    for (let i = 0; i < this.frames; i++) out[i] = (this.bytes[b.offset + i] ?? 0) / 255;
    this.scalars.set(id, out);
    return out;
  }

  /** Frame position (fractional) of a time. */
  frameAt(tMs: number): number {
    return Math.max(0, Math.min(this.frames - 1, (tMs / 1000) * this.fps));
  }

  /** Linear interpolation of a channel array at tMs. */
  static interp(arr: Float32Array, f: number): number {
    const i = Math.floor(f);
    const a = arr[i] ?? 0;
    const b = arr[Math.min(arr.length - 1, i + 1)] ?? a;
    return a + (b - a) * (f - i);
  }

  sample(id: string, tMs: number): number {
    const ch = this.channel(id);
    return ch ? Analysis.interp(ch, this.frameAt(tMs)) : 0;
  }

  /** A vector block (spectrum, wave) at tMs into out (0..1; wave is -1..1). */
  vector(id: string, tMs: number, out: Float32Array): Float32Array {
    const b = this.blocks.get(id);
    if (!b || b.kind !== "vector") return out.fill(0);
    const f = this.frameAt(tMs);
    const i = Math.floor(f);
    const j = Math.min(this.frames - 1, i + 1);
    const w = f - i;
    const signed = id === "wave";
    const n = Math.min(out.length, b.width);
    for (let k = 0; k < n; k++) {
      const a = this.bytes[b.offset + i * b.width + k] ?? 0;
      const c = this.bytes[b.offset + j * b.width + k] ?? 0;
      const v = a + (c - a) * w;
      out[k] = signed ? (v - 128) / 127 : v / 255;
    }
    return out;
  }

  /** The integral of a 0..1 channel from 0 to tMs, in value·seconds. */
  cum(id: string, tMs: number): number {
    let c = this.cums.get(id);
    if (!c) {
      const ch = this.channel(id);
      c = new Float64Array(this.frames + 1);
      if (ch) for (let i = 0; i < this.frames; i++) c[i + 1] = (c[i] ?? 0) + (ch[i] ?? 0) / this.fps;
      this.cums.set(id, c);
    }
    const f = Math.max(0, Math.min(this.frames, (tMs / 1000) * this.fps));
    const i = Math.floor(f);
    const a = c[i] ?? 0;
    const b = c[Math.min(this.frames, i + 1)] ?? a;
    return a + (b - a) * (f - i);
  }

  events(id: string): readonly Event2[] {
    const e = this.audio.events[id];
    return Array.isArray(e) ? (e as Event2[]) : [];
  }

  held(): readonly Held[] {
    return (this.audio.events.held ?? []) as Held[];
  }

  /** Events with t0 < ms <= t1. */
  eventsBetween(id: string, t0: number, t1: number): Event2[] {
    const ev = this.events(id);
    const a = lastAtOrBefore(ev, t0, (e) => e[0]) + 1;
    const out: Event2[] = [];
    for (let i = a; i < ev.length; i++) {
      const e = ev[i] as Event2;
      if (e[0] > t1) break;
      out.push(e);
    }
    return out;
  }

  lastEvent(id: string, tMs: number): Event2 | null {
    const ev = this.events(id);
    const i = lastAtOrBefore(ev, tMs, (e) => e[0]);
    return i >= 0 ? (ev[i] as Event2) : null;
  }

  /** Position within the current beat (0..1) and the beat index. */
  beatAt(tMs: number): { index: number; phase: number } {
    const b = this.audio.beats;
    const i = lastAtOrBefore(b, tMs, (x) => x);
    if (i < 0 || b.length < 2) return { index: -1, phase: 0 };
    const cur = b[i] as number;
    const next = b[i + 1] ?? cur + (cur - (b[i - 1] ?? cur - 500));
    return { index: i, phase: Math.max(0, Math.min(1, (tMs - cur) / Math.max(1, next - cur))) };
  }

  barAt(tMs: number): { index: number; phase: number } {
    const d = this.audio.downbeats;
    const i = lastAtOrBefore(d, tMs, (x) => x);
    if (i < 0 || d.length < 2) return { index: -1, phase: 0 };
    const cur = d[i] as number;
    const next = d[i + 1] ?? cur + (cur - (d[i - 1] ?? cur - 2000));
    return { index: i, phase: Math.max(0, Math.min(1, (tMs - cur) / Math.max(1, next - cur))) };
  }

  sectionAt(tMs: number): { section: Section; index: number } | null {
    const s = this.audio.sections;
    const i = lastAtOrBefore(s, tMs, (x) => x.startMs);
    return i >= 0 ? { section: s[i] as Section, index: i } : null;
  }

  chordAt(tMs: number): Chord | null {
    const c = this.audio.chords;
    const i = lastAtOrBefore(c, tMs, (x) => x.startMs);
    return i >= 0 && tMs < (c[i] as Chord).endMs ? (c[i] as Chord) : null;
  }

  lineAt(tMs: number): { line: TextLine; index: number } | null {
    const l = this.text?.lines ?? [];
    const i = lastAtOrBefore(l, tMs, (x) => x.startMs);
    return i >= 0 && tMs < (l[i] as TextLine).endMs ? { line: l[i] as TextLine, index: i } : null;
  }

  wordAt(tMs: number): { word: TextWord; line: number; index: number } | null {
    const hit = this.lineAt(tMs);
    if (!hit) return null;
    const w = hit.line.words;
    const i = lastAtOrBefore(w, tMs, (x) => x.startMs);
    return i >= 0 && tMs < (w[i] as TextWord).endMs ? { word: w[i] as TextWord, line: hit.index, index: i } : null;
  }

  /** All words in time order (for word pulses). */
  allWords(): TextWord[] {
    return (this.text?.lines ?? []).flatMap((l) => l.words);
  }

  /** The mood at tMs, linearly interpolated between keyframes. */
  moodAt(tMs: number): MoodKey {
    const m = this.text?.mood ?? [];
    if (m.length === 0) return { ms: tMs, valence: 0, energy: 0.5, emotion: "calm" };
    const i = lastAtOrBefore(m, tMs, (x) => x.ms);
    if (i < 0) return m[0] as MoodKey;
    const a = m[i] as MoodKey;
    const b = m[i + 1];
    if (!b) return a;
    const w = Math.max(0, Math.min(1, (tMs - a.ms) / Math.max(1, b.ms - a.ms)));
    return { ms: tMs, valence: a.valence + (b.valence - a.valence) * w, energy: a.energy + (b.energy - a.energy) * w, emotion: w < 0.5 ? a.emotion : b.emotion };
  }
}
