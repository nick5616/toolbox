/**
 * An analysis of nothing (Phase 10 SPEC §5.4): every curve reads 0 at any
 * time, and there are no events, beats, sections, chords or words. A Video
 * Editor project without a song renders with it, so the engine's inputs are
 * the same shape with or without a song.
 */
import { Analysis, type AudioDoc } from "../analysis";

let shared: Analysis | null = null;

export function emptyAnalysis(): Analysis {
  if (shared) return shared;
  const audio: AudioDoc = {
    version: 1,
    durationMs: 0,
    fps: 60,
    frames: 1,
    stems: false,
    tempo: 0,
    beatsPerBar: 4,
    beats: [],
    downbeats: [],
    key: { name: "", camelot: "", minor: false },
    chords: [],
    sections: [],
    events: {},
    blocks: [],
    features: "",
  };
  shared = new Analysis(audio, new Uint8Array(0), null);
  return shared;
}
