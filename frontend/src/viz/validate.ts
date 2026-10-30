/** validateShow (SPEC.md §6.4): checks a show before it is rendered or saved. */
import "./layers";
import "./post";
import { layerDef } from "./layers/registry";
import type { ParamSpec } from "./layers/registry";
import { postDef } from "./post/registry";
import { SIGNAL_META } from "./signals";
import {
  LAYER_TYPES,
  MAX_LAYERS_PER_SCENE,
  MAX_SCENES,
  MAX_SHOW_BYTES,
  MIX_GROUPS,
  PALETTE_IDS,
  POST_TYPES,
  type Param,
  type Show,
} from "./types";

export type ValidateResult = { ok: true; show: Show } | { ok: false; problem: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function checkParams(where: string, params: unknown, specs: Record<string, ParamSpec>): string | null {
  if (!isObj(params)) return `${where}: params must be an object`;
  for (const [k, v] of Object.entries(params)) {
    const spec = specs[k];
    if (!spec) return `${where}: unknown parameter "${k}"`;
    if (spec.kind === "number") {
      const p = v as Param;
      const base = typeof p === "number" ? p : isObj(p) && typeof p.base === "number" ? p.base : NaN;
      if (!Number.isFinite(base)) return `${where}.${k}: must be a number`;
      if (base < spec.min - 1e-9 || base > spec.max + 1e-9) return `${where}.${k}: ${base} is outside ${spec.min}–${spec.max}`;
      if (typeof p !== "number") {
        if (!Array.isArray(p.mods)) return `${where}.${k}: mods must be a list`;
        for (const m of p.mods) {
          if (!isObj(m) || !SIGNAL_META.has(m.signal as never)) return `${where}.${k}: unknown signal "${String(isObj(m) ? m.signal : m)}"`;
          if (typeof m.amount !== "number" || m.amount < -2 || m.amount > 2) return `${where}.${k}: amount must be between -2 and 2`;
          if (!["linear", "ease", "exp", "gate"].includes(String(m.shape))) return `${where}.${k}: unknown shape`;
        }
      }
    } else if (spec.kind === "bool" && typeof v !== "boolean") return `${where}.${k}: must be on or off`;
    else if (spec.kind === "enum" && !spec.options.includes(String(v))) return `${where}.${k}: must be one of ${spec.options.join(", ")}`;
    else if (spec.kind === "color" && (typeof v !== "string" || !/^(c[0-3]|accent|glow|bg|#[0-9a-fA-F]{6})$/.test(v))) return `${where}.${k}: not a colour`;
  }
  return null;
}

export function validateShow(input: unknown): ValidateResult {
  let show: unknown = input;
  if (typeof input === "string") {
    if (input.length > MAX_SHOW_BYTES) return { ok: false, problem: "The design is too large" };
    try {
      show = JSON.parse(input);
    } catch {
      return { ok: false, problem: "The design isn't valid JSON" };
    }
  } else if (JSON.stringify(input).length > MAX_SHOW_BYTES) return { ok: false, problem: "The design is too large" };
  if (!isObj(show)) return { ok: false, problem: "The design must be an object" };
  const s = show;
  if (s.version !== 1) return { ok: false, problem: "Unknown design version" };
  if (!Array.isArray(s.scenes) || s.scenes.length < 1 || s.scenes.length > MAX_SCENES) return { ok: false, problem: `A design has 1–${MAX_SCENES} scenes` };
  const ids = new Set<string>();
  const sceneIds = new Set<string>();
  for (const [si, sc] of (s.scenes as unknown[]).entries()) {
    if (!isObj(sc) || typeof sc.id !== "string" || !sc.id) return { ok: false, problem: `Scene ${si + 1} has no id` };
    if (sceneIds.has(sc.id)) return { ok: false, problem: `Two scenes are called "${sc.id}"` };
    sceneIds.add(sc.id);
    if (!Array.isArray(sc.layers) || sc.layers.length > MAX_LAYERS_PER_SCENE) return { ok: false, problem: `Scene "${sc.id}" has more than ${MAX_LAYERS_PER_SCENE} layers` };
    for (const l of sc.layers as unknown[]) {
      if (!isObj(l) || typeof l.id !== "string" || !l.id) return { ok: false, problem: `A layer in "${sc.id}" has no id` };
      if (ids.has(`${sc.id}/${l.id}`)) return { ok: false, problem: `Two layers in "${sc.id}" are called "${l.id}"` };
      ids.add(`${sc.id}/${l.id}`);
      if (!(LAYER_TYPES as readonly string[]).includes(String(l.type))) return { ok: false, problem: `Unknown layer type "${String(l.type)}"` };
      const def = layerDef(l.type as never);
      if (!def) continue; // a known type not built in this version is skipped when rendering
      const p = checkParams(`${sc.id}.${l.id}`, l.params, def.params);
      if (p) return { ok: false, problem: p };
      if (!["normal", "add", "screen", "multiply"].includes(String(l.blend))) return { ok: false, problem: `${sc.id}.${l.id}: unknown blend` };
      const op = checkParams(`${sc.id}.${l.id}`, { opacity: l.opacity }, { opacity: { kind: "number", label: "Opacity", min: 0, max: 1, default: 1 } });
      if (op) return { ok: false, problem: op };
    }
    if (!Array.isArray(sc.post)) return { ok: false, problem: `Scene "${sc.id}" has no post list` };
  }
  const postLists: unknown[] = [s.post, ...(s.scenes as Array<Record<string, unknown>>).map((x) => x.post)];
  for (const list of postLists) {
    if (!Array.isArray(list)) return { ok: false, problem: "The post effects must be a list" };
    for (const pc of list as unknown[]) {
      if (!isObj(pc) || !(POST_TYPES as readonly string[]).includes(String(pc.type))) return { ok: false, problem: `Unknown effect "${String(isObj(pc) ? pc.type : pc)}"` };
      const def = postDef(pc.type as never);
      if (!def) continue;
      const p = checkParams(`post.${String(pc.id)}`, pc.params, def.params);
      if (p) return { ok: false, problem: p };
    }
  }
  if (!isObj(s.palette) || !Array.isArray(s.palette.ids) || !(s.palette.ids as unknown[]).every((i) => (PALETTE_IDS as readonly string[]).includes(String(i)))) {
    return { ok: false, problem: "Unknown palette" };
  }
  if (!["fixed", "journey", "mood", "chords", "sections"].includes(String(s.palette.mode))) return { ok: false, problem: "Unknown palette mode" };
  if (!isObj(s.mix) || !MIX_GROUPS.every((g) => typeof (s.mix as Record<string, unknown>)[g] === "number")) return { ok: false, problem: "The visual mix is incomplete" };
  if (typeof s.reactivity !== "number" || s.reactivity < 0 || s.reactivity > 2) return { ok: false, problem: "Reactivity must be 0–2" };
  if (typeof s.speed !== "number" || s.speed < 0.25 || s.speed > 2) return { ok: false, problem: "Speed must be 0.25–2" };
  if (!isObj(s.timeline) || !["auto", "manual"].includes(String(s.timeline.mode)) || !Array.isArray(s.timeline.entries)) return { ok: false, problem: "The timeline is invalid" };
  for (const e of s.timeline.entries as unknown[]) {
    if (!isObj(e) || !sceneIds.has(String(e.sceneId))) return { ok: false, problem: `The timeline uses an unknown scene "${String(isObj(e) ? e.sceneId : e)}"` };
  }
  if (!Array.isArray(s.controls)) return { ok: false, problem: "The reactions list is missing" };
  if (s.text !== null && !isObj(s.text)) return { ok: false, problem: "The text style is invalid" };
  if (typeof s.motifs !== "boolean") return { ok: false, problem: "Motifs must be on or off" };
  return { ok: true, show: s as unknown as Show };
}
