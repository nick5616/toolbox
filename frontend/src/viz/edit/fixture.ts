/**
 * Edit Studio fixtures (Phase 9 SPEC §16.3), shared by every package's tests
 * and by Edit Lab. CONTRACT (Wave 0): the truth values below are what the
 * marker tests check against.
 *
 * buildEditFixture(): 120 bpm, 24 s, bars of 2 s (bar k, 1-based, starts at
 * (k−1)·2000 ms). Kicks on every beat, snares on beats 2 and 4, eighth-note
 * hats. Sections intro 0–4 s, verse 4–8 s, chorus 8–16 s, drop 16–24 s.
 * A stop (near-silence, no drum hits) at 15,000–15,400 ms — inside bar 8 —
 * and a drop event at 16,000 ms (bar 9). Timed lines every 4 s from 4 s.
 */
import type { Analysis } from "../analysis";
import { buildFixture } from "../fixture";
import { emptyEditProject } from "./defaults";
import type { EditProject } from "./types";

export const FIXTURE_DURATION_MS = 24_000;
export const FIXTURE_BEAT_MS = 500;
export const FIXTURE_STOP: readonly [number, number] = [15_000, 15_400];
export const FIXTURE_DROP_MS = 16_000;

export function buildEditFixture(): Analysis {
  return buildFixture({
    durationMs: FIXTURE_DURATION_MS,
    fps: 60,
    stems: true,
    words: true,
    sections: [
      [0, "intro", "A", 0.2],
      [4000, "verse", "B", 0.5],
      [8000, "chorus", "C", 0.85],
      [16_000, "drop", "D", 1],
    ],
    silences: [[FIXTURE_STOP[0], FIXTURE_STOP[1]]],
  });
}

/** Truth: kick times (every beat except inside the stop). */
export function fixtureKicks(): number[] {
  const out: number[] = [];
  for (let t = 0; t < FIXTURE_DURATION_MS; t += FIXTURE_BEAT_MS) if (t < FIXTURE_STOP[0] || t >= FIXTURE_STOP[1]) out.push(t);
  return out;
}

/** Truth: snare times (beats 2 and 4). */
export function fixtureSnares(): number[] {
  const out: number[] = [];
  for (let t = FIXTURE_BEAT_MS; t < FIXTURE_DURATION_MS; t += 2 * FIXTURE_BEAT_MS) if (t < FIXTURE_STOP[0] || t >= FIXTURE_STOP[1]) out.push(t);
  return out;
}

/**
 * A project over the whole fixture song (range 0–24 s): a video track with a
 * video, a photo and a colour clip (an effect driven by marker.kick, a flash
 * transition), an adjustment track, and captions. Paths are fake: use it for
 * logic tests, or swap paths for generated media (Edit Lab).
 */
export function fixtureProject(): EditProject {
  const p = emptyEditProject("9:16", 30, 7);
  p.song = { path: "/fixture/song.wav", startMs: 0, endMs: FIXTURE_DURATION_MS, gainDb: 0, fadeInMs: 0, fadeOutMs: 500 };
  p.analysisKey = "fixture-s1-none-m0";
  p.sources = [
    { path: "/fixture/a.mp4", tags: ["hero"] },
    { path: "/fixture/b.mp4", tags: ["broll"] },
    { path: "/fixture/photo.jpg", tags: [] },
  ];
  const clip = (over: Partial<import("@/lib/api").EditClip> & { id: string; kind: string; startMs: number; endMs: number }) => ({
    path: "",
    color: "",
    inMs: 0,
    speed: "",
    slow: "",
    volume: 0,
    fit: "fill",
    fitColor: "#000000",
    flipX: false,
    blend: "normal",
    transform: "",
    matte: null,
    fxTarget: "clip",
    masks: "",
    effects: "",
    in: "",
    text: "",
    visual: "",
    pinned: false,
    auto: false,
    ...over,
  });
  p.tracks = [
    {
      id: "t1",
      kind: "video",
      name: "Video 1",
      muted: false,
      locked: false,
      matte: "",
      clips: [
        clip({
          id: "c1",
          kind: "video",
          path: "/fixture/a.mp4",
          startMs: 0,
          endMs: 8000,
          inMs: 1000,
          effects: JSON.stringify([
            { id: "fx1", type: "punch", enabled: true, params: { amount: { base: 0, mods: [{ signal: "marker.kick", amount: 1, shape: "exp", attackMs: 5, releaseMs: 160 }] } } },
          ]),
        }),
        clip({ id: "c2", kind: "image", path: "/fixture/photo.jpg", startMs: 8000, endMs: 16_000, transform: JSON.stringify({ x: 0, y: 0, scale: { base: 1, keys: [{ t: 0, v: 1, ease: "linear" }, { t: 8000, v: 1.15, ease: "ease" }] }, rotation: 0, opacity: 1 }) }),
        clip({ id: "c3", kind: "video", path: "/fixture/b.mp4", startMs: 16_000, endMs: 24_000, in: JSON.stringify({ kind: "flash", ms: 300 }) }),
      ],
    },
    {
      id: "t2",
      kind: "adjust",
      name: "Adjust 1",
      muted: false,
      locked: false,
      matte: "",
      clips: [clip({ id: "c4", kind: "adjust", startMs: 16_000, endMs: 24_000, effects: JSON.stringify([{ id: "fx2", type: "grade", enabled: true, params: { saturation: 1.4 } }]) })],
    },
  ];
  p.captions = { style: "", behindSubject: false, lines: "" };
  return p;
}
