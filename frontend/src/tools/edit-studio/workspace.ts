/**
 * Edit Studio's workspace (Phase 11): the editor's panels plus the music
 * layer's, `edit-studio.preview` and `edit-studio.panel`. Shares the editor
 * bridge channels with the Video Editor.
 */
import { defineEditorWorkspace } from "@/editor/workspace";
import { MUSIC_EDIT_PROFILE } from "./profile";

export const editStudioWorkspace = defineEditorWorkspace(MUSIC_EDIT_PROFILE);
