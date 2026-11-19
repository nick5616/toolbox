import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import { registerToolActions, registerToolPreload, registerToolViews, type ToolViewProps } from "@/lib/toolActions";

export type { ToolViewProps };

type ToolLoader = () => Promise<{ default: ComponentType<ToolViewProps> }>;

/**
 * Module id → its UI. Modules without an entry render the ComingSoon view.
 * Adding a module's UI = adding one line here (see CLAUDE.md).
 */
const loaders: Record<string, ToolLoader> = {
  downloader: () => import("./downloader/DownloaderView"),
  stems: () => import("./stems/StemsView"),
  "bpm-key": () => import("./bpmkey/BpmKeyView"),
  "audio-to-midi": () => import("./midi/MidiView"),
  converter: () => import("./converter/ConverterView"),
  transcribe: () => import("./transcribe/TranscribeView"),
  exif: () => import("./exif/ExifView"),
  clipboard: () => import("./clipboard/ClipboardView"),
  "bg-remover": () => import("./bgremove/BgRemoveView"),
  upscaler: () => import("./upscale/UpscaleView"),
  pdf: () => import("./pdf/PdfView"),
  "llm-chat": () => import("./chat/ChatView"),
  ocr: () => import("./ocr/OcrView"),
  vault: () => import("./vault/VaultView"),
  trimmer: () => import("./trimmer/TrimmerView"),
  subtitles: () => import("./subtitles/SubtitlesView"),
  "audio-cleanup": () => import("./audiocleanup/AudioCleanupView"),
  "lyric-video": () => import("./lyricvideo/LyricVideoView"),
  redact: () => import("./redact/RedactView"),
  "object-eraser": () => import("./eraser/ObjectEraserView"),
  "dev-utils": () => import("./devutils/DevUtilsView"),
  documents: () => import("./documents/DocumentsView"),
  archiver: () => import("./archiver/ArchiverView"),
  scenes: () => import("./scenes/ScenesView"),
  gif: () => import("./gif/GifView"),
  organize: () => import("./organize/OrganizeView"),
  captions: () => import("./captions/CaptionsView"),
  grade: () => import("./grade/GradeView"),
  "lan-share": () => import("./lan-share/LanShareView"),
  silence: () => import("./silence/SilenceView"),
  compress: () => import("./compress/CompressView"),
  focus: () => import("./focus/FocusView"),
  imagebatch: () => import("./imagebatch/ImageBatchView"),
  tts: () => import("./tts/TtsView"),
  visualizer: () => import("./visualizer/VisualizerView"),
  pipelines: () => import("./pipelines/PipelinesView"),
  "photo-composer": () => import("./photo-composer/PhotoComposerView"),
  "video-editor": () => import("./video-editor/VideoEditorView"), // the Sequence Editor (Post Builder's video slides)
  "video-studio": () => import("./video-studio/VideoEditorView"), // the Video Editor (multitrack); Edit Studio is composed on it
  "edit-studio": () => import("./edit-studio/EditStudioView"),
  "post-builder": () => import("./post-builder/PostBuilderView"),
  paint: () => import("./paint/PaintView"),
};

/** Module id → its lazy view component (React.lazy over the loader above). */
export const toolViews: Record<string, LazyExoticComponent<ComponentType<ToolViewProps>>> = Object.fromEntries(
  Object.entries(loaders).map(([id, load]) => [id, lazy(load)]),
);

// The composition root (Phase 11, SPEC §3.4): code outside a tool reaches tool
// views and cross-tool actions through lib/toolActions, never by importing them.
registerToolViews(toolViews);
registerToolPreload((id) => loaders[id]?.());
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
