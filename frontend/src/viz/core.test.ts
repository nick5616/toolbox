import { describe, expect, it } from "vitest";
import { fetchAll } from "./analysis";
import { activeAt, autoTimeline } from "./director";
import { buildFixture } from "./fixture";
import { hexToLinear, linearToOklab, mixLinear, oklabToLinear, paletteById, resolvePalette } from "./palette";
import { PRESETS, showFromPreset } from "./presets";
import { evalParam, Signals } from "./signals";
import { validateShow } from "./validate";
import { Batcher, BATCH_BYTES, Sender, toBase64 } from "./worker/transport";
import { bitrateFor, codecFor } from "./worker/encoder";

describe("analysis", () => {
  const a = buildFixture({ durationMs: 20_000 });

  it("samples channels with interpolation and clamps", () => {
    expect(a.has("mix.level")).toBe(true);
    const v = a.sample("mix.level", 5000);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThanOrEqual(1);
    expect(a.sample("nope", 1000)).toBe(0);
  });

  it("integrates a channel monotonically", () => {
    expect(a.cum("mix.level", 0)).toBe(0);
    expect(a.cum("mix.level", 10_000)).toBeGreaterThan(a.cum("mix.level", 5000));
  });

  it("finds events, beats, sections, chords and words", () => {
    expect(a.eventsBetween("kick", 0, 1000).map((e) => e[0])).toEqual([500, 1000]);
    expect(a.lastEvent("kick", 1250)?.[0]).toBe(1000);
    expect(a.beatAt(1250)).toEqual({ index: 2, phase: 0.5 });
    expect(a.barAt(1000).index).toBe(0);
    expect(a.sectionAt(100)?.section.label).toBe("intro");
    expect(a.chordAt(2100)?.name).toBe("F");
    const line = a.text?.lines[0];
    expect(line).toBeDefined();
    expect(a.lineAt((line?.startMs ?? 0) + 10)?.index).toBe(0);
    expect(a.wordAt((line?.startMs ?? 0) + 10)?.index).toBe(0);
  });

  it("reads vectors", () => {
    const out = new Float32Array(64);
    a.vector("spectrum", 1000, out);
    expect(Math.max(...out)).toBeGreaterThan(0);
    a.vector("wave", 1000, out);
    expect(Math.min(...out)).toBeLessThan(0);
  });

  it("reassembles ranged responses", async () => {
    const data = new Uint8Array(10_000_000).map((_, i) => i & 255);
    const fake = (async (_url: string, init?: RequestInit) => {
      const range = new Headers(init?.headers).get("Range") ?? "";
      const [, s, e] = /bytes=(\d+)-(\d+)/.exec(range) ?? [];
      const start = Number(s);
      const end = Math.min(data.length - 1, Number(e));
      return new Response(data.slice(start, end + 1), { status: 206, headers: { "Content-Range": `bytes ${start}-${end}/${data.length}` } });
    }) as typeof fetch;
    const got = await fetchAll("/media/x/y.bin", fake);
    expect(got.length).toBe(data.length);
    expect(got[9_999_999]).toBe(data[9_999_999]);
  });
});

describe("signals", () => {
  const a = buildFixture({ durationMs: 20_000 });
  const s = new Signals(a);

  it("makes decaying pulses at events", () => {
    expect(s.value("kick", 1000)).toBeGreaterThan(0.5);
    expect(s.value("kick", 1300)).toBeLessThan(s.value("kick", 1050));
    expect(s.value("beat.pulse", 500)).toBeCloseTo(1, 1);
  });

  it("smooths with attack and release", () => {
    const raw = s.get("kick");
    const env = s.envelope("kick", 10, 500);
    const i = Math.round(1.2 * a.fps);
    expect(env[i] ?? 0).toBeGreaterThan(raw[i] ?? 0); // the slow release holds it up
  });

  it("falls back to the mix without stems", () => {
    const noStems = new Signals(buildFixture({ durationMs: 10_000, stems: false }));
    expect(noStems.value("bass.level", 5000)).toBeGreaterThan(0);
  });

  it("modulates within the range with mix gains and reactivity", () => {
    const mix = { drums: 1, bass: 1, vocals: 1, other: 1, words: 1, mood: 1 };
    const p = { base: 0.2, mods: [{ signal: "kick" as const, amount: 1, shape: "linear" as const }] };
    const hit = evalParam(p, 0, 1, 1010, { signals: s, mix, reactivity: 1 });
    expect(hit).toBeGreaterThan(0.5);
    expect(evalParam(p, 0, 1, 1010, { signals: s, mix: { ...mix, drums: 0 }, reactivity: 1 })).toBeCloseTo(0.2);
    expect(evalParam(p, 0, 1, 1010, { signals: s, mix, reactivity: 0 })).toBeCloseTo(0.2);
    expect(evalParam(5, 0, 1, 0, { signals: s, mix, reactivity: 1 })).toBe(1);
  });
});

describe("palette", () => {
  it("round-trips OKLab", () => {
    const c = hexToLinear("#ff8800");
    const back = oklabToLinear(linearToOklab(c));
    back.forEach((v, i) => expect(v).toBeCloseTo(c[i] as number, 4));
  });

  it("mixes and journeys", () => {
    const a = buildFixture({ durationMs: 20_000 });
    const start = resolvePalette({ mode: "journey", ids: ["deep-night", "golden"] }, a, 0);
    const end = resolvePalette({ mode: "journey", ids: ["deep-night", "golden"] }, a, 20_000);
    expect(start.accent).toEqual(paletteById("deep-night").accent);
    expect(end.accent).toEqual(paletteById("golden").accent);
    const m = mixLinear([0, 0, 0], [1, 1, 1], 0.5);
    expect(m[0]).toBeGreaterThan(0);
  });
});

describe("shows and presets", () => {
  it("validates every preset", () => {
    for (const p of PRESETS) {
      const r = validateShow(JSON.stringify(p.show));
      expect(r.ok ? "ok" : `${p.id}: ${r.problem}`).toBe("ok");
      expect(p.show.controls.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("rejects bad designs", () => {
    const base = showFromPreset(PRESETS[0] as (typeof PRESETS)[number]);
    expect(validateShow("{").ok).toBe(false);
    const badLayer = structuredClone(base);
    (badLayer.scenes[0]?.layers[0] as { type: string }).type = "teapot";
    expect(validateShow(badLayer).ok).toBe(false);
    const badRange = structuredClone(base);
    (badRange.scenes[0]?.layers[1] as { params: Record<string, unknown> }).params.count = 999;
    expect(validateShow(badRange).ok).toBe(false);
    const badSignal = structuredClone(base);
    (badSignal.scenes[0]?.layers[1] as { params: Record<string, unknown> }).params.height = { base: 0.5, mods: [{ signal: "vibes", amount: 1, shape: "linear" }] };
    expect(validateShow(badSignal).ok).toBe(false);
  });

  it("maps sections to scenes with transitions", () => {
    const a = buildFixture({ durationMs: 60_000 });
    const show = showFromPreset(PRESETS[0] as (typeof PRESETS)[number]);
    const tl = autoTimeline(a, show);
    expect(tl[0]?.sceneId).toBe("calm");
    expect(tl.some((e) => e.sceneId === "full")).toBe(true);
    expect(tl.find((e) => e.sceneId === "full")?.transition.kind).toBe("crossfade");
    const second = tl[1];
    if (!second) throw new Error("no second entry");
    expect(activeAt(tl, second.startMs + 10)?.previous?.sceneId).toBe(tl[0]?.sceneId);
  });
});

describe("transport and encoder", () => {
  it("encodes base64 like btoa", () => {
    const u8 = new Uint8Array([0, 1, 2, 250, 255, 128]);
    expect(toBase64(u8)).toBe(btoa(String.fromCharCode(...u8)));
  });

  it("numbers data messages and reports bytes", () => {
    const msgs: string[] = [];
    const s = new Sender("tok", (m) => msgs.push(m));
    s.start({ encoder: "h264-hw", width: 2, height: 2, fps: 30, frames: 1 });
    s.data(new Uint8Array([1, 2, 3]));
    s.data(new Uint8Array([4]));
    s.done(1);
    expect(msgs[1]).toBe(`vz1|tok|data|0|${btoa("\x01\x02\x03")}`);
    expect(msgs[2]?.startsWith("vz1|tok|data|1|")).toBe(true);
    expect(JSON.parse(msgs[3]?.split("|")[3] ?? "{}")).toEqual({ frames: 1, bytes: 4 });
  });

  it("batches chunks under the limit", () => {
    const out: number[] = [];
    const b = new Batcher((buf) => out.push(buf.length));
    b.push(new Uint8Array(BATCH_BYTES - 10));
    b.push(new Uint8Array(20));
    b.flush();
    expect(out).toEqual([BATCH_BYTES - 10, 20]);
  });

  it("picks codec levels and bitrates", () => {
    expect(codecFor(1920, 1080)).toBe("avc1.640028");
    expect(codecFor(1920, 2160)).toBe("avc1.640033");
    expect(bitrateFor(1920, 1080, 30, false)).toBe(14e6);
    expect(bitrateFor(1920, 1080, 60, true)).toBe(Math.round(14e6 * 1.5 * 1.6));
  });
});
