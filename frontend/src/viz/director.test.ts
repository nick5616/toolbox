import { describe, expect, it } from "vitest";
import type { Analysis, Section } from "./analysis";
import { activeAt, autoTimeline, DEFAULT_SCENE_FOR, MAX_MOTIFS, MIN_EMOTION_BARS, motifsAt, sceneOrFallback, timelineFor } from "./director";
import { buildFixture } from "./fixture";
import { presetById, showFromPreset } from "./presets";
import type { Emotion, Motif, SectionLabel, Show, TimelineEntry } from "./types";

const BAR = 2000; // 120 bpm, 4 beats
const BEAT = 500;

function show(id = "spectrum-classic", patch: (s: Show) => void = () => {}): Show {
  const p = presetById(id);
  if (!p) throw new Error(`no preset ${id}`);
  const s = showFromPreset(p);
  patch(s);
  return s;
}

function sectionsOf(a: Analysis, list: Array<[number, number, SectionLabel]>): void {
  a.audio.sections.splice(
    0,
    a.audio.sections.length,
    ...list.map(([startMs, endMs, label], i): Section => ({ startMs, endMs, label, group: String.fromCharCode(65 + i), energy: 0.5 })),
  );
}

describe("director: sections to scenes", () => {
  it("maps every label to its scene", () => {
    expect(DEFAULT_SCENE_FOR).toEqual({ intro: "calm", outro: "calm", bridge: "calm", break: "calm", verse: "main", section: "main", chorus: "full", drop: "full" });
    const a = buildFixture({ durationMs: 60_000 });
    const tl = autoTimeline(a, show());
    expect(tl.map((e) => e.sceneId)).toEqual(["calm", "main", "full", "calm"]); // the drop continues the chorus scene
    expect(tl[0]).toMatchObject({ startMs: 0, transition: { kind: "cut", ms: 0 } });
    expect(tl[tl.length - 1]?.endMs).toBe(60_000);
    for (let i = 1; i < tl.length; i++) expect(tl[i]?.startMs).toBe(tl[i - 1]?.endMs);
  });

  it("uses a preset's own map and falls back to main for a missing scene", () => {
    const a = buildFixture({ durationMs: 60_000 });
    const s = show("spectrum-classic", (x) => {
      x.director = { sceneFor: { verse: "full", chorus: "ghost" }, transitions: {} };
    });
    const tl = autoTimeline(a, s);
    expect(tl.find((e) => e.startMs > 0)?.sceneId).toBe("full");
    expect(sceneOrFallback(s, "ghost")).toBe("main");
    const only = show("spectrum-classic", (x) => {
      x.scenes = [x.scenes[0] as Show["scenes"][number]];
    });
    expect(sceneOrFallback(only, "ghost")).toBe("calm");
  });

  it("snaps scene changes to the nearest downbeat", () => {
    const a = buildFixture({ durationMs: 60_000 });
    sectionsOf(a, [
      [0, 8_900, "intro"],
      [8_900, 21_900, "verse"],
      [21_900, 60_000, "chorus"],
    ]);
    const tl = autoTimeline(a, show());
    expect(tl.map((e) => e.startMs)).toEqual([0, 8_000, 22_000]);
    for (const e of tl) expect(e.startMs % BAR).toBe(0);
  });

  it("flashes on a drop and crossfades by default", () => {
    const a = buildFixture({ durationMs: 60_000 });
    sectionsOf(a, [
      [0, 10_000, "verse"],
      [10_000, 20_000, "drop"],
      [20_000, 40_000, "intro"],
      [40_000, 60_000, "verse"],
    ]);
    const s = show("spectrum-classic", (x) => {
      x.director = { sceneFor: { drop: "full" }, transitions: {} };
    });
    const tl = autoTimeline(a, s);
    expect(tl.map((e) => e.sceneId)).toEqual(["main", "full", "calm", "main"]);
    expect(tl[1]?.transition.kind).toBe("flash");
    expect(tl[2]?.transition.kind).toBe("crossfade");
    expect(tl[2]?.transition.ms).toBe(BAR);
  });

  it("flashes when a drop event starts a section that is not labelled drop", () => {
    const a = buildFixture({ durationMs: 60_000 });
    sectionsOf(a, [
      [0, 10_000, "verse"],
      [10_000, 60_000, "chorus"],
    ]);
    a.audio.events.drop = [[10_000, 255]];
    const s = show("spectrum-classic", (x) => {
      x.director = { sceneFor: {}, transitions: {} };
    });
    expect(autoTimeline(a, s)[1]?.transition.kind).toBe("flash");
  });

  it("zooms into a chorus that follows a build-up, and crossfades otherwise", () => {
    const sections: Array<[number, number, SectionLabel]> = [
      [0, 10_000, "verse"],
      [10_000, 60_000, "chorus"],
    ];
    const plain = buildFixture({ durationMs: 60_000 });
    sectionsOf(plain, sections);
    const noRules = show("spectrum-classic", (x) => {
      x.director = { sceneFor: {}, transitions: {} };
    });
    expect(autoTimeline(plain, noRules)[1]?.transition.kind).toBe("crossfade");

    const lifted = buildFixture({ durationMs: 60_000 });
    sectionsOf(lifted, sections);
    lifted.audio.events.lift = [[4_000, 200]];
    expect(autoTimeline(lifted, noRules)[1]?.transition.kind).toBe("zoom");
    // A preset's own rule wins over the default.
    const custom = show("spectrum-classic", (x) => {
      x.director = { sceneFor: {}, transitions: { chorusAfterLift: { kind: "sweep", ms: 1234 } } };
    });
    expect(autoTimeline(lifted, custom)[1]?.transition).toEqual({ kind: "sweep", ms: 1234 });
    // ...and a rule for the label itself wins over both.
    const byLabel = show("spectrum-classic", (x) => {
      x.director = { sceneFor: {}, transitions: { chorus: { kind: "glitch", ms: 700 } } };
    });
    expect(autoTimeline(lifted, byLabel)[1]?.transition).toEqual({ kind: "glitch", ms: 700 });
  });

  it("runs on a song without sections", () => {
    const a = buildFixture({ durationMs: 30_000 });
    sectionsOf(a, []);
    const tl = autoTimeline(a, show());
    expect(tl).toHaveLength(1);
    expect(tl[0]).toMatchObject({ sceneId: "main", startMs: 0, endMs: 30_000 });
  });
});

describe("director: manual mode and activeAt", () => {
  const entries: TimelineEntry[] = [
    { startMs: 0, endMs: 5_000, sceneId: "full", transition: { kind: "cut", ms: 0 } },
    { startMs: 5_000, endMs: 12_000, sceneId: "calm", transition: { kind: "crossfade", ms: 1_000 }, paletteId: "ice" },
    { startMs: 12_000, endMs: 60_000, sceneId: "main", transition: { kind: "cut", ms: 0 } },
  ];

  it("uses the show's entries in manual mode", () => {
    const a = buildFixture({ durationMs: 60_000 });
    const s = show("spectrum-classic", (x) => {
      x.timeline = { mode: "manual", entries };
    });
    expect(timelineFor(a, s)).toBe(entries);
  });

  it("falls back to auto when manual mode has no entries, and ignores entries in auto mode", () => {
    const a = buildFixture({ durationMs: 60_000 });
    const empty = show("spectrum-classic", (x) => {
      x.timeline = { mode: "manual", entries: [] };
    });
    expect(timelineFor(a, empty)).toEqual(autoTimeline(a, empty));
    const auto = show("spectrum-classic", (x) => {
      x.timeline = { mode: "auto", entries };
    });
    expect(timelineFor(a, auto)).not.toBe(entries);
  });

  it("finds the active scene and the mix of a transition", () => {
    expect(activeAt([], 100)).toBeNull();
    expect(activeAt(entries, 100)).toMatchObject({ current: { sceneId: "full" }, previous: null, mix: 1 });
    const mid = activeAt(entries, 5_500);
    expect(mid?.current.sceneId).toBe("calm");
    expect(mid?.previous?.sceneId).toBe("full");
    expect(mid?.mix).toBeCloseTo(0.5, 5);
    expect(activeAt(entries, 6_500)?.previous).toBeNull(); // the crossfade is over
    expect(activeAt(entries, 12_050)?.previous).toBeNull(); // a cut never mixes
  });
});

describe("director: motifs", () => {
  function songWithMotifs(lines: Array<[number, number, Motif[]]>): Analysis {
    const a = buildFixture({ durationMs: 60_000 });
    const base = a.text?.lines[0];
    if (!a.text || !base) throw new Error("fixture has no lines");
    a.text.lines.splice(
      0,
      a.text.lines.length,
      ...lines.map(([startMs, endMs, motifs]) => ({ ...base, startMs, endMs, words: [], meaning: { valence: 0, energy: 0.5, emotion: "calm" as Emotion, motifs } })),
    );
    return a;
  }
  const on = show("mood-field");

  it("is empty when the show has motifs off", () => {
    const a = songWithMotifs([[10_000, 14_000, ["fire"]]]);
    expect(motifsAt(a, show("spectrum-classic"), 12_000)).toEqual([]);
  });

  it("starts one beat before the line and ends one bar after it", () => {
    const a = songWithMotifs([[10_000, 14_000, ["fire"]]]);
    expect(motifsAt(a, on, 10_000 - BEAT - 10)).toEqual([]);
    expect(motifsAt(a, on, 10_000 - BEAT + 20).map((m) => m.motif)).toEqual(["fire"]);
    expect(motifsAt(a, on, 12_000).map((m) => m.motif)).toEqual(["fire"]);
    expect(motifsAt(a, on, 14_000 + BAR - 20).map((m) => m.motif)).toEqual(["fire"]);
    expect(motifsAt(a, on, 14_000 + BAR + 20)).toEqual([]);
  });

  it("returns a motif layer ready to draw that fades in and out", () => {
    const a = songWithMotifs([[10_000, 14_000, ["rain"]]]);
    const mid = motifsAt(a, on, 12_000)[0];
    expect(mid?.layer).toMatchObject({ id: "motif-rain", type: "motif", enabled: true, blend: "add" });
    expect(mid?.layer.params.motif).toBe("rain");
    const amount = (t: number) => (motifsAt(a, on, t)[0]?.layer.params.amount as number) ?? 0;
    expect(amount(12_000)).toBeGreaterThan(0.85);
    expect(amount(10_000 - BEAT + 20)).toBeLessThan(0.1);
    expect(amount(14_000 + BAR - 100)).toBeLessThan(amount(14_000));
    expect(amount(14_000)).toBeLessThanOrEqual(0.9);
  });

  it("plays at most two motifs at once and the newest win", () => {
    const a = songWithMotifs([
      [10_000, 20_000, ["fire", "rain", "snow"]],
      [12_000, 20_000, ["stars"]],
      [14_000, 20_000, ["ocean"]],
    ]);
    for (let t = 8_000; t < 24_000; t += 250) expect(motifsAt(a, on, t).length).toBeLessThanOrEqual(MAX_MOTIFS);
    expect(MAX_MOTIFS).toBe(2);
    expect(motifsAt(a, on, 11_000).length).toBe(2);
    expect(motifsAt(a, on, 11_000).map((m) => m.motif)).toEqual(["fire", "rain"]);
    // The third line starts: its motif and the second line's stay, the oldest leave.
    expect(motifsAt(a, on, 15_000).map((m) => m.motif)).toEqual(["ocean", "stars"]);
  });

  it("does not repeat a motif that two lines both ask for", () => {
    const a = songWithMotifs([
      [10_000, 14_000, ["fire"]],
      [12_000, 16_000, ["fire", "stars"]],
    ]);
    const list = motifsAt(a, on, 13_000).map((m) => m.motif);
    expect(list.sort()).toEqual(["fire", "stars"]);
  });

  it("is empty without words", () => {
    const a = buildFixture({ durationMs: 60_000, words: false });
    expect(motifsAt(a, on, 20_000)).toEqual([]);
  });

  it("finds the fixture's own imagery", () => {
    const a = buildFixture({ durationMs: 60_000 });
    const line = a.text?.lines[2];
    expect(line?.meaning?.motifs).toEqual(["fire"]);
    expect(motifsAt(a, on, (line?.startMs ?? 0) + 1_000).map((m) => m.motif)).toContain("fire");
  });
});

describe("director: following the mood", () => {
  const emotional = show("mood-field");

  it("changes scene with the emotion, on downbeats, at least two bars apart", () => {
    const a = buildFixture({ durationMs: 60_000 });
    const tl = autoTimeline(a, emotional);
    expect(tl.length).toBeGreaterThan(2);
    expect(tl[0]).toMatchObject({ startMs: 0, transition: { kind: "cut" } });
    for (const [i, e] of tl.entries()) {
      expect(e.startMs % BAR, `entry ${i}`).toBe(0);
      expect(e.endMs - e.startMs).toBeGreaterThanOrEqual(MIN_EMOTION_BARS * BAR);
      if (i > 0) {
        expect(e.sceneId).not.toBe(tl[i - 1]?.sceneId);
        expect(e.startMs).toBe(tl[i - 1]?.endMs);
      }
    }
    expect(tl[tl.length - 1]?.endMs).toBe(60_000);
  });

  it("follows sceneForEmotion", () => {
    const a = buildFixture({ durationMs: 60_000 });
    const mapped = show("mood-field", (s) => {
      s.director = { sceneFor: {}, transitions: {}, follow: "emotion", sceneForEmotion: { calm: "calm", awe: "full", joy: "main", love: "main", sadness: "calm", hope: "full", fear: "main", anger: "full" } };
    });
    const keys = a.text?.mood ?? [];
    const tl = autoTimeline(a, mapped);
    const sceneOf = (emotion: Emotion) => mapped.director?.sceneForEmotion?.[emotion];
    for (const e of tl.slice(1)) {
      // A change lands on a downbeat within a bar of the key that asked for it.
      const key = keys.find((k) => Math.abs(k.ms - e.startMs) <= BAR && sceneOf(k.emotion) === e.sceneId);
      expect(key, `a mood key for ${e.sceneId} near ${e.startMs}`).toBeDefined();
    }
    // The first scene is the first key's.
    const first = keys[0] as (typeof keys)[number];
    expect(tl[0]?.sceneId).toBe(first.emotion === "calm" || first.emotion === "sadness" ? "calm" : first.emotion === "awe" || first.emotion === "hope" || first.emotion === "anger" ? "full" : "main");
  });

  it("picks a scene from the mood's energy when an emotion is not mapped", () => {
    const a = buildFixture({ durationMs: 60_000 });
    const keys = a.text?.mood ?? [];
    keys.forEach((k, i) => {
      k.emotion = "joy";
      k.energy = i % 2 === 0 ? 0.1 : 0.9;
    });
    const s = show("mood-field", (x) => {
      x.director = { sceneFor: {}, transitions: {}, follow: "emotion", sceneForEmotion: {} };
    });
    const ids = new Set(autoTimeline(a, s).map((e) => e.sceneId));
    expect(ids.has("calm")).toBe(true);
    expect(ids.has("full")).toBe(true);
  });

  it("holds a scene for two bars when the mood flickers", () => {
    const a = buildFixture({ durationMs: 60_000 });
    const emotions: Emotion[] = ["sadness", "joy"];
    if (a.text) a.text.mood = Array.from({ length: 50 }, (_, i) => ({ ms: i * 1_000 + 300, valence: 0, energy: 0.5, emotion: emotions[i % 2] as Emotion }));
    const tl = autoTimeline(a, emotional);
    for (const e of tl) expect(e.endMs - e.startMs).toBeGreaterThanOrEqual(MIN_EMOTION_BARS * BAR);
    expect(tl.length).toBeGreaterThan(2);
  });

  it("falls back to the sections without words", () => {
    const a = buildFixture({ durationMs: 60_000, words: false });
    const tl = autoTimeline(a, emotional);
    expect(tl.map((e) => e.sceneId)).toEqual(["calm", "main", "full", "calm"]);
  });

  it("keeps manual entries even when following emotion", () => {
    const a = buildFixture({ durationMs: 60_000 });
    const entries: TimelineEntry[] = [{ startMs: 0, endMs: 60_000, sceneId: "calm", transition: { kind: "cut", ms: 0 } }];
    const s = show("mood-field", (x) => {
      x.timeline = { mode: "manual", entries };
    });
    expect(timelineFor(a, s)).toBe(entries);
  });
});
