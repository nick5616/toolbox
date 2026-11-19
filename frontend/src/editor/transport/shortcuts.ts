/**
 * Edit Studio's keyboard map (Phase 9 SPEC §14.11) as data: commands.ts binds
 * each entry. T and M (tap / add a marker) belong to the Lanes package, and
 * holding Alt to bypass snapping is read by the drags.
 */
export interface EditShortcut {
  id: string;
  combos: string[];
  label: string;
  /**
   * Where the key applies: both editors (the default), or one of them. Two
   * entries may share a combo only when their scopes can't be active together
   * (a test enforces this). M is bound by the Video Editor's ruler and by Edit
   * Studio's Lanes, so it is in neither table.
   */
  scope?: "video-editor" | "edit-studio";
}

/** The scopes a shortcut can have besides "both". */
export const SHORTCUT_SCOPES = ["video-editor", "edit-studio"] as const;

export const EDIT_SHORTCUTS: readonly EditShortcut[] = [
  { id: "play", combos: [" "], label: "Play / pause" },
  { id: "pause", combos: ["K"], label: "Pause" },
  { id: "forward", combos: ["L"], label: "Play (again: 1.5×, then 2×)" },
  { id: "back", combos: ["J"], label: "Play backwards (again: 2×, then 4×)" },
  { id: "prevFrame", combos: [",", "ArrowLeft"], label: "Previous frame" },
  { id: "nextFrame", combos: [".", "ArrowRight"], label: "Next frame" },
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
  // Phase 21 (SPEC §B2, §B5, §B7). E3 binds the editing keys, E5 the navigation keys.
  { id: "toolSelect", combos: ["V"], label: "Select tool" },
  { id: "toolRazor", combos: ["C"], label: "Razor tool (Shift+click: every track)" },
  { id: "toolRipple", combos: ["B"], label: "Ripple trim tool" },
  { id: "toolRoll", combos: ["N"], label: "Roll tool" },
  { id: "toolSlip", combos: ["Y"], label: "Slip tool" },
  { id: "zoomIn", combos: ["="], label: "Zoom in" },
  { id: "zoomOut", combos: ["-"], label: "Zoom out" },
  { id: "zoomFit", combos: ["\\"], label: "Zoom to fit" },
  { id: "markIn", combos: ["I"], label: "Set the range start" },
  { id: "markOut", combos: ["O"], label: "Set the range end" },
  { id: "clearRange", combos: ["Alt+X"], label: "Clear the range" },
  { id: "loop", combos: ["Shift+L"], label: "Loop the range" },
  { id: "snapping", combos: ["Shift+N"], label: "Snapping on / off" },
  { id: "rippleDelete", combos: ["Shift+Delete", "Shift+Backspace"], label: "Ripple delete (close the gap)" },
  { id: "copy", combos: ["Mod+C"], label: "Copy clips" },
  { id: "cut", combos: ["Mod+X"], label: "Cut clips" },
  { id: "paste", combos: ["Mod+V"], label: "Paste at the playhead (overwrite)" },
  { id: "pasteInsert", combos: ["Mod+Shift+V"], label: "Paste at the playhead (insert)" },
  { id: "link", combos: ["Mod+L"], label: "Link / unlink" },
  { id: "prevEdit", combos: ["ArrowUp"], label: "Previous edit point" },
  { id: "nextEdit", combos: ["ArrowDown"], label: "Next edit point" },
  { id: "back1s", combos: ["Shift+ArrowLeft"], label: "Back 1 second" },
  { id: "fwd1s", combos: ["Shift+ArrowRight"], label: "Forward 1 second" },
  { id: "prevKey", combos: ["Alt+["], label: "Previous keyframe of the selected clip" },
  { id: "nextKey", combos: ["Alt+]"], label: "Next keyframe of the selected clip" },
];
