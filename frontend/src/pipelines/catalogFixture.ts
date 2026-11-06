import { Category, ModuleStatus, type Accepts, type Descriptor, type StepType } from "@/lib/api";
import { normalizeModule, type ModuleView } from "@/state/modules";

// A fixture that mirrors the Go app's module list and pipeline step catalogue
// (core/pipeline/catalog.go, each module's Descriptor and StepProvider). The
// proof test (everyTool.test.tsx) checks the frontend against it: every tool in
// the sidebar has a step editor and is in the Pipelines palette. The Go side is
// proved by TestEveryToolIsAPipelineStep. When a tool is added or renamed
// there, change it here too.

const acc = (extensions: string[], o: Partial<Accepts> = {}): Accepts => ({ extensions, urls: false, any: false, ...o });

interface Tool {
  id: string;
  name: string;
  category: Category;
  order: number;
  accepts?: Accepts;
  hidden?: boolean;
  jobLess?: boolean;
  base?: string;
  /** Module-level step id when it differs from the module id (never in the Go app today). */
  stepId?: string;
}

const TOOLS: Tool[] = [
  { id: "downloader", name: "Downloader", category: Category.CategoryMedia, order: 10, accepts: acc([], { urls: true }) },
  { id: "converter", name: "Converter", category: Category.CategoryMedia, order: 11, accepts: acc([".mp4", ".mp3"]) },
  { id: "trimmer", name: "Video Trimmer", category: Category.CategoryMedia, order: 12, accepts: acc([".mp4"]) },
  { id: "scenes", name: "Scene Splitter", category: Category.CategoryMedia, order: 138, accepts: acc([".mp4"]) },
  { id: "gif", name: "GIF & Contact Sheet", category: Category.CategoryMedia, order: 139, accepts: acc([".mp4"]) },
  { id: "tts", name: "Text to Speech", category: Category.CategoryAudio, order: 150, accepts: acc([".txt", ".md"]) },
  { id: "silence", name: "Silence Cutter", category: Category.CategoryMedia, order: 140, accepts: acc([".mp4", ".mp3"]) },
  { id: "focus", name: "Focus Lock", category: Category.CategoryUtility, order: 235, accepts: acc([], { any: true }) },
  { id: "compress", name: "Compress to Size", category: Category.CategoryUtility, order: 225, accepts: acc([], { any: true }) },
  { id: "subtitles", name: "Subtitles", category: Category.CategoryMedia, order: 13, accepts: acc([".mp4", ".mp3"]), base: "transcribe" },
  { id: "video-studio", name: "Video Editor", category: Category.CategoryMedia, order: 14, accepts: acc([".mp4", ".jpg"]) },
  { id: "edit-studio", name: "Edit Studio", category: Category.CategoryMedia, order: 15, accepts: acc([".mp4", ".mp3"]), base: "video-studio" },
  { id: "post-builder", name: "Post Builder", category: Category.CategoryMedia, order: 17, accepts: acc([".jpg", ".mp4"]) },
  { id: "video-editor", name: "Sequence Editor", category: Category.CategoryMedia, order: 16, hidden: true, accepts: acc([".mp4"]) },
  { id: "audio-cleanup", name: "Audio Cleanup", category: Category.CategoryAudio, order: 20, accepts: acc([".mp3", ".wav"]) },
  { id: "stems", name: "Stem Splitter", category: Category.CategoryAudio, order: 21, accepts: acc([".mp3", ".flac"]) },
  { id: "bpm-key", name: "BPM & Key", category: Category.CategoryAudio, order: 22, accepts: acc([".mp3", ".flac"]) },
  { id: "audio-to-midi", name: "Audio → MIDI", category: Category.CategoryAudio, order: 23, accepts: acc([".mp3", ".flac"]) },
  { id: "lyric-video", name: "Lyric Video", category: Category.CategoryAudio, order: 24, accepts: acc([".mp3", ".flac"]) },
  { id: "visualizer", name: "Visualizer", category: Category.CategoryAudio, order: 25, accepts: acc([".mp3", ".flac"]) },
  { id: "transcribe", name: "Transcribe", category: Category.CategoryAI, order: 30, accepts: acc([".mp3", ".mp4"]) },
  { id: "bg-remover", name: "Background Remover", category: Category.CategoryImage, order: 40, accepts: acc([".png", ".jpg"]) },
  { id: "upscaler", name: "Upscaler", category: Category.CategoryImage, order: 41, accepts: acc([".png", ".jpg"]) },
  { id: "exif", name: "EXIF", category: Category.CategoryImage, order: 42, accepts: acc([".jpg"]) },
  { id: "redact", name: "Redact", category: Category.CategoryImage, order: 43, accepts: acc([".png", ".mp4"]) },
  { id: "object-eraser", name: "Object Eraser", category: Category.CategoryImage, order: 44, accepts: acc([".png", ".jpg"]) },
  { id: "photo-composer", name: "Photo Composer", category: Category.CategoryImage, order: 45, accepts: acc([".png", ".jpg"]) },
  { id: "paint", name: "Paint+", category: Category.CategoryImage, order: 11, accepts: acc([".png", ".jpg", ".ora"]) },
  { id: "pdf", name: "PDF Toolkit", category: Category.CategoryDocument, order: 50, accepts: acc([".pdf"]) },
  { id: "ocr", name: "OCR", category: Category.CategoryDocument, order: 51, accepts: acc([".pdf", ".png"]) },
  { id: "documents", name: "Document Converter", category: Category.CategoryUtility, order: 60, accepts: acc([".docx", ".md"]) },
  { id: "archiver", name: "Web Archiver", category: Category.CategoryUtility, order: 61, accepts: acc([], { urls: true }) },
  { id: "vault", name: "Vault", category: Category.CategoryUtility, order: 62, accepts: acc([], { any: true }) },
  { id: "imagebatch", name: "Image Batch", category: Category.CategoryImage, order: 47, accepts: acc([".png", ".jpg"]) },
  { id: "organize", name: "Organizer", category: Category.CategoryImage, order: 48, accepts: acc([], { any: true }) },
  { id: "lan-share", name: "Local File Transfer", category: Category.CategoryUtility, order: 49, accepts: acc([], { any: true }) },
  { id: "dev-utils", name: "Dev Utilities", category: Category.CategoryUtility, order: 63, accepts: acc([]) },
  { id: "clipboard", name: "Clipboard History", category: Category.CategoryUtility, order: 64, jobLess: true, accepts: acc([]) },
  { id: "llm-chat", name: "Local Chat", category: Category.CategoryAI, order: 65, jobLess: true, accepts: acc([]) },
  { id: "pipelines", name: "Pipelines", category: Category.CategoryUtility, order: 0, accepts: acc([]) },
  // Hidden system modules whose jobs run the steps of job-less tools.
  { id: "clipboard-copy", name: "Clipboard copy", category: Category.CategoryUtility, order: 99, hidden: true, jobLess: false },
  { id: "system-chat-model", name: "Chat model", category: Category.CategoryAI, order: 99, hidden: true },
];

/** The app's modules as `useModules` holds them. */
export const GO_MODULES: ModuleView[] = TOOLS.map((t) =>
  normalizeModule({
    id: t.id,
    name: t.name,
    tagline: `${t.name} tagline`,
    description: "",
    icon: "box",
    category: t.category,
    status: ModuleStatus.StatusReady,
    accepts: t.accepts ?? acc([]),
    requires: null,
    recommends: null,
    outputSubdir: "",
    order: t.order,
    hidden: !!t.hidden,
    jobLess: !!t.jobLess,
    maxInputs: 0,
    ...(t.base ? { base: t.base } : {}),
  } as Descriptor),
);

/**
 * Each step type's `StepDefaults` as the Go app returns them (dumped from the registered modules; the
 * parameter tests derive their parameters from these). Refresh when a module's defaults change.
 */
export const STEP_DEFAULTS: Record<string, string> = {
  "archiver": "{\"urls\":[],\"renderJs\":false,\"noJs\":false,\"noImages\":false,\"alsoPdf\":false,\"timeoutSec\":60,\"allowLocal\":false}",
  "audio-cleanup": "{\"highPass\":true,\"hum\":\"auto\",\"denoise\":\"voice\",\"loudness\":\"podcast\",\"format\":\"same\"}",
  "audio-to-midi": "{\"sensitivity\":0.5,\"noteFloor\":0.3,\"minNoteMs\":127.7,\"range\":\"full\",\"melodiaTrick\":true}",
  "bg-remover": "{\"model\":\"balanced\",\"output\":\"transparent\",\"color\":\"#ffffff\",\"crop\":false,\"padding\":24,\"cleanEdges\":true,\"refine\":false}",
  "bpm-key": "{}",
  "clipboard": "{\"text\":\"\"}",
  "converter": "{\"preset\":\"mp3-320\",\"maxHeight\":\"keep\",\"keepMetadata\":true}",
  "dev-utils": "{\"action\":\"checksums\",\"format\":\"sidecar\",\"algorithms\":[\"sha256\",\"sha1\",\"md5\"],\"encoding\":\"base64\",\"name\":\"\"}",
  "documents": "{\"to\":\"docx\",\"pageSize\":\"a4\",\"marginMm\":25,\"mainFont\":\"\",\"fontSizePt\":11,\"toc\":false,\"numberSections\":false,\"referenceDoc\":\"\",\"embedResources\":true,\"extractMedia\":false}",
  "downloader": "{\"mode\":\"audio\",\"audioFormat\":\"mp3\",\"audioQuality\":\"320\",\"maxResolution\":\"1080\",\"trimEnabled\":false,\"trimStart\":\"\",\"trimEnd\":\"\",\"embedMetadata\":true,\"embedThumbnail\":true,\"playlist\":false}",
  "edit-studio": "{\"recipeId\":\"downbeat\",\"seed\":1,\"order\":\"recipe\",\"song\":\"\",\"startMs\":0,\"lengthMs\":30000,\"aspect\":\"9:16\",\"fps\":30,\"height\":1080,\"name\":\"\"}",
  "exif": "{\"action\":\"strip-location\",\"keepOrientation\":true,\"fields\":{}}",
  "focus": "{\"action\":\"start\",\"profileId\":\"\",\"mode\":\"for\",\"minutes\":50,\"at\":\"17:00\",\"strength\":\"firm\",\"extra\":[],\"onStart\":\"close\",\"ifActive\":\"extend\"}",
  "gif": "{\"mode\":\"gif\",\"startSec\":0,\"lengthSec\":5,\"fps\":12,\"width\":480,\"loop\":true,\"columns\":4,\"rows\":4,\"cellWidth\":320,\"labels\":true}",
  "imagebatch": "{\"resize\":\"longSide\",\"longSide\":2048,\"noEnlarge\":true,\"width\":1080,\"height\":1080,\"aspect\":\"\",\"fit\":\"crop\",\"background\":\"#ffffff\",\"format\":\"jpg\",\"quality\":85,\"strip\":true,\"watermark\":{\"kind\":\"none\",\"text\":\"\",\"font\":\"Arial\",\"color\":\"#ffffff\",\"logo\":\"\",\"corner\":\"br\",\"opacity\":0.6,\"size\":5},\"name\":\"{name}\"}",
  "llm-chat": "{\"mode\":\"write\",\"system\":\"\",\"prompt\":\"\",\"fields\":[],\"outputName\":\"{item} (notes)\",\"format\":\"md\",\"saveJson\":false,\"temperature\":0.3}",
  "lyric-video": "{\"language\":\"\",\"look\":{\"background\":\"blur-cover\",\"backgroundPath\":\"\",\"color1\":\"#1b1f2a\",\"color2\":\"#3a2f5b\",\"font\":\"Arial\",\"textColor\":\"#ffffff\",\"highlightColor\":\"#ffd166\",\"karaoke\":true,\"position\":\"center\",\"showNext\":true,\"visualizer\":\"none\",\"titleCard\":true,\"title\":\"{item}\",\"artist\":\"\",\"visuals\":{\"showJson\":\"\",\"stems\":false,\"useWords\":false}},\"audio\":\"original\",\"aspect\":\"16:9\",\"height\":1080}",
  "object-eraser": "{\"model\":\"best\",\"maskId\":\"\"}",
  "paint": "{\"action\":\"overlay\",\"project\":\"\",\"layer\":\"\",\"mask\":\"\",\"fit\":\"contain\",\"passes\":6,\"ghost\":0.3,\"drift\":0.5,\"seed\":1,\"model\":\"fast\"}",
  "ocr": "{\"language\":\"latin\",\"pdfOutput\":\"searchable\",\"imageOutput\":\"text\",\"skipText\":true}",
  "lan-share": "{\"device\":\"\",\"waitMinutes\":30,\"text\":\"\"}",
  "organize": "{\"groupBy\":\"date\",\"pattern\":\"{yyyy}/{mm}/{type}\",\"duplicates\":\"exact\",\"similarity\":90,\"dupAction\":\"folder\",\"destination\":\"\",\"runName\":\"\"}",
  "pdf": "{\"action\":\"merge\",\"every\":1,\"level\":\"balanced\",\"pageSize\":\"a4\",\"margin\":\"small\",\"imageFormat\":\"png\",\"dpi\":150}",
  "photo-composer": "{\"templateId\":\"\",\"templateName\":\"\",\"format\":\"\",\"scale\":1,\"name\":\"\"}",
  "pipelines": "{\"pipelineId\":\"\"}",
  "pipelines.check": "{}",
  "pipelines.open": "{\"app\":\"\",\"label\":\"\",\"args\":[],\"files\":\"none\",\"window\":\"normal\",\"closeWhen\":\"never\"}",
  "pipelines.wait": "{\"mode\":\"for\",\"minutes\":25,\"at\":\"17:00\",\"note\":\"\"}",
  "pipelines.copy": "{\"folder\":\"\",\"subfolder\":\"\"}",
  "pipelines.rename": "{\"template\":\"{name}\"}",
  "pipelines.table": "{\"name\":\"{pipeline} {date}\",\"columns\":[{\"header\":\"File\",\"value\":\"{item}\"}]}",
  "pipelines.zip": "{\"together\":true,\"name\":\"{pipeline} {date}\"}",
  "post-builder": "{\"format\":\"auto\",\"aspect\":\"4:5\",\"name\":\"{item}\",\"caption\":\"\",\"keepLocation\":false}",
  "redact": "{\"faces\":true,\"plates\":true,\"sensitivity\":\"normal\",\"style\":\"blur\",\"strength\":6,\"padding\":15,\"stripMetadata\":true}",
  "scenes": "{\"threshold\":0.3,\"minSceneSecs\":1,\"output\":\"stills\",\"keep\":\"all\",\"keepN\":10}",
  "compress": "{\"targetId\":\"discord\",\"targetMb\":20,\"ifTooSmall\":\"lower\",\"videoCodec\":\"h264\",\"maxHeight\":0,\"keepAudio\":true,\"imageFormat\":\"auto\",\"keepMetadata\":false}",
  "silence": "{\"thresholdDb\":-35,\"minSilenceMs\":500,\"paddingMs\":150,\"crossfadeMs\":15,\"cutList\":true}",
  "stems": "{\"preset\":\"four-fast\",\"format\":\"flac\"}",
  "subtitles": "{\"model\":\"small\",\"language\":\"\",\"translateToEnglish\":false,\"targetLanguage\":\"\",\"maxLineChars\":42,\"maxLines\":2,\"save\":[\"srt\"],\"video\":\"burn\",\"style\":\"classic\",\"size\":\"m\",\"position\":\"bottom\",\"font\":\"Arial\",\"trackLanguage\":\"\",\"maxSizeMB\":0,\"canvas\":\"16:9\",\"canvasHeight\":1080,\"background\":\"visualizer\",\"backgroundColor\":\"#11131a\",\"backgroundPath\":\"\",\"visuals\":null}",
  "transcribe": "{\"model\":\"small\",\"language\":\"\",\"task\":\"transcribe\",\"formats\":[\"txt\",\"srt\"],\"vad\":true}",
  "trimmer": "{\"keep\":\"whole\",\"seconds\":30,\"from\":\"\",\"to\":\"\",\"mode\":\"precise\",\"aspect\":\"keep\",\"cropX\":0.5,\"cropY\":0.5,\"maxSizeMB\":0,\"maxHeight\":0,\"removeAudio\":false}",
  "tts": "{\"voice\":\"af_heart\",\"speed\":1,\"split\":\"none\",\"format\":\"mp3\"}",
  "upscaler": "{\"model\":\"photo\",\"scale\":4,\"format\":\"same\",\"device\":\"auto\"}",
  "vault": "{\"folder\":\"\"}",
  "video-studio": "{\"templateId\":\"\",\"templateName\":\"\",\"transition\":\"cut\",\"transitionMs\":500,\"title\":\"\",\"titleMs\":3000,\"music\":\"\",\"aspect\":\"9:16\",\"fps\":30,\"height\":1080,\"stillMs\":3000,\"fit\":\"fill\",\"name\":\"\"}",
  "visualizer": "{\"presetId\":\"\",\"designName\":\"\",\"showJson\":\"\",\"mode\":\"full\",\"aspect\":\"16:9\",\"height\":1080,\"fps\":30,\"audio\":\"original\",\"background\":\"none\",\"stems\":true,\"saveStems\":false,\"words\":\"none\",\"language\":\"\",\"mood\":true}",
};

const step = (id: string, name: string, o: Partial<StepType> = {}): StepType => ({
  id,
  moduleId: id,
  name,
  icon: "box",
  category: Category.CategoryUtility,
  description: `${name} description`,
  auto: true,
  manual: false,
  builtin: false,
  accepts: acc([], { any: true }),
  defaultsJson: STEP_DEFAULTS[id] ?? "{}",
  ...o,
});

const BUILTINS: StepType[] = [
  step("pipelines.check", "Check", { moduleId: "", builtin: true, auto: false, manual: true }),
  step("pipelines.rename", "Rename files", { moduleId: "pipelines", builtin: true }),
  step("llm-chat", "Local Chat", { moduleId: "pipelines", builtin: true, category: Category.CategoryAI, accepts: acc([".txt", ".md"]) }),
  step("pipelines.table", "Make a table", { moduleId: "pipelines", builtin: true }),
  step("pipelines.zip", "Zip", { moduleId: "pipelines", builtin: true }),
  step("pipelines.copy", "Copy to folder", { moduleId: "pipelines", builtin: true }),
  step("pipelines.wait", "Wait", { moduleId: "pipelines", builtin: true }),
  step("pipelines.open", "Open in app", { moduleId: "pipelines", builtin: true }),
  step("pipelines", "Run another pipeline", { moduleId: "pipelines", builtin: true, accepts: acc([], { urls: true, any: true }) }),
];

/**
 * The step catalogue (`PipelinesService.Catalog`): built-ins in menu order, then
 * the tools in descriptor order. The clipboard step is the tool's own (id
 * "clipboard") although its jobs run on the hidden "clipboard-copy" module.
 */
export const GO_STEP_TYPES: StepType[] = [
  ...BUILTINS,
  ...TOOLS.filter((t) => !t.hidden && t.id !== "pipelines" && t.id !== "llm-chat")
    .sort((a, b) => a.order - b.order)
    .map((t) =>
      step(t.stepId ?? t.id, t.name, {
        moduleId: t.id === "clipboard" ? "clipboard-copy" : t.id,
        category: t.category,
        manual: !["clipboard", "dev-utils", "post-builder", "photo-composer", "video-studio", "edit-studio", "documents", "archiver", "focus"].includes(t.id),
        accepts: t.accepts ?? acc([]),
      }),
    ),
];
