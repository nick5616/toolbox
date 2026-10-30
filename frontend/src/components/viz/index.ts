/**
 * Shared Visualizer pieces for every tool (SPEC.md §9.1, §8.3). CONTRACT
 * (foundation): the props and hook shapes here are final; VP1 implements them.
 * UI-V2 (the designer's Presets tab), Lyric Video and Subtitles consume them.
 */
export { useVisualsAnalysis } from "./useVisualsAnalysis";
export type { VisualsAnalysis, VisualsAnalysisOptions } from "./useVisualsAnalysis";
export { VisualsCanvas } from "./VisualsCanvas";
export type { VisualsCanvasProps } from "./VisualsCanvas";
export { PresetThumbs } from "./PresetThumbs";
export type { PresetThumbsProps, ThumbItem } from "./PresetThumbs";
export { VisualsPicker } from "./VisualsPicker";
export type { VisualsPickerProps } from "./VisualsPicker";
