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
  SearchService,
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
export * as DocumentsService from "@bindings/modules/documents/service";
export * as OrganizeService from "@bindings/modules/organize/service";
// --- Phase 13: Local File Transfer ---
export * as LanShareService from "@bindings/modules/lanshare/service";
export { FromMode as LanFromMode, PromptKind as LanPromptKind, ReceiveMode as LanReceiveMode } from "@bindings/core/lan/models";
export type {
  Activity as LanActivity,
  Device as LanDevice,
  DevicesChanged as LanDevicesChanged,
  Message as LanMessage,
  Prompt as LanPrompt,
  PromptClosed as LanPromptClosed,
  PromptFile as LanPromptFile,
  State as LanState,
} from "@bindings/core/lan/models";
export type { LanSettings, LanSettingsInput, SendInput as LanSendInput, StepOptions as LanShareStepOptions } from "@bindings/modules/lanshare/models";
export * as ArchiverService from "@bindings/modules/archiver/service";

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
  PopOutRequest,
  WindowHandoff,
  WindowRelay,
  WindowsChanged,
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
export { Format as DocumentFormat } from "@bindings/modules/documents/models";
export type { Options as DocumentsOptions } from "@bindings/modules/documents/models";
export { DupAction as OrganizeDupAction, DupMode as OrganizeDupMode, GroupBy as OrganizeGroupBy } from "@bindings/modules/organize/models";
export type { DuplicateGroup as OrganizeDuplicateGroup, Options as OrganizeOptions, Preview as OrganizePreview, PreviewFile as OrganizePreviewFile, PreviewFolder as OrganizePreviewFolder } from "@bindings/modules/organize/models";
export type { BrowserInfo as ArchiverBrowserInfo, Options as ArchiverOptions } from "@bindings/modules/archiver/models";
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

// --- Phase 8: Pipelines ---
export * as PipelinesService from "@bindings/modules/pipelines/service";
export { CellStatus, RunStatus, ValueType, WaitKind } from "@bindings/core/models";
export type {
  ContinueRequest,
  Pipeline,
  PipelineCheck,
  PipelineEntry,
  PipelineParam,
  PipelineRun,
  PipelineStep,
  PipelineTemplate,
  PipelinesChanged,
  RunBrief,
  RunCell,
  RunFile,
  RunFilter,
  RunItem,
  RunRequest,
  RunsRemoved,
  SecretAsk,
  StepBind,
  StepCheck,
  StepFilter,
  StepInfo,
  StepProduct,
  StepSecret,
  StepType,
  StepVar,
  WatchConfig,
  WatchState,
  ScheduleTrigger,
  ScheduleState,
} from "@bindings/core/models";
export type {
  ChatField as PipelineChatField,
  ChatStep as PipelineChatStep,
  CopyStep as PipelineCopyStep,
  OpenStep as PipelineOpenStep,
  WaitStep as PipelineWaitStep,
  RenameStep as PipelineRenameStep,
  TableColumn as PipelineTableColumn,
  TableStep as PipelineTableStep,
  ZipStep as PipelineZipStep,
} from "@bindings/modules/pipelines/models";
export { StepKeep as TrimStepKeep } from "@bindings/modules/trimmer/models";
export type { StepOptions as TrimmerStepOptions } from "@bindings/modules/trimmer/models";
export type { StepOptions as SubtitlesStepOptions } from "@bindings/modules/subtitles/models";
export type { StepOptions as AudioCleanupStepOptions } from "@bindings/modules/audiocleanup/models";
export type { StepOptions as LyricVideoStepOptions } from "@bindings/modules/lyricvideo/models";
export type { StepOptions as VisualizerStepOptions } from "@bindings/modules/visualizer/models";
export type { StepOptions as RedactStepOptions } from "@bindings/modules/redact/models";
export type { StepOptions as PdfStepOptions } from "@bindings/modules/pdf/models";
export type { StepOptions as VaultStepOptions } from "@bindings/modules/vault/models";

// --- Phase 8 Part B: creator tools ---
export * as ComposerService from "@bindings/modules/composer/service";
export * as VideoEditorService from "@bindings/modules/videoeditor/service";
export * as PostsService from "@bindings/modules/posts/service";
export { ProjectKind } from "@bindings/core/models";
export type { ProjectInfo } from "@bindings/core/models";
export type {
  AspectInfo as ComposerAspect,
  Background as ComposerBackground,
  Composition,
  ImageLayer as ComposerImageLayer,
  ImageRef as ComposerImageRef,
  Layer as ComposerLayer,
  Look as ComposerLook,
  Outline as ComposerOutline,
  Rect as ComposerRect,
  Shadow as ComposerShadow,
  TextLayer as ComposerTextLayer,
} from "@bindings/modules/composer/models";
export type {
  Clip as VideoClip,
  ClipInfo as VideoClipInfo,
  Music as VideoMusic,
  PlanRequest as VlogPlanRequest,
  PlanResult as VlogPlanResult,
  Title as VideoTitle,
  Transition as VideoTransition,
  VideoProject,
} from "@bindings/modules/videoeditor/models";
export type {
  ExportResult as PostExportResult,
  Issue as PostIssue,
  Limits as PostLimits,
  Post,
  Slide as PostSlide,
  SlideSource as PostSlideSource,
  SourceFile as PostSourceFile,
} from "@bindings/modules/posts/models";

// --- Phase 9: Edit Studio ---
export * as EditStudioService from "@bindings/modules/editstudio/service";
export { Action as EditAction } from "@bindings/modules/editstudio/models";
export type {
  AnalyzeRequest as EditAnalyzeRequest,
  Captions as EditCaptions,
  Clip as EditClip,
  CustomMarker as EditCustomMarker,
  EditProject,
  EditStream,
  InterpRequest as EditInterpRequest,
  LaneSettings as EditLaneSettings,
  MarkerRow as EditMarkerRow,
  MarkerState as EditMarkerState,
  Matte as EditMatte,
  MatteClick as EditMatteClick,
  MatteGlow as EditMatteGlow,
  MatteModels as EditMatteModels,
  MatteRequest as EditMatteRequest,
  MatteState as EditMatteState,
  MatteStroke as EditMatteStroke,
  RecipeRun as EditRecipeRun,
  Result as EditResult,
  Song as EditSong,
  Source as EditSource,
  SourceState as EditSourceState,
  Moment as EditMoment,
  StreamIndex as EditStreamIndex,
  TextRequest as EditTextRequest,
  Track as EditTrack,
} from "@bindings/modules/editstudio/models";

// --- Phase 14: step options of the tools that became pipeline steps ---
export type { SavedMask as EraserSavedMask, StepOptions as EraserStepOptions } from "@bindings/modules/eraser/models";
export type { SlotInfo as ComposerSlotInfo, StepOptions as ComposerStepOptions } from "@bindings/modules/composer/models";
export type { RunStep as PipelineRunStep } from "@bindings/modules/pipelines/models";
export type { AssembleRequest as EditAssembleRequest, BeatRequest as EditBeatRequest } from "@bindings/modules/editstudio/models";
export type { ClipTrigger } from "@bindings/core/models";

// Scene Splitter and GIF & Contact Sheet (Phase 15, T2)
export * as ScenesService from "@bindings/modules/scenes/service";
export * as GifService from "@bindings/modules/gif/service";
export { Output as SceneOutput, Keep as SceneKeep } from "@bindings/modules/scenes/models";
export type { Options as ScenesOptions, Result as ScenesResult, Scene as SceneInfo, StepOptions as ScenesStepOptions } from "@bindings/modules/scenes/models";
export { Mode as GifMode } from "@bindings/modules/gif/models";
export type { Options as GifOptions, Result as GifResult, StepOptions as GifStepOptions } from "@bindings/modules/gif/models";

// Silence Cutter and Image Batch (Phase 15, T3).
export * as SilenceService from "@bindings/modules/silence/service";
export * as ImageBatchService from "@bindings/modules/imagebatch/service";
export type {
  Analysis as SilenceAnalysis,
  Options as SilenceOptions,
  Range as SilenceRange,
  Result as SilenceResult,
  StepOptions as SilenceStepOptions,
} from "@bindings/modules/silence/models";
export {
  Corner as BatchCorner,
  Fit as BatchFit,
  Format as BatchFormat,
  ResizeMode as BatchResize,
  WatermarkKind as BatchWatermarkKind,
} from "@bindings/modules/imagebatch/models";
export type {
  FileResult as ImageBatchFile,
  Options as ImageBatchOptions,
  Result as ImageBatchResult,
  StepOptions as ImageBatchStepOptions,
  Watermark as ImageBatchWatermark,
} from "@bindings/modules/imagebatch/models";

// Compress to Size (Phase 17).
export * as CompressService from "@bindings/modules/compress/service";
export {
  Grade as CompressGrade,
  ImageFormat as CompressImageFormat,
  Kind as CompressKind,
  TooSmall as CompressTooSmall,
  VideoCodec as CompressVideoCodec,
} from "@bindings/modules/compress/models";
export type {
  Estimate as CompressEstimate,
  Options as CompressOptions,
  Result as CompressResult,
  Target as CompressTarget,
} from "@bindings/modules/compress/models";

// Focus Lock (Phase 18).
export * as FocusService from "@bindings/modules/focus/service";
export { Strength as FocusStrength, Weaken as FocusWeaken } from "@bindings/core/focus/models";
export type {
  AllowRule as FocusAllowRule,
  BlockEvent as FocusBlockEvent,
  BlockedApp as FocusBlockedApp,
  Friction as FocusFriction,
  LearnEntry as FocusLearnEntry,
  OpenApp as FocusOpenApp,
  Profile as FocusProfile,
  Session as FocusSession,
  Settings as FocusSettings,
  StartRequest as FocusStartRequest,
  State as FocusState,
} from "@bindings/core/focus/models";
export type { App as FocusApp, StepOptions as FocusStepOptions } from "@bindings/modules/focus/models";

// Text to Speech (Phase 15, T1).
export * as TtsService from "@bindings/modules/tts/service";
export { Format as TtsFormat, Split as TtsSplit } from "@bindings/modules/tts/models";
export type {
  FileResult as TtsFileResult,
  Options as TtsOptions,
  Result as TtsResult,
  StepOptions as TtsStepOptions,
  VoiceInfo as TtsVoiceInfo,
} from "@bindings/modules/tts/models";

// --- Phase 19: Paint+ and the Library browser ---
export * as PaintService from "@bindings/modules/paint/service";
export { AIOp as PaintAIOp, ExportFormat as PaintExportFormat, StepAction as PaintStepAction } from "@bindings/modules/paint/models";
export type {
  AIModelInfo as PaintAIModelInfo,
  AIPoint as PaintAIPoint,
  AIRequest as PaintAIRequest,
  AIResultInfo as PaintAIResultInfo,
  BrushImportResult,
  BrushInfo,
  BrushSet,
  ExportOptions as PaintExportOptions,
  Origin as PaintOrigin,
  PaintDoc,
  PaintLayer,
  StepOptions as PaintStepOptions,
} from "@bindings/modules/paint/models";
export { LibrarySort } from "@bindings/core/models";
export type {
  LibraryEntry,
  LibraryFolder,
  LibraryListing,
  LibraryPlaces,
  LibraryProject,
  LibraryQuery,
  LibrarySavedMask,
  OutputDetail,
  TrashResult,
} from "@bindings/core/models";

// --- Phase 20: Smart search and Caption Writer ---
export type {
  LabelCount,
  MediaLabel,
  MediaText,
  SearchFailure,
  SearchHit,
  SearchIndexed,
  SearchPage,
  SearchQuery,
  SearchReady,
  SearchSettings,
  SearchStatus,
} from "@bindings/core/models";
export * as CaptionService from "@bindings/modules/captions/service";
export {
  Action as CaptionAction,
  Field as CaptionField,
  Length as CaptionLength,
  NamePattern as CaptionNamePattern,
  Preset as CaptionPreset,
  Then as CaptionThen,
  Tone as CaptionTone,
} from "@bindings/modules/captions/models";
export type {
  Batch as CaptionBatch,
  BatchInfo as CaptionBatchInfo,
  Fields as CaptionFields,
  Item as CaptionItem,
  ItemEvent as CaptionItemEvent,
  Options as CaptionOptions,
  Status as CaptionStatus,
  WriteOptions as CaptionWriteOptions,
} from "@bindings/modules/captions/models";
