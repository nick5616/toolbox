/**
 * Defaults and normalisation of Edit Studio documents (Phase 9 SPEC §5.2,
 * §6.2). CONTRACT (Wave 0). Mirrors modules/editstudio NewProject/LaneDefaults.
 */
import type { EditClip, EditMarkerState, EditTrack } from "@/lib/api";
import type { EditProject, LaneSettings, MarkerLane } from "./types";
import { MARKER_LANES } from "./types";

const lane = (visible: boolean, minStrength: number): LaneSettings => ({ visible, minStrength, every: 1, firstOfBar: false, nudgeMs: 0 });

export const LANE_DEFAULTS: Readonly<Record<MarkerLane, LaneSettings>> = {
  beat: lane(true, 0),
  downbeat: lane(true, 0),
  kick: lane(true, 0.25),
  snare: lane(true, 0.25),
  hats: lane(false, 0.25),
  bass: lane(false, 0.3),
  vocals: lane(false, 0.3),
  other: lane(false, 0.3),
  section: lane(true, 0),
  drop: lane(true, 0),
  lift: lane(true, 0),
  break: lane(false, 0),
  stop: lane(true, 0.5),
  phrase: lane(false, 0),
  word: lane(false, 0),
  custom: lane(true, 0),
};

/** A lane's settings in a project (defaults for a missing lane). */
export function laneSettings(m: EditMarkerState, l: MarkerLane): LaneSettings {
  return m.lanes?.[l] ?? LANE_DEFAULTS[l];
}

/** A new project as Go's Create makes it (§6.2). */
export function emptyEditProject(aspect: string, fps: number, seed: number): EditProject {
  const lanes: Record<string, LaneSettings> = {};
  for (const l of MARKER_LANES) lanes[l] = { ...LANE_DEFAULTS[l] };
  return {
    version: 1,
    aspect,
    fps,
    song: null,
    analysisKey: "",
    markers: { lanes, barOffset: 0, hidden: [], moved: {}, labels: {}, custom: [] },
    sources: [],
    tracks: [{ id: "t1", kind: "video", name: "Video 1", muted: false, locked: false, matte: "", clips: [] }],
    captions: null,
    look: "",
    background: "#000000",
    cutOffsetFrames: 0,
    seed,
    recipe: null,
    exportHeight: 1080,
  };
}

export interface NormalTrack extends EditTrack {
  clips: EditClip[];
}

/** The project with every list and map non-null (Go returns null for empty slices in the TS types). */
export interface NormalProject extends EditProject {
  sources: NonNullable<EditProject["sources"]>;
  tracks: NormalTrack[];
  markers: EditMarkerState & {
    lanes: NonNullable<EditMarkerState["lanes"]>;
    hidden: string[];
    moved: NonNullable<EditMarkerState["moved"]>;
    labels: NonNullable<EditMarkerState["labels"]>;
    custom: NonNullable<EditMarkerState["custom"]>;
  };
}

/** Fills nulls; returns the same object when nothing was null (stable references). */
export function normalizeProject(p: EditProject): NormalProject {
  const m = p.markers;
  const clean =
    p.sources !== null &&
    p.tracks !== null &&
    p.tracks.every((t) => t.clips !== null) &&
    m.lanes !== null &&
    m.hidden !== null &&
    m.moved !== null &&
    m.labels !== null &&
    m.custom !== null &&
    (p.sources ?? []).every((s) => s.tags !== null);
  if (clean) return p as NormalProject;
  return {
    ...p,
    sources: (p.sources ?? []).map((s) => (s.tags === null ? { ...s, tags: [] } : s)),
    tracks: (p.tracks ?? []).map((t) => (t.clips === null ? { ...t, clips: [] } : t)) as NormalTrack[],
    markers: {
      ...m,
      lanes: m.lanes ?? { ...LANE_DEFAULTS },
      hidden: m.hidden ?? [],
      moved: m.moved ?? {},
      labels: m.labels ?? {},
      custom: m.custom ?? [],
    },
  };
}
