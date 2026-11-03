/**
 * compileEdit (Phase 9 SPEC §8.3): everything the engine needs that doesn't
 * depend on a GPU. Pure and deterministic; runs in the UI and in the export
 * worker.
 *
 *  - every JSON field is parsed with schema.ts (problems carry the field path);
 *  - clip spans sit on the output frame grid after the cut offset;
 *  - video clips get a source-frame table that integrates their Speed keys on
 *    the output grid: src(j) = InMs·fps/1000 + Σ_{i<j} speed(u_i);
 *  - transitions know their outgoing clip, which keeps playing past its end;
 *  - `needsAt` lists the stream frames a frame uses (the engine's needs()).
 */
import "../post";
import { Analysis, type TextDoc } from "../analysis";
import { hexToLinear, type RGB } from "../palette";
import { postDef } from "../post/registry";
import { Signals } from "../signals";
import type { TextStyle } from "../types";
import { MarkerSignals } from "./markerSignals";
import { evalEditParam } from "./params";
import {
  parseCaptionLines,
  parseEffects,
  parseLook,
  parseMasks,
  parseSpeed,
  parseTextStyle,
  parseTransform,
  parseTransition,
  IDENTITY_TRANSFORM,
  SPEED_MAX,
  SPEED_MIN,
  CUT,
} from "./schema";
import { normalizeProject } from "./defaults";
import type { ClipTransform, CompiledEdit, EditEngineOptions, EditInputs, EditParam, EditPost, EditTransition, FrameKey, Mask } from "./types";
import { editLength } from "./types";

export const MAX_TRANSITION_MS = 2000;
const EPS = 1e-6;
const ceilF = (x: number) => Math.ceil(x - EPS) + 0; // + 0 turns -0 into 0

export type ClipKind = "video" | "image" | "color" | "adjust";
export type FitMode = "fill" | "fit" | "fit-color" | "fit-blur";
export type BlendMode = "normal" | "add" | "screen" | "multiply";
export type SlowMode = "blend" | "none" | "interpolate";
export type FxTarget = "clip" | "subject" | "background";

export interface CompiledMatte {
  /** EditFiles key: "m:<id>" in streams (video) or images (photo). */
  key: string;
  image: boolean;
  /** Source frame that matte frame 0 shows (round(FromMs·fps/1000)). */
  fromFrame: number;
  cutout: boolean;
  invert: boolean;
  feather: number;
  strokePx: number;
  strokeColor: RGB;
  glowAmount: number;
  glowColor: RGB;
}

export interface InterpRef {
  key: string;
  fromMs: number;
  toMs: number;
  /** Frames per second of the interp stream (4 × project fps). */
  fps: number;
}

export interface CompiledClip {
  id: string;
  kind: ClipKind;
  trackIndex: number;
  /** Timeline ms after the cut offset. */
  startMs: number;
  endMs: number;
  /** Frame span [k0, k1) on the output grid (clamped to the edit). */
  k0: number;
  k1: number;
  /** Extra frames of source positions past k1 (the outgoing side of a transition). */
  tail: number;
  path: string;
  color: RGB;
  fit: FitMode;
  fitColor: RGB;
  flipX: boolean;
  blend: BlendMode;
  fxTarget: FxTarget;
  transform: ClipTransform;
  masks: Mask[];
  effects: EditPost[];
  transition: EditTransition;
  /** First frame after the transition window (k0 when there is none). */
  trEnd: number;
  /** Index in the track's clips of the outgoing clip, or −1. */
  outgoing: number;
  streamKey: string | null;
  imageKey: string | null;
  slow: SlowMode;
  /** Source position (frames of the stream) per frame j = k − k0, length k1 − k0 + tail. */
  src: Float64Array | null;
  /** Source frames advanced per output frame (the speed). */
  adv: Float32Array | null;
  /** Per frame: index into `interps` or −1. */
  interpIdx: Int16Array | null;
  interps: InterpRef[];
  matte: CompiledMatte | null;
  /** A matte is set but its files don't exist (yet). */
  matteMissing: boolean;
  /** The clip's speed is not a plain 1 (the UI may show badges). */
  speed: EditParam;
}

export interface CompiledTrack {
  index: number;
  id: string;
  kind: "video" | "adjust";
  muted: boolean;
  /** Sorted by k0. */
  clips: CompiledClip[];
}

export interface CompiledCaptions {
  style: TextStyle;
  behindSubject: boolean;
  /** The analysis the text layer reads (edited lines applied). */
  analysis: Analysis;
}

/** What compileEdit returns (the contract fields plus the engine's data). */
export interface CompiledEditFull extends CompiledEdit {
  readonly brand: "edit-compiled";
  width: number;
  height: number;
  seed: number;
  cutOffsetFrames: number;
  songStartMs: number;
  background: RGB;
  tracks: CompiledTrack[];
  look: EditPost[];
  captions: CompiledCaptions | null;
  analysis: Analysis;
  signals: Signals;
  markerSignals: MarkerSignals;
}

export function isCompiled(c: CompiledEdit | null | undefined): c is CompiledEditFull {
  return !!c && (c as Partial<CompiledEditFull>).brand === "edit-compiled";
}

export interface CompileOptions {
  width: number;
  height: number;
  fps: number;
  /** Frame counts of loaded streams: positions are capped at the last frame (otherwise the provider clamps). */
  streamFrames?: Record<string, number>;
}

// ---- pure helpers (tested) ----

/** The output frame at a timeline time (a small epsilon makes k·1000/fps map back to k). */
export function frameAtTime(tMs: number, fps: number, frames: number): number {
  return Math.max(0, Math.min(frames - 1, Math.floor((tMs * fps) / 1000 + EPS)));
}

/** The frame span [k0, k1) of a clip at [startMs, endMs) with the cut offset, unclamped. */
export function frameSpan(startMs: number, endMs: number, fps: number, offsetFrames: number): { k0: number; k1: number } {
  return { k0: ceilF((startMs * fps) / 1000 + offsetFrames), k1: ceilF((endMs * fps) / 1000 + offsetFrames) };
}

export interface SourceTable {
  src: Float64Array;
  adv: Float32Array;
}

/**
 * Source positions for `count` frames starting at output frame k0:
 * src(0) = startFrame and src(j+1) = src(j) + speed(u_j), where u_j is the
 * clip-relative time of frame j. Positions stop at `cap` (the last frame).
 */
export function integrateSpeed(count: number, startFrame: number, k0: number, clipStartMs: number, fps: number, speed: (uMs: number) => number, cap = Infinity): SourceTable {
  const src = new Float64Array(count);
  const adv = new Float32Array(count);
  let p = startFrame;
  for (let j = 0; j < count; j++) {
    const u = ((k0 + j) * 1000) / fps - clipStartMs;
    const s = Math.max(SPEED_MIN, Math.min(SPEED_MAX, speed(u)));
    src[j] = Math.min(p, cap);
    adv[j] = s;
    p += s;
  }
  return { src, adv };
}

export interface PlanRef {
  /** A key of EditFiles.streams (video, matte, interp) or images (photo, image matte, with f0 = 0). */
  stream: string;
  f0: number;
  /** An EditFiles.images key (loaded with FrameProvider.image) rather than a stream. */
  image?: boolean;
  /** The second frame blended in at weight w (= f0 when w is 0). */
  f1: number;
  w: number;
}

export interface ClipFramePlan {
  main: PlanRef | null;
  matte: PlanRef | null;
}

const FRAC_EPS = 1e-4;

function blendRef(stream: string, p: number, adv: number, slow: SlowMode, offset = 0): PlanRef {
  const q = Math.max(0, p - offset);
  const f = Math.floor(q);
  const frac = q - f;
  if (slow !== "none" && adv < 1 - EPS && frac > FRAC_EPS && frac < 1 - FRAC_EPS) return { stream, f0: f, f1: f + 1, w: frac };
  const r = Math.round(q);
  return { stream, f0: r, f1: r, w: 0 };
}

/** The stream frames clip `c` draws at output frame k (video/image clips only). */
export function clipFramePlan(c: CompiledClip, k: number, fps: number): ClipFramePlan {
  let main: PlanRef | null = null;
  let matte: PlanRef | null = null;
  if (c.kind === "image" && c.imageKey) main = { stream: c.imageKey, f0: 0, f1: 0, w: 0, image: true };
  else if (c.kind === "video" && c.streamKey && c.src && c.adv) {
    const j = Math.max(0, Math.min(c.src.length - 1, k - c.k0));
    const p = c.src[j] as number;
    const a = c.adv[j] as number;
    const ii = c.interpIdx ? (c.interpIdx[j] as number) : -1;
    if (ii >= 0) {
      const ip = c.interps[ii] as InterpRef;
      const q = Math.max(0, Math.round((((p * 1000) / fps - ip.fromMs) * ip.fps) / 1000));
      main = { stream: ip.key, f0: q, f1: q, w: 0 };
    } else main = blendRef(c.streamKey, p, a, c.slow);
    if (c.matte && !c.matte.image) matte = blendRef(c.matte.key, p, a, c.slow, c.matte.fromFrame);
  }
  if (c.matte?.image) matte = { stream: c.matte.key, f0: 0, f1: 0, w: 0, image: true };
  return { main, matte };
}

/** The clip of a track covering output frame k, if any (clips are sorted and don't overlap). */
export function clipAt(t: CompiledTrack, k: number): CompiledClip | null {
  let lo = 0;
  let hi = t.clips.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = t.clips[mid] as CompiledClip;
    if (k < c.k0) hi = mid - 1;
    else if (k >= c.k1) lo = mid + 1;
    else return c;
  }
  return null;
}

/** Transition progress (0..1) of clip b at timeline time tMs, or null outside its window. */
export function transitionMix(b: CompiledClip, tMs: number, k: number): number | null {
  if (b.transition.kind === "cut" || b.transition.ms <= 0 || k >= b.trEnd || k < b.k0) return null;
  return Math.max(0, Math.min(1, (tMs - b.startMs) / b.transition.ms));
}

/** The outgoing clip of b while its transition runs, or null (then the outgoing side is transparent). */
export function outgoingOf(t: CompiledTrack, b: CompiledClip): CompiledClip | null {
  return b.outgoing >= 0 ? (t.clips[b.outgoing] ?? null) : null;
}

function pushRefs(out: FrameKey[], seen: Set<string>, p: PlanRef | null): void {
  if (!p) return;
  for (const f of p.w > 0 ? [p.f0, p.f1] : [p.f0]) {
    const id = `${p.stream}#${f}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ stream: p.stream, frame: f });
  }
}

/** Every stream frame and image the frame at output frame k uses. */
export function needsAt(c: CompiledEditFull, k: number): FrameKey[] {
  const out: FrameKey[] = [];
  const seen = new Set<string>();
  const clipRefs = (cl: CompiledClip) => {
    const plan = clipFramePlan(cl, k, c.fps);
    pushRefs(out, seen, plan.main);
    pushRefs(out, seen, plan.matte);
  };
  for (const t of c.tracks) {
    if (t.muted || t.kind !== "video") continue;
    const cl = clipAt(t, k);
    if (!cl) continue;
    clipRefs(cl);
    if (cl.trEnd > k && cl.transition.kind !== "cut") {
      const a = outgoingOf(t, cl);
      if (a) clipRefs(a);
    }
  }
  return out;
}

// ---- compile ----

const FIT_MODES: readonly FitMode[] = ["fill", "fit", "fit-color", "fit-blur"];
const BLENDS: readonly BlendMode[] = ["normal", "add", "screen", "multiply"];
const SLOWS: readonly SlowMode[] = ["blend", "none", "interpolate"];
const TARGETS: readonly FxTarget[] = ["clip", "subject", "background"];

function pick<T extends string>(v: string, set: readonly T[], def: T): T {
  return (set as readonly string[]).includes(v) ? (v as T) : def;
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const lin = (h: string, def = "#000000"): RGB => hexToLinear(HEX.test(h) ? h : def);

const INTERP_KEY = /^i:(.*)\|(\d+)-(\d+)$/;

function dropStateful(list: EditPost[], where: string, problems: string[]): EditPost[] {
  return list.filter((p) => {
    if (postDef(p.type)?.stateful) {
      problems.push(`${where}: "${p.type}" can't be used in an edit`);
      return false;
    }
    return true;
  });
}

function textDocFor(lines: NonNullable<ReturnType<typeof parseCaptionLines>["value"]>): TextDoc {
  return { version: 1, source: "edit", language: "", matched: lines.length, lines, mood: [] };
}

export function compileEdit(inputs: EditInputs, opts: CompileOptions): CompiledEditFull {
  const p = normalizeProject(inputs.project);
  const fps = opts.fps;
  const durationMs = editLength(p);
  const frames = Math.max(1, Math.round((durationMs / 1000) * fps));
  const problems: string[] = [];
  const offset = Math.max(-3, Math.min(3, Math.round(p.cutOffsetFrames || 0)));
  const speedCap = (key: string) => {
    const n = opts.streamFrames?.[key];
    return n !== undefined ? Math.max(0, n - 1) : Infinity;
  };
  const files = inputs.files;
  const frameMs = 1000 / fps;
  const eval1 = (e: EditParam) => (u: number) => evalEditParam(e, SPEED_MIN, SPEED_MAX, u, 0, null);

  // interp streams by clip path
  const interpsByPath = new Map<string, InterpRef[]>();
  for (const key of Object.keys(files.streams)) {
    const m = INTERP_KEY.exec(key);
    if (!m) continue;
    const list = interpsByPath.get(m[1] as string) ?? [];
    list.push({ key, fromMs: Number(m[2]) * 1000, toMs: Number(m[3]) * 1000, fps: 4 * fps });
    interpsByPath.set(m[1] as string, list);
  }

  const tracks: CompiledTrack[] = [];
  p.tracks.forEach((tr, ti) => {
    const kind = tr.kind === "adjust" ? "adjust" : "video";
    const clips: CompiledClip[] = [];
    tr.clips.forEach((cl, ci) => {
      const where = `tracks[${ti}].clips[${ci}]`;
      const note = (r: { problems: string[] }) => {
        for (const m of r.problems) problems.push(`${where}.${m}`);
      };
      const ck: ClipKind = cl.kind === "image" || cl.kind === "color" || cl.kind === "adjust" ? cl.kind : "video";
      const span = frameSpan(cl.startMs, cl.endMs, fps, offset);
      const k0 = Math.max(0, span.k0);
      const k1 = Math.min(frames, span.k1);
      if (k1 <= k0) return; // outside the edit, or shorter than a frame
      const transform = parseTransform(cl.transform);
      note(transform);
      const masks = parseMasks(cl.masks);
      note(masks);
      const effects = parseEffects(cl.effects);
      note(effects);
      const tr2 = parseTransition(cl.in);
      note(tr2);
      const speed = parseSpeed(cl.speed);
      note(speed);
      const startMs = cl.startMs + offset * frameMs;
      const endMs = cl.endMs + offset * frameMs;
      const slow = pick(cl.slow, SLOWS, "blend");
      let streamKey: string | null = null;
      let imageKey: string | null = null;
      if (ck === "video") streamKey = `v:${cl.path}`;
      else if (ck === "image") imageKey = `p:${cl.path}`;
      let matte: CompiledMatte | null = null;
      let matteMissing = false;
      if (cl.matte && (ck === "video" || ck === "image")) {
        const key = `m:${cl.matte.id}`;
        const isImage = key in files.images && !(key in files.streams);
        if (key in files.streams || key in files.images) {
          matte = {
            key,
            image: isImage,
            fromFrame: Math.round((cl.matte.fromMs * fps) / 1000),
            cutout: cl.matte.cutout === true,
            invert: cl.matte.invert === true,
            feather: Math.max(0, Math.min(1, cl.matte.feather || 0)),
            strokePx: Math.max(0, Math.min(40, cl.matte.stroke?.px || 0)),
            strokeColor: lin(cl.matte.stroke?.color ?? ""),
            glowAmount: Math.max(0, Math.min(1, cl.matte.glow?.amount || 0)),
            glowColor: lin(cl.matte.glow?.color ?? ""),
          };
        } else matteMissing = true;
      }
      const target = pick(cl.fxTarget, TARGETS, "clip");
      clips.push({
        id: cl.id,
        kind: ck,
        trackIndex: ti,
        startMs,
        endMs,
        k0,
        k1,
        tail: 0,
        path: cl.path,
        color: lin(cl.color, "#000000"),
        fit: pick(cl.fit, FIT_MODES, "fill"),
        fitColor: lin(cl.fitColor, "#000000"),
        flipX: cl.flipX === true,
        blend: pick(cl.blend, BLENDS, "normal"),
        fxTarget: matte ? target : "clip",
        transform: transform.value,
        masks: masks.value,
        effects: dropStateful(effects.value, `${where}.effects`, problems),
        transition: kind === "adjust" ? { ...CUT } : tr2.value,
        trEnd: k0,
        outgoing: -1,
        streamKey,
        imageKey,
        slow,
        src: null,
        adv: null,
        interpIdx: null,
        interps: slow === "interpolate" ? (interpsByPath.get(cl.path) ?? []) : [],
        matte,
        matteMissing,
        speed: speed.value,
      });
    });
    clips.sort((a, b) => a.k0 - b.k0);
    tracks.push({ index: ti, id: tr.id, kind, muted: tr.muted, clips });
  });

  // Transitions: window, outgoing clip, and the tail its source continues for.
  for (const t of tracks) {
    if (t.kind !== "video") continue;
    t.clips.forEach((b, i) => {
      const tr = b.transition;
      if (tr.kind === "cut" || tr.ms <= 0) return;
      const ms = Math.min(tr.ms, MAX_TRANSITION_MS, b.endMs - b.startMs);
      b.transition = { kind: tr.kind, ms };
      b.trEnd = Math.min(b.k1, Math.max(b.k0, ceilF(((b.startMs + ms) * fps) / 1000)));
      const a = t.clips[i - 1];
      if (a && a.kind !== "adjust" && Math.abs(b.startMs - a.endMs) <= frameMs + EPS) {
        b.outgoing = i - 1;
        a.tail = Math.max(a.tail, b.trEnd - a.k1);
      }
    });
  }

  // Source tables.
  for (const t of tracks) {
    for (const c of t.clips) {
      if (c.kind !== "video" || !c.streamKey) continue;
      const src = p.tracks[t.index]?.clips.find((x) => x.id === c.id);
      const inMs = src?.inMs ?? 0;
      const count = c.k1 - c.k0 + Math.max(0, c.tail);
      const tab = integrateSpeed(count, (inMs * fps) / 1000, c.k0, c.startMs, fps, eval1(c.speed), speedCap(c.streamKey));
      c.src = tab.src;
      c.adv = tab.adv;
      if (c.slow === "interpolate" && c.interps.length > 0) {
        const idx = new Int16Array(count).fill(-1);
        for (let j = 0; j < count; j++) {
          if ((tab.adv[j] as number) >= 1 - EPS) continue;
          const ms = ((tab.src[j] as number) * 1000) / fps;
          const hit = c.interps.findIndex((ip) => ms >= ip.fromMs && ms <= ip.toMs);
          idx[j] = hit;
        }
        c.interpIdx = idx;
      }
    }
  }

  // Look, captions, signals.
  const look = parseLook(p.look);
  for (const m of look.problems) problems.push(m);
  let captions: CompiledCaptions | null = null;
  if (p.captions) {
    const style = parseTextStyle(p.captions.style);
    for (const m of style.problems) problems.push(m);
    const lines = parseCaptionLines(p.captions.lines);
    for (const m of lines.problems) problems.push(m);
    captions = { style: style.value, behindSubject: p.captions.behindSubject === true, analysis: lines.value ? inputs.analysis.withText(textDocFor(lines.value)) : inputs.analysis };
  }
  const songStartMs = p.song?.startMs ?? 0;
  void IDENTITY_TRANSFORM;

  return {
    brand: "edit-compiled",
    durationMs,
    frames,
    fps,
    problems,
    width: opts.width,
    height: opts.height,
    seed: p.seed,
    cutOffsetFrames: offset,
    songStartMs,
    background: lin(p.background, "#000000"),
    tracks,
    look: dropStateful(look.value, "look", problems),
    captions,
    analysis: inputs.analysis,
    signals: new Signals(inputs.analysis),
    markerSignals: new MarkerSignals(inputs.analysis, inputs.markers, songStartMs),
  };
}

/** Compile options an engine was created with (for callers that build both). */
export function compileOptionsFor(o: Pick<EditEngineOptions, "width" | "height" | "fps">): CompileOptions {
  return { width: o.width, height: o.height, fps: o.fps };
}
