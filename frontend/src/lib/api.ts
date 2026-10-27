// Single import point for generated bindings. UI code imports services and
// types from here, never from "@bindings/..." directly, so regenerating
// bindings only ever touches this file if paths move.

export {
  DepsService,
  JobsService,
  LibraryService,
  ModulesService,
  SettingsService,
} from "@bindings/api";

export * as DownloaderService from "@bindings/modules/downloader/service";

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
