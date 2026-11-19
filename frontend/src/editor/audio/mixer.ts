/**
 * The preview mixer (Phase 21 SPEC §B1): one Web Audio graph for every clip's
 * sound and the song.
 *
 *   AudioBufferSourceNode (per clip segment) → clip GainNode (Volume × dB keys
 *   × fades, one value curve) → track GainNode (mute/solo/level) → master → out
 *
 * Sources are scheduled `LOOKAHEAD_MS` ahead by `pump()` (called on a timer
 * while playing) and rescheduled on seek, rate change or a changed edit. A
 * negative rate (reverse) is picture only: the mixer stays silent.
 */
import { wholeFileBuffer } from "@/lib/wholeFile";
import { clipGainAt, gainCurve, segmentSourceMs, SILENT_RATE, SONG_ID, songPlan, trackLevel } from "./project";
import type { AudioClipPlan, AudioSourceState, Mixer, ProjectAudio } from "./types";

export const LOOKAHEAD_MS = 200;
export const GRAIN_MS = 60;
/** Decoded audio kept in memory (SPEC §B1). */
export const MAX_DECODED_BYTES = 512 * 1024 * 1024;

/** What the mixer needs from an AudioContext. */
export interface MixerContext {
  readonly currentTime: number;
  readonly destination: AudioNode;
  readonly state?: string;
  resume?(): Promise<void>;
  createGain(): GainNode;
  createBufferSource(): AudioBufferSourceNode;
  decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer>;
}

export interface MixerDeps {
  ctx: MixerContext;
  /** The file to decode for a source path (its preview audio.m4a); null = it has no sound (yet). */
  resolve(path: string): string | null;
  /** Reads a file's bytes (default: the media URL in ranges). */
  read?(file: string): Promise<ArrayBuffer>;
  maxDecodedBytes?: number;
  /** The pump timer (tests pass their own). */
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  /** A source's state changed ("loading audio" dots). */
  onState?(): void;
}

export interface MixerImpl extends Mixer {
  /** Schedules what falls inside the lookahead window (the timer calls it). */
  pump(): void;
  /** Whether sound is being made (false in reverse). */
  playing(): boolean;
  /** How many files are decoding right now. */
  loading(): number;
}

interface Cached {
  buffer: AudioBuffer;
  bytes: number;
}

export function createMixer(deps: MixerDeps): MixerImpl {
  const { ctx } = deps;
  const read = deps.read ?? wholeFileBuffer;
  const maxBytes = deps.maxDecodedBytes ?? MAX_DECODED_BYTES;
  const setTimer = deps.setTimer ?? ((fn, ms) => setInterval(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));

  const master = ctx.createGain();
  master.connect(ctx.destination);
  const trackNodes = new Map<string, GainNode>();
  const clipNodes = new Map<string, GainNode>();
  const active = new Set<AudioBufferSourceNode>();
  const scheduled = new Set<string>();
  let grains: AudioBufferSourceNode[] = [];

  const cache = new Map<string, Cached>(); // insertion order = LRU order
  const states = new Map<string, AudioSourceState>();
  let cachedBytes = 0;
  let disposed = false;

  let audio: ProjectAudio = { clips: [], tracks: [], song: null };
  let plans: AudioClipPlan[] = [];
  let planSig = "";
  let anySolo = false;
  let scrubOn = true;

  let isPlaying = false;
  let startCtx = 0;
  let startMs = 0;
  let rate = 1;
  let timer: unknown = null;

  const fileOf = (path: string): string | null => deps.resolve(path);
  const position = () => startMs + (ctx.currentTime - startCtx) * 1000 * rate;

  // ---- decoding ----

  const evict = (keep: string) => {
    for (const [file, c] of cache) {
      if (cachedBytes <= maxBytes) break;
      if (file === keep) continue;
      cache.delete(file);
      states.delete(file);
      cachedBytes -= c.bytes;
    }
  };

  const ensure = (file: string): AudioBuffer | null => {
    const hit = cache.get(file);
    if (hit) {
      cache.delete(file); // touch
      cache.set(file, hit);
      return hit.buffer;
    }
    const st = states.get(file);
    if (st === "loading" || st === "failed") return null;
    states.set(file, "loading");
    deps.onState?.();
    void read(file)
      .then((bytes) => ctx.decodeAudioData(bytes))
      .then((buffer) => {
        if (disposed) return;
        const size = buffer.length * buffer.numberOfChannels * 4;
        cache.set(file, { buffer, bytes: size });
        cachedBytes += size;
        states.set(file, "ready");
        evict(file);
        deps.onState?.();
      })
      .catch(() => {
        if (disposed) return;
        states.set(file, "failed");
        deps.onState?.();
      });
    return null;
  };

  const bufferFor = (plan: AudioClipPlan): AudioBuffer | null => {
    const file = fileOf(plan.path);
    return file ? ensure(file) : null;
  };

  // ---- graph ----

  const trackNode = (trackId: string): GainNode => {
    let n = trackNodes.get(trackId);
    if (!n) {
      n = ctx.createGain();
      n.connect(master);
      trackNodes.set(trackId, n);
      const t = audio.tracks.find((x) => x.trackId === trackId);
      n.gain.value = t ? trackLevel(t, anySolo) : 1;
    }
    return n;
  };

  const applyTrackLevels = () => {
    for (const [id, node] of trackNodes) {
      const t = audio.tracks.find((x) => x.trackId === id);
      node.gain.value = t ? trackLevel(t, anySolo) : 1;
    }
  };

  const stopNodes = () => {
    for (const n of active) {
      try {
        n.stop();
      } catch {
        /* never started */
      }
      n.disconnect();
    }
    active.clear();
    for (const g of clipNodes.values()) g.disconnect();
    clipNodes.clear();
    scheduled.clear();
  };

  const clipNode = (plan: AudioClipPlan, fromTl: number, when: number): GainNode => {
    let g = clipNodes.get(plan.clipId);
    if (g) return g;
    g = ctx.createGain();
    g.connect(plan.trackId ? trackNode(plan.trackId) : master);
    const curve = gainCurve(plan, fromTl, plan.endMs);
    const seconds = (plan.endMs - fromTl) / (1000 * Math.abs(rate));
    g.gain.value = curve[0] ?? 0;
    if (seconds > 0 && curve.length >= 2) g.gain.setValueCurveAtTime(curve, when, seconds);
    clipNodes.set(plan.clipId, g);
    return g;
  };

  const scheduleSegment = (plan: AudioClipPlan, i: number, buffer: AudioBuffer, curTl: number) => {
    const seg = plan.speed[i];
    if (!seg || seg.rate < SILENT_RATE) return;
    const tl = Math.max(seg.fromMs, curTl);
    if (tl >= seg.toMs) return;
    const srcMs = segmentSourceMs(plan, i) + (tl - seg.fromMs) * seg.rate;
    if (srcMs < 0 || srcMs / 1000 >= buffer.duration) return;
    const when = Math.max(ctx.currentTime, startCtx + (tl - startMs) / (1000 * rate));
    const srcSeconds = Math.min(((seg.toMs - tl) * seg.rate) / 1000, buffer.duration - srcMs / 1000);
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.playbackRate.value = seg.rate * rate;
    node.connect(clipNode(plan, Math.max(plan.startMs, tl), when));
    node.onended = () => {
      active.delete(node);
      node.disconnect();
    };
    node.start(when, srcMs / 1000, srcSeconds);
    active.add(node);
  };

  const pump = () => {
    if (!isPlaying || disposed) return;
    const cur = position();
    const horizon = cur + LOOKAHEAD_MS * rate;
    for (const plan of plans) {
      if (plan.endMs <= cur || plan.startMs >= horizon) continue;
      for (let i = 0; i < plan.speed.length; i++) {
        const seg = plan.speed[i] as AudioClipPlan["speed"][number];
        if (seg.toMs <= cur || seg.fromMs >= horizon) continue;
        const key = `${plan.clipId}#${i}`;
        if (scheduled.has(key)) continue;
        const buf = bufferFor(plan);
        if (!buf) continue; // still loading: starts mid-way when it arrives
        scheduled.add(key);
        scheduleSegment(plan, i, buf, cur);
      }
    }
  };

  const stopTimer = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  const begin = (atMs: number, r: number) => {
    stopNodes();
    stopTimer();
    if (r <= 0) {
      isPlaying = false;
      return;
    }
    if (ctx.state === "suspended") void ctx.resume?.();
    isPlaying = true;
    startMs = atMs;
    startCtx = ctx.currentTime;
    rate = r;
    pump();
    timer = setTimer(pump, 50);
  };

  const rebuildPlans = () => {
    plans = [...audio.clips, ...(audio.song ? [songPlan(audio.song)] : [])];
    anySolo = audio.tracks.some((t) => t.solo);
    for (const plan of plans) bufferFor(plan); // start decoding now
  };

  const stopGrains = () => {
    for (const n of grains) {
      try {
        n.stop();
      } catch {
        /* ignore */
      }
      n.disconnect();
    }
    grains = [];
  };

  return {
    pump,
    playing: () => isPlaying,
    loading: () => {
      let n = 0;
      for (const st of states.values()) if (st === "loading") n++;
      return n;
    },
    setProject(next) {
      const sig = JSON.stringify([next.clips, next.song]);
      const changed = sig !== planSig;
      planSig = sig;
      audio = next;
      rebuildPlans();
      applyTrackLevels();
      if (changed && isPlaying) begin(Math.max(0, position()), rate);
    },
    start(atMs, r) {
      stopGrains();
      begin(atMs, r);
    },
    stop() {
      isPlaying = false;
      stopTimer();
      stopNodes();
    },
    setScrubAudio(on) {
      scrubOn = on;
      if (!on) stopGrains();
    },
    scrub(ms) {
      if (!scrubOn || isPlaying || disposed) return;
      stopGrains();
      const now = ctx.currentTime;
      const ramp = 0.005;
      for (const plan of plans) {
        if (ms < plan.startMs || ms >= plan.endMs) continue;
        const buf = bufferFor(plan);
        if (!buf) continue;
        const i = plan.speed.findIndex((s) => ms >= s.fromMs && ms < s.toMs);
        const seg = plan.speed[i];
        if (!seg || seg.rate < SILENT_RATE) continue;
        const srcMs = segmentSourceMs(plan, i) + (ms - seg.fromMs) * seg.rate;
        if (srcMs < 0 || srcMs / 1000 >= buf.duration) continue;
        const track = plan.clipId === SONG_ID ? null : audio.tracks.find((t) => t.trackId === plan.trackId);
        const level = clipGainAt(plan, ms) * (track ? trackLevel(track, anySolo) : 1);
        if (level <= 0) continue;
        const g = ctx.createGain();
        g.connect(master);
        const grain = GRAIN_MS / 1000;
        g.gain.setValueAtTime(0, now);
        g.gain.linearRampToValueAtTime(level, now + ramp);
        g.gain.setValueAtTime(level, now + grain - ramp);
        g.gain.linearRampToValueAtTime(0, now + grain);
        const node = ctx.createBufferSource();
        node.buffer = buf;
        node.playbackRate.value = seg.rate;
        node.connect(g);
        node.onended = () => {
          g.disconnect();
          node.disconnect();
        };
        node.start(now, srcMs / 1000, grain * seg.rate);
        grains.push(node);
      }
    },
    state(path) {
      const file = fileOf(path);
      if (!file) return "none";
      return states.get(file) ?? "none";
    },
    dispose() {
      disposed = true;
      isPlaying = false;
      stopTimer();
      stopNodes();
      stopGrains();
      master.disconnect();
      cache.clear();
      states.clear();
      cachedBytes = 0;
    },
  };
}
