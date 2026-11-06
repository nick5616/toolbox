/**
 * Post Builder as a workspace (Phase 11, SPEC §5.2): its panels and the phone
 * preview open in click-in drawers or their own windows. The window showing the
 * tool hosts the store; part windows hold replicas whose listed actions run on
 * the host. Pictures are loaded per window (`useSlideVisual`).
 */
import type { StoreApi } from "zustand";
import type { PostIssue, PostLimits, ProjectInfo } from "@/lib/api";
import { newHistory } from "@/lib/history";
import { useShortcut } from "@/lib/shortcuts";
import { defineWorkspace } from "@/workspace";
import type { PostDoc } from "./logic";
import { AltPanelView, CaptionPanelView, ChecksPanelView, FormatPanelView, FramingPanelView, PostsPanelView, SourcesPanelView, TrimPanelView } from "./panels";
import { PhonePreviewPart } from "./preview";
import { MODULE_ID, usePostBuilder, type LiveFraming, type PostState, type SaveState, type Still } from "./postStore";

export type PostBridgeValues = {
  posts: ProjectInfo[];
  postId: string;
  loadedId: string;
  name: string;
  doc: PostDoc | null;
  /** A framing drag in progress (about 30 fps), so popped-out windows follow it. */
  liveFraming: LiveFraming | null;
  undoDepth: number;
  redoDepth: number;
  saveState: SaveState;
  selectedId: string;
  still: Still | null;
  issues: PostIssue[];
  limits: PostLimits;
  comps: ProjectInfo[];
  videos: ProjectInfo[];
};

/** The actions a replica forwards to the host: every argument is JSON. */
export const BRIDGED_ACTIONS = [
  "undo",
  "redo",
  "select",
  "setStill",
  "patchSlide",
  "patchDoc",
  "setCaption",
  "setAltText",
  "deleteSlide",
  "copySlide",
  "reorderSlides",
  "addPaths",
  "buildSlide",
  "openPost",
  "createPost",
  "createFromFolder",
  "duplicatePost",
  "renamePost",
  "deletePost",
] as const satisfies readonly (keyof PostState)[];

export function pickPostValues(s: PostState): PostBridgeValues {
  return {
    posts: s.posts,
    postId: s.postId,
    loadedId: s.loadedId,
    name: s.name,
    doc: s.history?.present ?? null,
    liveFraming: s.liveFramingOut,
    undoDepth: s.history?.past.length ?? 0,
    redoDepth: s.history?.future.length ?? 0,
    saveState: s.saveState,
    selectedId: s.selectedId,
    still: s.still,
    issues: s.issues,
    limits: s.limits,
    comps: s.comps,
    videos: s.videos,
  };
}

/** Only the history's depths matter to a replica (undo and redo run on the host), so it's rebuilt around the document. */
export function applyPostValues(store: StoreApi<PostState>, v: Partial<PostBridgeValues>): void {
  const cur = store.getState();
  const { doc, undoDepth, redoDepth, ...rest } = v;
  const patch: Partial<PostState> = { ...rest };
  if (doc !== undefined || undoDepth !== undefined || redoDepth !== undefined) {
    const present = doc !== undefined ? doc : (cur.history?.present ?? null);
    if (!present) patch.history = null;
    else {
      const past = undoDepth ?? cur.history?.past.length ?? 0;
      const future = redoDepth ?? cur.history?.future.length ?? 0;
      patch.history = { ...newHistory(present), past: new Array<PostDoc>(past).fill(present), future: new Array<PostDoc>(future).fill(present) };
    }
  }
  if (Object.keys(patch).length) store.setState(patch);
}

function useReplica(): void {
  useShortcut("Mod+Z", () => usePostBuilder.getState().undo());
  useShortcut(["Mod+Shift+Z", "Mod+Y"], () => usePostBuilder.getState().redo());
}

export const postWorkspace = defineWorkspace<PostState, PostBridgeValues>({
  moduleId: MODULE_ID,
  store: usePostBuilder,
  bridge: { pick: pickPostValues, apply: applyPostValues, actions: BRIDGED_ACTIONS },
  isOpen: (s) => s.history !== null,
  panels: [
    { id: "posts", title: "Posts", icon: "gallery-horizontal-end", tip: "Your posts: open, start, duplicate, rename or delete one", component: PostsPanelView, drawerWidth: 400, width: 400, height: 640 },
    { id: "sources", title: "Sources", icon: "images", tip: "The photos and clips you can use in this post; make collages and stitched videos", component: SourcesPanelView, drawerWidth: 400, width: 420, height: 720 },
    { id: "format", title: "Format", icon: "layout-grid", tip: "What kind of post this is, its shape, and whether photos keep their location", component: FormatPanelView, drawerWidth: 360, width: 380, height: 460 },
    { id: "caption", title: "Caption", icon: "text", tip: "The text under the post, with Instagram's limits", component: CaptionPanelView, drawerWidth: 380, width: 400, height: 460 },
    { id: "framing", title: "Framing", icon: "crop", tip: "Zoom, rotate and reposition the picture inside the frame", component: FramingPanelView, drawerWidth: 360, width: 380, height: 340 },
    { id: "trim", title: "Trim", icon: "scissors", tip: "Choose where the clip starts and ends, and whether it has sound", component: TrimPanelView, drawerWidth: 400, width: 420, height: 560 },
    { id: "alt", title: "Alt text", icon: "text", tip: "A description of the selected slide for screen readers", component: AltPanelView, drawerWidth: 360, width: 380, height: 340 },
    { id: "checks", title: "Checks", icon: "list-checks", tip: "Problems that would stop Instagram accepting the post", component: ChecksPanelView, drawerWidth: 380, width: 400, height: 520 },
  ],
  preview: { title: "Phone preview", icon: "smartphone", tip: "Roughly how the post will look in Instagram, in its own window", component: PhonePreviewPart, width: 420, height: 800 },
  useReplica,
});
