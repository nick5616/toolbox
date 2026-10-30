// Single import point for generated bindings. UI code imports services and
// types from here, never from "@bindings/..." directly, so regenerating
// bindings only ever touches this file if paths move.

export {
  DepsService,
  DesktopService,
  FilesService,
  JobsService,
  LibraryService,
  MediaService,
  ModulesService,
  PacksService,
  SettingsService,
} from "@bindings/api";

export * as DownloaderService from "@bindings/modules/downloader/service";
export * as StemsService from "@bindings/modules/stems/service";
export * as BpmKeyService from "@bindings/modules/bpmkey/service";
export * as MidiService from "@bindings/modules/midi/service";
export * as ConverterService from "@bindings/modules/converter/service";
export * as ClipboardService from "@bindings/modules/clipboard/service";
export * as TranscribeService from "@bindings/modules/transcribe/service";
export * as ExifService from "@bindings/modules/exif/service";
export * as BgRemoveService from "@bindings/modules/bgremove/service";
export * as UpscaleService from "@bindings/modules/upscale/service";
export * as PdfService from "@bindings/modules/pdf/service";
export * as ChatService from "@bindings/modules/chat/service";
export * as OcrService from "@bindings/modules/ocr/service";
export * as VaultService from "@bindings/modules/vault/service";
export * as TrimmerService from "@bindings/modules/trimmer/service";
export * as SubtitlesService from "@bindings/modules/subtitles/service";
export * as AudioCleanupService from "@bindings/modules/audiocleanup/service";
export * as LyricVideoService from "@bindings/modules/lyricvideo/service";
export * as RedactService from "@bindings/modules/redact/service";
export * as EraserService from "@bindings/modules/eraser/service";
export * as VisualizerService from "@bindings/modules/visualizer/service";
export * as DevUtilsService from "@bindings/modules/devutils/service";

export {
  Category,
  ChatBackend,
  ChatMessageStatus,
  ChatRole,
  ChatServerState,
  ClipKind,
  DepSource,
  DepState,
  ErrorCode,
  JobStatus,
  LogStream,
  ModuleStatus,
  OutputKind,
  PackComponentKind,
  PackComponentState,
  PackState,
  Theme,
} from "@bindings/core/models";

export type {
  Accepts,
  AppInfo,
  ChatConversation,
  ChatConversationPatch,
  ChatDelta,
  ChatDone,
  ChatMessage,
  ChatPage,
  ChatSettings,
  ChatStatus,
  DiskInfo,
  PackComponentStatus,
  PackInstallResult,
  PackKept,
  PackRemovePreview,
  PackStatus,
  PackUnlock,
  PacksChanged,
  SetupSettings,
  ToolsDirInfo,
  VaultSettings,
  VaultState,
  ClipItem,
  ClipPage,
  ClipQuery,
  ClipboardSettings,
  ClipboardState,
  ClipsRemoved,
  DepStatus,
  DepsChanged,
  Descriptor,
  FileInfo,
  FilesDropped,
  HotkeyStatus,
  HotkeysChanged,
  Job,
  JobFilter,
  JobLogBatch,
  JobProgress,
  JobsRemoved,
  LogLine,
  MatchResult,
  ModuleMatch,
  Navigate,
  Output,
  OutputPage,
  OutputQuery,
  OutputsRemoved,
  PresetInfo,
  Settings,
  SettingsPatch,
  ShowView,
  Size,
} from "@bindings/core/models";

export {
  AudioFormat,
  AudioQuality,
  MaxResolution,
  Mode as DownloadMode,
} from "@bindings/modules/downloader/models";
export type { Options as DownloaderOptions } from "@bindings/modules/downloader/models";

export { Format as StemsFormat, Preset as StemsPreset } from "@bindings/modules/stems/models";
export type { Options as StemsOptions } from "@bindings/modules/stems/models";
export type { Result as BpmKeyResult, KeyCandidate } from "@bindings/modules/bpmkey/models";
export { Range as MidiRange } from "@bindings/modules/midi/models";
export type { Options as MidiOptions, Result as MidiResult } from "@bindings/modules/midi/models";
export { MaxHeight } from "@bindings/modules/converter/models";
export type { Options as ConverterOptions } from "@bindings/modules/converter/models";
export { Model as TranscribeModel, Task as TranscribeTask } from "@bindings/modules/transcribe/models";
export type {
  Language,
  Options as TranscribeOptions,
  Result as TranscribeResult,
} from "@bindings/modules/transcribe/models";
export { Action as ExifAction } from "@bindings/modules/exif/models";
export type {
  GeoPoint,
  MetaField,
  MetaGroup,
  MetadataView,
  Options as ExifOptions,
  Result as ExifResult,
} from "@bindings/modules/exif/models";
export { Model as BgModel, Output as BgOutput } from "@bindings/modules/bgremove/models";
export type { Options as BgRemoveOptions, Result as BgRemoveResult } from "@bindings/modules/bgremove/models";
export {
  Device as UpscaleDevice,
  Format as UpscaleFormat,
  Model as UpscaleModel,
} from "@bindings/modules/upscale/models";
export type {
  Limits as UpscaleLimits,
  ModelInfo as UpscaleModelInfo,
  Options as UpscaleOptions,
  Result as UpscaleResult,
} from "@bindings/modules/upscale/models";
export { Action as PdfAction } from "@bindings/modules/pdf/models";
export type {
  Info as PdfInfo,
  Options as PdfOptions,
  PageEdit as PdfPageEdit,
  PageSize as PdfPageSize,
  Result as PdfResult,
} from "@bindings/modules/pdf/models";

export type { ConversationView, ModelInfo as ChatModelInfo, SendResult as ChatSendResult } from "@bindings/modules/chat/models";
export { ImageOutput as OcrImageOutput, Language as OcrLanguage, PDFOutput as OcrPdfOutput } from "@bindings/modules/ocr/models";
export type { LanguageInfo as OcrLanguageInfo, Options as OcrOptions, Result as OcrResult } from "@bindings/modules/ocr/models";
export type { Entry as VaultEntry } from "@bindings/modules/vault/models";

// Phase 6
export type { MediaSource } from "@bindings/api/models";
export type {
  AudioStream as MediaAudioStream,
  Info as MediaInfo,
  SubtitleStream as MediaSubtitleStream,
  VideoStream as MediaVideoStream,
} from "@bindings/core/media/models";
export { Aspect as TrimAspect, Join as TrimJoin, Mode as TrimMode } from "@bindings/modules/trimmer/models";
export type { Options as TrimmerOptions, Result as TrimmerResult, Segment as TrimSegment } from "@bindings/modules/trimmer/models";
export { Action as SubtitlesAction, Style as SubtitleStyle } from "@bindings/modules/subtitles/models";
export type {
  Cue,
  Language as SubtitleLanguage,
  Options as SubtitlesOptions,
  Result as SubtitlesResult,
  StyleInfo as SubtitleStyleInfo,
  TranslatorStatus,
} from "@bindings/modules/subtitles/models";
export {
  Denoise as CleanupDenoise,
  Format as CleanupFormat,
  Hum as CleanupHum,
  Loudness as CleanupLoudness,
} from "@bindings/modules/audiocleanup/models";
export type {
  FileResult as CleanupFileResult,
  Options as AudioCleanupOptions,
  Result as AudioCleanupResult,
} from "@bindings/modules/audiocleanup/models";
export { Action as LyricAction, Source as LyricSource } from "@bindings/modules/lyricvideo/models";
export type {
  Look as LyricLook,
  LyricLine,
  Options as LyricVideoOptions,
  Result as LyricVideoResult,
} from "@bindings/modules/lyricvideo/models";
export type { Line as TimedLine, Word as LyricWord } from "@bindings/core/lyrics/models";
export {
  Action as RedactAction,
  Sensitivity as RedactSensitivity,
  Style as RedactStyle,
} from "@bindings/modules/redact/models";
export type {
  Box as RedactBox,
  ImageDetections,
  Options as RedactOptions,
  Result as RedactResult,
  TimedBox,
  Track as RedactTrack,
  TrackSample,
  VideoDetections,
} from "@bindings/modules/redact/models";
export { Model as EraserModel } from "@bindings/modules/eraser/models";
export type {
  ModelInfo as EraserModelInfo,
  Options as EraserOptions,
  Result as EraserResult,
} from "@bindings/modules/eraser/models";
export type {
  FileHashes,
  HashResult,
  Options as DevUtilsOptions,
  Result as DevUtilsResult,
} from "@bindings/modules/devutils/models";
export { Action as VisualizerAction, Mode as VisualizerMode } from "@bindings/modules/visualizer/models";
export type {
  ChatStatus as VisualizerChatStatus,
  Design as VisualizerDesign,
  Options as VisualizerOptions,
  Result as VisualizerResult,
} from "@bindings/modules/visualizer/models";
export { WordsSource } from "@bindings/core/viz/models";
export type {
  AnalysisRef,
  AnalysisSummary,
  AnalyzeOptions,
  RenderAck,
  RenderCancel,
  RenderStart,
  VisualsSpec,
} from "@bindings/core/viz/models";
export type { CueWord } from "@bindings/modules/subtitles/models";
