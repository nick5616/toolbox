import { lazy, type ComponentType, type LazyExoticComponent } from "react";

/** Props every tool view receives. */
export interface ToolViewProps {
  moduleId: string;
}

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
  visualizer: lazy(() => import("./visualizer/VisualizerView")),
};

/**
 * Views a popup window can show (`/?window=popup&view=<id>`), rendered by
 * PopupShell without the sidebar or job tray.
 */
export const popupViews: Record<string, LazyExoticComponent<ComponentType>> = {
  clipboard: lazy(() => import("./clipboard/ClipboardPopup")),
};
