import {
  Category,
  OutputKind,
  type Accepts,
  type Pipeline,
  type PipelineCheck,
  type PipelineEntry,
  type PipelineStep,
  type StepCheck,
  type StepProduct,
  type StepType,
} from "@/lib/api";

// Shared fixtures for the Pipelines page tests.

export const acc = (extensions: string[], o: Partial<Accepts> = {}): Accepts => ({ extensions, urls: false, any: false, ...o });

export const stepType = (id: string, name: string, o: Partial<StepType> = {}): StepType => ({
  id,
  moduleId: id,
  name,
  icon: "box",
  category: Category.CategoryMedia,
  description: `${name} description`,
  auto: true,
  manual: false,
  builtin: false,
  accepts: acc([".mp4", ".mp3"]),
  defaultsJson: "{}",
  ...o,
});

export const CATALOG: StepType[] = [
  stepType("pipelines.check", "Check", { builtin: true, auto: false, manual: false, accepts: acc([], { any: true }), icon: "eye" }),
  stepType("pipelines.chat", "Ask Local Chat", { builtin: true, accepts: acc([]), icon: "sparkles" }),
  stepType("downloader", "Downloader", { accepts: acc([], { urls: true }), defaultsJson: '{"format":"video"}', icon: "arrow-down-to-line" }),
  stepType("trimmer", "Video Trimmer", { manual: true, accepts: acc([".mp4"]), icon: "scissors", defaultsJson: '{"whole":true}' }),
  stepType("stems", "Stem Splitter", { category: Category.CategoryAudio, accepts: acc([".mp3", ".flac"]), icon: "layers" }),
  stepType("subtitles", "Subtitles", { manual: true, accepts: acc([".mp4", ".mp3"]), icon: "captions" }),
  stepType("pdf", "PDF Toolkit", { manual: true, category: Category.CategoryDocument, accepts: acc([".pdf"]), icon: "file-text" }),
  stepType("object-eraser", "Object Eraser", { auto: false, manual: true, category: Category.CategoryImage, accepts: acc([".png", ".jpg"]), icon: "eraser" }),
  // No step editor is registered for this one (the fallback).
  stepType("fixture-tool", "Fixture Tool", { accepts: acc([".mp3"]), icon: "box" }),
  stepType("visualizer", "Visualizer", { manual: true, accepts: acc([".mp3", ".flac"]), icon: "audio-waveform", defaultsJson: '{"presetId":"golden-hour","showJson":""}' }),
];

export const filter0 = () => ({ roles: [], kinds: [], exts: [], name: "" });

export const step = (id: string, type: string, o: Partial<PipelineStep> = {}): PipelineStep => ({
  id,
  type,
  label: "",
  optionsJson: "{}",
  from: "input",
  filter: filter0(),
  manual: false,
  autoContinue: true,
  keep: false,
  note: "",
  ...o,
});

export const pipeline = (id: string, steps: PipelineStep[], o: Partial<Pipeline> = {}): Pipeline => ({
  id,
  name: `Pipeline ${id}`,
  description: "",
  layout: "",
  templateId: "",
  steps,
  watch: { enabled: false, folder: "" },
  createdAt: 1,
  updatedAt: 1,
  ...o,
});

export const product = (role: string, exts: string[], label = role): StepProduct => ({ role, label, kind: OutputKind.KindAudio, exts, many: false });

export const stepCheck = (stepId: string, o: Partial<StepCheck> = {}, produces: StepProduct[] = []): StepCheck => ({
  stepId,
  info: {
    accepts: acc([]),
    produces,
    vars: [],
    together: false,
    noFiles: false,
    secrets: [],
    templates: [],
    warnings: [],
    summary: "",
  },
  problems: [],
  vars: [],
  ...o,
});

export const check = (steps: StepCheck[], o: Partial<PipelineCheck> = {}): PipelineCheck => ({
  steps,
  accepts: acc([], { urls: true }),
  problems: [],
  secrets: [],
  missing: [],
  ready: true,
  ...o,
});

export const entry = (p: Pipeline, c: PipelineCheck = check((p.steps ?? []).map((s) => stepCheck(s.id))), o: Partial<PipelineEntry> = {}): PipelineEntry => ({
  pipeline: p,
  check: c,
  watch: { active: false, message: "" },
  lastRun: null,
  ...o,
});
