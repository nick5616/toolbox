/**
 * Pure editing helpers for a Show (SPEC.md §6.4, §8.3). Every function takes a
 * show and returns a new one (never mutating the input), so the designer can
 * hand the result straight to `onChange` and the host's undo stays simple.
 */
import "@/viz/layers";
import "@/viz/post";
import { layerDef, type ParamSpec } from "@/viz/layers/registry";
import { postDef } from "@/viz/post/registry";
import { SIGNAL_META } from "@/viz/signals";
import {
  MAX_LAYERS_PER_SCENE,
  MAX_SCENES,
  type Blend,
  type LayerConfig,
  type LayerType,
  type Mod,
  type PaletteId,
  type PaletteMode,
  type Param,
  type PostConfig,
  type PostType,
  type Scene,
  type SignalId,
  type Show,
  type TextStyle,
  type TimelineEntry,
  type Transition,
} from "@/viz/types";

export type ParamValue = Param | string | boolean;
export type NumberSpec = Extract<ParamSpec, { kind: "number" }>;

// ---- params ----------------------------------------------------------------

export function baseOf(p: Param): number {
  return typeof p === "number" ? p : p.base;
}
export function modsOf(p: Param): Mod[] {
  return typeof p === "number" ? [] : p.mods;
}
/** A constant when there are no mods, else a reactive param. */
export function makeParam(base: number, mods: Mod[]): Param {
  return mods.length === 0 ? base : { base, mods };
}
export function withBase(p: Param, base: number): Param {
  return makeParam(base, modsOf(p));
}
export function withMods(p: Param, mods: Mod[]): Param {
  return makeParam(baseOf(p), mods);
}

export const DEFAULT_MOD: Mod = { signal: "mix.level", amount: 0.3, shape: "linear" };

export function isNumberSpec(s: ParamSpec | undefined): s is NumberSpec {
  return !!s && s.kind === "number";
}

// ---- targets ("<layerId>.<param>" | "post.<id>.<param>") --------------------

export type Target = { kind: "layer"; layerId: string; param: string } | { kind: "post"; postId: string; param: string };

export function parseTarget(t: string): Target | null {
  const parts = t.split(".");
  if (parts[0] === "post" && parts.length >= 3) return { kind: "post", postId: parts[1] as string, param: parts.slice(2).join(".") };
  if (parts.length >= 2) return { kind: "layer", layerId: parts[0] as string, param: parts.slice(1).join(".") };
  return null;
}
export function targetString(t: Target): string {
  return t.kind === "post" ? `post.${t.postId}.${t.param}` : `${t.layerId}.${t.param}`;
}

/** Every post list in the show: the global chain, then each scene's. */
function postLists(show: Show): PostConfig[][] {
  return [show.post, ...show.scenes.map((s) => s.post)];
}

function findPostConfig(show: Show, postId: string): PostConfig | null {
  for (const list of postLists(show)) {
    const hit = list.find((p) => p.id === postId);
    if (hit) return hit;
  }
  return null;
}

function layerOfType(show: Show, layerId: string): LayerType | null {
  for (const s of show.scenes) {
    const hit = s.layers.find((l) => l.id === layerId);
    if (hit) return hit.type;
  }
  return null;
}

/** The numeric spec a target points at (null when it isn't a reactive number). */
export function targetSpec(show: Show, target: string): NumberSpec | null {
  const t = parseTarget(target);
  if (!t) return null;
  if (t.kind === "post") {
    const pc = findPostConfig(show, t.postId);
    const spec = pc ? postDef(pc.type)?.params[t.param] : undefined;
    return isNumberSpec(spec) ? spec : null;
  }
  if (t.param === "opacity") return { kind: "number", label: "Opacity", min: 0, max: 1, default: 1 };
  const type = layerOfType(show, t.layerId);
  const spec = type ? layerDef(type)?.params[t.param] : undefined;
  return isNumberSpec(spec) ? spec : null;
}

function paramOf(cfg: { params: Record<string, Param | string | boolean> }, key: string): Param | null {
  const v = cfg.params[key];
  return typeof v === "number" || (typeof v === "object" && v !== null) ? (v as Param) : null;
}

/** The first copy of a target's param (the same layer id repeats in each scene). */
export function targetParam(show: Show, target: string): Param | null {
  const t = parseTarget(target);
  if (!t) return null;
  if (t.kind === "post") {
    const pc = findPostConfig(show, t.postId);
    return pc ? (paramOf(pc, t.param) ?? defaultOf(targetSpec(show, target))) : null;
  }
  for (const s of show.scenes) {
    const l = s.layers.find((x) => x.id === t.layerId);
    if (!l) continue;
    if (t.param === "opacity") return l.opacity;
    return paramOf(l, t.param) ?? defaultOf(targetSpec(show, target));
  }
  return null;
}

function defaultOf(spec: NumberSpec | null): Param | null {
  return spec ? spec.default : null;
}

/** Applies fn to every copy of the target's param in every scene (and the global chain). */
export function mapTarget(show: Show, target: string, fn: (p: Param, spec: NumberSpec) => Param): Show {
  const t = parseTarget(target);
  const spec = targetSpec(show, target);
  if (!t || !spec) return show;
  if (t.kind === "post") {
    const mapList = (list: PostConfig[]): PostConfig[] =>
      list.map((pc) => (pc.id === t.postId ? { ...pc, params: { ...pc.params, [t.param]: fn(paramOf(pc, t.param) ?? spec.default, spec) } } : pc));
    return { ...show, post: mapList(show.post), scenes: show.scenes.map((s) => ({ ...s, post: mapList(s.post) })) };
  }
  return {
    ...show,
    scenes: show.scenes.map((s) => ({
      ...s,
      layers: s.layers.map((l) => {
        if (l.id !== t.layerId) return l;
        if (t.param === "opacity") return { ...l, opacity: fn(l.opacity, spec) };
        return { ...l, params: { ...l.params, [t.param]: fn(paramOf(l, t.param) ?? spec.default, spec) } };
      }),
    })),
  };
}

// ---- reactions ---------------------------------------------------------------

/** The mod a Reactions row edits: the first mod of its param. */
export function reactionMod(show: Show, slot: { target: string }): Mod | null {
  const p = targetParam(show, slot.target);
  return p ? (modsOf(p)[0] ?? null) : null;
}

export function setReactionDriver(show: Show, index: number, signal: SignalId): Show {
  const slot = show.controls[index];
  if (!slot) return show;
  return mapTarget(show, slot.target, (p) => {
    const mods = modsOf(p);
    const first = mods[0];
    return withMods(p, first ? [{ ...first, signal }, ...mods.slice(1)] : [{ ...DEFAULT_MOD, signal }]);
  });
}

export function setReactionAmount(show: Show, index: number, amount: number): Show {
  const slot = show.controls[index];
  if (!slot) return show;
  const a = Math.max(-2, Math.min(2, amount));
  return mapTarget(show, slot.target, (p) => {
    const mods = modsOf(p);
    const first = mods[0];
    return withMods(p, first ? [{ ...first, amount: a }, ...mods.slice(1)] : [{ ...DEFAULT_MOD, amount: a }]);
  });
}

/** Removes a row and stops the parameter reacting (it keeps its base value). */
export function removeReaction(show: Show, index: number): Show {
  const slot = show.controls[index];
  if (!slot) return show;
  const cleared = mapTarget(show, slot.target, (p) => baseOf(p));
  return { ...cleared, controls: cleared.controls.filter((_, i) => i !== index) };
}

export function addReaction(show: Show, target: string, label?: string): Show {
  if (show.controls.some((c) => c.target === target)) return show;
  const spec = targetSpec(show, target);
  if (!spec) return show;
  const t = parseTarget(target);
  const name = label ?? (t?.kind === "post" ? `${postDef(findPostConfig(show, t.postId)?.type ?? "bloom")?.label ?? t.postId} ${spec.label.toLowerCase()}` : `${t ? layerName(show, t.layerId) : ""} ${spec.label.toLowerCase()}`.trim());
  const withMod = mapTarget(show, target, (p) => (modsOf(p).length > 0 ? p : withMods(p, [{ ...DEFAULT_MOD }])));
  return { ...withMod, controls: [...withMod.controls, { label: name, target }] };
}

export function layerName(show: Show, layerId: string): string {
  const type = layerOfType(show, layerId);
  return (type ? layerDef(type)?.label : undefined) ?? layerId;
}

export interface ReactionTarget {
  /** Layer id, or "post". */
  groupId: string;
  groupLabel: string;
  params: Array<{ target: string; label: string }>;
}

/** The two-level menu for "Add reaction": every layer then its reactive params, then the effects. */
export function reactionTargets(show: Show): ReactionTarget[] {
  const out: ReactionTarget[] = [];
  const seen = new Set<string>();
  for (const s of show.scenes) {
    for (const l of s.layers) {
      if (seen.has(l.id)) continue;
      seen.add(l.id);
      const def = layerDef(l.type);
      if (!def) continue;
      const params = [{ target: `${l.id}.opacity`, label: "Opacity" }];
      for (const [k, spec] of Object.entries(def.params)) if (spec.kind === "number") params.push({ target: `${l.id}.${k}`, label: spec.label });
      out.push({ groupId: l.id, groupLabel: `${def.label}${l.id !== l.type ? ` (${l.id})` : ""}`, params });
    }
  }
  const posts: ReactionTarget["params"] = [];
  const seenPost = new Set<string>();
  for (const list of postLists(show)) {
    for (const pc of list) {
      if (seenPost.has(pc.id)) continue;
      seenPost.add(pc.id);
      const def = postDef(pc.type);
      if (!def) continue;
      for (const [k, spec] of Object.entries(def.params)) if (spec.kind === "number") posts.push({ target: `post.${pc.id}.${k}`, label: `${def.label} · ${spec.label}` });
    }
  }
  if (posts.length > 0) out.push({ groupId: "post", groupLabel: "Effects", params: posts });
  return out;
}

// ---- layers ------------------------------------------------------------------

function mapScene(show: Show, sceneId: string, fn: (s: Scene) => Scene): Show {
  return { ...show, scenes: show.scenes.map((s) => (s.id === sceneId ? fn(s) : s)) };
}
function mapLayer(show: Show, sceneId: string, layerId: string, fn: (l: LayerConfig) => LayerConfig): Show {
  return mapScene(show, sceneId, (s) => ({ ...s, layers: s.layers.map((l) => (l.id === layerId ? fn(l) : l)) }));
}

export function uniqueId(base: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  if (!set.has(base)) return base;
  for (let i = 2; ; i++) if (!set.has(`${base}-${i}`)) return `${base}-${i}`;
}

/** Layers draw bottom-up: index 0 is the back. */
export function moveLayer(show: Show, sceneId: string, from: number, to: number): Show {
  return mapScene(show, sceneId, (s) => {
    if (from === to || from < 0 || to < 0 || from >= s.layers.length || to >= s.layers.length) return s;
    const layers = s.layers.slice();
    const [item] = layers.splice(from, 1);
    if (!item) return s;
    layers.splice(to, 0, item);
    return { ...s, layers };
  });
}

export function toggleLayer(show: Show, sceneId: string, layerId: string): Show {
  return mapLayer(show, sceneId, layerId, (l) => ({ ...l, enabled: !l.enabled }));
}
export function setLayerBlend(show: Show, sceneId: string, layerId: string, blend: Blend): Show {
  return mapLayer(show, sceneId, layerId, (l) => ({ ...l, blend }));
}
export function setLayerOpacity(show: Show, sceneId: string, layerId: string, opacity: Param): Show {
  return mapLayer(show, sceneId, layerId, (l) => ({ ...l, opacity }));
}
export function setLayerParam(show: Show, sceneId: string, layerId: string, key: string, value: ParamValue): Show {
  return mapLayer(show, sceneId, layerId, (l) => ({ ...l, params: { ...l.params, [key]: value } }));
}

export function defaultParams(specs: Record<string, ParamSpec>): LayerConfig["params"] {
  const out: LayerConfig["params"] = {};
  for (const [k, s] of Object.entries(specs)) out[k] = s.default;
  return out;
}

export function canAddLayer(show: Show, sceneId: string): boolean {
  const s = show.scenes.find((x) => x.id === sceneId);
  return !!s && s.layers.length < MAX_LAYERS_PER_SCENE;
}

export function addLayer(show: Show, sceneId: string, type: LayerType): Show {
  const def = layerDef(type);
  if (!def || !canAddLayer(show, sceneId)) return show;
  return mapScene(show, sceneId, (s) => ({
    ...s,
    layers: [
      ...s.layers,
      {
        id: uniqueId(type, s.layers.map((l) => l.id)),
        type,
        enabled: true,
        blend: def.group === "background" ? "normal" : "add",
        opacity: 1,
        params: defaultParams(def.params),
      },
    ],
  }));
}

export function duplicateLayer(show: Show, sceneId: string, layerId: string): Show {
  if (!canAddLayer(show, sceneId)) return show;
  return mapScene(show, sceneId, (s) => {
    const i = s.layers.findIndex((l) => l.id === layerId);
    const src = s.layers[i];
    if (!src) return s;
    const copy: LayerConfig = { ...structuredClone(src), id: uniqueId(src.id, s.layers.map((l) => l.id)) };
    const layers = s.layers.slice();
    layers.splice(i + 1, 0, copy);
    return { ...s, layers };
  });
}

/** Deletes a layer; Reactions rows pointing at a layer id no scene has any more go with it. */
export function deleteLayer(show: Show, sceneId: string, layerId: string): Show {
  const next = mapScene(show, sceneId, (s) => ({ ...s, layers: s.layers.filter((l) => l.id !== layerId) }));
  const stillThere = next.scenes.some((s) => s.layers.some((l) => l.id === layerId));
  if (stillThere) return next;
  return {
    ...next,
    controls: next.controls.filter((c) => {
      const t = parseTarget(c.target);
      return !(t && t.kind === "layer" && t.layerId === layerId);
    }),
  };
}

// ---- post effects --------------------------------------------------------------

export type PostScope = "global" | string; // "global" or a scene id

function mapPost(show: Show, scope: PostScope, fn: (list: PostConfig[]) => PostConfig[]): Show {
  if (scope === "global") return { ...show, post: fn(show.post) };
  return mapScene(show, scope, (s) => ({ ...s, post: fn(s.post) }));
}
export function postList(show: Show, scope: PostScope): PostConfig[] {
  return scope === "global" ? show.post : (show.scenes.find((s) => s.id === scope)?.post ?? []);
}
export function addPost(show: Show, scope: PostScope, type: PostType): Show {
  const def = postDef(type);
  if (!def) return show;
  return mapPost(show, scope, (list) => [...list, { id: uniqueId(type, list.map((p) => p.id)), type, enabled: true, params: defaultParams(def.params) }]);
}
export function removePost(show: Show, scope: PostScope, id: string): Show {
  const next = mapPost(show, scope, (list) => list.filter((p) => p.id !== id));
  const gone = !postLists(next).some((l) => l.some((p) => p.id === id));
  return gone ? { ...next, controls: next.controls.filter((c) => !c.target.startsWith(`post.${id}.`)) } : next;
}
export function togglePost(show: Show, scope: PostScope, id: string): Show {
  return mapPost(show, scope, (list) => list.map((p) => (p.id === id ? { ...p, enabled: !p.enabled } : p)));
}
export function setPostParam(show: Show, scope: PostScope, id: string, key: string, value: ParamValue): Show {
  return mapPost(show, scope, (list) => list.map((p) => (p.id === id ? { ...p, params: { ...p.params, [key]: value } } : p)));
}

// ---- Look: global knobs -----------------------------------------------------------

export function setReactivity(show: Show, v: number): Show {
  return { ...show, reactivity: v };
}
export function setSpeed(show: Show, v: number): Show {
  return { ...show, speed: v };
}
export function setMix(show: Show, group: keyof Show["mix"], v: number): Show {
  return { ...show, mix: { ...show.mix, [group]: v } };
}

/** How many palettes each mode takes (SPEC.md §6.4): fixed 1, journey/sections 2–5. */
export function paletteLimits(mode: PaletteMode): { min: number; max: number } {
  switch (mode) {
    case "fixed":
      return { min: 1, max: 1 };
    case "journey":
    case "sections":
      return { min: 2, max: 5 };
    default:
      return { min: 0, max: 5 };
  }
}

export function setPaletteMode(show: Show, mode: PaletteMode): Show {
  const lim = paletteLimits(mode);
  let ids = show.palette.ids.slice(0, Math.max(lim.max, 1));
  const fill: PaletteId[] = ["cyber", "sunset", "ice", "neon", "fire"];
  for (const f of fill) if (ids.length < lim.min && !ids.includes(f)) ids = [...ids, f];
  return { ...show, palette: { mode, ids } };
}

/** Clicking a swatch: replaces in fixed mode, toggles in multi modes within the limits. */
export function togglePalette(show: Show, id: PaletteId): Show {
  const { mode, ids } = show.palette;
  const lim = paletteLimits(mode);
  if (lim.max === 1) return { ...show, palette: { mode, ids: [id] } };
  if (ids.includes(id)) return ids.length <= Math.max(1, lim.min) ? show : { ...show, palette: { mode, ids: ids.filter((x) => x !== id) } };
  return ids.length >= lim.max ? show : { ...show, palette: { mode, ids: [...ids, id] } };
}

// The three Look knobs are views onto the global effects (added on first use; the id is the type).
function globalParam(show: Show, type: PostType, key: string): number {
  const pc = show.post.find((p) => p.type === type);
  const spec = postDef(type)?.params[key];
  if (!pc || !pc.enabled) return type === "grade" ? 1 : 0;
  const v = pc.params[key];
  const d = isNumberSpec(spec) ? spec.default : 0;
  return v === undefined ? d : baseOf(v as Param);
}
function setGlobalParam(show: Show, type: PostType, key: string, value: number, neutral: number): Show {
  let cur = show;
  if (!cur.post.some((p) => p.type === type)) {
    if (value === neutral) return show;
    cur = addPost(cur, "global", type);
  }
  return {
    ...cur,
    post: cur.post.map((p) => {
      if (p.type !== type) return p;
      const old = p.params[key];
      return { ...p, enabled: true, params: { ...p.params, [key]: typeof old === "object" && old !== null ? withBase(old, value) : value } };
    }),
  };
}

/** Glow = bloom intensity. */
export const getGlow = (s: Show): number => globalParam(s, "bloom", "intensity");
export const setGlow = (s: Show, v: number): Show => setGlobalParam(s, "bloom", "intensity", v, 0);
/** Grain = film-grain amount. */
export const getGrain = (s: Show): number => globalParam(s, "grain", "amount");
export const setGrain = (s: Show, v: number): Show => setGlobalParam(s, "grain", "amount", v, 0);
/** Intensity = the grade pass's gain (highlights). */
export const getIntensity = (s: Show): number => globalParam(s, "grade", "gain");
export const setIntensity = (s: Show, v: number): Show => setGlobalParam(s, "grade", "gain", v, 1);

// ---- text ----------------------------------------------------------------------

export const TEXT_PRESETS: ReadonlyArray<{ id: TextStyle["preset"]; label: string; hint: string }> = [
  { id: "karaoke", label: "Karaoke", hint: "Words fill as they are sung" },
  { id: "pop", label: "Pop", hint: "Words pop in with a bounce" },
  { id: "rise", label: "Rise", hint: "Lines float up and fade in" },
  { id: "typewriter", label: "Typewriter", hint: "Letters appear one by one" },
  { id: "fade", label: "Fade", hint: "Soft fades, nothing else" },
  { id: "wave", label: "Wave", hint: "Words bob while sung" },
  { id: "subtitle", label: "Subtitle", hint: "Plain readable captions" },
  { id: "subtitle-boxed", label: "Boxed", hint: "Captions on a dark box" },
];

export function defaultTextStyle(preset: TextStyle["preset"] = "karaoke"): TextStyle {
  return {
    preset,
    font: "Arial",
    weight: 700,
    size: 6,
    color: "#ffffff",
    highlight: "mood",
    position: preset === "subtitle" || preset === "subtitle-boxed" ? "lower" : "center",
    showNext: true,
    uppercase: false,
    outline: 0.05,
    glow: 0.3,
    emphasis: { scale: 1.25, glow: 0.6, color: "highlight", sparks: true },
    react: { signal: null, amount: 1 },
    titleCard: null,
  };
}

export function setText(show: Show, patch: Partial<TextStyle>): Show {
  const cur = show.text ?? defaultTextStyle();
  return { ...show, text: { ...cur, ...patch } };
}

// ---- timeline -------------------------------------------------------------------

export function setTimelineMode(show: Show, mode: "auto" | "manual", auto: TimelineEntry[]): Show {
  if (mode === "auto") return { ...show, timeline: { mode: "auto", entries: [] } };
  // New manual entries copy from auto (SPEC.md §6.9).
  return { ...show, timeline: { mode: "manual", entries: show.timeline.entries.length > 0 ? show.timeline.entries : structuredClone(auto) } };
}

export function resetTimeline(show: Show): Show {
  return { ...show, timeline: { mode: "auto", entries: [] } };
}

export function patchEntry(show: Show, index: number, patch: Partial<Pick<TimelineEntry, "sceneId" | "transition">> & { paletteId?: PaletteId | null }): Show {
  const entries = show.timeline.entries.map((e, i) => {
    if (i !== index) return e;
    const { paletteId, ...rest } = patch;
    const next: TimelineEntry = { ...e, ...rest };
    if (paletteId === null) delete next.paletteId;
    else if (paletteId) next.paletteId = paletteId;
    return next;
  });
  return { ...show, timeline: { ...show.timeline, entries } };
}

export const TRANSITION_KINDS: ReadonlyArray<Transition["kind"]> = ["cut", "crossfade", "flash", "zoom", "sweep", "glitch"];

// ---- scenes ----------------------------------------------------------------------

export function canAddScene(show: Show): boolean {
  return show.scenes.length < MAX_SCENES;
}

// ---- presets ----------------------------------------------------------------------

/** Drops full-frame background layers (overlay mode keeps the video visible). */
export function dropBackgrounds(show: Show): Show {
  const scenes = show.scenes.map((s) => {
    const layers = s.layers.filter((l) => layerDef(l.type)?.group !== "background" || l.type === "motif");
    return layers.length === 0 ? s : { ...s, layers };
  });
  const ids = new Set(scenes.flatMap((s) => s.layers.map((l) => l.id)));
  const controls = show.controls.filter((c) => {
    const t = parseTarget(c.target);
    return !t || t.kind === "post" || ids.has(t.layerId);
  });
  return { ...show, scenes, controls };
}

/**
 * Applies a template to the current design. The result is always a fresh copy;
 * host-drawn text (`engineText` false) never survives into the show.
 */
export function applyTemplate(template: Show, opts: { mode: "full" | "overlay"; engineText: boolean; keepText?: TextStyle | null }): Show {
  let next = structuredClone(template);
  if (opts.mode === "overlay") next = dropBackgrounds(next);
  if (!opts.engineText) next = { ...next, text: null };
  else if (!next.text && opts.keepText) next = { ...next, text: opts.keepText };
  return next;
}

/** Host-drawn text: whatever the designer emits has no text (SPEC.md §9.4). */
export function withoutText(show: Show): Show {
  return show.text === null ? show : { ...show, text: null };
}

export function signalLabel(id: SignalId): string {
  return SIGNAL_META.get(id)?.label ?? id;
}
