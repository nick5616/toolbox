/**
 * Lyric Video as a workspace (Phase 11, SPEC §5.4): `defineWorkspace` over the
 * Lyric Video store. Panels: Song, Lyrics, Visuals, Look and Render (they pick
 * files or submit jobs, so they open inline only; a part window never submits
 * jobs) and `lines`, the lyric sheet, which pops out.
 *
 * Replicated to part windows: the song, title/artist, the sheet's lines, the
 * options, the playhead and play state, the cover and background URLs, the
 * analysis ref. Not replicated: the analysis itself (a window loads it from the
 * ref). The host window owns the audio player; the replica's edit and playback
 * actions run there.
 */
import { Suspense, lazy, type ComponentType } from "react";
import { Spinner } from "@/components";
import { defineWorkspace } from "@/workspace";
import { LYRIC_VIDEO_ID, useLyricVideo, type LyricVideoState } from "./store";

export type LyricVideoBridgeValues = {
  songPath: string | null;
  meta: LyricVideoState["meta"];
  rows: LyricVideoState["rows"];
  canUndo: boolean;
  canRedo: boolean;
  matched: number | null;
  prefs: LyricVideoState["prefs"];
  selectedId: string;
  playheadMs: number;
  playing: boolean;
  tapIndex: number;
  durationMs: number;
  hasCover: boolean;
  coverUrl: string | undefined;
  imageUrl: string | undefined;
  listenRef: LyricVideoState["listenRef"];
}

export const lyricVideoBridge = {
  pick: (s: LyricVideoState): LyricVideoBridgeValues => ({
    songPath: s.songPath,
    meta: s.meta,
    rows: s.rows,
    canUndo: s.canUndo,
    canRedo: s.canRedo,
    matched: s.matched,
    prefs: s.prefs,
    selectedId: s.selectedId,
    playheadMs: s.playheadMs,
    playing: s.playing,
    tapIndex: s.tapIndex,
    durationMs: s.durationMs,
    hasCover: s.hasCover,
    coverUrl: s.coverUrl,
    imageUrl: s.imageUrl,
    listenRef: s.listenRef,
  }),
  apply: (store: { setState: (v: Partial<LyricVideoState>) => void }, v: Partial<LyricVideoBridgeValues>) => store.setState(v),
  actions: ["select", "setStart", "nudge", "setLineText", "insertLine", "deleteSelected", "shiftAll", "undo", "redo", "seek", "playFrom", "togglePlay", "startTap", "endTap", "stamp", "tapBackOne"] as const,
};

/** A panel or preview loaded on first use: part windows import this file, not the heavy views. */
function lazyBody(load: () => Promise<{ default: ComponentType }>): ComponentType {
  const Body = lazy(load);
  return function LazyBody() {
    return (
      <Suspense fallback={<Spinner size={18} label="Loading" />}>
        <Body />
      </Suspense>
    );
  };
}

export const lyricVideoWorkspace = defineWorkspace({
  moduleId: LYRIC_VIDEO_ID,
  store: useLyricVideo,
  bridge: { pick: lyricVideoBridge.pick, apply: lyricVideoBridge.apply, actions: [...lyricVideoBridge.actions] },
  isOpen: (s) => s.songPath !== null,
  panels: [
    { id: "song", title: "Song", icon: "music", tip: "The song, its title and artist, and original or instrumental audio", component: lazyBody(() => import("./SongPanel")), drawerWidth: 420, poppable: false },
    { id: "lyrics", title: "Lyrics", icon: "mic-vocal", tip: "Detect the words from the vocals, paste them or load a file, then get the timings", component: lazyBody(() => import("./LyricsPanel")), drawerWidth: 440, poppable: false },
    { id: "visuals", title: "Visuals", icon: "sparkles", tip: "Animated visuals that react to the song, or a classic background", component: lazyBody(() => import("./VisualsPanel")), drawerWidth: 460, poppable: false },
    { id: "look", title: "Look", icon: "palette", tip: "Shape, background, font, colours, karaoke and position", component: lazyBody(() => import("./LookPanel")), drawerWidth: 420, poppable: false },
    { id: "render", title: "Export", icon: "film", tip: "A short exact preview, then the whole video", component: lazyBody(() => import("./RenderPanel")), drawerWidth: 460, poppable: false },
    { id: "lines", title: "Lyric lines", icon: "captions", tip: "The timed lines: edit words and times, tap to sync", component: lazyBody(() => import("./LinesPanel")), drawerWidth: 420, width: 420, height: 720 },
  ],
  preview: {
    title: "Preview",
    icon: "monitor",
    tip: "The live preview of the video, following the playhead of the main window",
    width: 960,
    height: 640,
    component: lazyBody(() => import("./PreviewPart")),
  },
});

export const PREVIEW_PART = lyricVideoWorkspace.previewPart;
