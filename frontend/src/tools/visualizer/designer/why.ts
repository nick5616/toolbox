/**
 * The "Why" readout (SPEC.md §8.3): up to four short facts about what the
 * visuals are doing at the playhead. Pure, so it is tested without a DOM.
 */
import type { Analysis } from "@/viz/analysis";
import { activeAt, timelineFor } from "@/viz/director";
import { layerDef } from "@/viz/layers/registry";
import { MOOD_PALETTE, PALETTE_BY_ID } from "@/viz/palette";
import { postDef } from "@/viz/post/registry";
import { SIGNAL_META, type Signals } from "@/viz/signals";
import type { Mod, Param, Show } from "@/viz/types";

const cap = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

export interface ActiveMod {
  /** "Kick → Rings 80%" */
  text: string;
  /** |amount × signal|, the sort key. */
  strength: number;
  signal: Mod["signal"];
  target: string;
}

/** Every mod of the scene playing at tMs, ranked by amount × the signal's current value. */
export function activeMods(show: Show, analysis: Analysis, signals: Signals, tMs: number): ActiveMod[] {
  const entry = activeAt(timelineFor(analysis, show), tMs)?.current;
  const scene = show.scenes.find((s) => s.id === entry?.sceneId) ?? show.scenes[0];
  const out: ActiveMod[] = [];
  const add = (owner: string, paramLabel: string, p: Param, target: string) => {
    if (typeof p === "number") return;
    for (const m of p.mods) {
      const meta = SIGNAL_META.get(m.signal);
      if (!meta) continue;
      const v = Math.max(0, Math.min(1, signals.value(m.signal, tMs, m.attackMs, m.releaseMs)));
      const gain = meta.mix ? (show.mix[meta.mix] ?? 1) : 1;
      const strength = Math.abs(m.amount * v * gain * show.reactivity);
      out.push({ text: `${meta.label} → ${owner} ${paramLabel.toLowerCase()} ${Math.round(strength * 100)}%`, strength, signal: m.signal, target });
    }
  };
  for (const l of scene?.layers ?? []) {
    if (!l.enabled) continue;
    const def = layerDef(l.type);
    const owner = def?.label ?? l.type;
    add(owner, "opacity", l.opacity, `${l.id}.opacity`);
    for (const [k, v] of Object.entries(l.params)) {
      const spec = def?.params[k];
      if (spec?.kind === "number" && typeof v !== "string" && typeof v !== "boolean") add(owner, spec.label, v, `${l.id}.${k}`);
    }
  }
  for (const pc of [...show.post, ...(scene?.post ?? [])]) {
    if (!pc.enabled) continue;
    const def = postDef(pc.type);
    for (const [k, v] of Object.entries(pc.params)) {
      const spec = def?.params[k];
      if (spec?.kind === "number" && typeof v !== "string" && typeof v !== "boolean") add(def?.label ?? pc.type, spec.label, v, `post.${pc.id}.${k}`);
    }
  }
  return out.sort((a, b) => b.strength - a.strength);
}

export function whyFacts(show: Show, analysis: Analysis, signals: Signals, tMs: number): string[] {
  const facts: string[] = [];
  const sec = analysis.sectionAt(tMs)?.section;
  if (sec) facts.push(`${cap(sec.label)} (${sec.group}) · energy ${sec.energy.toFixed(2)}`);

  const mods = activeMods(show, analysis, signals, tMs)
    .filter((m) => m.strength >= 0.005)
    .slice(0, 3);
  if (mods.length > 0) facts.push(mods.map((m) => m.text).join(" · "));

  if (show.motifs) {
    const line = analysis.lineAt(tMs)?.line;
    const motifs = line?.meaning?.motifs ?? [];
    if (line && motifs.length > 0) {
      const word = line.words.find((w) => w.emphasis)?.text ?? line.words[0]?.text ?? "";
      facts.push(`"${word.replace(/[^\p{L}\p{N}'-]/gu, "")}" → ${motifs.slice(0, 2).map(cap).join(" + ")} motif`);
    }
  }

  const mode = show.palette.mode;
  if (mode === "mood" && analysis.text) {
    const emotion = analysis.moodAt(tMs).emotion;
    facts.push(`Mood: ${emotion} → ${PALETTE_BY_ID.get(MOOD_PALETTE[emotion])?.name ?? ""} palette`);
  } else {
    const names = show.palette.ids.map((id) => PALETTE_BY_ID.get(id)?.name ?? id);
    facts.push(`Colours: ${mode === "fixed" ? names[0] ?? "" : `${mode} (${names.join(" → ")})`}`);
  }
  return facts.slice(0, 4);
}
