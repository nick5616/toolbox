import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Field, SegmentedControl, Select, Slider, Stepper, Switch, TimecodeInput } from "@/components";
import {
  AudioFormat,
  AudioQuality,
  CleanupDenoise,
  CleanupFormat,
  CleanupHum,
  CleanupLoudness,
  ConverterService,
  DownloadMode,
  MaxHeight,
  MaxResolution,
  MidiRange,
  OcrImageOutput,
  OcrPdfOutput,
  OutputKind,
  StemsFormat,
  StemsPreset,
  TranscribeModel,
  TranscribeService,
  TranscribeTask,
  TrimAspect,
  TrimMode,
  TrimStepKeep,
  type AudioCleanupStepOptions,
  type ConverterOptions,
  type DownloaderOptions,
  type MidiOptions,
  type OcrOptions,
  type PresetInfo,
  type RedactStepOptions,
  type StemsOptions,
  type TranscribeOptions,
  type TrimmerStepOptions,
} from "@/lib/api";
import { OptionsPanel as RedactOptionsPanel } from "@/tools/redact/OptionsPanel";
import { DEFAULT_SETTINGS as REDACT_DEFAULTS, sanitizeSettings as sanitizeRedact } from "@/tools/redact/logic";
import { DEFAULT_OPTIONS as DOWNLOADER_DEFAULTS, sanitizeOptions as sanitizeDownloader } from "@/tools/downloader/options";
import { DEFAULT_CONVERTER_OPTIONS, presetHint, presetSelectOptions, sanitizeConverterOptions } from "@/tools/converter/options";
import { DEFAULT_CLEANUP_OPTIONS, sanitizeCleanupOptions } from "@/tools/audiocleanup/options";
import { DEFAULT_STEMS_OPTIONS, sanitizeStemsOptions } from "@/tools/stems/options";
import { DEFAULT_MIDI_OPTIONS, sanitizeMidiOptions } from "@/tools/midi/options";
import { DEFAULT_TRANSCRIBE_OPTIONS, FORMATS, sanitizeTranscribeOptions, toggleFormat } from "@/tools/transcribe/options";
import { DEFAULT_OCR_OPTIONS, FALLBACK_LANGUAGES, sanitizeOcrOptions } from "@/tools/ocr/options";
import { parseObject, registerSteps, type StepEditorProps, type StepUI } from "./registry";
import styles from "./media.module.css";

// Step editors owned by WP-AD1 (downloader, converter, trimmer, audio-cleanup, redact, stems, bpm-key, audio-to-midi, transcribe, ocr).
// Each parse() sanitises over the tool's defaults and never throws.

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.row}>
      <span className={styles.label}>{label}</span>
      <div className={styles.control}>{children}</div>
    </div>
  );
}

function oneOf<T extends string>(enumObj: Record<string, T>, v: unknown): T | undefined {
  return typeof v === "string" && v !== "" && Object.values(enumObj).includes(v as T) ? (v as T) : undefined;
}

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

// ---- downloader ----

const STEP_DOWNLOADER_DEFAULTS: DownloaderOptions = { ...DOWNLOADER_DEFAULTS, playlist: false };

function parseDownloader(json: string): DownloaderOptions {
  // Trimming is the Trimmer step's job, so it is never on here.
  return { ...sanitizeDownloader(parseObject(json), STEP_DOWNLOADER_DEFAULTS), trimEnabled: false, trimStart: "", trimEnd: "" };
}

const QUALITIES = [
  { value: AudioQuality.QualityBest, label: "Best (V0)" },
  { value: AudioQuality.Quality320, label: "320 kbps" },
  { value: AudioQuality.Quality256, label: "256 kbps" },
  { value: AudioQuality.Quality192, label: "192 kbps" },
  { value: AudioQuality.Quality128, label: "128 kbps" },
];

const RESOLUTIONS = [
  { value: MaxResolution.ResBest, label: "Best" },
  { value: MaxResolution.Res2160, label: "2160p" },
  { value: MaxResolution.Res1440, label: "1440p" },
  { value: MaxResolution.Res1080, label: "1080p" },
  { value: MaxResolution.Res720, label: "720p" },
  { value: MaxResolution.Res480, label: "480p" },
  { value: MaxResolution.Res360, label: "360p" },
];

function DownloaderEditor({ value, onChange }: StepEditorProps<DownloaderOptions>) {
  const set = (patch: Partial<DownloaderOptions>) => onChange({ ...value, ...patch });
  const audio = value.mode === DownloadMode.ModeAudio;
  const wav = audio && value.audioFormat === AudioFormat.FormatWAV;
  return (
    <div className={styles.stack}>
      <Row label="Download">
        <SegmentedControl
          aria-label="Mode"
          value={value.mode}
          onChange={(mode) => set({ mode })}
          options={[
            { value: DownloadMode.ModeAudio, label: "Audio" },
            { value: DownloadMode.ModeVideo, label: "Video" },
          ]}
        />
      </Row>
      {audio ? (
        <>
          <Row label="Format">
            <SegmentedControl
              aria-label="Audio format"
              value={value.audioFormat}
              onChange={(audioFormat) => set({ audioFormat })}
              options={[
                { value: AudioFormat.FormatMP3, label: "mp3" },
                { value: AudioFormat.FormatWAV, label: "wav" },
                { value: AudioFormat.FormatFLAC, label: "flac" },
              ]}
            />
          </Row>
          {value.audioFormat === AudioFormat.FormatMP3 && (
            <Row label="Quality">
              <Select aria-label="Quality" value={value.audioQuality} onChange={(audioQuality) => set({ audioQuality })} options={QUALITIES} />
            </Row>
          )}
        </>
      ) : (
        <Row label="Max resolution">
          <Select aria-label="Max resolution" value={value.maxResolution} onChange={(maxResolution) => set({ maxResolution })} options={RESOLUTIONS} />
        </Row>
      )}
      <Row label="Embed">
        <Switch checked={value.embedMetadata} onChange={(embedMetadata) => set({ embedMetadata })} label="Metadata" />
        <Switch checked={value.embedThumbnail && !wav} disabled={wav} onChange={(embedThumbnail) => set({ embedThumbnail })} label="Thumbnail" />
      </Row>
      <Row label="Playlists">
        <Switch checked={value.playlist} onChange={(playlist) => set({ playlist })} label="Download the whole playlist when a link is one" />
      </Row>
    </div>
  );
}

// ---- converter ----

function parseConverter(json: string): ConverterOptions {
  return sanitizeConverterOptions(parseObject(json), DEFAULT_CONVERTER_OPTIONS);
}

const HEIGHTS: { value: MaxHeight; label: string }[] = [
  { value: MaxHeight.HeightKeep, label: "Keep original" },
  { value: MaxHeight.Height2160, label: "2160p" },
  { value: MaxHeight.Height1440, label: "1440p" },
  { value: MaxHeight.Height1080, label: "1080p" },
  { value: MaxHeight.Height720, label: "720p" },
  { value: MaxHeight.Height480, label: "480p" },
];

function ConverterEditor({ value, onChange }: StepEditorProps<ConverterOptions>) {
  const [presets, setPresets] = useState<PresetInfo[]>([]);
  useEffect(() => {
    let cancelled = false;
    ConverterService.Presets()
      .then((p) => {
        if (!cancelled) setPresets(p ?? []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  const set = (patch: Partial<ConverterOptions>) => onChange({ ...value, ...patch });
  const preset = presets.find((p) => p.id === value.preset);
  const options = useMemo(() => {
    const list = presetSelectOptions(presets);
    return list.some((o) => o.value === value.preset) ? list : [{ value: value.preset, label: value.preset }, ...list];
  }, [presets, value.preset]);
  const hasHeight = preset?.kind === OutputKind.KindVideo || preset?.kind === OutputKind.KindImage;
  return (
    <div className={styles.stack}>
      <Field label="Format" hint={presetHint(preset)}>
        {(c) => <Select {...c} value={value.preset} options={options} onChange={(p) => set({ preset: p })} />}
      </Field>
      {hasHeight && (
        <Row label="Max height">
          <Select aria-label="Max height" value={value.maxHeight} options={HEIGHTS} onChange={(maxHeight) => set({ maxHeight })} />
        </Row>
      )}
      <Switch checked={value.keepMetadata} onChange={(keepMetadata) => set({ keepMetadata })} label="Keep metadata" />
    </div>
  );
}

// ---- trimmer ----

const DEFAULT_TRIM: TrimmerStepOptions = {
  keep: TrimStepKeep.KeepWhole,
  seconds: 30,
  from: "",
  to: "",
  mode: TrimMode.ModePrecise,
  aspect: TrimAspect.AspectKeep,
  cropX: 0.5,
  cropY: 0.5,
  maxSizeMB: 0,
  maxHeight: 0,
  removeAudio: false,
};

const TRIM_HEIGHTS = [0, 2160, 1440, 1080, 720, 480];

function parseTrimmer(json: string): TrimmerStepOptions {
  const r = parseObject(json);
  const d = DEFAULT_TRIM;
  const mode = oneOf(TrimMode, r.mode) ?? d.mode;
  const aspect = mode === TrimMode.ModeFast ? TrimAspect.AspectKeep : (oneOf(TrimAspect, r.aspect) ?? d.aspect);
  const size = Math.round(clampNum(r.maxSizeMB, 0, 4000, 0));
  const height = typeof r.maxHeight === "number" && TRIM_HEIGHTS.includes(r.maxHeight) ? r.maxHeight : 0;
  return {
    keep: oneOf(TrimStepKeep, r.keep) ?? d.keep,
    seconds: clampNum(r.seconds, 1, 36000, d.seconds),
    from: typeof r.from === "string" ? r.from : "",
    to: typeof r.to === "string" ? r.to : "",
    mode,
    aspect,
    cropX: clampNum(r.cropX, 0, 1, d.cropX),
    cropY: clampNum(r.cropY, 0, 1, d.cropY),
    maxSizeMB: mode === TrimMode.ModeFast ? 0 : size,
    maxHeight: mode === TrimMode.ModeFast ? 0 : height,
    removeAudio: typeof r.removeAudio === "boolean" ? r.removeAudio : false,
  };
}

function TrimmerEditor({ value, onChange }: StepEditorProps<TrimmerStepOptions>) {
  const set = (patch: Partial<TrimmerStepOptions>) => onChange({ ...value, ...patch });
  const precise = value.mode === TrimMode.ModePrecise;
  return (
    <div className={styles.stack}>
      <Row label="Keep">
        <SegmentedControl
          aria-label="Keep"
          value={value.keep}
          onChange={(keep) => set({ keep })}
          options={[
            { value: TrimStepKeep.KeepWhole, label: "Whole file" },
            { value: TrimStepKeep.KeepFirst, label: "First…" },
            { value: TrimStepKeep.KeepLast, label: "Last…" },
            { value: TrimStepKeep.KeepRange, label: "From–To" },
          ]}
        />
      </Row>
      {(value.keep === TrimStepKeep.KeepFirst || value.keep === TrimStepKeep.KeepLast) && (
        <Row label="Seconds">
          <Stepper aria-label="Seconds to keep" value={value.seconds} min={1} max={36000} unit="s" onChange={(seconds) => set({ seconds })} />
        </Row>
      )}
      {value.keep === TrimStepKeep.KeepRange && (
        <div className={styles.pair}>
          <Field label="From" hint="Empty = the start">
            {(c) => <TimecodeInput {...c} value={value.from} onChange={(from) => set({ from })} placeholder="0:00" />}
          </Field>
          <Field label="To" hint="Empty = the end">
            {(c) => <TimecodeInput {...c} value={value.to} onChange={(to) => set({ to })} placeholder="end" />}
          </Field>
        </div>
      )}
      <Row label="Mode">
        <SegmentedControl
          aria-label="Mode"
          value={value.mode}
          onChange={(mode) =>
            onChange(mode === TrimMode.ModeFast ? { ...value, mode, aspect: TrimAspect.AspectKeep, maxSizeMB: 0, maxHeight: 0 } : { ...value, mode })
          }
          options={[
            { value: TrimMode.ModePrecise, label: "Precise" },
            { value: TrimMode.ModeFast, label: "Fast (no re-encode)" },
          ]}
        />
      </Row>
      {precise && (
        <>
          <Row label="Frame">
            <SegmentedControl
              aria-label="Frame"
              size="sm"
              value={value.aspect}
              onChange={(aspect) => set({ aspect })}
              options={[
                { value: TrimAspect.AspectKeep, label: "Keep" },
                { value: TrimAspect.AspectPortrait, label: "9:16" },
                { value: TrimAspect.AspectSquare, label: "1:1" },
                { value: TrimAspect.AspectFourFive, label: "4:5" },
                { value: TrimAspect.AspectWide, label: "16:9" },
              ]}
            />
          </Row>
          {value.aspect !== TrimAspect.AspectKeep && (
            <>
              <Row label="Crop across">
                <Slider aria-label="Crop centre across" min={0} max={1} step={0.01} value={value.cropX} onChange={(cropX) => set({ cropX })} format={(v) => `${Math.round(v * 100)}%`} />
              </Row>
              <Row label="Crop down">
                <Slider aria-label="Crop centre down" min={0} max={1} step={0.01} value={value.cropY} onChange={(cropY) => set({ cropY })} format={(v) => `${Math.round(v * 100)}%`} />
              </Row>
            </>
          )}
          <Row label="Max size">
            <Stepper aria-label="Max size" value={value.maxSizeMB} min={0} max={4000} unit="MB (0 = no limit)" onChange={(maxSizeMB) => set({ maxSizeMB })} />
          </Row>
          <Row label="Max height">
            <Select
              aria-label="Max height"
              value={String(value.maxHeight)}
              onChange={(v) => set({ maxHeight: Number(v) })}
              options={TRIM_HEIGHTS.map((h) => ({ value: String(h), label: h === 0 ? "Keep original" : `${h}p` }))}
            />
          </Row>
        </>
      )}
      <Switch checked={value.removeAudio} onChange={(removeAudio) => set({ removeAudio })} label="Remove the audio" />
    </div>
  );
}

// ---- audio cleanup ----

function parseCleanup(json: string): AudioCleanupStepOptions {
  const o = sanitizeCleanupOptions(parseObject(json), DEFAULT_CLEANUP_OPTIONS);
  return { highPass: o.highPass, hum: o.hum, denoise: o.denoise, loudness: o.loudness, format: o.format };
}

function CleanupEditor({ value, onChange }: StepEditorProps<AudioCleanupStepOptions>) {
  const set = (patch: Partial<AudioCleanupStepOptions>) => onChange({ ...value, ...patch });
  return (
    <div className={styles.stack}>
      <Row label="Rumble">
        <Switch checked={value.highPass} onChange={(highPass) => set({ highPass })} label="Cut rumble below 80 Hz" />
      </Row>
      <Row label="Hum">
        <SegmentedControl
          aria-label="Hum"
          size="sm"
          value={value.hum}
          onChange={(hum) => set({ hum })}
          options={[
            { value: CleanupHum.HumAuto, label: "Auto" },
            { value: CleanupHum.Hum50, label: "50 Hz" },
            { value: CleanupHum.Hum60, label: "60 Hz" },
            { value: CleanupHum.HumOff, label: "Off" },
          ]}
        />
      </Row>
      <Row label="Noise">
        <SegmentedControl
          aria-label="Noise reduction"
          size="sm"
          value={value.denoise}
          onChange={(denoise) => set({ denoise })}
          options={[
            { value: CleanupDenoise.DenoiseOff, label: "Off" },
            { value: CleanupDenoise.DenoiseLight, label: "Light" },
            { value: CleanupDenoise.DenoiseStrong, label: "Strong" },
            { value: CleanupDenoise.DenoiseVoice, label: "Voice isolation (AI)" },
          ]}
        />
      </Row>
      <Row label="Loudness">
        <SegmentedControl
          aria-label="Loudness"
          size="sm"
          value={value.loudness}
          onChange={(loudness) => set({ loudness })}
          options={[
            { value: CleanupLoudness.LoudnessOff, label: "Off" },
            { value: CleanupLoudness.LoudnessPodcast, label: "Podcast" },
            { value: CleanupLoudness.LoudnessStreaming, label: "Streaming" },
            { value: CleanupLoudness.LoudnessBroadcast, label: "Broadcast" },
          ]}
        />
      </Row>
      <Row label="Format">
        <Select
          aria-label="Format"
          value={value.format}
          onChange={(format) => set({ format })}
          options={[
            { value: CleanupFormat.FormatSame, label: "Same as the file (videos keep their container)" },
            { value: CleanupFormat.FormatWAV, label: "WAV" },
            { value: CleanupFormat.FormatFLAC, label: "FLAC" },
            { value: CleanupFormat.FormatMP3, label: "MP3" },
            { value: CleanupFormat.FormatM4A, label: "M4A" },
          ]}
        />
      </Row>
    </div>
  );
}

// ---- redact ----

function parseRedact(json: string): RedactStepOptions {
  return sanitizeRedact(parseObject(json), REDACT_DEFAULTS);
}

function RedactEditor({ value, onChange }: StepEditorProps<RedactStepOptions>) {
  return <RedactOptionsPanel part="all" settings={value} onChange={(patch) => onChange({ ...value, ...patch })} />;
}

// ---- stems ----

function parseStems(json: string): StemsOptions {
  return sanitizeStemsOptions(parseObject(json), DEFAULT_STEMS_OPTIONS);
}

function StemsEditor({ value, onChange }: StepEditorProps<StemsOptions>) {
  const set = (patch: Partial<StemsOptions>) => onChange({ ...value, ...patch });
  return (
    <div className={styles.stack}>
      <Row label="Split into">
        <Select
          aria-label="Preset"
          value={value.preset}
          onChange={(preset) => set({ preset })}
          options={[
            { value: StemsPreset.PresetFourFast, label: "4 stems · fast" },
            { value: StemsPreset.PresetFourBest, label: "4 stems · best" },
            { value: StemsPreset.PresetVocalsFast, label: "Vocals + instrumental · fast" },
            { value: StemsPreset.PresetVocalsBest, label: "Vocals + instrumental · best" },
          ]}
        />
      </Row>
      <Row label="Format">
        <SegmentedControl
          aria-label="Format"
          value={value.format}
          onChange={(format) => set({ format })}
          options={[
            { value: StemsFormat.FormatFLAC, label: "FLAC" },
            { value: StemsFormat.FormatWAV, label: "WAV" },
            { value: StemsFormat.FormatMP3, label: "MP3" },
          ]}
        />
      </Row>
    </div>
  );
}

// ---- bpm & key ----

type NoOptions = Record<string, never>;

function BpmKeyEditor(_props: StepEditorProps<NoOptions>) {
  return (
    <p className={styles.note}>
      Finds the tempo and key of each file. It makes no files; it adds the variables <code>{"{bpm}"}</code>, <code>{"{bpm_exact}"}</code>,{" "}
      <code>{"{key}"}</code>, <code>{"{key_short}"}</code> and <code>{"{camelot}"}</code> for later steps, for example to rename files.
    </p>
  );
}

// ---- audio to midi ----

function parseMidi(json: string): MidiOptions {
  return sanitizeMidiOptions(parseObject(json), DEFAULT_MIDI_OPTIONS);
}

function MidiEditor({ value, onChange }: StepEditorProps<MidiOptions>) {
  const set = (patch: Partial<MidiOptions>) => onChange({ ...value, ...patch });
  return (
    <div className={styles.stack}>
      <Row label="Pitch range">
        <SegmentedControl
          aria-label="Pitch range"
          value={value.range}
          onChange={(range) => set({ range })}
          options={[
            { value: MidiRange.RangeFull, label: "Full" },
            { value: MidiRange.RangeBass, label: "Bass" },
            { value: MidiRange.RangeMelody, label: "Melody" },
          ]}
        />
      </Row>
      <Row label="Sensitivity">
        <Slider aria-label="Sensitivity" min={0.1} max={0.9} step={0.05} value={value.sensitivity} onChange={(sensitivity) => set({ sensitivity })} format={(v) => v.toFixed(2)} />
      </Row>
      <Row label="Note floor">
        <Slider aria-label="Note floor" min={0.1} max={0.6} step={0.05} value={value.noteFloor} onChange={(noteFloor) => set({ noteFloor })} format={(v) => v.toFixed(2)} />
      </Row>
      <Row label="Shortest note">
        <Slider aria-label="Shortest note" min={30} max={500} step={10} value={value.minNoteMs} onChange={(minNoteMs) => set({ minNoteMs })} format={(v) => `${Math.round(v)} ms`} />
      </Row>
      <Switch checked={value.melodiaTrick} onChange={(melodiaTrick) => set({ melodiaTrick })} label="Smooth held notes" />
    </div>
  );
}

// ---- transcribe ----

function parseTranscribe(json: string): TranscribeOptions {
  return sanitizeTranscribeOptions(parseObject(json), DEFAULT_TRANSCRIBE_OPTIONS);
}

function TranscribeEditor({ value, onChange }: StepEditorProps<TranscribeOptions>) {
  const [languages, setLanguages] = useState<{ code: string; name: string }[]>([]);
  useEffect(() => {
    let cancelled = false;
    TranscribeService.Languages()
      .then((l) => {
        if (!cancelled) setLanguages(l ?? []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  const set = (patch: Partial<TranscribeOptions>) => onChange({ ...value, ...patch });
  const langOptions = useMemo(() => {
    const list = [{ value: "", label: "Auto-detect" }, ...languages.map((l) => ({ value: l.code, label: l.name }))];
    return list.some((o) => o.value === value.language) ? list : [...list, { value: value.language, label: value.language }];
  }, [languages, value.language]);
  return (
    <div className={styles.stack}>
      <Row label="Model">
        <SegmentedControl
          aria-label="Model"
          value={value.model}
          onChange={(model) => set({ model })}
          options={[
            { value: TranscribeModel.ModelBase, label: "Base" },
            { value: TranscribeModel.ModelSmall, label: "Small" },
            { value: TranscribeModel.ModelTurbo, label: "Turbo" },
          ]}
        />
      </Row>
      <Row label="Language">
        <Select aria-label="Language" value={value.language} onChange={(language) => set({ language })} options={langOptions} />
      </Row>
      <Row label="Task">
        <SegmentedControl
          aria-label="Task"
          value={value.task}
          onChange={(task) => set({ task })}
          options={[
            { value: TranscribeTask.TaskTranscribe, label: "Transcribe" },
            { value: TranscribeTask.TaskTranslate, label: "Translate to English" },
          ]}
        />
      </Row>
      <Row label="Files to make">
        {FORMATS.map((f) => (
          <Switch
            key={f}
            checked={(value.formats ?? []).includes(f)}
            onChange={() => set({ formats: toggleFormat(value.formats, f) })}
            label={f.toUpperCase()}
          />
        ))}
      </Row>
      <Switch checked={value.vad} onChange={(vad) => set({ vad })} label="Skip silence" />
    </div>
  );
}

// ---- ocr ----

function parseOcr(json: string): OcrOptions {
  return sanitizeOcrOptions(parseObject(json), DEFAULT_OCR_OPTIONS);
}

function OcrEditor({ value, onChange }: StepEditorProps<OcrOptions>) {
  const set = (patch: Partial<OcrOptions>) => onChange({ ...value, ...patch });
  return (
    <div className={styles.stack}>
      <Row label="Language">
        <Select aria-label="Language" value={value.language} onChange={(language) => set({ language })} options={FALLBACK_LANGUAGES.map((l) => ({ value: l.id, label: l.label }))} />
      </Row>
      <Row label="PDFs">
        <Select
          aria-label="PDF output"
          value={value.pdfOutput}
          onChange={(pdfOutput) => set({ pdfOutput })}
          options={[
            { value: OcrPdfOutput.PDFSearchable, label: "Searchable PDF" },
            { value: OcrPdfOutput.PDFText, label: "Text file" },
            { value: OcrPdfOutput.PDFBoth, label: "Both" },
          ]}
        />
      </Row>
      <Row label="Images">
        <Select
          aria-label="Image output"
          value={value.imageOutput}
          onChange={(imageOutput) => set({ imageOutput })}
          options={[
            { value: OcrImageOutput.ImageText, label: "Text file" },
            { value: OcrImageOutput.ImageJSON, label: "Text with positions (JSON)" },
          ]}
        />
      </Row>
      <Switch checked={value.skipText} onChange={(skipText) => set({ skipText })} label="Skip PDF pages that already have text" />
    </div>
  );
}

// registerSteps takes StepUI<never> (the registry stores them untyped), so each typed pair is widened here.
const ui = <T,>(type: string, parse: (json: string) => T, Editor: StepUI<T>["Editor"]): StepUI<never> =>
  ({ type, parse, Editor }) as unknown as StepUI<never>;

registerSteps([
  ui<DownloaderOptions>("downloader", parseDownloader, DownloaderEditor),
  ui<ConverterOptions>("converter", parseConverter, ConverterEditor),
  ui<TrimmerStepOptions>("trimmer", parseTrimmer, TrimmerEditor),
  ui<AudioCleanupStepOptions>("audio-cleanup", parseCleanup, CleanupEditor),
  ui<RedactStepOptions>("redact", parseRedact, RedactEditor),
  ui<StemsOptions>("stems", parseStems, StemsEditor),
  ui<NoOptions>("bpm-key", () => ({}), BpmKeyEditor),
  ui<MidiOptions>("audio-to-midi", parseMidi, MidiEditor),
  ui<TranscribeOptions>("transcribe", parseTranscribe, TranscribeEditor),
  ui<OcrOptions>("ocr", parseOcr, OcrEditor),
]);
