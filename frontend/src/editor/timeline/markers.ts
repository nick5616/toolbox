/**
 * The Video Editor's markers (Phase 21 SPEC §B2, §B7): they reuse
 * `project.markers.custom`, whose `ms` is song ms (`song.startMs + timeline
 * ms`; with no song, timeline ms). Pure helpers over a NormalProject.
 */
import type { NormalProject } from "@/viz/edit/defaults";
import { newId } from "@/editor/doc";

export interface RulerMarker {
  id: string;
  /** Timeline ms. */
  ms: number;
  label: string;
}

export const MAX_CUSTOM_MARKERS = 500;
const songStart = (doc: NormalProject): number => doc.song?.startMs ?? 0;

/** The custom markers on the timeline, ascending. */
export function rulerMarkers(doc: NormalProject): RulerMarker[] {
  const off = songStart(doc);
  return doc.markers.custom
    .map((m) => ({ id: m.id, ms: m.ms - off, label: m.label }))
    .filter((m) => m.ms >= 0)
    .sort((a, b) => a.ms - b.ms);
}

/** Adds a marker at timeline ms (none when one is already within a millisecond). */
export function addRulerMarker(doc: NormalProject, timelineMs: number): { project: NormalProject; id: string } | null {
  const ms = Math.round(Math.max(0, timelineMs)) + songStart(doc);
  if (doc.markers.custom.length >= MAX_CUSTOM_MARKERS || doc.markers.custom.some((m) => Math.abs(m.ms - ms) < 1)) return null;
  const id = newId("k");
  return { project: { ...doc, markers: { ...doc.markers, custom: [...doc.markers.custom, { id, ms, label: "" }] } }, id };
}

/** Moves a marker to timeline ms. */
export function moveRulerMarker(doc: NormalProject, id: string, timelineMs: number): NormalProject | null {
  const ms = Math.round(Math.max(0, timelineMs)) + songStart(doc);
  const cur = doc.markers.custom.find((m) => m.id === id);
  if (!cur || cur.ms === ms) return null;
  return { ...doc, markers: { ...doc.markers, custom: doc.markers.custom.map((m) => (m.id === id ? { ...m, ms } : m)) } };
}

/** Names a marker (≤ 40 characters). */
export function renameRulerMarker(doc: NormalProject, id: string, label: string): NormalProject | null {
  const next = label.trim().slice(0, 40);
  const cur = doc.markers.custom.find((m) => m.id === id);
  if (!cur || cur.label === next) return null;
  return { ...doc, markers: { ...doc.markers, custom: doc.markers.custom.map((m) => (m.id === id ? { ...m, label: next } : m)) } };
}
