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
};
