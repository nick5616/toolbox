/**
 * Edit Lab (Phase 9 SPEC §17.3, §17.4 step 2): VizLab modes for the Edit
 * Studio engine, in a real webview. Enable with
 *   TOOLBOX_VIZLAB=1 TOOLBOX_VIEW=vizlab TOOLBOX_VIZLAB_ARGS="edit=1"
 * (and "edit=e2e&dir=<folder>" for the end-to-end mode; "decode=1" for the
 * decode bench). Files go to <support>/tmp/vizlab/ over the vzlab| sink.
 *
 * `edit=1` renders a lab project (the fixture project plus a cut-out clip with
 * a matte, masks, fit-blur and captions behind the subject) over generated
 * streams at five times into edit-<n>.png, renders the same frames twice with
 * fresh engines and providers into edit-hash.json (the two must match), and
 * measures preview-path playback in both upload modes into edit-fps.json.
 * `edit=1&media=prepared&paths=<a|b|photo>` uses real files through
 * EditStudioService.Prepare instead of generated ones.
 */
import { EditStudioService, JobsService, JobStatus, MediaService, type WordsSource } from "@/lib/api";
import { fetchAll, type Analysis } from "../analysis";
import { compileEdit } from "../edit/compile";
import { EditEngine } from "../edit/engine";
import { normalizeProject } from "../edit/defaults";
import { buildEditFixture, fixtureProject } from "../edit/fixture";
import { deriveMarkers } from "../edit/markers";
import type { EditFiles, EditProject, FrameKey } from "../edit/types";
import { EditFrameProvider } from "../frames/provider";
import { getUploadMode, setUploadMode, type UploadMode } from "../frames/upload";
import type { StreamIndex } from "../frames/types";
import { aheadKeys } from "../edit/EditCanvas";
import { encodeSyntheticStream, hashPixels, memoryFetch, syntheticPhoto } from "./synth";

type Sender = (name: string, bytes: Uint8Array) => void;
type JSONSender = (name: string, v: unknown) => void;

// ---- the lab project and its media ----

const W = 540;
const H = 960;
const FPS = 30;

/** The fixture project plus a top track with a matted, masked, fit-blur clip, and captions behind the subject. */
export function labProject(): EditProject {
  const p = normalizeProject(fixtureProject());
  const base = p.tracks[0]?.clips[0];
  if (base) {
    base.effects = JSON.stringify([
      { id: "fx1", type: "grade", enabled: true, params: { saturation: 1.3 } },
      { id: "fx3", type: "shake", enabled: true, params: { amount: { base: 0.1, mods: [{ signal: "marker.kick", amount: 0.8, shape: "exp", attackMs: 5, releaseMs: 160 }] } } },
    ]);
  }
  const top = {
    ...(base as NonNullable<typeof base>),
    id: "c5",
    kind: "video",
    path: "/fixture/a.mp4",
    startMs: 4000,
    endMs: 12_000,
    inMs: 2000,
    fit: "fit-blur",
    flipX: true,
    transform: JSON.stringify({ x: 0, y: 0, scale: 0.7, rotation: { base: 0, keys: [{ t: 0, v: -8, ease: "ease" }, { t: 8000, v: 8, ease: "ease" }] }, opacity: 1 }),
    masks: JSON.stringify([{ id: "k1", shape: "ellipse", x: 0.5, y: 0.5, w: 0.9, h: 0.8, rotation: 0, feather: 0.04, invert: false, op: "add" }]),
    matte: { mode: "people", id: "lab-matte", fromMs: 0, toMs: 10_000, clicks: [], cutout: true, invert: false, feather: 0.3, stroke: { px: 6, color: "#ffffff" }, glow: { amount: 0.6, color: "#00e5ff" } },
    fxTarget: "subject",
    effects: JSON.stringify([{ id: "fx4", type: "grade", enabled: true, params: { saturation: 0.2 } }]),
    in: "",
    speed: JSON.stringify({ base: 1, keys: [{ t: 0, v: 1, ease: "linear" }, { t: 8000, v: 0.5, ease: "linear" }] }),
  };
  p.tracks = [...p.tracks, { id: "t3", kind: "video", name: "Video 2", muted: false, locked: false, clips: [top] }];
  if (p.captions) p.captions.behindSubject = true;
  return p;
}

export const LAB_TIMES_MS = [1200, 6000, 9500, 16_100, 21_000];

interface LabMedia {
  files: EditFiles;
  fetchImpl: typeof fetch | undefined;
  bytes: number;
}

/** Generated streams for every path the lab project uses. */
export async function makeSyntheticMedia(say: (s: string) => void): Promise<LabMedia> {
  const mem = new Map<string, Uint8Array>();
  const files: EditFiles = { streams: {}, images: {} };
  const addStream = (key: string, name: string, s: { bytes: Uint8Array; index: StreamIndex }) => {
    mem.set(`mem://${name}.h264`, s.bytes);
    mem.set(`mem://${name}.idx.json`, new TextEncoder().encode(JSON.stringify(s.index)));
    files.streams[key] = { url: `mem://${name}.h264`, indexUrl: `mem://${name}.idx.json` };
  };
  const frames = FPS * 12; // 12 s: the lab clips read up to ~10 s of source
  say("encoding synthetic streams…");
  addStream("v:/fixture/a.mp4", "a", await encodeSyntheticStream({ width: W, height: H, fps: FPS, frames, gop: 10, hue: 20 }));
  addStream("v:/fixture/b.mp4", "b", await encodeSyntheticStream({ width: W, height: H, fps: FPS, frames, gop: 10, hue: 200 }));
  addStream("m:lab-matte", "matte", await encodeSyntheticStream({ width: W, height: H, fps: FPS, frames, gop: 10, hue: 0, kind: "matte" }));
  mem.set("mem://photo.png", await syntheticPhoto(1080, 1440, "PHOTO"));
  files.images["p:/fixture/photo.jpg"] = "mem://photo.png";
  let bytes = 0;
  for (const v of mem.values()) bytes += v.length;
  return { files, fetchImpl: memoryFetch(mem), bytes };
}

/** Real files through EditStudioService (works once WP-ES4 is merged): paths = a video, another video, a photo. */
export async function makePreparedMedia(paths: string[], say: (s: string) => void): Promise<LabMedia> {
  say("preparing sources…");
  const created = await EditStudioService.Create("Edit Lab", "9:16", FPS);
  const job = await EditStudioService.Prepare(created.id, paths, FPS);
  await waitJob(job.id, say, 15 * 60_000);
  const states = (await EditStudioService.Sources(paths, FPS)) ?? [];
  const files: EditFiles = { streams: {}, images: {} };
  for (const s of states) {
    if (s.preview) files.streams[`v:${s.path}`] = { url: await MediaService.URLFor(s.preview.stream), indexUrl: await MediaService.URLFor(s.preview.index) };
    else if (s.image) files.images[`p:${s.path}`] = await MediaService.URLFor(s.image);
  }
  await EditStudioService.Delete(created.id);
  return { files, fetchImpl: undefined, bytes: 0 };
}

// ---- rendering ----

function newCanvas(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  return c;
}

async function pngOf(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : new Uint8Array();
}

interface RenderedSet {
  hashes: string[];
  pixels: Uint8Array[];
  pngs: Uint8Array[];
  gpu: string;
}

/** Renders the lab project at the given times with a fresh engine and an exact provider. */
export async function renderSet(project: EditProject, analysis: Analysis, media: LabMedia, times: number[], wantPng: boolean): Promise<RenderedSet> {
  const markers = deriveMarkers(analysis, project.markers, { startMs: project.song?.startMs ?? 0, endMs: project.song?.endMs ?? 0 });
  const provider = new EditFrameProvider({ files: media.files, mode: "export", fetchImpl: media.fetchImpl });
  const canvas = newCanvas();
  const engine = new EditEngine(canvas, { width: W, height: H, fps: FPS, seed: project.seed, quality: "full", inWorker: false });
  try {
    const streamFrames = await provider.loadIndexes(Object.keys(media.files.streams));
    const compiled = compileEdit({ project, analysis, markers, files: media.files }, { width: W, height: H, fps: FPS, streamFrames });
    engine.setEdit(compiled);
    const out: RenderedSet = { hashes: [], pixels: [], pngs: [], gpu: engine.gpu };
    for (const t of times) {
      await provider.prepare(engine.needs(t), true);
      engine.render(t, provider);
      const px = engine.readPixels();
      out.pixels.push(px);
      out.hashes.push(hashPixels(px));
      if (wantPng) out.pngs.push(await pngOf(canvas));
    }
    return out;
  } finally {
    engine.dispose();
    provider.dispose();
  }
}

function meanAbsDiff(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return 1;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs((a[i] as number) - (b[i] as number));
  return s / a.length / 255;
}

const raf = () => new Promise<number>((r) => requestAnimationFrame(r));

interface PlaybackResult {
  mode: UploadMode;
  seconds: number;
  rendered: number;
  fps: number;
  waitingFraction: number;
  dropped: number;
  decoders: Record<string, { resets: number; runs: number; requests: number; resident: number }>;
  error: string;
}

/** Real-time playback through the preview path (inexact prepare, decode ahead), as EditCanvas does it. */
export async function measurePlayback(project: EditProject, analysis: Analysis, media: LabMedia, mode: UploadMode, startMs: number, seconds: number): Promise<PlaybackResult> {
  setUploadMode(mode, "edit lab measurement");
  const markers = deriveMarkers(analysis, project.markers, { startMs: project.song?.startMs ?? 0, endMs: project.song?.endMs ?? 0 });
  const provider = new EditFrameProvider({ files: media.files, mode: "preview", fetchImpl: media.fetchImpl });
  const canvas = newCanvas();
  const engine = new EditEngine(canvas, { width: W, height: H, fps: FPS, seed: project.seed, quality: "draft", inWorker: false });
  try {
    const compiled = compileEdit({ project, analysis, markers, files: media.files }, { width: W, height: H, fps: FPS });
    engine.setEdit(compiled);
    // warm up: a first draw so shaders compile and the first GOPs decode
    for (let i = 0; i < 20; i++) {
      await provider.prepare(engine.needs(startMs), false);
      engine.render(startMs, provider);
      await raf();
    }
    let rendered = 0;
    let waiting = 0;
    let dropped = 0;
    let lastK = -1;
    const t0 = await raf();
    let now = t0;
    while (now - t0 < seconds * 1000) {
      const t = startMs + (now - t0);
      const keys: FrameKey[] = engine.needs(t);
      provider.hint(aheadKeys((x) => engine.needs(x), t, FPS), true);
      void provider.prepare(keys, false).catch(() => undefined);
      engine.render(t, provider);
      rendered++;
      if (!provider.isReady(keys)) waiting++;
      const k = Math.floor((t * FPS) / 1000);
      if (lastK >= 0 && k > lastK + 1) dropped += k - lastK - 1;
      lastK = k;
      now = await raf();
    }
    engine.readPixels(); // waits for the GPU
    const secs = (now - t0) / 1000;
    return { mode, seconds: secs, rendered, fps: Math.round((rendered / secs) * 10) / 10, waitingFraction: rendered ? waiting / rendered : 0, dropped, decoders: provider.stats(), error: provider.lastError };
  } finally {
    engine.dispose();
    provider.dispose();
  }
}

/** `edit=1`: five PNGs, the double-render hash check and the playback fps. */
export async function runEditLab(q: URLSearchParams, say: (s: string) => void, send: Sender, sendJSON: JSONSender): Promise<void> {
  const project = labProject();
  const analysis = buildEditFixture();
  let media: LabMedia;
  if (q.get("media") === "prepared") media = await makePreparedMedia((q.get("paths") ?? "").split("|").filter(Boolean), say);
  else media = await makeSyntheticMedia(say);
  say(`media ready (${(media.bytes / 1e6).toFixed(1)} MB)`);

  const first = await renderSet(project, analysis, media, LAB_TIMES_MS, true);
  first.pngs.forEach((png, i) => send(`edit-${i}.png`, png));
  say(`rendered ${LAB_TIMES_MS.length} frames on ${first.gpu}`);

  const second = await renderSet(project, analysis, media, LAB_TIMES_MS, false);
  const equal = first.hashes.every((h, i) => h === second.hashes[i]);
  // Informational: the other upload path draws the same frames.
  const mode = getUploadMode();
  const other: UploadMode = mode === "direct" ? "bitmap" : "direct";
  setUploadMode(other, "edit lab comparison");
  const third = await renderSet(project, analysis, media, LAB_TIMES_MS, false);
  setUploadMode(mode, "restored");
  sendJSON("edit-hash.json", {
    equal,
    times: LAB_TIMES_MS,
    uploadMode: mode,
    first: first.hashes,
    second: second.hashes,
    otherMode: other,
    otherModeMeanAbsDiff: first.pixels.map((p, i) => Math.round(meanAbsDiff(p, third.pixels[i] as Uint8Array) * 1e6) / 1e6),
    gpu: first.gpu,
    width: W,
    height: H,
  });
  say(equal ? "double render: identical" : "double render: DIFFERENT");

  const fps = { gpu: first.gpu, size: `${W}x${H}`, fps: FPS, results: [] as PlaybackResult[] };
  for (const m of ["direct", "bitmap"] as const) {
    say(`playback (${m})…`);
    fps.results.push(await measurePlayback(project, analysis, media, m, 1000, 4));
  }
  setUploadMode(mode, "restored");
  sendJSON("edit-fps.json", fps);
  say("edit lab done");
}

// ---- end to end (SPEC §17.4 step 2) ----

interface E2EProject {
  name: string;
  doc: EditProject;
  renders: number;
}

interface E2EOut {
  name: string;
  id: string;
  analysisKey: string;
  outputs: string[];
  encoders: string[];
  seconds: number[];
  error: string;
}

const E2E_TIMEOUT_MS = 15 * 60_000;

async function waitJob(id: string, say: (s: string) => void, timeoutMs = E2E_TIMEOUT_MS): Promise<{ status: string; result: string; error: string }> {
  const t0 = Date.now();
  for (;;) {
    const j = await JobsService.Get(id);
    say(`${j.title || id}: ${j.status} ${Math.round((j.progress ?? 0) * 100)}% ${j.message ?? ""}`);
    if (j.status === JobStatus.JobDone || j.status === JobStatus.JobFailed || j.status === JobStatus.JobCancelled) {
      const err = j.status === JobStatus.JobDone ? "" : `${j.error || j.status}${j.errorHint ? `: ${j.errorHint}` : ""}`;
      return { status: j.status, result: j.resultJson ?? "", error: err };
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`Timed out waiting for job ${id}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

function readProjects(raw: unknown): E2EProject[] {
  const list = Array.isArray(raw) ? raw : ((raw as { projects?: unknown } | null)?.projects ?? []);
  if (!Array.isArray(list)) return [];
  return list.map((e, i) => {
    const o = e as { name?: string; doc?: EditProject; renders?: number };
    return { name: o.name ?? `Edit ${i + 1}`, doc: (o.doc ?? (e as EditProject)) as EditProject, renders: Math.max(0, o.renders ?? 1) };
  });
}

/**
 * `edit=e2e&dir=<folder>`: reads <dir>/projects.json ({"projects":[{name, doc, renders}]}), then for each:
 * Create, Analyze (stems on, no words), Save with the analysis key, Prepare every source, Render `renders` times.
 * Writes e2e.json = {"projects":[{name, id, analysisKey, outputs, encoders, seconds, error}]}, even on failure.
 */
export async function runEditE2E(q: URLSearchParams, say: (s: string) => void, sendJSON: JSONSender): Promise<void> {
  const dir = (q.get("dir") ?? "").replace(/[\\/]+$/, "");
  const results: E2EOut[] = [];
  let fatal = "";
  try {
    if (!dir) throw new Error("No dir given (edit=e2e&dir=<folder with projects.json>)");
    const url = await MediaService.URLFor(`${dir}/projects.json`);
    const projects = readProjects(JSON.parse(new TextDecoder().decode(await fetchAll(url))));
    if (projects.length === 0) throw new Error("projects.json has no projects");
    for (const p of projects) {
      const out: E2EOut = { name: p.name, id: "", analysisKey: "", outputs: [], encoders: [], seconds: [], error: "" };
      results.push(out);
      try {
        const doc = p.doc;
        if (!doc.song) throw new Error("the project has no song");
        const info = await EditStudioService.Create(p.name, doc.aspect, doc.fps);
        out.id = info.id;
        say(`${p.name}: analysing…`);
        const aj = await EditStudioService.Analyze(info.id, { song: doc.song.path, words: "none" as WordsSource, lyricsText: "", language: "" });
        const analyzed = await waitJob(aj.id, say);
        if (analyzed.error) throw new Error(`analysis failed: ${analyzed.error}`);
        const key = (JSON.parse(analyzed.result || "{}") as { analysis?: { key?: string } }).analysis?.key ?? "";
        if (!key) throw new Error("the analysis has no key");
        out.analysisKey = key;
        doc.analysisKey = key;
        await EditStudioService.Save(info.id, p.name, doc);
        const paths = [...new Set([...(doc.sources ?? []).map((s) => s.path), ...(doc.tracks ?? []).flatMap((t) => (t.clips ?? []).map((c) => c.path).filter(Boolean))])];
        if (paths.length > 0) {
          say(`${p.name}: preparing ${paths.length} sources…`);
          const pj = await EditStudioService.Prepare(info.id, paths, doc.fps);
          const prepared = await waitJob(pj.id, say);
          if (prepared.error) throw new Error(`prepare failed: ${prepared.error}`);
        }
        for (let r = 0; r < p.renders; r++) {
          say(`${p.name}: render ${r + 1} of ${p.renders}…`);
          const t0 = Date.now();
          const rj = await EditStudioService.Render(info.id);
          const done = await waitJob(rj.id, say);
          out.seconds.push(Math.round((Date.now() - t0)) / 1000);
          if (done.error) throw new Error(`render failed: ${done.error}`);
          const res = JSON.parse(done.result || "{}") as { outputs?: string[]; encoder?: string };
          out.outputs.push(...(res.outputs ?? []));
          out.encoders.push(res.encoder ?? "");
        }
      } catch (e) {
        out.error = e instanceof Error ? e.message : String(e);
      }
    }
  } catch (e) {
    fatal = e instanceof Error ? e.message : String(e);
  }
  if (fatal && results.length === 0) results.push({ name: "", id: "", analysisKey: "", outputs: [], encoders: [], seconds: [], error: fatal });
  sendJSON("e2e.json", { projects: results });
  say("edit e2e done");
}
