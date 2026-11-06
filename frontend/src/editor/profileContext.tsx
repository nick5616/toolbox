/**
 * The open tool's composition profile, available to everything under the
 * EditorShell. Components in `editor/` read slots from it instead of importing
 * the music layer (SPEC §5.3). Outside a shell (tests, pop-out parts) the
 * plain profile applies: the Video Editor with no extras.
 */
import { createContext, useContext, type ReactNode } from "react";
import { getWorkspace, type Workspace } from "@/workspace";
import type { EditorProfile } from "./profile";

/** The profile with no extras: what the editor is by itself. */
export const PLAIN_PROFILE: EditorProfile = {
  moduleId: "video-studio",
  title: "Video Editor",
  noun: "video",
  song: "optional",
  homeFilter: "all",
  markerSignals: false,
};

const Ctx = createContext<EditorProfile>(PLAIN_PROFILE);

export function EditorProfileProvider({ profile, children }: { profile: EditorProfile; children: ReactNode }) {
  return <Ctx.Provider value={profile}>{children}</Ctx.Provider>;
}

export function useEditorProfile(): EditorProfile {
  return useContext(Ctx);
}

/**
 * The open tool's editor workspace (panels, part ids, bridge): `undefined` until
 * `defineEditorWorkspace` ran for the profile's module (the tool's workspace
 * file does that at load; the shell does too).
 */
export function useEditorWorkspace(): Workspace | undefined {
  return getWorkspace(useContext(Ctx).moduleId);
}

/** The tool's display name. */
export const profileTitle = (p: EditorProfile): string => p.title ?? p.moduleId;
