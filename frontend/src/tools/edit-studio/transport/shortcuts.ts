/**
 * Edit Studio's keyboard map (Phase 9 SPEC §14.11) as data: commands.ts binds
 * each entry. T and M (tap / add a marker) belong to the Lanes package, and
 * holding Alt to bypass snapping is read by the drags.
 */
export interface EditShortcut {
  id: string;
  combos: string[];
  label: string;
}

export const EDIT_SHORTCUTS: readonly EditShortcut[] = [
  { id: "play", combos: [" "], label: "Play / pause" },
  { id: "pause", combos: ["K"], label: "Pause" },
  { id: "forward", combos: ["L"], label: "Play (again: 1.5×, then 2×)" },
  { id: "back", combos: ["J"], label: "Back 2 s and play" },
  { id: "prevFrame", combos: [","], label: "Previous frame" },
  { id: "nextFrame", combos: ["."], label: "Next frame" },
  { id: "prevMarker", combos: ["["], label: "Previous marker on the active lane" },
  { id: "nextMarker", combos: ["]"], label: "Next marker on the active lane" },
  { id: "home", combos: ["Home"], label: "Start" },
  { id: "end", combos: ["End"], label: "End" },
  { id: "split", combos: ["S"], label: "Split at the playhead" },
  { id: "slice", combos: ["Shift+S"], label: "Slice at the active lane's markers" },
  { id: "delete", combos: ["Delete", "Backspace"], label: "Delete selected clips or markers" },
  { id: "duplicate", combos: ["Mod+D"], label: "Duplicate" },
  { id: "undo", combos: ["Mod+Z"], label: "Undo" },
  { id: "redo", combos: ["Mod+Shift+Z", "Mod+Y"], label: "Redo" },
  { id: "selectAll", combos: ["Mod+A"], label: "Select all clips on the track" },
  { id: "lane", combos: ["1", "2", "3", "4", "5", "6", "7", "8", "9"], label: "Active lane (order of visible lanes)" },
];
