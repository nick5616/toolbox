/**
 * Editor composition profiles (Phase 10, SPEC.md §5). FOUNDATION CONTRACT:
 * WP-E1 implements EditorShell against this and may ADD optional fields;
 * nobody removes or renames one.
 *
 * `frontend/src/editor/` is the Video Editor: a multitrack editor of an
 * `EditProject` (project kind "edit"). It knows tracks, clips, sources,
 * effects, masks, cut-outs, text and an optional music bed (`project.song`),
 * and nothing about beats, markers, recipes or lyrics.
 *
 * A profile composes a tool from it. The Video Editor's profile adds nothing.
 * Edit Studio's profile (tools/edit-studio/profile.tsx) plugs the music layer
 * into the slots below. The editor never imports tools/edit-studio; anything
 * music-specific reaches it only through a profile.
 */
import type { ComponentType, ReactNode } from "react";
import type { MenuItem } from "@/components";
import type { NormalProject } from "@/viz/edit/defaults";
import type { EditClip as Clip } from "@/lib/api";
import type { EditPost, Marker } from "@/viz/edit/types";
import type { ToolPanel } from "@/workspace";

/** One launcher chip in the selection bar for a clip's constituent panel. */
export interface ClipChip {
  /** Registered panel id. */
  panel: string;
  /** Clip kinds the chip applies to (default: all). */
  kinds?: Clip["kind"][];
  /** Muted state text shown on the chip. */
  summary?: (clip: Clip) => string;
}

/** Which layout an editor shows: the composition's own focus, or the Video Editor in depth. */
export type EditorFocus = "compose" | "video";

export interface EditorProfile {
  /** Module id of the tool ("video-studio" | "edit-studio"). */
  moduleId: string;
  /** Short noun for documents in this tool ("video", "edit"). */
  noun: string;
  /** The tool's name as the breadcrumb and palette show it ("Edit Studio", "Video Editor"). Defaults to the module id. */
  title?: string;
  /**
   * What the song must be before the editor is usable:
   * "optional" — Video Editor: no song needed; a song is a music bed;
   * "analyzed" — Edit Studio: a song with a ready analysis (else Setup shows).
   */
  song: "optional" | "analyzed";
  /** Projects shown by the home ("all" | only those with the "music-edit" flag first). */
  homeFilter: "all" | "music-edit";

  /** Extra header controls, left of the spacer (Edit Studio: beat-sync controls). */
  HeaderStart?: ComponentType<{ disabled: boolean }>;
  /** Extra header buttons right of undo/redo (Edit Studio: Auto-fill). */
  HeaderEnd?: ComponentType<{ disabled: boolean }>;
  /** Items appended to the header's More menu. */
  moreItems?: (ctx: { disabled: boolean; project: NormalProject }) => MenuItem[];

  /** Shown instead of the timeline while the song isn't ready ("analyzed" profiles). */
  Setup?: ComponentType;
  /** Rows above the tracks (Edit Studio: section bands + marker lanes). */
  TimelineTop?: ComponentType<{ focus: EditorFocus }>;
  /** @deprecated Phase 10 §5.5: constituents are panels now (see `rail`); the shell no longer shows right-panel tabs. */
  rightTabs?: { id: string; label: string; tip: string; render: () => ReactNode }[];

  /** Panels the tool adds to the editor's own (Phase 11): they join the editor workspace of this tool (rail, drawers, pop-outs). */
  panels?: readonly ToolPanel[];
  /**
   * Phase 10 §5.5. Panel ids (see `panelDefs.tsx` and `panels`) of the left rail's click-in
   * launchers, top to bottom. Default: `DEFAULT_RAIL` (media, text, music, project).
   */
  rail?: string[];
  /** Panel the selected song track opens (default "music"; Edit Studio: "song"). */
  songPanel?: string;
  /** Panel selected markers open (Edit Studio: "markers"); none without a music layer. */
  markersPanel?: string;
  /** Extra chips in the selection bar for selected clips (Edit Studio: Moments and Auto-fill). */
  clipChips?: ClipChip[];

  /**
   * Inspector slots. Phase 10 §5.5: only `SourceExtras` (inside the Speed panel) and `PostExtras`
   * (inside the Effects panel) are still read; `Song`, `Markers` and `ClipExtras` were replaced by
   * `songPanel`, `markersPanel` and `clipChips`.
   */
  inspector?: {
    /** Replaces the song inspector (Edit Studio: range, analysis, markers). */
    Song?: ComponentType;
    /** Sections appended to the clip inspector for the selected clips. */
    ClipExtras?: ComponentType<{ clips: Clip[] }>;
    /** Shown when markers are selected. */
    Markers?: ComponentType<{ ids: string[] }>;
    /** Controls inside a video clip's Source section, under the in point (Edit Studio: Velocity). */
    SourceExtras?: ComponentType<{ clip: Clip }>;
    /** Controls under an effect's header in the effects stack (Edit Studio: "Hit on"). */
    PostExtras?: ComponentType<{ post: EditPost; onChange(next: EditPost, key: string): void }>;
  };
  /** Per-clip timeline decorations (Edit Studio: moments overlay). */
  ClipOverlay?: ComponentType<{ clip: Clip; widthPx: number }>;
  /** Extra items in a clip's context menu (`ctx.markers`: the song's markers, empty without an analysis). */
  clipMenuItems?: (clips: Clip[], ctx?: { markers: readonly Marker[] }) => MenuItem[];
  /** Extra buttons in the tracks toolbar (Edit Studio: Cut to beat, Style). */
  TracksToolbar?: ComponentType;
  /** Mounted inside the track rows, positioned over them (Edit Studio: the moments ticks). */
  TracksOverlay?: ComponentType;
  /** Markers the playhead and clip edges snap to, with their lane as the hint label (a hook). */
  useSnapMarkers?: () => readonly Marker[];
  /** Times (timeline ms) the playhead and clip edges snap to, besides clip edges. */
  useSnapTargets?: () => number[];
  /** Whether effect modulation offers marker signals (`marker.<lane>`). */
  markerSignals: boolean;

  /** Dialogs the composition owns (always mounted; they open themselves). */
  Dialogs?: ComponentType;
  /** Registers palette commands and shortcuts (a hook). */
  useCommands?: () => void;
}
