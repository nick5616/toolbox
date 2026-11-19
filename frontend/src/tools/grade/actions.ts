/**
 * What the Color Grader does through services (Phase 21 SPEC §E1): opening an
 * input (probe, prepare, URLs, region maps), the saved looks, Vibe, Read the
 * picture, Steal a look, region maps, exports and .cube files. These only run
 * in the window that hosts the store: replicas never save or submit jobs
 * (their panels for these are not poppable).
 */
import { pickFromLibrary } from "@/blocks/library-picker";
import { toast } from "@/components";
import { EditStudioService, FilesService, GradeService, MediaService, PacksService, type Job } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { isActive, announceWhenDone, useJobs } from "@/state/jobs";
import { submitJobs } from "../_kit/enqueue";
import { asAi, fromService, toService } from "./recipe";
import { bakeLut } from "./seams";
import { acceptsPath } from "../_kit/accepts";
import { ALL_EXTS, IMAGE_EXTS, kindOfPath, useGrade, type Suggestion } from "./store";
import { CHAOS_ABOVE, type GradeRecipe } from "@/grade/types";
import { opDef } from "@/grade/ops";

const PREVIEW_FPS = 30;

const st = () => useGrade.getState();

// ---- adding inputs ----

/** Adds pictures and videos to the batch (unsupported and missing files are skipped, with a note). */
export async function addPaths(paths: string[]): Promise<void> {
  const ok = paths.filter((p) => acceptsPath(ALL_EXTS, p));
  const skipped = paths.length - ok.length;
  if (skipped > 0) toast({ title: `Skipped ${skipped} ${skipped === 1 ? "file" : "files"} Color Grader can't read`, tone: "warn" });
  if (ok.length === 0) return;
  try {
    const infos = (await FilesService.Stat(ok)) ?? [];
    const good = infos.filter((i) => i.exists && !i.isDir).map((i) => i.path);
    if (good.length > 0) {
      st().addInputs(good);
      st().select(good[0] as string); // show what was just added
    }
  } catch (e) {
    toast({ title: toAppError(e).message, tone: "danger" });
  }
}

export async function pickFiles(): Promise<void> {
  try {
    await addPaths((await FilesService.PickWith("Choose pictures or videos to grade", ALL_EXTS, true)) ?? []);
  } catch (e) {
    toast({ title: toAppError(e).message, tone: "danger" });
  }
}

export async function pickLibraryFiles(): Promise<void> {
  await addPaths(await pickFromLibrary({ exts: ALL_EXTS, multiple: true, have: st().inputs }));
}

// ---- opening an input ----

/** Jobs followed until they end, then `done` runs once. */
function followJob(job: Job, done: () => void): void {
  useJobs.getState().upsert(job);
  const stop = useJobs.subscribe((s) => {
    const j = s.byId[job.id];
    if (j && isActive(j)) return;
    stop();
    done();
  });
}

async function urlsFor(paths: string[]): Promise<Record<string, string>> {
  const pairs = await Promise.all(paths.filter(Boolean).map((p) => MediaService.URLFor(p).then((u) => [p, u] as const, () => null)));
  const out: Record<string, string> = {};
  for (const pr of pairs) if (pr) out[pr[0]] = pr[1];
  return out;
}

/** Reads the open input's state; asks for its preview when it has none yet. */
export async function loadSource(path: string, prepareIfMissing = true): Promise<void> {
  try {
    const states = (await EditStudioService.Sources([path], PREVIEW_FPS)) ?? [];
    if (st().selected !== path) return;
    const src = states.find((s) => s.path === path) ?? null;
    st().setSource(src);
    if (!src) return;
    const files = [src.preview?.stream ?? "", src.preview?.index ?? "", src.image];
    st().addUrls(await urlsFor(files));
    const ready = !!src.preview || !!src.image;
    if (!ready && !src.preparing && !src.error && prepareIfMissing) {
      const job = await EditStudioService.Prepare("", [path], PREVIEW_FPS);
      st().setPrepareJob(job.id);
      followJob(job, () => {
        if (st().prepareJob === job.id) st().setPrepareJob("");
        void loadSource(path, false);
      });
    }
  } catch (e) {
    toast({ title: toAppError(e).message, tone: "danger" });
  }
}

/** Reads which region maps exist for the open input. */
export async function loadMaps(path: string): Promise<void> {
  try {
    const m = await GradeService.Maps(path);
    if (st().selected === path) st().setMaps(m);
  } catch {
    // Stays "unknown": Regions offers to prepare them.
  }
}

/** Opens an input: its source state, preview URLs and maps. */
export async function openInput(path: string): Promise<void> {
  if (!path) return;
  await Promise.all([loadSource(path), loadMaps(path)]);
}

// ---- saved looks ----

export async function loadMine(): Promise<void> {
  try {
    const list = (await GradeService.Looks()) ?? [];
    st().setMine(list.map(fromService));
  } catch {
    // Mine stays as it was.
  }
}

export async function saveLook(recipe: GradeRecipe): Promise<boolean> {
  try {
    const saved = await GradeService.SaveLook(toService({ ...recipe, tier: "mine" }));
    toast({ title: `Saved “${saved.name}” to Mine`, tone: "success" });
    await loadMine();
    return true;
  } catch (e) {
    toast({ title: toAppError(e).message, tone: "danger" });
    return false;
  }
}

export async function renameSavedLook(oldName: string, newName: string): Promise<void> {
  try {
    await GradeService.RenameLook(oldName, newName);
    await loadMine();
  } catch (e) {
    toast({ title: toAppError(e).message, tone: "danger" });
  }
}

export async function deleteSavedLook(name: string): Promise<void> {
  try {
    await GradeService.DeleteLook(name);
    await loadMine();
  } catch (e) {
    toast({ title: toAppError(e).message, tone: "danger" });
  }
}

// ---- Vibe and Read the picture ----

let aiToken = 0;

/** Asks the chat model for `n` looks; a newer call or Cancel makes this one's answer stale. */
export async function writeLooks(text: string, n: number, seedOffset = 0): Promise<void> {
  const clean = text.trim();
  if (!clean) return;
  const token = ++aiToken;
  st().setVibe({ phase: "busy", error: "" });
  try {
    const list = (await GradeService.Vibe({ text: clean, seed: st().chaosSeed + seedOffset, n })) ?? [];
    if (token !== aiToken) return;
    st().setVibe({ phase: "idle", error: "", results: list.map((r) => asAi(fromService(r))) });
    const first = list[0];
    if (first && n === 1) st().setRecipe(asAi(fromService(first)), "");
  } catch (e) {
    if (token !== aiToken) return;
    st().setVibe({ phase: "error", error: toAppError(e).message });
  }
}

export function cancelAi(): void {
  aiToken++;
  GradeService.CancelVibe().catch(() => undefined);
  if (st().vibe.phase === "busy") st().setVibe({ phase: "idle", error: "" });
  if (st().read.phase === "busy") st().setRead({ phase: "idle", error: "" });
}

export async function readPicture(): Promise<void> {
  const path = st().selected;
  if (!path) return;
  const token = ++aiToken;
  st().setRead({ phase: "busy", error: "" });
  try {
    const list = (await GradeService.Read(path, st().src?.info.kind === "video" ? Math.round(st().timeMs) : 0)) ?? [];
    if (token !== aiToken) return;
    const items: Suggestion[] = list.map((s) => ({ name: s.name, why: s.why, recipe: asAi(fromService(s.recipe)) }));
    st().setSuggestions(items, path);
    st().setRead({ phase: "idle", error: "" });
  } catch (e) {
    if (token !== aiToken) return;
    st().setRead({ phase: "error", error: toAppError(e).message });
  }
}

// ---- Steal a look ----

export async function stealFrom(ref: string): Promise<void> {
  st().setSteal({ phase: "busy", error: "", ref });
  try {
    const stats = (await GradeService.Transfer(ref)) ?? [];
    if (stats.length !== 18) throw new Error("That picture's colours couldn't be read");
    const id = `st${Date.now().toString(36).slice(-4)}`.slice(0, 6);
    st().addOpFromRecipe({ id, kind: "transfer", on: true, amount: 0.8, region: { kind: "all" }, params: { stats } });
    st().setSteal({ phase: "idle", error: "" });
  } catch (e) {
    st().setSteal({ phase: "error", error: toAppError(e).message });
  }
}

/** Picks a reference picture (from a file or the Library) and steals its colours. */
export async function pickReference(from: "file" | "library"): Promise<void> {
  try {
    const paths =
      from === "file" ? ((await FilesService.PickWith("Choose a reference picture", IMAGE_EXTS, false)) ?? []) : await pickFromLibrary({ exts: IMAGE_EXTS, multiple: false });
    const ref = paths[0];
    if (ref) await stealFrom(ref);
  } catch (e) {
    toast({ title: toAppError(e).message, tone: "danger" });
  }
}

// ---- region maps ----

/** Seconds the CPU needs for a clip's depth map (SPEC §E5: about 0.3 s per inferred frame, every 2nd frame above 15 fps). */
export function depthSeconds(durationMs: number, fps: number): number {
  const frames = (Math.max(0, durationMs) / 1000) * Math.max(1, fps);
  return Math.round((fps > 15 ? frames / 2 : frames) * 0.3);
}

export function estimateLabel(seconds: number): string {
  if (seconds < 90) return `about ${Math.max(5, Math.round(seconds / 5) * 5)} s`;
  return `about ${Math.round(seconds / 60)} min`;
}

export async function prepareMaps(kinds: string[]): Promise<void> {
  const path = st().selected;
  if (!path || kinds.length === 0) return;
  try {
    const job = await GradeService.PrepareMaps(path, kinds);
    followJob(job, () => void loadMaps(path));
    void loadMaps(path);
  } catch (e) {
    toast({ title: toAppError(e).message, tone: "danger" });
  }
}

export async function installForMap(missing: string): Promise<void> {
  try {
    const res = await PacksService.Install([missing.includes(":") ? (missing.split(":")[0] ?? "color") : missing || "color"], "");
    for (const j of res.jobs ?? []) useJobs.getState().upsert(j);
  } catch (e) {
    toast({ title: toAppError(e).message, tone: "danger" });
  }
}

// ---- export ----

/** Exports every input with the current look (one job per file). */
export async function exportAll(): Promise<boolean> {
  const s = st();
  if (s.inputs.length === 0) return false;
  s.setExporting(true);
  try {
    const res = await submitJobs(
      () => GradeService.Enqueue(s.inputs, { recipe: toService(s.recipe), wild: s.wild, format: s.format, beat: { on: s.beat.on, song: s.beat.song } }),
      s.inputs,
      ["graded file", "graded files"],
    );
    for (const id of res.jobIds) announceWhenDone(id);
    return res.ok;
  } finally {
    st().setExporting(false);
  }
}

export async function exportCube(): Promise<string> {
  const s = st();
  try {
    const { data } = await bakeLut(s.recipe, s.wild, 33);
    const path = await GradeService.SaveCube(s.recipe.name || "look", 33, data);
    toast({ title: "Saved the LUT", description: path, tone: "success" });
    return path;
  } catch (e) {
    toast({ title: toAppError(e).message, tone: "danger" });
    return "";
  }
}

/** Whether the open input is a video (from its probe, else its extension). */
export function openIsVideo(): boolean {
  const s = st();
  return s.src ? s.src.info.kind === "video" : !!s.selected && kindOfPath(s.selected) === "video";
}

/** The region maps a look uses at a Wildness ("depth" and/or "subject"; people share the subject map). */
export function mapsNeeded(recipe: GradeRecipe, wild: number): string[] {
  const out = new Set<string>();
  for (const op of recipe.ops) {
    if (!op.on || (op.chaos && wild <= CHAOS_ABOVE)) continue;
    const r = op.region.kind;
    if (r === "near" || r === "far") out.add("depth");
    if (r === "subject" || r === "background" || r === "people") out.add("subject");
    for (const n of opDef(op.kind)?.needs ?? []) out.add(n === "depth" ? "depth" : "subject");
    if (op.params.source === "depth" || op.params.by === "depth") out.add("depth");
  }
  return [...out].sort();
}

const autoAsked = new Set<string>();

/**
 * Pictures: when the look uses a region map that isn't made yet and its model is
 * installed, make it without asking (a few seconds). Videos take minutes, so the
 * Regions panel offers it with an estimate instead. Once per (file, map).
 */
export function autoPrepareMaps(): void {
  const s = st();
  const path = s.selected;
  const maps = s.maps;
  if (!path || !maps || s.src?.info.kind === "video") return;
  const want = mapsNeeded(s.recipe, s.wild).filter((k) => {
    const m = k === "depth" ? maps.depth : maps.subject;
    return !m.ready && !m.missing && !(maps.preparing ?? []).includes(k) && !autoAsked.has(`${path}|${k}`);
  });
  if (!want.length) return;
  for (const k of want) autoAsked.add(`${path}|${k}`);
  void prepareMaps(want);
}
