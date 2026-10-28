// Single import point for generated bindings. UI code imports services and
// types from here, never from "@bindings/..." directly, so regenerating
// bindings only ever touches this file if paths move.

export {
  DepsService,
  DesktopService,
  FilesService,
  JobsService,
  LibraryService,
  ModulesService,
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

export {
  Category,
  ClipKind,
  DepSource,
  DepState,
  ErrorCode,
  JobStatus,
  LogStream,
  ModuleStatus,
  OutputKind,
  Theme,
} from "@bindings/core/models";

export type {
  Accepts,
  AppInfo,
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
