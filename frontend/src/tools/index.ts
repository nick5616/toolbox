import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import { registerToolActions, registerToolViews, type ToolViewProps } from "@/lib/toolActions";

export type { ToolViewProps };

/**
 * Module id → its UI. Modules without an entry render the ComingSoon view.
 * Adding a module's UI = adding one line here (see CLAUDE.md).
 */
export const toolViews: Record<string, LazyExoticComponent<ComponentType<ToolViewProps>>> = {
  downloader: lazy(() => import("./downloader/DownloaderView")),
  stems: lazy(() => import("./stems/StemsView")),
  "bpm-key": lazy(() => import("./bpmkey/BpmKeyView")),
  "audio-to-midi": lazy(() => import("./midi/MidiView")),
  converter: lazy(() => import("./converter/ConverterView")),
  transcribe: lazy(() => import("./transcribe/TranscribeView")),
  exif: lazy(() => import("./exif/ExifView")),
  clipboard: lazy(() => import("./clipboard/ClipboardView")),
  "bg-remover": lazy(() => import("./bgremove/BgRemoveView")),
  upscaler: lazy(() => import("./upscale/UpscaleView")),
  pdf: lazy(() => import("./pdf/PdfView")),
  "llm-chat": lazy(() => import("./chat/ChatView")),
  ocr: lazy(() => import("./ocr/OcrView")),
  vault: lazy(() => import("./vault/VaultView")),
  trimmer: lazy(() => import("./trimmer/TrimmerView")),
  subtitles: lazy(() => import("./subtitles/SubtitlesView")),
  "audio-cleanup": lazy(() => import("./audiocleanup/AudioCleanupView")),
  "lyric-video": lazy(() => import("./lyricvideo/LyricVideoView")),
  redact: lazy(() => import("./redact/RedactView")),
  "object-eraser": lazy(() => import("./eraser/ObjectEraserView")),
  "dev-utils": lazy(() => import("./devutils/DevUtilsView")),
  documents: lazy(() => import("./documents/DocumentsView")),
  archiver: lazy(() => import("./archiver/ArchiverView")),
  scenes: lazy(() => import("./scenes/ScenesView")),
  gif: lazy(() => import("./gif/GifView")),
  organize: lazy(() => import("./organize/OrganizeView")),
  "lan-share": lazy(() => import("./lan-share/LanShareView")),
  silence: lazy(() => import("./silence/SilenceView")),
  compress: lazy(() => import("./compress/CompressView")),
  focus: lazy(() => import("./focus/FocusView")),
  imagebatch: lazy(() => import("./imagebatch/ImageBatchView")),
  tts: lazy(() => import("./tts/TtsView")),
  visualizer: lazy(() => import("./visualizer/VisualizerView")),
  pipelines: lazy(() => import("./pipelines/PipelinesView")),
  "photo-composer": lazy(() => import("./photo-composer/PhotoComposerView")),
  "video-editor": lazy(() => import("./video-editor/VideoEditorView")), // the Sequence Editor (Post Builder's video slides)
  "video-studio": lazy(() => import("./video-studio/VideoEditorView")), // the Video Editor (multitrack); Edit Studio is composed on it
  "edit-studio": lazy(() => import("./edit-studio/EditStudioView")),
  "post-builder": lazy(() => import("./post-builder/PostBuilderView")),
};

// The composition root (Phase 11, SPEC §3.4): code outside a tool reaches tool
// views and cross-tool actions through lib/toolActions, never by importing them.
registerToolViews(toolViews);
registerToolActions({
  addToPost: (path) => import("./post-builder/AddToPostDialog").then((m) => m.openAddToPostDialog(path)),
});

/**
 * Views a popup window can show (`/?window=popup&view=<id>`), rendered by
 * PopupShell without the sidebar or job tray.
 */
/**
 * Components the main window's shell renders over every view (Phase 13):
 * Local File Transfer's incoming-transfer and pairing prompts.
 */
export const shellOverlays: LazyExoticComponent<ComponentType>[] = [lazy(() => import("./lan-share/LanSharePrompt"))];

export const popupViews: Record<string, LazyExoticComponent<ComponentType>> = {
  clipboard: lazy(() => import("./clipboard/ClipboardPopup")),
};
