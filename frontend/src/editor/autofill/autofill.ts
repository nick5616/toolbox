/**
 * The auto-fill engine (Phase 9 SPEC §13.2). Pure and deterministic: the same
 * input always gives the same clips.
 *
 * Conventions:
 * - `options.trackId` is the target video track. "new" means the track doesn't
 *   exist yet: the CALLER (the dialog) adds a track named "Auto" on top of the
 *   stack, then passes its real id. If "new" (or an unknown id) still reaches
 *   this function it is treated as an empty track and echoed in the result.
 * - `options.sources: "selected"` is resolved by the caller to a path list.
 *   Here it behaves like "all".
 * - `result.clips` holds only the NEW clips; the caller drops `result.removed`
 *   from the track and merges the two lists.
 */
import { newClip } from "@/editor/doc";
import type { EditClip } from "@/lib/api";
import { serializeEffects, serializeSpeed, serializeTransition, CUT } from "@/viz/edit/schema";
import { editLength, type EditParam, type EditPost, type EditTransition, type Key, type MarkerLane } from "@/viz/edit/types";
import { makeRng } from "@/viz/layers/registry";
import { SECTION_LABELS, type SectionLabel } from "@/viz/types";
import type { AutofillInput, AutofillResult, AutofillSource, RecipeRule } from "./types";

const DEFAULT_MIN_CLIP_MS = 250;

interface Cut {
  ms: number;
  protect: boolean;
}

interface Slice {
  start: number;
  end: number;
  rule: RecipeRule;
  drop: boolean;
}

interface Draft {
  kind: "video" | "image" | "color";
  path: string;
  startMs: number;
  endMs: number;
  inMs: number;
  effects: EditPost[];
  transition: EditTransition;
}

interface Region {
  start: number;
  end: number;
  label: SectionLabel;
}

/** Section label from a (possibly renamed) marker label. */
function labelOf(raw: string | undefined): SectionLabel {
  const l = (raw ?? "").trim().toLowerCase();
  const hit = SECTION_LABELS.find((s) => l === s) ?? SECTION_LABELS.find((s) => s !== "section" && l.startsWith(s));
  return hit ?? "section";
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function autofill(input: AutofillInput): AutofillResult {
  const { project, markers, analysis, recipe, options } = input;
  const warnings: string[] = [];
  const trackId = options.trackId;
  const done = (clips: EditClip[], removed: string[]): AutofillResult => ({ trackId, clips, removed, warnings });

  const fps = project.fps > 0 ? project.fps : 30;
  const frameMs = 1000 / fps;
  const snap = (ms: number) => Math.round(Math.round((ms * fps) / 1000) * (1000 / fps));
  const D = editLength(project);
  if (D <= 0) {
    warnings.push("This edit has no song yet");
    return done([], []);
  }

  // 1. range
  const a = snap(Math.max(0, Math.min(D, options.range?.fromMs ?? 0)));
  const b = Math.min(D, snap(Math.max(0, Math.min(D, options.range?.toMs ?? D))));
  if (b - a < frameMs) {
    warnings.push("The range is empty");
    return done([], []);
  }

  // sources
  const byPath = new Map<string, AutofillSource>();
  for (const s of input.sources) if (!byPath.has(s.path)) byPath.set(s.path, s);
  const wanted = Array.isArray(options.sources) ? options.sources : null;
  const list: AutofillSource[] = [];
  if (wanted) {
    const seen = new Set<string>();
    for (const p of wanted) {
      const s = byPath.get(p);
      if (s && !seen.has(p)) {
        seen.add(p);
        list.push(s);
      }
    }
  } else list.push(...byPath.values());
  // A video without a duration can't be cut from.
  const pool = list.filter((s) => s.kind === "image" || s.durationMs >= frameMs);

  // existing clips on the target track
  const track = project.tracks.find((t) => t.id === trackId);
  const existing = track?.clips ?? [];
  const kept = existing.filter((c) => c.pinned || !c.auto).sort((x, y) => x.startMs - y.startMs || x.endMs - y.endMs);
  const removed = existing.filter((c) => c.auto && !c.pinned && c.startMs < b && c.endMs > a).map((c) => c.id);

  if (pool.length === 0) {
    warnings.push("There are no sources to fill with");
    return done([], removed);
  }

  // lanes
  const byLane = new Map<MarkerLane, number[]>();
  for (const m of markers) {
    if (m.ms < 0 || m.ms > D) continue;
    const arr = byLane.get(m.lane);
    if (arr) arr.push(m.ms);
    else byLane.set(m.lane, [m.ms]);
  }
  for (const arr of byLane.values()) arr.sort((x, y) => x - y);
  const warned = new Set<string>();
  const warnOnce = (msg: string) => {
    if (!warned.has(msg)) {
      warned.add(msg);
      warnings.push(msg);
    }
  };
  const laneFor = (lane: MarkerLane): number[] => {
    const chain: MarkerLane[] = lane === "downbeat" ? ["downbeat", "beat"] : lane === "beat" ? ["beat", "downbeat"] : [lane, "downbeat", "beat"];
    for (const l of chain) {
      const arr = byLane.get(l);
      if (arr && arr.length) {
        if (l !== lane) warnOnce(`The ${lane} lane is empty, so cuts use the ${l} lane instead`);
        return arr;
      }
    }
    return [];
  };

  // sections
  const regions: Region[] = [];
  {
    let secs: Array<{ start: number; end: number; label: SectionLabel }> = markers
      .filter((m) => m.lane === "section" && m.endMs !== undefined)
      .map((m) => ({ start: m.ms, end: m.endMs as number, label: labelOf(m.label) }));
    if (secs.length === 0 && project.song) {
      secs = analysis.audio.sections.map((s) => ({ start: s.startMs - (project.song?.startMs ?? 0), end: s.endMs - (project.song?.startMs ?? 0), label: labelOf(s.label) }));
    }
    secs.sort((x, y) => x.start - y.start);
    let cur = a;
    for (const s of secs) {
      const st = Math.max(snap(s.start), cur);
      const en = Math.min(snap(s.end), b);
      if (en <= st) continue;
      if (st > cur) regions.push({ start: cur, end: st, label: "section" });
      regions.push({ start: st, end: en, label: s.label });
      cur = en;
    }
    if (cur < b) regions.push({ start: cur, end: b, label: "section" });
  }

  const ruleFor = (label: SectionLabel): RecipeRule | undefined => recipe.rules.find((r) => !r.sections || r.sections.includes(label));

  const dropTimes = new Set<number>();
  const dropList: number[] = [];
  if (recipe.onDrop) {
    for (const ms of byLane.get("drop") ?? []) {
      const t = snap(ms);
      if (t >= a && t < b && !dropTimes.has(t)) {
        dropTimes.add(t);
        dropList.push(t);
      }
    }
  }

  // 2 + 3. cut points and slices
  const slices: Slice[] = [];
  for (const reg of regions) {
    const rule = ruleFor(reg.label);
    if (!rule) continue;
    const minClip = rule.minClipMs ?? DEFAULT_MIN_CLIP_MS;
    const every = Math.max(1, Math.floor(rule.every ?? 1));
    const pts: Cut[] = [{ ms: reg.start, protect: true }];
    const inner = (t: number) => t > reg.start && t < reg.end;
    laneFor(rule.cutLane).forEach((ms, i) => {
      if (i % every !== 0) return;
      const t = snap(ms);
      if (inner(t)) pts.push({ ms: t, protect: false });
    });
    for (const t of dropList) if (inner(t)) pts.push({ ms: t, protect: true });
    pts.push({ ms: reg.end, protect: true });
    pts.sort((x, y) => x.ms - y.ms);
    // equal times collapse; protection wins
    const uniq: Cut[] = [];
    for (const p of pts) {
      const last = uniq[uniq.length - 1];
      if (last && last.ms === p.ms) last.protect = last.protect || p.protect;
      else uniq.push({ ...p });
    }
    // merge cuts closer than minClip: keep the earlier, never drop a protected one
    const out: Cut[] = [];
    for (const p of uniq) {
      let last = out[out.length - 1];
      while (last && p.ms - last.ms < minClip && !last.protect && p.protect) {
        out.pop();
        last = out[out.length - 1];
      }
      if (last && p.ms - last.ms < minClip && !p.protect) continue;
      out.push(p);
    }
    for (let i = 0; i + 1 < out.length; i++) {
      const s = (out[i] as Cut).ms;
      const e = (out[i + 1] as Cut).ms;
      if (e > s) slices.push({ start: s, end: e, rule, drop: dropTimes.has(s) });
    }
  }

  // 4. cut around kept clips
  const pieces: Slice[] = [];
  for (const sl of slices) {
    const minClip = sl.rule.minClipMs ?? DEFAULT_MIN_CLIP_MS;
    const parts: Array<[number, number]> = [];
    let cur = sl.start;
    let cutAny = false;
    for (const k of kept) {
      if (k.endMs <= cur) continue;
      if (k.startMs >= sl.end) break;
      cutAny = true;
      if (k.startMs > cur) parts.push([cur, k.startMs]);
      cur = Math.max(cur, k.endMs);
    }
    if (cur < sl.end) parts.push([cur, sl.end]);
    for (const [s, e] of parts) {
      if (cutAny && e - s < minClip) continue;
      pieces.push({ start: s, end: e, rule: sl.rule, drop: sl.drop && s === sl.start });
    }
  }

  // 5 + 6. sources and in-points
  const rng = makeRng(options.seed, "autofill/" + recipe.id);
  const poolIdx = pool.map((_, i) => i);
  const shuffle = (xs: number[]): number[] => {
    const arr = xs.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = arr[i] as number;
      arr[i] = arr[j] as number;
      arr[j] = t;
    }
    return arr;
  };
  let last = -1;
  const states = new Map<string, { seq: number; deck: number[]; members: number[] }>();
  const stateFor = (mode: string, tags: string[]) => {
    const key = `${mode}|${tags.join("+")}`;
    let st = states.get(key);
    if (!st) {
      let members = tags.length ? poolIdx.filter((i) => (pool[i] as AutofillSource).tags.some((t) => tags.includes(t))) : [];
      if (members.length === 0) {
        if (tags.length && mode === "byTag") warnOnce(`No sources are tagged ${tags.join(" or ")}, so all sources are used`);
        members = poolIdx;
      }
      st = { seq: 0, deck: [], members };
      states.set(key, st);
    }
    return st;
  };
  const pick = (rule: RecipeRule): number => {
    const mode = options.order === "recipe" ? rule.sourceOrder : options.order;
    const st = stateFor(mode, rule.tags ?? []);
    let idx: number;
    if (mode === "shuffleNoRepeat") {
      const n = st.members.length;
      if (st.deck.length === 0) st.deck = shuffle(st.members);
      let k = 0;
      if (n > 1 && st.deck[0] === last) {
        k = st.deck.findIndex((x) => x !== last);
        if (k < 0) {
          st.deck = shuffle(st.members);
          k = st.deck.findIndex((x) => x !== last);
        }
      }
      idx = st.deck.splice(k, 1)[0] as number;
    } else {
      idx = st.members[st.seq % st.members.length] as number;
      st.seq++;
    }
    last = idx;
    return idx;
  };
  const dropTag = recipe.onDrop?.tag;
  const dropMembers = dropTag ? poolIdx.filter((i) => (pool[i] as AutofillSource).tags.includes(dropTag)) : [];
  let dropSeq = 0;
  const pickDrop = (rule: RecipeRule): number => {
    if (dropTag && dropMembers.length === 0) warnOnce(`No sources are tagged ${dropTag} for the drop, so the normal order is used`);
    if (dropMembers.length === 0) return pick(rule);
    const idx = dropMembers[dropSeq++ % dropMembers.length] as number;
    last = idx;
    return idx;
  };

  const cursors = new Map<string, number>();
  const drafts: Draft[] = [];
  for (const pc of pieces) {
    let cur = pc.start;
    let first = true;
    for (let guard = 0; cur < pc.end && guard < 1000; guard++) {
      const isDrop = first && pc.drop;
      const src = pool[isDrop ? pickDrop(pc.rule) : pick(pc.rule)] as AutofillSource;
      const L = pc.end - cur;
      const effects: EditPost[] = [...(pc.rule.effects ?? []), ...(isDrop ? (recipe.onDrop?.effects ?? []) : [])].map(clone);
      const transition = first ? ((isDrop ? recipe.onDrop?.transition : undefined) ?? pc.rule.transition ?? CUT) : CUT;
      first = false;
      if (src.kind === "image") {
        drafts.push({ kind: "image", path: src.path, startMs: cur, endMs: pc.end, inMs: 0, effects, transition: { ...transition } });
        cur = pc.end;
        continue;
      }
      const dur = src.durationMs;
      if (dur < L) {
        // used whole; the slice continues with the next source
        const end = Math.min(pc.end, Math.max(cur + 1, snap(cur + dur)));
        drafts.push({ kind: "video", path: src.path, startMs: cur, endMs: end, inMs: 0, effects, transition: { ...transition } });
        cursors.set(src.path, 0);
        cur = end;
        if (pc.end - cur < frameMs) break;
        continue;
      }
      const c = cursors.get(src.path) ?? 0;
      const fromStart = c + L <= dur ? c : 0;
      let inMs = fromStart;
      if (pc.rule.videoIn === "random") {
        inMs = dur > L ? Math.min(snap(rng() * (dur - L)), dur - L) : 0;
      } else if (pc.rule.videoIn === "shotAligned") {
        const shot = (src.shots ?? []).slice().sort((x, y) => x - y).find((t) => t >= c && t + L <= dur);
        inMs = shot !== undefined ? shot : fromStart;
      }
      inMs = Math.round(Math.max(0, inMs));
      cursors.set(src.path, inMs + L);
      drafts.push({ kind: "video", path: src.path, startMs: cur, endMs: pc.end, inMs, effects, transition: { ...transition } });
      cur = pc.end;
    }
  }

  // 8. stops
  const stops = markers
    .filter((m) => m.lane === "stop" && m.endMs !== undefined && m.ms < b && (m.endMs as number) > a)
    .sort((x, y) => x.ms - y.ms);
  const freezes = new Map<Draft, Array<[number, number]>>();
  const onStop = recipe.onStop ?? "none";
  if (onStop === "freeze") {
    for (const st of stops) {
      const s0 = snap(st.ms);
      const s1 = snap(st.endMs as number);
      const d = drafts.find((x) => x.kind === "video" && x.startMs <= s0 && s0 < x.endMs);
      if (!d || s1 <= s0) continue;
      const arr = freezes.get(d);
      if (arr) arr.push([s0, s1]);
      else freezes.set(d, [[s0, s1]]);
    }
  } else if (onStop === "black") {
    for (const st of stops) {
      const s0 = Math.max(a, snap(st.ms));
      const s1 = Math.min(b, snap(st.endMs as number));
      if (s1 - s0 < frameMs * 0.5) continue;
      const next: Draft[] = [];
      const blacks: Draft[] = [];
      for (const d of drafts) {
        if (d.startMs >= s1 || d.endMs <= s0) {
          next.push(d);
          continue;
        }
        if (d.startMs < s0 && s0 - d.startMs >= frameMs * 0.5) next.push({ ...d, endMs: s0 });
        const bs = Math.max(s0, d.startMs);
        const be = Math.min(s1, d.endMs);
        const prev = blacks[blacks.length - 1];
        if (prev && prev.endMs === bs) prev.endMs = be;
        else blacks.push({ kind: "color", path: "", startMs: bs, endMs: be, inMs: 0, effects: [], transition: { ...CUT } });
        if (d.endMs > s1 && d.endMs - s1 >= frameMs * 0.5) {
          next.push({ ...d, startMs: s1, inMs: d.kind === "video" ? d.inMs + (s1 - d.startMs) : 0, effects: clone(d.effects), transition: { ...CUT } });
        }
      }
      drafts.length = 0;
      drafts.push(...next, ...blacks);
      drafts.sort((x, y) => x.startMs - y.startMs);
    }
  }

  // 7. finalize
  drafts.sort((x, y) => x.startMs - y.startMs || x.endMs - y.endMs);
  const run = (project.recipe?.run ?? 0) + 1;
  const clips: EditClip[] = drafts.map((d, i) => {
    const id = `a${run}-${i + 1}`;
    const fx = d.effects.map((e, k) => ({ ...e, id: `${id}-e${k}` }));
    let speed = "";
    const fr = freezes.get(d);
    if (fr) {
      const len = d.endMs - d.startMs;
      const keys: Key[] = [{ t: 0, v: 1, ease: "hold" }];
      for (const [s0, s1] of fr) {
        const r0 = Math.max(0, s0 - d.startMs);
        const r1 = Math.min(len, s1 - d.startMs);
        const lastKey = keys[keys.length - 1] as Key;
        if (r0 <= lastKey.t) lastKey.v = 0;
        else keys.push({ t: r0, v: 0, ease: "hold" });
        if (r1 < len) keys.push({ t: r1, v: 1, ease: "hold" });
      }
      const p: EditParam = { base: 1, keys };
      speed = serializeSpeed(p);
    }
    return newClip({
      id,
      kind: d.kind,
      path: d.path,
      color: d.kind === "color" ? "#000000" : "",
      startMs: d.startMs,
      endMs: d.endMs,
      inMs: d.inMs,
      speed,
      fit: "fill",
      effects: serializeEffects(fx),
      in: serializeTransition(d.transition),
      auto: true,
      pinned: false,
    });
  });
  return done(clips, removed);
}

/**
 * A cheap shape check on a track's clips after a merge: sorted, inside the edit
 * and no overlaps that involve a new clip. Returns a message, or null when fine.
 */
export function validateShape(clips: readonly EditClip[], newIds: ReadonlySet<string>, durationMs: number): string | null {
  const sorted = clips.slice().sort((x, y) => x.startMs - y.startMs || x.endMs - y.endMs);
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i] as EditClip;
    const p = sorted[i - 1];
    const isNew = newIds.has(c.id);
    if (isNew && (c.startMs < 0 || c.endMs <= c.startMs || c.endMs > durationMs + 1)) return `A new clip has a bad time range (${c.startMs}-${c.endMs} ms)`;
    if (p && (isNew || newIds.has(p.id)) && c.startMs < p.endMs) return `Clips overlap at ${c.startMs} ms`;
  }
  return null;
}
