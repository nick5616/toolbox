/**
 * Focus (SPEC §5.3): profiles with a `TimelineTop` (Edit Studio) can look at
 * the composition ("compose": song, markers, recipes) or click into the video
 * ("video": tracks, clips and effects in depth). The Video Editor is always
 * in video focus. Its own small store, so the main window and pop-outs can
 * bridge it (WP-E3).
 */
import { create } from "zustand";
import { useEditStudio } from "./store";
import type { EditorFocus } from "./profile";
import { useEditorProfile } from "./profileContext";

export interface FocusState {
  focus: EditorFocus;
  setFocus(f: EditorFocus): void;
}

export const useEditorFocus = create<FocusState>((set) => ({
  focus: "compose",
  setFocus: (focus) => set({ focus }),
}));

/** Whether a tool with this profile has a focus switch at all. */
export const hasFocusSwitch = (p: { TimelineTop?: unknown }): boolean => !!p.TimelineTop;

/** The focus the open editor is really in: always "video" without a composition layer. */
export function useEffectiveFocus(): EditorFocus {
  const profile = useEditorProfile();
  const focus = useEditorFocus((s) => s.focus);
  return hasFocusSwitch(profile) ? focus : "video";
}

/** Enter video focus: the Inspector takes the right panel. */
export function enterVideoFocus(): void {
  useEditorFocus.getState().setFocus("video");
  useEditStudio.getState().setRightPanel("inspector");
}

/** Back to the composition. */
export function leaveVideoFocus(): void {
  useEditorFocus.getState().setFocus("compose");
}
