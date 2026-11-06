/**
 * The Video Editor's profile (Phase 10 SPEC §5): the editor with nothing
 * plugged in. A song is an optional music bed; no markers, lanes or recipes.
 */
import "@/editor/panelDefs";
import type { EditorProfile } from "@/editor/profile";

export const VIDEO_PROFILE: EditorProfile = {
  moduleId: "video-studio",
  title: "Video Editor",
  noun: "video",
  song: "optional",
  homeFilter: "all",
  markerSignals: false,
};
