// Single import point for generated bindings. UI code imports services and
// types from here, never from "@bindings/..." directly, so regenerating
// bindings only ever touches this file if paths move.

export {
  DepsService,
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

export {
  Category,
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
  DepStatus,
  DepsChanged,
  Descriptor,
  FileInfo,
  FilesDropped,
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
