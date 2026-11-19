import { describe, expect, it, vi } from "vitest";
import { createClock, normalizeRate } from "./clock";
import { createMixer, type MixerContext } from "./mixer";
import { audioLengthMs, buildProjectAudio, clipGainAt, gainCurve, segmentSourceMs, speedSegments, trackLevel } from "./project";
import type { AudioClipPlan, ProjectAudio } from "./types";
import { emptyEditProject, type NormalProject } from "@/viz/edit/defaults";
import { newClip } from "@/editor/doc";

// ---- a fake AudioContext ----

class FakeParam {
  value = 1;
  events: Array<{ type: string; args: unknown[] }> = [];
  setValueAtTime(...args: unknown[]) {
    this.events.push({ type: "set", args });
  }
  linearRampToValueAtTime(...args: unknown[]) {
    this.events.push({ type: "ramp", args });
  }
  setValueCurveAtTime(...args: unknown[]) {
    this.events.push({ type: "curve", args });
  }
}
class FakeNode {
  out: unknown[] = [];
  connect(n: unknown) {
    this.out.push(n);
    return n;
  }
  disconnect() {}
}
class FakeGain extends FakeNode {
  gain = new FakeParam();
}
class FakeSource extends FakeNode {
  buffer: unknown = null;
  playbackRate = new FakeParam();
  started: { when: number; offset: number; duration: number } | null = null;
  stopped = false;
  onended: (() => void) | null = null;
  start(when: number, offset: number, duration: number) {
    this.started = { when, offset, duration };
  }
  stop() {
    this.stopped = true;
  }
}
class FakeCtx {
  currentTime = 0;
  state = "running";
  destination = new FakeNode();
  gains: FakeGain[] = [];
  sources: FakeSource[] = [];
  createGain() {
    const g = new FakeGain();
    this.gains.push(g);
    return g;
  }
  createBufferSource() {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  async decodeAudioData() {
    return { duration: 60, length: 48000 * 60, numberOfChannels: 2 };
  }
}

const asCtx = (c: FakeCtx) => c as unknown as MixerContext;

// ---- the clock ----

describe("clock", () => {
  const make = (length = 10_000) => {
    const ctx = new FakeCtx();
    const mixer = { start: vi.fn(), stop: vi.fn() };
    const onEnd = vi.fn();
    const clock = createClock({ ctx, mixer, length: () => length, onEnd });
    return { ctx, mixer, onEnd, clock };
  };

  it("plays with no song: time follows the context and pause keeps it", () => {
    const { ctx, clock, mixer } = make();
    clock.play();
    expect(clock.playing()).toBe(true);
    expect(mixer.start).toHaveBeenLastCalledWith(0, 1);
    ctx.currentTime = 2;
    expect(clock.now()).toBe(2000);
    clock.pause();
    ctx.currentTime = 5;
    expect(clock.now()).toBe(2000);
    expect(clock.playing()).toBe(false);
    expect(mixer.stop).toHaveBeenCalled();
  });

  it("reports the edit's length", () => {
    expect(make(12_345).clock.lengthMs()).toBe(12_345);
  });

  it("stops at the end and calls onEnd; play at the end restarts from 0", () => {
    const { ctx, clock, onEnd } = make(10_000);
    clock.play(8000);
    ctx.currentTime = 3;
    expect(clock.now()).toBe(10_000);
    clock.update();
    expect(clock.playing()).toBe(false);
    expect(onEnd).toHaveBeenCalledOnce();
    expect(clock.now()).toBe(10_000);
    clock.play();
    expect(clock.now()).toBe(0);
    expect(clock.playing()).toBe(true);
  });

  it("applies the rate and clamps it to 0.25..4", () => {
    const { ctx, clock } = make();
    clock.play(0, 2);
    ctx.currentTime = 1;
    expect(clock.now()).toBe(2000);
    expect(normalizeRate(10)).toBe(4);
    expect(normalizeRate(0.1)).toBe(0.25);
    expect(normalizeRate(-9)).toBe(-4);
    expect(normalizeRate(0)).toBe(1);
    clock.setRate(0.5); // continues from now at the new rate
    ctx.currentTime = 3;
    expect(clock.now()).toBe(3000);
  });

  it("loops between in and out", () => {
    const { ctx, clock, mixer } = make();
    clock.setLoop({ inMs: 2000, outMs: 4000 });
    clock.play(3500);
    ctx.currentTime = 1; // 4500, past the out point
    clock.update();
    expect(clock.playing()).toBe(true);
    expect(mixer.start).toHaveBeenLastCalledWith(2000, 1);
    expect(clock.now()).toBe(2000);
    clock.setLoop(null);
    ctx.currentTime = 20;
    clock.update();
    expect(clock.playing()).toBe(false);
  });

  it("reverse runs backwards, silent, and stops at 0", () => {
    const { ctx, clock, mixer, onEnd } = make();
    clock.play(5000, -2);
    expect(clock.rate()).toBe(-2);
    expect(mixer.start).toHaveBeenLastCalledWith(5000, -2);
    ctx.currentTime = 1;
    expect(clock.now()).toBe(3000);
    ctx.currentTime = 10;
    clock.update();
    expect(clock.playing()).toBe(false);
    expect(clock.now()).toBe(0);
    expect(onEnd).toHaveBeenCalled();
  });

  it("seeks while playing by restarting the mixer", () => {
    const { clock, mixer } = make();
    clock.play();
    clock.seek(4000);
    expect(mixer.start).toHaveBeenLastCalledWith(4000, 1);
    expect(clock.now()).toBe(4000);
    clock.seek(99_999);
    expect(clock.now()).toBe(10_000);
  });
});

// ---- the project's audio ----

function proj(): NormalProject {
  const p = emptyEditProject("9:16", 30, 1) as NormalProject;
  p.song = { path: "/song.mp3", startMs: 10_000, endMs: 20_000, gainDb: -6, fadeInMs: 500, fadeOutMs: 0 };
  p.tracks = [
    {
      id: "v1",
      kind: "video",
      name: "V",
      muted: false,
      locked: false,
      matte: "",
      clips: [
        newClip({ id: "a", kind: "video", path: "/a.mp4", startMs: 1000, endMs: 5000, inMs: 2000, volume: 0.5, fadeInMs: 200, gain: JSON.stringify({ base: 0, keys: [{ t: 0, v: 0, ease: "linear" }, { t: 1000, v: -12, ease: "linear" }] }) }),
        newClip({ id: "b", kind: "video", path: "/silent.mp4", startMs: 0, endMs: 1000 }),
        newClip({ id: "c", kind: "image", path: "/c.jpg", startMs: 0, endMs: 1000 }),
      ],
    },
    { id: "a1", kind: "audio", name: "A", muted: true, locked: false, solo: true, matte: "", clips: [newClip({ id: "d", kind: "audio", path: "/d.wav", startMs: 500, endMs: 2500, speed: "2" })] },
    { id: "adj", kind: "adjust", name: "Adj", muted: false, locked: false, matte: "", clips: [] },
  ];
  return p;
}

describe("buildProjectAudio", () => {
  const sources = { "/silent.mp4": { info: { hasAudio: false } }, "/a.mp4": { info: { hasAudio: true } } };

  it("plans clips with sound, tracks and the song", () => {
    const a = buildProjectAudio(proj(), sources);
    expect(a.clips.map((c) => c.clipId)).toEqual(["a", "d"]); // no photo, no silent video
    const c = a.clips[0] as AudioClipPlan;
    expect(c).toMatchObject({ trackId: "v1", path: "/a.mp4", startMs: 1000, endMs: 5000, inMs: 2000, volume: 0.5, fadeInMs: 200, fadeOutMs: 0, gainBaseDb: 0 });
    expect(c.gainKeys).toHaveLength(2);
    expect(c.speed).toEqual([{ fromMs: 1000, toMs: 5000, rate: 1 }]);
    expect(a.clips[1]?.speed).toEqual([{ fromMs: 500, toMs: 2500, rate: 2 }]);
    expect(a.tracks).toEqual([
      { trackId: "v1", gainDb: 0, muted: false, solo: false },
      { trackId: "a1", gainDb: 0, muted: true, solo: true },
    ]);
    expect(a.song).toEqual({ path: "/song.mp3", startMs: 10_000, endMs: 20_000, gainDb: -6, fadeInMs: 500, fadeOutMs: 0 });
  });

  it("has no song when the edit has none", () => {
    const p = proj();
    p.song = null;
    expect(buildProjectAudio(p, sources).song).toBeNull();
  });

  it("the length is the latest clip end or the song's length, whichever is longer", () => {
    expect(audioLengthMs(proj())).toBe(10_000);
    const p = proj();
    p.song = null;
    expect(audioLengthMs(p)).toBe(5000);
    p.tracks = [];
    expect(audioLengthMs(p)).toBe(1000);
  });

  it("cuts a speed ramp into constant steps that merge when equal", () => {
    const ramp = JSON.stringify({ base: 1, keys: [{ t: 0, v: 1, ease: "linear" }, { t: 400, v: 3, ease: "linear" }] });
    const seg = speedSegments({ startMs: 0, endMs: 600, speed: ramp });
    expect(seg[0]?.fromMs).toBe(0);
    expect(seg[seg.length - 1]?.toMs).toBe(600);
    for (let i = 1; i < seg.length; i++) expect(seg[i]?.fromMs).toBe(seg[i - 1]?.toMs);
    expect(seg[0]?.rate).toBeLessThan(seg[3]?.rate ?? 0);
    expect(seg[seg.length - 1]?.rate).toBe(3); // held after the last key
    expect(speedSegments({ startMs: 0, endMs: 600, speed: "" })).toEqual([{ fromMs: 0, toMs: 600, rate: 1 }]);
  });
});

describe("gain", () => {
  const plan: AudioClipPlan = {
    clipId: "c",
    trackId: "t",
    path: "/a.mp4",
    startMs: 1000,
    endMs: 3000,
    inMs: 0,
    speed: [{ fromMs: 1000, toMs: 3000, rate: 1 }],
    volume: 0.5,
    gainKeys: [],
    gainBaseDb: 0,
    fadeInMs: 400,
    fadeOutMs: 0,
  };

  it("multiplies volume, dB keys and fades", () => {
    expect(clipGainAt(plan, 1000)).toBe(0);
    expect(clipGainAt(plan, 1200)).toBeCloseTo(0.25);
    expect(clipGainAt(plan, 2000)).toBeCloseTo(0.5);
    expect(clipGainAt(plan, 3000)).toBe(0); // the 10 ms de-click at the end
    expect(clipGainAt(plan, 500)).toBe(0);
    const keyed = { ...plan, gainKeys: [{ t: 0, v: 0, ease: "linear" as const }, { t: 2000, v: -20, ease: "linear" as const }] };
    expect(clipGainAt(keyed, 2000)).toBeCloseTo(0.5 * 10 ** (-10 / 20));
  });

  it("makes a value curve over the window", () => {
    const c = gainCurve(plan, 1000, 3000);
    expect(c.length).toBeGreaterThanOrEqual(2);
    expect(c[0]).toBe(0);
    expect(c[c.length - 1]).toBe(0);
    expect(Math.max(...c)).toBeCloseTo(0.5);
    expect(gainCurve(plan, 1000, 1000).length).toBe(2);
    expect(gainCurve(plan, 0, 10_000_000).length).toBeLessThanOrEqual(2048);
  });

  it("mute and solo set a track's level", () => {
    expect(trackLevel({ trackId: "t", gainDb: 0, muted: true, solo: false }, false)).toBe(0);
    expect(trackLevel({ trackId: "t", gainDb: 0, muted: false, solo: false }, true)).toBe(0);
    expect(trackLevel({ trackId: "t", gainDb: 0, muted: false, solo: true }, true)).toBe(1);
    expect(trackLevel({ trackId: "t", gainDb: -20, muted: false, solo: false }, false)).toBeCloseTo(0.1);
  });

  it("source ms accumulates through the speed segments", () => {
    const p = { ...plan, inMs: 100, speed: [{ fromMs: 0, toMs: 100, rate: 2 }, { fromMs: 100, toMs: 200, rate: 0.5 }] };
    expect(segmentSourceMs(p, 0)).toBe(100);
    expect(segmentSourceMs(p, 1)).toBe(300);
    expect(segmentSourceMs(p, 2)).toBe(350);
  });
});

// ---- the mixer ----

const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

function setup(audio: ProjectAudio, resolve: (p: string) => string | null = (p) => `${p}.m4a`) {
  const ctx = new FakeCtx();
  const read = vi.fn(async () => new ArrayBuffer(8));
  const mixer = createMixer({ ctx: asCtx(ctx), resolve, read, setTimer: () => 1, clearTimer: () => undefined });
  mixer.setProject(audio);
  return { ctx, read, mixer };
}

const clipPlan = (over: Partial<AudioClipPlan> = {}): AudioClipPlan => ({
  clipId: "c1",
  trackId: "t1",
  path: "/a.mp4",
  startMs: 1000,
  endMs: 3000,
  inMs: 2000,
  speed: [{ fromMs: 1000, toMs: 3000, rate: 1 }],
  volume: 1,
  gainKeys: [],
  gainBaseDb: 0,
  fadeInMs: 0,
  fadeOutMs: 0,
  ...over,
});
const tracks = (over: Partial<ProjectAudio["tracks"][number]> = {}): ProjectAudio["tracks"] => [{ trackId: "t1", gainDb: 0, muted: false, solo: false, ...over }];

describe("mixer", () => {
  it("decodes once, reports state, and plays only after it is ready", async () => {
    const { mixer, read, ctx } = setup({ clips: [clipPlan()], tracks: tracks(), song: null });
    expect(mixer.state("/a.mp4")).toBe("loading");
    expect(mixer.loading()).toBe(1);
    mixer.start(900, 1);
    expect(ctx.sources).toHaveLength(0);
    await flush();
    expect(mixer.state("/a.mp4")).toBe("ready");
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith("/a.mp4.m4a");
    expect(mixer.state("/none.mp4")).toBe("none");
  });

  it("a source without sound is 'none'; a failed read is 'failed'", async () => {
    const a = setup({ clips: [clipPlan()], tracks: tracks(), song: null }, () => null);
    expect(a.mixer.state("/a.mp4")).toBe("none");
    const ctx = new FakeCtx();
    const m = createMixer({ ctx: asCtx(ctx), resolve: (p) => p, read: async () => Promise.reject(new Error("x")) });
    m.setProject({ clips: [clipPlan()], tracks: tracks(), song: null });
    await flush();
    expect(m.state("/a.mp4")).toBe("failed");
    m.dispose();
  });

  it("schedules a clip 200 ms ahead with its start offset", async () => {
    const { mixer, ctx } = setup({ clips: [clipPlan()], tracks: tracks(), song: null });
    await flush();
    mixer.start(0, 1);
    expect(ctx.sources).toHaveLength(0); // 1000 ms is beyond the lookahead
    ctx.currentTime = 0.85;
    mixer.pump();
    expect(ctx.sources).toHaveLength(1);
    const s = ctx.sources[0] as FakeSource;
    expect(s.started?.when).toBeCloseTo(1.0);
    expect(s.started?.offset).toBeCloseTo(2.0); // the clip's inMs
    expect(s.started?.duration).toBeCloseTo(2.0);
    expect(s.playbackRate.value).toBe(1);
    mixer.pump(); // not scheduled twice
    expect(ctx.sources).toHaveLength(1);
  });

  it("starting inside a clip begins at the matching source time, now", async () => {
    const { mixer, ctx } = setup({ clips: [clipPlan()], tracks: tracks(), song: null });
    await flush();
    mixer.start(1500, 1);
    const s = ctx.sources[0] as FakeSource;
    expect(s.started?.when).toBe(0);
    expect(s.started?.offset).toBeCloseTo(2.5);
    expect(s.started?.duration).toBeCloseTo(1.5);
  });

  it("applies the clock rate and per-segment speed to playbackRate", async () => {
    const plan = clipPlan({ speed: [{ fromMs: 1000, toMs: 2000, rate: 2 }, { fromMs: 2000, toMs: 3000, rate: 0.5 }] });
    const { mixer, ctx } = setup({ clips: [plan], tracks: tracks(), song: null });
    await flush();
    mixer.start(1000, 1.5);
    expect(ctx.sources).toHaveLength(1);
    expect((ctx.sources[0] as FakeSource).playbackRate.value).toBeCloseTo(3);
    expect((ctx.sources[0] as FakeSource).started?.duration).toBeCloseTo(2); // 1000 ms of timeline at 2×
    ctx.currentTime = 0.5; // timeline 1750 at 1.5×; the next segment is within the lookahead
    mixer.pump();
    expect(ctx.sources).toHaveLength(2);
    const s2 = ctx.sources[1] as FakeSource;
    expect(s2.playbackRate.value).toBeCloseTo(0.75);
    expect(s2.started?.offset).toBeCloseTo(2 + 2); // inMs 2000 + 1000 ms × 2 = 4000
  });

  it("seeking stops what was scheduled and starts again", async () => {
    const { mixer, ctx } = setup({ clips: [clipPlan()], tracks: tracks(), song: null });
    await flush();
    mixer.start(1000, 1);
    const first = ctx.sources[0] as FakeSource;
    mixer.start(2000, 1);
    expect(first.stopped).toBe(true);
    expect((ctx.sources[1] as FakeSource).started?.offset).toBeCloseTo(3.0);
    mixer.stop();
    expect((ctx.sources[1] as FakeSource).stopped).toBe(true);
  });

  it("reverse is silent", async () => {
    const { mixer, ctx } = setup({ clips: [clipPlan()], tracks: tracks(), song: null });
    await flush();
    mixer.start(2000, -1);
    expect(ctx.sources).toHaveLength(0);
    expect(mixer.playing()).toBe(false);
  });

  it("gain keys and fades become one value curve on the clip's gain", async () => {
    const plan = clipPlan({ volume: 0.5, fadeInMs: 500, gainKeys: [{ t: 0, v: 0, ease: "linear" }, { t: 2000, v: -12, ease: "linear" }] });
    const { mixer, ctx } = setup({ clips: [plan], tracks: tracks(), song: null });
    await flush();
    mixer.start(1000, 1);
    const withCurve = ctx.gains.filter((g) => g.gain.events.some((e) => e.type === "curve"));
    expect(withCurve).toHaveLength(1);
    const ev = (withCurve[0] as FakeGain).gain.events.find((e) => e.type === "curve");
    const [curve, when, duration] = ev?.args as [Float32Array, number, number];
    expect(when).toBe(0);
    expect(duration).toBeCloseTo(2);
    expect(curve[0]).toBe(0); // fade-in starts silent
    expect(curve[curve.length - 1]).toBeCloseTo(0, 1); // de-click at the end
    const mid = curve[Math.floor(curve.length / 2)] as number;
    expect(mid).toBeCloseTo(0.5 * 10 ** (-6 / 20), 1);
  });

  it("mute and solo set the track gains, in place", async () => {
    const audio: ProjectAudio = { clips: [clipPlan(), clipPlan({ clipId: "c2", trackId: "t2" })], tracks: [...tracks(), { trackId: "t2", gainDb: 0, muted: false, solo: false }], song: null };
    const { mixer, ctx } = setup(audio);
    await flush();
    mixer.start(1000, 1);
    const trackGains = () => ctx.gains.filter((g) => g.out.length === 1 && g.out[0] === ctx.gains[0]); // those feeding the master
    expect(trackGains()).toHaveLength(2);
    const before = ctx.sources.length;
    mixer.setProject({ ...audio, tracks: [{ trackId: "t1", gainDb: 0, muted: true, solo: false }, { trackId: "t2", gainDb: 0, muted: false, solo: false }] });
    expect(ctx.sources.length).toBe(before); // no reschedule for a mute
    const [g1, g2] = trackGains();
    expect(g1?.gain.value).toBe(0);
    expect(g2?.gain.value).toBe(1);
    mixer.setProject({ ...audio, tracks: [{ trackId: "t1", gainDb: 0, muted: false, solo: false }, { trackId: "t2", gainDb: 0, muted: false, solo: true }] });
    expect(g1?.gain.value).toBe(0);
    expect(g2?.gain.value).toBe(1);
  });

  it("an edit while playing reschedules from the current time", async () => {
    const { mixer, ctx } = setup({ clips: [clipPlan()], tracks: tracks(), song: null });
    await flush();
    mixer.start(1000, 1);
    ctx.currentTime = 0.5;
    const first = ctx.sources[0] as FakeSource;
    mixer.setProject({ clips: [clipPlan({ inMs: 5000 })], tracks: tracks(), song: null });
    expect(first.stopped).toBe(true);
    expect((ctx.sources[1] as FakeSource).started?.offset).toBeCloseTo(5.5);
  });

  it("plays the song as one more source from its start", async () => {
    const song = { path: "/song.mp3", startMs: 10_000, endMs: 20_000, gainDb: 0, fadeInMs: 0, fadeOutMs: 0 };
    const { mixer, ctx } = setup({ clips: [], tracks: [], song }, (p) => p);
    await flush();
    mixer.start(2000, 1);
    const s = ctx.sources[0] as FakeSource;
    expect(s.started?.offset).toBeCloseTo(12);
    expect(s.started?.duration).toBeCloseTo(8);
  });

  it("scrub plays a 60 ms grain, only when allowed and not playing", async () => {
    const { mixer, ctx } = setup({ clips: [clipPlan()], tracks: tracks(), song: null });
    await flush();
    mixer.scrub(1500);
    expect(ctx.sources).toHaveLength(1);
    expect((ctx.sources[0] as FakeSource).started?.duration).toBeCloseTo(0.06);
    expect((ctx.sources[0] as FakeSource).started?.offset).toBeCloseTo(2.5);
    mixer.scrub(1600);
    expect((ctx.sources[0] as FakeSource).stopped).toBe(true);
    mixer.setScrubAudio(false);
    mixer.scrub(1700);
    expect(ctx.sources).toHaveLength(2);
    mixer.setScrubAudio(true);
    mixer.start(1000, 1);
    const n = ctx.sources.length;
    mixer.scrub(1700); // playing: no grain
    expect(ctx.sources).toHaveLength(n);
    mixer.scrub(100);
  });

  it("evicts the least recently used decoded audio over the cap", async () => {
    const ctx = new FakeCtx();
    const mixer = createMixer({ ctx: asCtx(ctx), resolve: (p) => p, read: async () => new ArrayBuffer(8), maxDecodedBytes: 48000 * 60 * 2 * 4 * 1.5, setTimer: () => 1, clearTimer: () => undefined });
    mixer.setProject({ clips: [clipPlan({ path: "/1" }), clipPlan({ clipId: "c2", path: "/2" })], tracks: tracks(), song: null });
    await flush();
    expect(mixer.state("/1")).toBe("none"); // evicted, will decode again when needed
    expect(mixer.state("/2")).toBe("ready");
  });
});
