import {
  AudioFormat,
  AudioQuality,
  BatchCorner,
  BatchFit,
  BatchFormat,
  BatchResize,
  BatchWatermarkKind,
  BgModel,
  BgOutput,
  CleanupDenoise,
  CleanupFormat,
  CleanupHum,
  CleanupLoudness,
  DocumentFormat,
  DownloadMode,
  EraserModel,
  ExifAction,
  GifMode,
  MaxHeight,
  MaxResolution,
  MidiRange,
  OcrImageOutput,
  OcrPdfOutput,
  OrganizeDupAction,
  OrganizeDupMode,
  OrganizeGroupBy,
  PdfAction,
  RedactSensitivity,
  RedactStyle,
  SceneKeep,
  SceneOutput,
  StemsFormat,
  StemsPreset,
  SubtitleStyle,
  TranscribeModel,
  TranscribeTask,
  TrimAspect,
  TrimMode,
  TrimStepKeep,
  TtsFormat,
  TtsSplit,
  UpscaleDevice,
  UpscaleFormat,
  UpscaleModel,
  VisualizerMode,
} from "@/lib/api";
import { FALLBACK_LANGUAGES } from "@/tools/ocr/options";
import { MAX_SIMILARITY, MIN_SIMILARITY } from "@/tools/organize/options";
import {
  CODEC_CHOICES,
  COMPRESS_LIMITS,
  IMAGE_FORMAT_CHOICES,
  MAX_HEIGHTS,
  STATIC_TARGETS,
  TOO_SMALL_CHOICES,
  maxHeightLabel,
} from "@/tools/compress/options";
import { SILENCE_LIMITS } from "@/tools/silence/options";
import { SIDE_LIMITS } from "@/tools/imagebatch/options";
import { MAX_SPEED, MIN_SPEED } from "@/tools/tts/options";
import type { ParamChoice, ParamOverrides } from "../params";

// Phase 16 §3.5: every step type's parameters (its scalar options) with the
// labels and choice lists its editor uses, keyed by JSON pointer. Fields not
// listed are still derived from the type's defaults (with a humanised key), so
// everything a step has is listed here deliberately: params.test.ts checks it.
// Numbers that the editor offers as a short list stay numbers (min/max + tip):
// a wire of a number never has to be one of several strings.

/** [value, label] pairs as a choice list. */
const ch = (...pairs: ReadonlyArray<readonly [string, string]>): ParamChoice[] => pairs.map(([value, label]) => ({ value, label }));

const ASPECTS_VIDEO = ch(["9:16", "9:16"], ["4:5", "4:5"], ["1:1", "1:1"], ["16:9", "16:9"]);
const ASPECTS_SHAPE = ch(["16:9", "16:9"], ["9:16", "9:16"], ["1:1", "1:1"]);
const SPOKEN_AUDIO = ch(["original", "Original"], ["instrumental", "Instrumental"]);
const WHISPER_MODELS = ch(["base", "Base"], ["small", "Small"], ["turbo", "Turbo"]);

export const PDF_ACTION_CHOICES = ch(
  [PdfAction.ActionMerge, "Merge into one PDF"],
  [PdfAction.ActionSplit, "Split a PDF"],
  [PdfAction.ActionCompress, "Compress a PDF"],
  [PdfAction.ActionImagesToPDF, "Photos to one PDF"],
  [PdfAction.ActionPDFToImages, "PDF pages to images"],
  [PdfAction.ActionProtect, "Add a password"],
  [PdfAction.ActionUnlock, "Remove the password"],
);

const RECIPES = ch(
  ["downbeat", "Cut on the downbeat"],
  ["kick", "Cut on the kick"],
  ["chorus-double", "Twice as fast in the chorus"],
  ["hold-verse", "Hold longer in the verse"],
  ["drop-slam", "Slam on the drop"],
  ["anime-drop", "Anime drop"],
);

const BASE: Readonly<Record<string, ParamOverrides>> = {
  // ── media.tsx ──
  downloader: {
    "/mode": { label: "Download", type: "choice", choices: ch([DownloadMode.ModeAudio, "Audio"], [DownloadMode.ModeVideo, "Video"]), primary: true },
    "/audioFormat": {
      label: "Audio format",
      type: "choice",
      choices: ch([AudioFormat.FormatMP3, "mp3"], [AudioFormat.FormatWAV, "wav"], [AudioFormat.FormatFLAC, "flac"]),
      primary: true,
    },
    "/audioQuality": {
      label: "MP3 quality",
      type: "choice",
      choices: ch(
        [AudioQuality.QualityBest, "Best (V0)"],
        [AudioQuality.Quality320, "320 kbps"],
        [AudioQuality.Quality256, "256 kbps"],
        [AudioQuality.Quality192, "192 kbps"],
        [AudioQuality.Quality128, "128 kbps"],
      ),
    },
    "/maxResolution": {
      label: "Max resolution",
      type: "choice",
      choices: ch(
        [MaxResolution.ResBest, "Best"],
        [MaxResolution.Res2160, "2160p"],
        [MaxResolution.Res1440, "1440p"],
        [MaxResolution.Res1080, "1080p"],
        [MaxResolution.Res720, "720p"],
        [MaxResolution.Res480, "480p"],
        [MaxResolution.Res360, "360p"],
      ),
      primary: true,
    },
    "/trimEnabled": { hidden: true },
    "/trimStart": { hidden: true },
    "/trimEnd": { hidden: true },
    "/embedMetadata": { label: "Embed metadata" },
    "/embedThumbnail": { label: "Embed thumbnail" },
    "/playlist": { label: "Whole playlist", tip: "Download the whole playlist when a link is one" },
  },
  converter: {
    "/preset": { label: "Format", primary: true, tip: "The format preset's id, such as mp3-320" },
    "/maxHeight": {
      label: "Max height",
      type: "choice",
      choices: ch(
        [MaxHeight.HeightKeep, "Keep original"],
        [MaxHeight.Height2160, "2160p"],
        [MaxHeight.Height1440, "1440p"],
        [MaxHeight.Height1080, "1080p"],
        [MaxHeight.Height720, "720p"],
        [MaxHeight.Height480, "480p"],
      ),
      primary: true,
    },
    "/keepMetadata": { label: "Keep metadata" },
  },
  trimmer: {
    "/keep": {
      label: "Keep",
      type: "choice",
      choices: ch([TrimStepKeep.KeepWhole, "Whole file"], [TrimStepKeep.KeepFirst, "First…"], [TrimStepKeep.KeepLast, "Last…"], [TrimStepKeep.KeepRange, "From–To"]),
      primary: true,
    },
    "/seconds": { label: "Seconds to keep", min: 1, max: 36000, tip: "For First and Last" },
    "/from": { label: "From", tip: "A timecode such as 1:30. Empty is the start" },
    "/to": { label: "To", tip: "A timecode such as 2:45. Empty is the end" },
    "/mode": {
      label: "Mode",
      type: "choice",
      choices: ch([TrimMode.ModePrecise, "Precise"], [TrimMode.ModeFast, "Fast (no re-encode)"]),
      primary: true,
    },
    "/aspect": {
      label: "Frame",
      type: "choice",
      choices: ch(
        [TrimAspect.AspectKeep, "Keep"],
        [TrimAspect.AspectPortrait, "9:16"],
        [TrimAspect.AspectSquare, "1:1"],
        [TrimAspect.AspectFourFive, "4:5"],
        [TrimAspect.AspectWide, "16:9"],
      ),
      primary: true,
    },
    "/cropX": { label: "Crop across", min: 0, max: 1, tip: "Where the crop sits across the frame: 0 left, 1 right" },
    "/cropY": { label: "Crop down", min: 0, max: 1, tip: "Where the crop sits down the frame: 0 top, 1 bottom" },
    "/maxSizeMB": { label: "Max size (MB)", min: 0, max: 4000, tip: "0 means no limit" },
    "/maxHeight": { label: "Max height (px)", min: 0, max: 2160, tip: "0 keeps the original; 480, 720, 1080, 1440 or 2160" },
    "/removeAudio": { label: "Remove the audio" },
  },
  "audio-cleanup": {
    "/highPass": { label: "Cut rumble", tip: "Cut rumble below 80 Hz" },
    "/hum": {
      label: "Hum",
      type: "choice",
      choices: ch([CleanupHum.HumAuto, "Auto"], [CleanupHum.Hum50, "50 Hz"], [CleanupHum.Hum60, "60 Hz"], [CleanupHum.HumOff, "Off"]),
    },
    "/denoise": {
      label: "Noise reduction",
      type: "choice",
      choices: ch(
        [CleanupDenoise.DenoiseOff, "Off"],
        [CleanupDenoise.DenoiseLight, "Light"],
        [CleanupDenoise.DenoiseStrong, "Strong"],
        [CleanupDenoise.DenoiseVoice, "Voice isolation (AI)"],
      ),
      primary: true,
    },
    "/loudness": {
      label: "Loudness",
      type: "choice",
      choices: ch(
        [CleanupLoudness.LoudnessOff, "Off"],
        [CleanupLoudness.LoudnessPodcast, "Podcast"],
        [CleanupLoudness.LoudnessStreaming, "Streaming"],
        [CleanupLoudness.LoudnessBroadcast, "Broadcast"],
      ),
      primary: true,
    },
    "/format": {
      label: "Format",
      type: "choice",
      choices: ch(
        [CleanupFormat.FormatSame, "Same as the file"],
        [CleanupFormat.FormatWAV, "WAV"],
        [CleanupFormat.FormatFLAC, "FLAC"],
        [CleanupFormat.FormatMP3, "MP3"],
        [CleanupFormat.FormatM4A, "M4A"],
      ),
      primary: true,
    },
  },
  redact: {
    "/faces": { label: "Find faces", primary: true },
    "/plates": { label: "Find number plates", primary: true },
    "/sensitivity": {
      label: "Sensitivity",
      type: "choice",
      choices: ch([RedactSensitivity.SensitivityNormal, "Normal"], [RedactSensitivity.SensitivityHigh, "High"]),
    },
    "/style": {
      label: "Style",
      type: "choice",
      choices: ch([RedactStyle.StyleBlur, "Blur"], [RedactStyle.StylePixelate, "Pixelate"], [RedactStyle.StyleSolid, "Solid"]),
      primary: true,
    },
    "/strength": { label: "Strength", min: 1, max: 10, tip: "How strongly blur or pixelation hides the area" },
    "/padding": { label: "Padding (%)", min: 0, max: 50, tip: "Grow each box by this percentage" },
    "/stripMetadata": { label: "Remove location and camera info" },
  },
  stems: {
    "/preset": {
      label: "Split into",
      type: "choice",
      choices: ch(
        [StemsPreset.PresetFourFast, "4 stems · fast"],
        [StemsPreset.PresetFourBest, "4 stems · best"],
        [StemsPreset.PresetVocalsFast, "Vocals + instrumental · fast"],
        [StemsPreset.PresetVocalsBest, "Vocals + instrumental · best"],
      ),
      primary: true,
    },
    "/format": { label: "Format", type: "choice", choices: ch([StemsFormat.FormatFLAC, "FLAC"], [StemsFormat.FormatWAV, "WAV"], [StemsFormat.FormatMP3, "MP3"]), primary: true },
  },
  "bpm-key": {},
  "audio-to-midi": {
    "/sensitivity": { label: "Sensitivity", min: 0.1, max: 0.9, primary: true },
    "/noteFloor": { label: "Note floor", min: 0.1, max: 0.6 },
    "/minNoteMs": { label: "Shortest note (ms)", min: 30, max: 500 },
    "/range": {
      label: "Pitch range",
      type: "choice",
      choices: ch([MidiRange.RangeFull, "Full"], [MidiRange.RangeBass, "Bass"], [MidiRange.RangeMelody, "Melody"]),
      primary: true,
    },
    "/melodiaTrick": { label: "Smooth held notes" },
  },
  transcribe: {
    "/model": {
      label: "Model",
      type: "choice",
      choices: ch([TranscribeModel.ModelBase, "Base"], [TranscribeModel.ModelSmall, "Small"], [TranscribeModel.ModelTurbo, "Turbo"]),
      primary: true,
    },
    "/language": { label: "Language", primary: true, tip: "A language code such as en or de. Empty detects it" },
    "/task": {
      label: "Task",
      type: "choice",
      choices: ch([TranscribeTask.TaskTranscribe, "Transcribe"], [TranscribeTask.TaskTranslate, "Translate to English"]),
      primary: true,
    },
    "/vad": { label: "Skip silence" },
  },
  ocr: {
    "/language": { label: "Language", type: "choice", choices: FALLBACK_LANGUAGES.map((l) => ({ value: l.id, label: l.label })), primary: true },
    "/pdfOutput": {
      label: "PDF output",
      type: "choice",
      choices: ch([OcrPdfOutput.PDFSearchable, "Searchable PDF"], [OcrPdfOutput.PDFText, "Text file"], [OcrPdfOutput.PDFBoth, "Both"]),
      primary: true,
    },
    "/imageOutput": {
      label: "Image output",
      type: "choice",
      choices: ch([OcrImageOutput.ImageText, "Text file"], [OcrImageOutput.ImageJSON, "Text with positions (JSON)"]),
    },
    "/skipText": { label: "Skip pages that already have text" },
  },

  // ── compound.tsx ──
  subtitles: {
    "/model": { label: "Model", type: "choice", choices: WHISPER_MODELS, primary: true },
    "/language": { label: "Spoken language", primary: true, tip: "A language code such as en. Empty detects it" },
    "/translateToEnglish": { label: "Translate to English" },
    "/targetLanguage": { label: "Translate to", tip: "A language code. Empty keeps the spoken language" },
    "/maxLineChars": { label: "Characters per line", min: 32, max: 60 },
    "/maxLines": { label: "Lines", min: 1, max: 2 },
    "/video": {
      label: "Video",
      type: "choice",
      choices: ch(["none", "No video"], ["burn", "Burn in"], ["embed", "Add as a track"]),
      primary: true,
    },
    "/style": {
      label: "Style",
      type: "choice",
      choices: ch(
        [SubtitleStyle.StyleClassic, "Classic"],
        [SubtitleStyle.StyleBoxed, "Boxed"],
        [SubtitleStyle.StyleYellow, "Yellow"],
        [SubtitleStyle.StyleMinimal, "Minimal"],
      ),
      primary: true,
    },
    "/size": { label: "Text size", type: "choice", choices: ch(["s", "Small"], ["m", "Medium"], ["l", "Large"]) },
    "/position": { label: "Position", type: "choice", choices: ch(["bottom", "Bottom"], ["top", "Top"]) },
    "/font": { label: "Font" },
    "/trackLanguage": { label: "Track language", tip: "The language tag of the added subtitle track" },
    "/maxSizeMB": { label: "Largest file (MB)", min: 0, max: 4000, tip: "0 means no limit" },
    "/canvas": { label: "Audio canvas shape", type: "choice", choices: ASPECTS_SHAPE },
    "/canvasHeight": { label: "Audio canvas height (px)", min: 720, max: 1080, tip: "720 or 1080" },
    "/background": { label: "Audio background", type: "choice", choices: ch(["color", "Colour"], ["image", "Image"], ["visualizer", "Visuals (from the tool)"]) },
    "/backgroundColor": { label: "Audio background colour", type: "color" },
    "/backgroundPath": { label: "Audio background image", type: "file" },
  },
  "lyric-video": {
    "/language": { label: "Language", tip: "A language code such as en. Empty detects it" },
    "/look/background": {
      label: "Background",
      type: "choice",
      choices: ch(
        ["blur-cover", "Blurred cover"],
        ["cover", "Cover and blur"],
        ["color", "Colour"],
        ["gradient", "Gradient"],
        ["image", "Image"],
        ["video", "Video"],
        ["visualizer", "Visuals (from the tool)"],
      ),
      primary: true,
    },
    "/look/backgroundPath": { label: "Background image or video", type: "file" },
    "/look/color1": { label: "Background colour", type: "color", tip: "The top colour for a gradient" },
    "/look/color2": { label: "Bottom colour", type: "color", tip: "The bottom colour for a gradient" },
    "/look/font": { label: "Font" },
    "/look/textColor": { label: "Text colour", type: "color" },
    "/look/highlightColor": { label: "Highlight colour", type: "color" },
    "/look/karaoke": { label: "Karaoke", tip: "Fill each word as it is sung", primary: true },
    "/look/position": { label: "Text position", type: "choice", choices: ch(["center", "Centre"], ["lower", "Lower"]) },
    "/look/showNext": { label: "Show the next line" },
    "/look/visualizer": { label: "Wave overlay", type: "choice", choices: ch(["none", "None"], ["wave", "Wave"], ["bars", "Bars"]) },
    "/look/titleCard": { label: "Title card" },
    "/look/title": { label: "Title" },
    "/look/artist": { label: "Artist" },
    "/look/visuals/showJson": { hidden: true },
    "/look/visuals/stems": { hidden: true },
    "/look/visuals/useWords": { hidden: true },
    "/audio": { label: "Audio", type: "choice", choices: SPOKEN_AUDIO },
    "/aspect": { label: "Shape", type: "choice", choices: ASPECTS_SHAPE, primary: true },
    "/height": { label: "Height (px)", min: 720, max: 1080, tip: "720 or 1080" },
  },
  visualizer: {
    "/presetId": { hidden: true },
    "/designName": { hidden: true },
    "/showJson": { hidden: true },
    "/mode": {
      label: "Visuals",
      type: "choice",
      choices: ch([VisualizerMode.ModeFull, "Full frame"], [VisualizerMode.ModeOverlay, "Over the video"]),
      primary: true,
    },
    "/aspect": { label: "Shape", type: "choice", choices: [...ASPECTS_SHAPE, { value: "4:5", label: "4:5" }], primary: true },
    "/height": { label: "Quality (px)", min: 720, max: 2160, tip: "720, 1080, 1440 or 2160" },
    "/fps": { label: "Frame rate", min: 30, max: 60, tip: "30 or 60" },
    "/audio": { label: "Audio", type: "choice", choices: SPOKEN_AUDIO, primary: true },
    "/background": { label: "Background", type: "choice", choices: ch(["none", "None"], ["cover", "Cover art"]) },
    "/stems": { label: "Separate instruments" },
    "/saveStems": { label: "Also keep the stems" },
    "/words": { label: "Words", type: "choice", choices: ch(["none", "None"], ["detect", "Detect"]) },
    "/language": { label: "Language", tip: "A language code such as en. Empty detects it" },
    "/mood": { label: "Read the mood of the music" },
  },

  // ── docs.tsx ──
  pdf: {
    "/action": { label: "What to do", type: "choice", choices: PDF_ACTION_CHOICES, primary: true },
    "/every": { label: "Pages per file", min: 1, max: 10000, primary: true },
    "/level": {
      label: "Compression",
      type: "choice",
      choices: ch(["small", "Smallest file"], ["balanced", "Balanced"], ["high", "Best quality"]),
      primary: true,
    },
    "/pageSize": { label: "Page size", type: "choice", choices: ch(["a4", "A4"], ["letter", "US Letter"], ["fit", "Fit to each image"]) },
    "/margin": { label: "Margin", type: "choice", choices: ch(["none", "None"], ["small", "Small"]) },
    "/imageFormat": { label: "Image format", type: "choice", choices: ch(["png", "PNG"], ["jpg", "JPG"]) },
    "/dpi": { label: "Resolution (dpi)", min: 72, max: 300, tip: "72, 150 or 300" },
  },
  vault: {
    "/folder": { label: "Folder in the Vault", primary: true },
  },
  "bg-remover": {
    "/model": {
      label: "Quality",
      type: "choice",
      choices: ch([BgModel.ModelFast, "Fast"], [BgModel.ModelBalanced, "Balanced"], [BgModel.ModelBest, "Best"]),
      primary: true,
    },
    "/output": {
      label: "Result",
      type: "choice",
      choices: ch([BgOutput.OutputTransparent, "Transparent"], [BgOutput.OutputColor, "Solid colour"], [BgOutput.OutputMask, "Mask only"]),
      primary: true,
    },
    "/color": { label: "Background colour", type: "color" },
    "/crop": { label: "Crop to the subject" },
    "/padding": { label: "Padding (px)", min: 0, max: 500 },
    "/cleanEdges": { label: "Clean edge colours" },
    "/refine": { label: "Refine edges" },
  },
  upscaler: {
    "/model": {
      label: "Kind of image",
      type: "choice",
      choices: ch([UpscaleModel.ModelPhoto, "Photo"], [UpscaleModel.ModelIllustration, "Illustration"], [UpscaleModel.ModelFast, "Fast"]),
      primary: true,
    },
    "/scale": { label: "Scale", min: 2, max: 4, tip: "2 or 4 times", primary: true },
    "/format": {
      label: "Save as",
      type: "choice",
      choices: ch([UpscaleFormat.FormatSame, "Same as the original"], [UpscaleFormat.FormatPNG, "PNG"], [UpscaleFormat.FormatJPG, "JPG"], [UpscaleFormat.FormatWebP, "WebP"]),
    },
    "/device": {
      label: "Runs on",
      type: "choice",
      choices: ch([UpscaleDevice.DeviceAuto, "Automatic"], [UpscaleDevice.DeviceGPU, "GPU"], [UpscaleDevice.DeviceCPU, "CPU (slower)"]),
    },
  },
  exif: {
    "/action": {
      label: "What to do",
      type: "choice",
      choices: ch([ExifAction.ActionStripLocation, "Strip location"], [ExifAction.ActionStripAll, "Strip all"], [ExifAction.ActionEdit, "Edit fields"]),
      primary: true,
    },
    "/keepOrientation": { label: "Keep orientation and colour profile" },
  },

  // ── phase14.tsx ──
  "dev-utils": {
    "/action": { label: "Action", type: "choice", choices: ch(["checksums", "Checksums"], ["encode", "Encode"]), primary: true },
    "/format": { label: "Save as", type: "choice", choices: ch(["sidecar", "One file each"], ["csv", "One CSV"]) },
    "/encoding": { label: "Encoding", type: "choice", choices: ch(["base64", "Base64"], ["hex", "Hex"]) },
    "/name": { label: "File name (optional)" },
  },
  "post-builder": {
    "/format": {
      label: "Make a",
      type: "choice",
      choices: ch(["auto", "Reel for one video, otherwise carousel"], ["carousel", "Carousel"], ["reel", "Reel"], ["story", "Story"]),
      primary: true,
    },
    "/aspect": { label: "Carousel shape", type: "choice", choices: ch(["4:5", "4:5"], ["1:1", "1:1"], ["3:4", "3:4"], ["1.91:1", "1.91:1"]), primary: true },
    "/name": { label: "Post name" },
    "/caption": { label: "Caption", primary: true },
    "/keepLocation": { label: "Keep location and metadata" },
  },
  clipboard: {
    "/text": { label: "Text to copy", primary: true },
  },
  "object-eraser": {
    "/model": { label: "Model", type: "choice", choices: ch([EraserModel.ModelBest, "Best"], [EraserModel.ModelFast, "Fast"]), primary: true },
    "/maskId": { hidden: true },
  },
  pipelines: {
    "/pipelineId": { hidden: true },
  },

  // ── paint.tsx (Phase 19) ──
  paint: {
    "/action": { label: "What it does", type: "choice", choices: ch(["overlay", "Draw a painting over"], ["dissolve", "Dissolve with a mask"]), primary: true },
    "/project": { hidden: true },
    "/layer": { hidden: true },
    "/mask": { hidden: true },
    "/fit": { label: "Fit", type: "choice", choices: ch(["contain", "Contain"], ["cover", "Cover"], ["stretch", "Stretch"]) },
    "/passes": { label: "Passes", min: 1, max: 12, primary: true },
    "/ghost": { label: "Ghost", min: 0, max: 1 },
    "/drift": { label: "Drift", min: 0, max: 1 },
    "/seed": { label: "Seed" },
    "/model": { label: "Fill", type: "choice", choices: ch(["fast", "Fast"], ["best", "Best"]) },
  },

  // ── phase14media.tsx ──
  "photo-composer": {
    "/templateId": { hidden: true },
    "/templateName": { hidden: true },
    "/format": { label: "Save as", type: "choice", choices: ch(["", "Template's"], ["jpg", "JPEG"], ["png", "PNG"]), primary: true },
    "/scale": { label: "Size (×)", min: 0.25, max: 4, primary: true },
    "/name": { label: "File name (optional)" },
  },
  "video-studio": {
    "/templateId": { hidden: true },
    "/templateName": { hidden: true },
    "/transition": { label: "Between clips", type: "choice", choices: ch(["cut", "Cut"], ["crossfade", "Crossfade"]), primary: true },
    "/transitionMs": { label: "Crossfade lasts (ms)", min: 100, max: 2000 },
    "/title": { label: "Title (optional)", tip: "Shown over the start" },
    "/titleMs": { label: "Title shows for (ms)", min: 500, max: 10000 },
    "/music": { label: "Music (optional)", type: "file", primary: true },
    "/aspect": { label: "Shape", type: "choice", choices: ASPECTS_VIDEO, primary: true },
    "/fps": { label: "Frame rate", min: 30, max: 60, tip: "30 or 60" },
    "/height": { label: "Quality (px)", min: 720, max: 1440, tip: "720, 1080 or 1440" },
    "/stillMs": { label: "Photos show for (ms)", min: 500, max: 60000 },
    "/fit": { label: "Fit", type: "choice", choices: ch(["fill", "Fill the frame"], ["fit", "Fit inside"], ["fit-blur", "Fit on a blurred background"]) },
    "/name": { label: "File name (optional)" },
  },
  "edit-studio": {
    "/recipeId": { label: "Cutting style", type: "choice", choices: RECIPES, primary: true },
    "/seed": { label: "Seed", min: 1, max: 2147483647, tip: "The same clips and seed always give the same cut" },
    "/order": {
      label: "Clips",
      type: "choice",
      choices: ch(["recipe", "The style decides"], ["sequential", "In order"], ["shuffleNoRepeat", "Shuffled, no repeats"], ["byTag", "By tag"]),
    },
    "/song": { label: "Song (optional)", type: "file", primary: true },
    "/startMs": { label: "Start at (ms)", min: 0, max: 86400000 },
    "/lengthMs": { label: "Length (ms)", min: 1000, max: 600000, primary: true },
    "/aspect": { label: "Shape", type: "choice", choices: ASPECTS_VIDEO },
    "/fps": { label: "Frame rate", min: 30, max: 60, tip: "30 or 60" },
    "/height": { label: "Quality (px)", min: 720, max: 1440, tip: "720, 1080 or 1440" },
    "/name": { label: "File name (optional)" },
  },

  // ── documents.tsx ──
  documents: {
    "/to": {
      label: "Convert to",
      type: "choice",
      choices: ch(
        [DocumentFormat.FormatDOCX, "Word (docx)"],
        [DocumentFormat.FormatPDF, "PDF"],
        [DocumentFormat.FormatODT, "OpenDocument (odt)"],
        [DocumentFormat.FormatRTF, "Rich Text (rtf)"],
        [DocumentFormat.FormatEPUB, "EPUB"],
        [DocumentFormat.FormatHTML, "HTML"],
        [DocumentFormat.FormatMD, "Markdown"],
        [DocumentFormat.FormatGFM, "Markdown (GitHub)"],
        [DocumentFormat.FormatLaTeX, "LaTeX"],
        [DocumentFormat.FormatTypst, "Typst"],
        [DocumentFormat.FormatIPYNB, "Jupyter notebook"],
        [DocumentFormat.FormatPPTX, "PowerPoint (pptx)"],
        [DocumentFormat.FormatTXT, "Plain text"],
      ),
      primary: true,
    },
    "/pageSize": { label: "Page size", type: "choice", choices: ch(["a4", "A4"], ["letter", "Letter"]), primary: true },
    "/marginMm": { label: "Margins (mm)", min: 10, max: 50 },
    "/mainFont": { label: "Font", tip: "Empty uses the default font" },
    "/fontSizePt": { label: "Font size (pt)", min: 9, max: 16 },
    "/toc": { label: "Table of contents" },
    "/numberSections": { label: "Number sections" },
    "/referenceDoc": { label: "Style template", type: "file", tip: "A Word or OpenDocument file whose styles to use" },
    "/embedResources": { label: "Embed images and styles" },
    "/extractMedia": { label: "Save images beside the file" },
  },
  archiver: {
    "/renderJs": { label: "Render JavaScript", primary: true },
    "/noJs": { label: "No JavaScript" },
    "/noImages": { label: "No images" },
    "/alsoPdf": { label: "Also PDF", tip: "Also keeps a PDF copy (needs Edge or Chrome)", primary: true },
    "/timeoutSec": { label: "Timeout (s)", min: 10, max: 300, primary: true },
    "/allowLocal": { label: "Allow local addresses" },
  },

  // ── gif.tsx ──
  gif: {
    "/mode": { label: "Make", type: "choice", choices: ch([GifMode.ModeGIF, "GIF"], [GifMode.ModeWebP, "WebP"], [GifMode.ModeSheet, "Contact sheet"]), primary: true },
    "/startSec": { label: "Start (s)", min: 0, max: 36000 },
    "/lengthSec": { label: "Length (s)", min: 0.5, max: 30, primary: true },
    "/fps": { label: "Frames per second", min: 1, max: 30, primary: true },
    "/width": { label: "Width (px)", min: 120, max: 1280 },
    "/loop": { label: "Loop forever" },
    "/columns": { label: "Columns", min: 1, max: 10, tip: "Contact sheet" },
    "/rows": { label: "Rows", min: 1, max: 10, tip: "Contact sheet" },
    "/cellWidth": { label: "Frame width (px)", min: 120, max: 1280, tip: "Contact sheet" },
    "/labels": { label: "Timecode on each frame", tip: "Contact sheet" },
  },

  // ── imagebatch.tsx ──
  imagebatch: {
    "/resize": {
      label: "Size",
      type: "choice",
      choices: ch([BatchResize.ResizeLongSide, "Long side"], [BatchResize.ResizeExact, "Exact size"], [BatchResize.ResizeKeep, "Keep size"]),
      primary: true,
    },
    "/longSide": { label: "Long side (px)", min: SIDE_LIMITS.min, max: SIDE_LIMITS.max, primary: true },
    "/noEnlarge": { label: "Never enlarge" },
    "/width": { label: "Width (px)", min: 1, max: SIDE_LIMITS.max, tip: "For exact size" },
    "/height": { label: "Height (px)", min: 1, max: SIDE_LIMITS.max, tip: "For exact size" },
    "/aspect": {
      label: "Shape",
      type: "choice",
      choices: ch(["", "Keep each picture's own"], ["1:1", "1:1"], ["4:5", "4:5"], ["5:4", "5:4"], ["3:2", "3:2"], ["2:3", "2:3"], ["4:3", "4:3"], ["3:4", "3:4"], ["16:9", "16:9"], ["9:16", "9:16"]),
    },
    "/fit": { label: "Different shape", type: "choice", choices: ch([BatchFit.FitCrop, "Crop"], [BatchFit.FitPad, "Pad"]) },
    "/background": { label: "Pad colour", type: "color" },
    "/format": {
      label: "Format",
      type: "choice",
      choices: ch([BatchFormat.FormatJPG, "JPEG"], [BatchFormat.FormatPNG, "PNG"], [BatchFormat.FormatWebP, "WebP"], [BatchFormat.FormatSame, "Same"]),
      primary: true,
    },
    "/quality": { label: "Quality", min: 1, max: 100, primary: true },
    "/strip": { label: "Strip metadata" },
    "/watermark/kind": {
      label: "Watermark",
      type: "choice",
      choices: ch([BatchWatermarkKind.WatermarkNone, "None"], [BatchWatermarkKind.WatermarkText, "Text"], [BatchWatermarkKind.WatermarkLogo, "Logo"]),
    },
    "/watermark/text": { label: "Watermark text" },
    "/watermark/font": { label: "Watermark font" },
    "/watermark/color": { label: "Watermark colour", type: "color" },
    "/watermark/logo": { label: "Logo file", type: "file", tip: "A PNG logo" },
    "/watermark/corner": {
      label: "Corner",
      type: "choice",
      choices: ch(
        [BatchCorner.CornerBottomRight, "Bottom right"],
        [BatchCorner.CornerBottomLeft, "Bottom left"],
        [BatchCorner.CornerTopRight, "Top right"],
        [BatchCorner.CornerTopLeft, "Top left"],
        [BatchCorner.CornerCenter, "Centre"],
      ),
    },
    "/watermark/opacity": { label: "Watermark opacity", min: 0.05, max: 1, tip: "1 is solid" },
    "/watermark/size": { label: "Watermark size (%)", min: 2, max: 60, tip: "Percent of the picture" },
    "/name": { label: "File name" },
  },

  // ── organize.tsx ──
  organize: {
    "/groupBy": {
      label: "Group by",
      type: "choice",
      choices: ch([OrganizeGroupBy.GroupDate, "Date taken"], [OrganizeGroupBy.GroupType, "Type"], [OrganizeGroupBy.GroupCamera, "Camera"], [OrganizeGroupBy.GroupPattern, "Pattern"]),
      primary: true,
    },
    "/pattern": { label: "Folder pattern", tip: "For Pattern: tokens like {yyyy}/{mm}/{type}" },
    "/duplicates": {
      label: "Duplicates",
      type: "choice",
      choices: ch([OrganizeDupMode.DupOff, "Off"], [OrganizeDupMode.DupExact, "Exact"], [OrganizeDupMode.DupSimilar, "Look-alike"]),
      primary: true,
    },
    "/similarity": { label: "Similarity (%)", min: MIN_SIMILARITY, max: MAX_SIMILARITY },
    "/dupAction": {
      label: "Duplicates go",
      type: "choice",
      choices: ch([OrganizeDupAction.ActionFolder, "In a Duplicates folder"], [OrganizeDupAction.ActionSkip, "Left out"]),
    },
    "/destination": { label: "Put the result in", tip: "A folder. Empty uses Organized in your library" },
    "/runName": { label: "Folder name" },
  },

  // ── scenes.tsx ──
  scenes: {
    "/threshold": { label: "Sensitivity", min: 0.05, max: 0.9, primary: true },
    "/minSceneSecs": { label: "Shortest scene (s)", min: 0.2, max: 60 },
    "/output": {
      label: "Save",
      type: "choice",
      choices: ch([SceneOutput.OutputStills, "Stills"], [SceneOutput.OutputClips, "Clips"], [SceneOutput.OutputBoth, "Both"]),
      primary: true,
    },
    "/keep": {
      label: "Keep",
      type: "choice",
      choices: ch([SceneKeep.KeepAll, "All scenes"], [SceneKeep.KeepLongest, "The longest"], [SceneKeep.KeepActive, "The most active"]),
      primary: true,
    },
    "/keepN": { label: "How many", min: 1, max: 200 },
  },

  // ── silence.tsx ──
  silence: {
    "/thresholdDb": { label: "Silence below (dB)", min: SILENCE_LIMITS.thresholdDb.min, max: SILENCE_LIMITS.thresholdDb.max, primary: true },
    "/minSilenceMs": { label: "Shortest silence (ms)", min: SILENCE_LIMITS.minSilenceMs.min, max: SILENCE_LIMITS.minSilenceMs.max, primary: true },
    "/paddingMs": { label: "Padding (ms)", min: SILENCE_LIMITS.paddingMs.min, max: SILENCE_LIMITS.paddingMs.max },
    "/crossfadeMs": { label: "Smooth joins (ms)", min: SILENCE_LIMITS.crossfadeMs.min, max: SILENCE_LIMITS.crossfadeMs.max },
    "/cutList": { label: "Also save a cut list (.csv)" },
  },

  // ── compress.tsx ──
  compress: {
    "/targetId": { label: "Target", type: "choice", choices: ch(...STATIC_TARGETS), primary: true },
    "/targetMb": { label: "Custom size (MB)", min: COMPRESS_LIMITS.targetMb.min, max: COMPRESS_LIMITS.targetMb.max, primary: true, tip: "Used only when the target is Custom size" },
    "/ifTooSmall": { label: "If it would look bad", type: "choice", choices: ch(...TOO_SMALL_CHOICES.map((c) => [c.value, c.label] as const)) },
    "/videoCodec": { label: "Video codec", type: "choice", choices: ch(...CODEC_CHOICES.map((c) => [c.value, c.label] as const)) },
    "/maxHeight": { label: "Max video height", type: "choice", choices: ch(...MAX_HEIGHTS.map((h) => [String(h), maxHeightLabel(h)] as const)) },
    "/keepAudio": { label: "Keep sound" },
    "/imageFormat": { label: "Photo format", type: "choice", choices: ch(...IMAGE_FORMAT_CHOICES.map((c) => [c.value, c.label] as const)) },
    "/keepMetadata": { label: "Keep location & camera data" },
  },

  // ── tts.tsx ──
  tts: {
    "/voice": { label: "Voice", primary: true, tip: "A voice id such as af_heart" },
    "/speed": { label: "Speed", min: MIN_SPEED, max: MAX_SPEED, primary: true },
    "/split": { label: "Split", type: "choice", choices: ch([TtsSplit.SplitNone, "One file"], [TtsSplit.SplitHeadings, "By heading"]) },
    "/format": { label: "Format", type: "choice", choices: ch([TtsFormat.FormatMP3, "MP3"], [TtsFormat.FormatM4A, "M4A (AAC)"], [TtsFormat.FormatWAV, "WAV"]) },
  },

  // ── builtin.tsx ──
  "pipelines.rename": {
    "/template": { label: "New name", primary: true },
  },
  "llm-chat": {
    "/mode": { label: "Mode", type: "choice", choices: ch(["write", "Write text"], ["extract", "Pull out fields"]), primary: true },
    "/system": { label: "Instructions (optional)" },
    "/prompt": { label: "Prompt", primary: true },
    "/outputName": { label: "File name" },
    "/format": { label: "Save as", type: "choice", choices: ch(["md", "Markdown (.md)"], ["txt", "Plain text (.txt)"]) },
    "/saveJson": { label: "Also save a JSON file" },
    "/temperature": { label: "Creativity", min: 0, max: 1, tip: "Low is steadier; high is more varied" },
  },
  "pipelines.table": {
    "/name": { label: "File name", primary: true },
  },
  "pipelines.zip": {
    "/together": { label: "One zip for the whole run", primary: true },
    "/name": { label: "Zip name", primary: true },
  },
  "pipelines.copy": {
    "/folder": { label: "Folder", primary: true },
    "/subfolder": { label: "Subfolder (optional)" },
  },
  "pipelines.check": {},

  // ── search.tsx (Phase 20) ──
  "search-filter": {
    "/query": { label: "Keep files that show", primary: true },
    "/match": { label: "Match by", type: "choice", choices: ch(["both", "Picture or text"], ["picture", "Picture"], ["text", "Text"]) },
    "/strength": { label: "How sure", type: "choice", choices: ch(["strong", "Strong matches only"], ["good", "Good matches"], ["maybe", "Include maybes"]) },
    "/invert": { label: "Keep the ones that don't match" },
  },
  // ── captions.tsx (Phase 20) ──
  captions: {
    "/preset": { label: "Write", type: "choice", choices: ch(["posting", "For posting"], ["accessible", "Accessible"], ["catalogue", "Catalogue"], ["rename", "Rename"], ["everything", "Everything"]), primary: true },
    "/context": { label: "Context", primary: true },
    "/tone": { label: "Tone", type: "choice", choices: ch(["plain", "Plain"], ["warm", "Warm"], ["playful", "Playful"], ["professional", "Professional"], ["poetic", "Poetic"]) },
    "/length": { label: "Length", type: "choice", choices: ch(["short", "Short"], ["medium", "Medium"], ["long", "Long"]) },
    "/language": { label: "Language" },
    "/emoji": { label: "Emoji" },
    "/hashtags": { label: "Hashtags", min: 0, max: 15 },
    "/namePattern": { label: "File names", type: "choice", choices: ch(["name", "Name"], ["date-name", "Date + name"], ["number-name", "Number + name"]) },
    "/kebab": { label: "kebab-case names" },
    "/useHints": { label: "Use Smart search hints" },
    "/readText": { label: "Mention words in the picture" },
    "/then": { label: "Then", type: "choice", choices: ch(["nothing", "Just the table"], ["writeCopies", "Write into copies"], ["renameCopies", "Rename copies"]), primary: true },
    "/action": { hidden: true },
    "/model": { hidden: true },
    "/batch": { hidden: true },
    "/index": { hidden: true },
    "/keepEdited": { hidden: true },
    "/seed": { hidden: true },
    "/write/alt": { label: "Write alt text" },
    "/write/description": { label: "Write description" },
    "/write/caption": { label: "Write caption" },
    "/write/captionFrom": { hidden: true },
    "/write/title": { label: "Write title" },
    "/write/keywords": { label: "Write keywords" },
    "/write/keepLocation": { label: "Keep location data" },
  },
};

/** The old Local Chat id shares Local Chat's parameters. */
export const PARAMS: Readonly<Record<string, ParamOverrides>> = { ...BASE, "pipelines.chat": BASE["llm-chat"]! };
