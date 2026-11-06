import { useState, type ReactNode } from "react";
import { create } from "zustand";
import { Banner, Button, toast } from "@/components";
import { ChatService, DepState, DepsService, PacksService, PackState } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { isOk, useDeps } from "@/state/deps";
import { isActive, useJobs, type JobView } from "@/state/jobs";
import { useModules } from "@/state/modules";
import { usePacks } from "@/state/packs";
import { formatSize, moduleNeeds, packSizes } from "@/views/setup/packSizes";
import styles from "./DepsGate.module.css";

export const AUDIO_ENGINE_ID = "audio-engine";
export const AUDIO_ENGINE_JOB_MODULE = "system-audio-engine";
export const EXIFTOOL_ID = "exiftool";
export const EXIFTOOL_JOB_MODULE = "system-exiftool-update";

export const FFMPEG_JOB_MODULE = "system-ffmpeg-install";
const CHAT_MODULE_ID = "llm-chat";

export const UPSCAYL_ID = "upscayl";
export const UPSCALER_JOB_MODULE = "system-upscaler-install";

/**
 * Per-module override of the descriptor's `requires` (e.g. the Upscaler needs
 * the AI engine instead of upscayl when its Processor is CPU). Set by a view.
 */
export const useRequiresOverride = create<{ byModule: Record<string, string[]> }>(() => ({ byModule: {} }));

export function setRequiresOverride(moduleId: string, requires: string[] | null): void {
  useRequiresOverride.setState((s) => {
    const next = { ...s.byModule };
    if (requires) next[moduleId] = requires;
    else delete next[moduleId];
    return { byModule: next };
  });
}

/** Effective requirements of a module (override first). */
function useRequires(moduleId: string): string[] | undefined {
  const base = useModules((s) => s.byId[moduleId]?.requires);
  const override = useRequiresOverride((s) => s.byModule[moduleId]);
  return override ?? base ?? undefined;
}

export interface DepsGateState {
  /** True while a required dependency (incl. the AI engine) isn't OK. */
  blocked: boolean;
  /** User-facing reason shown under the run button when blocked. */
  reason: string;
}

function reasonFor(id: string, name: string, state: DepState | undefined): string {
  if (id === AUDIO_ENGINE_ID) {
    return state === DepState.DepOutdated ? "The AI engine needs an update" : "The AI engine isn't installed";
  }
  if (id === "ffmpeg" || id === "ffprobe") return "ffmpeg is required";
  return `${name} isn't installed`;
}

/** Computes whether a module can run, from its descriptor's `requires`. */
export function useDepsGate(moduleId: string): DepsGateState {
  const requires = useRequires(moduleId);
  const byId = useDeps((s) => s.byId);
  const loaded = useDeps((s) => s.list.length > 0);
  if (!loaded || !requires) return { blocked: false, reason: "" };
  for (const id of requires) {
    const d = byId[id];
    if (!isOk(d)) return { blocked: true, reason: reasonFor(id, d?.name ?? id, d?.state) };
  }
  return { blocked: false, reason: "" };
}

/** The active audio-engine install/update job, if any (stable reference). */
export function useAudioEngineJob(): JobView | undefined {
  return useJobs((s) => Object.values(s.byId).find((j) => j.moduleId === AUDIO_ENGINE_JOB_MODULE && isActive(j)));
}

/** The active ExifTool install/update job, if any (stable reference). */
export function useExiftoolJob(): JobView | undefined {
  return useJobs((s) => Object.values(s.byId).find((j) => j.moduleId === EXIFTOOL_JOB_MODULE && isActive(j)));
}

/** The active FFmpeg install/update job, if any (stable reference). */
export function useFfmpegJob(): JobView | undefined {
  return useJobs((s) => Object.values(s.byId).find((j) => j.moduleId === FFMPEG_JOB_MODULE && isActive(j)));
}

/** The active upscaler install/update job, if any (stable reference). */
export function useUpscalerJob(): JobView | undefined {
  return useJobs((s) => Object.values(s.byId).find((j) => j.moduleId === UPSCALER_JOB_MODULE && isActive(j)));
}

/**
 * Local Chat is useless without a model, so installing its engine also starts
 * the default model download (the same call Settings → Local Chat makes),
 * unless a model is installed or already downloading.
 */
export async function installDefaultChatModel(): Promise<void> {
  const models = (await ChatService.Catalog()) ?? [];
  if (models.some((m) => m.installed && !m.ollama)) return;
  const def = models.find((m) => m.isDefault && !m.ollama);
  if (!def || def.installed || def.jobId) return;
  useJobs.getState().upsert(await ChatService.DownloadModel(def.id));
}

/**
 * "Install what this tool needs" and "Install the <Pack> pack" buttons (SPEC 7.5).
 * Hidden when no pack unlocks the module, or the pack is unsupported here.
 */
function PackButtons({ moduleId, requires }: { moduleId: string; requires: string[] }) {
  const packs = usePacks((s) => s.list);
  const [busy, setBusy] = useState<"" | "needs" | "pack">("");
  const needs = moduleNeeds(packs, moduleId, requires);
  const pack = needs.pack;
  if (!pack || pack.state === PackState.PackUnsupported || pack.state === PackState.PackInstalled) return null;
  const packSize = packSizes(packs, [pack.id]).byPack[pack.id];
  const packDisk = packSize?.disk ?? 0;
  // The pack is exactly what this tool needs: one button, not two.
  const same = needs.disk === packDisk && needs.download === (packSize?.download ?? 0);

  const run = async (kind: "needs" | "pack") => {
    setBusy(kind);
    try {
      if (kind === "needs") {
        useJobs.getState().upsert(await PacksService.InstallFor(moduleId));
      } else {
        const res = await PacksService.Install([pack.id], "");
        for (const j of res.jobs ?? []) useJobs.getState().upsert(j);
        if (res.restart) await PacksService.Relaunch();
      }
      if (moduleId === CHAT_MODULE_ID) await installDefaultChatModel();
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    } finally {
      setBusy("");
    }
  };
  const withSize = (label: string, bytes: number) => (bytes > 0 ? `${label} (${formatSize(bytes)})` : label);
  if (same) {
    return (
      <div className={styles.packActions}>
        <Button
          variant="primary"
          size="sm"
          icon="download"
          loading={busy === "needs"}
          disabled={busy !== ""}
          data-tip={`Download and set up everything this tool needs; the ${pack.name} pack is the same set`}
          onClick={() => void run("needs")}
        >
          {withSize("Install what this tool needs", needs.disk)}
        </Button>
      </div>
    );
  }
  return (
    <div className={styles.packActions}>
      <Button
        variant="primary"
        size="sm"
        icon="download"
        loading={busy === "needs"}
        disabled={busy !== ""}
        data-tip="Download and set up only the engines and models this tool needs, and nothing else"
        onClick={() => void run("needs")}
      >
        {withSize("Install what this tool needs", needs.disk)}
      </Button>
      <Button
        variant="secondary"
        size="sm"
        loading={busy === "pack"}
        disabled={busy !== ""}
        data-tip={`Install every tool in the ${pack.name} pack at once, so they all work offline later`}
        onClick={() => void run("pack")}
      >
        {withSize(`Install the ${pack.name} pack`, packDisk)}
      </Button>
    </div>
  );
}

/** Banners for missing/outdated dependencies with install/update actions. */
export function DepsGate({ moduleId }: { moduleId: string }) {
  const requires = useRequires(moduleId);
  const packs = usePacks((s) => s.list);
  const byId = useDeps((s) => s.byId);
  const loaded = useDeps((s) => s.list.length > 0);
  const job = useAudioEngineJob();
  const exifJob = useExiftoolJob();
  const upscalerJob = useUpscalerJob();
  const ffmpegJob = useFfmpegJob();
  const [queuing, setQueuing] = useState(false);

  if (!loaded || !requires) return null;

  const installEngine = async () => {
    setQueuing(true);
    try {
      const j = await DepsService.InstallAudioEngine();
      useJobs.getState().upsert(j);
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    } finally {
      setQueuing(false);
    }
  };

  const installExiftool = async () => {
    setQueuing(true);
    try {
      useJobs.getState().upsert(await DepsService.UpdateExiftool());
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    } finally {
      setQueuing(false);
    }
  };

  const installFfmpeg = async () => {
    setQueuing(true);
    try {
      useJobs.getState().upsert(await DepsService.InstallFFmpeg());
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    } finally {
      setQueuing(false);
    }
  };

  const installUpscaler = async () => {
    setQueuing(true);
    try {
      useJobs.getState().upsert(await DepsService.InstallUpscaler());
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    } finally {
      setQueuing(false);
    }
  };

  const banners: ReactNode[] = [];
  let ffDone = false;
  for (const id of requires) {
    const d = byId[id];
    if (isOk(d)) continue;
    if (id === AUDIO_ENGINE_ID) {
      const outdated = d?.state === DepState.DepOutdated;
      const busy = queuing || !!job;
      banners.push(
        <Banner
          key={id}
          tone={outdated ? "warn" : "info"}
          title={outdated ? "The AI engine needs an update" : "The AI engine isn't installed"}
          action={
            <Button
              variant="primary"
              size="sm"
              loading={busy}
              data-tip={outdated ? "Download the newer AI engine; installed models are kept" : "Download and set up the local Python engine (about 1 GB) that runs the audio, speech and image tools"}
              onClick={() => void installEngine()}
            >
              {outdated ? "Update" : "Install AI engine"}
            </Button>
          }
        >
          {busy && job?.message
            ? job.message
            : outdated
              ? "Update the AI engine to keep using the audio, speech and image tools that run on it."
              : "The audio, speech and image tools (stems, transcription, subtitles, cleanup, background removal, redaction, OCR and more) run locally on a Python engine (about 1 GB download, 1.4 GB on disk)."}
        </Banner>,
      );
    } else if (id === EXIFTOOL_ID) {
      const outdated = d?.state === DepState.DepOutdated;
      const busy = queuing || !!exifJob;
      banners.push(
        <Banner
          key={id}
          tone="info"
          title={outdated ? "ExifTool needs an update" : "ExifTool isn't installed"}
          action={
            <Button
              variant="primary"
              size="sm"
              loading={busy}
              data-tip={outdated ? "Download the newer ExifTool (about 11 MB)" : "Download ExifTool (about 11 MB), the program that reads and writes photo metadata"}
              onClick={() => void installExiftool()}
            >
              {outdated ? "Update ExifTool" : "Install ExifTool"}
            </Button>
          }
        >
          {busy && exifJob?.message ? exifJob.message : "ExifTool reads and edits photo metadata (about 11 MB download)."}
        </Banner>,
      );
    } else if (id === UPSCAYL_ID) {
      const outdated = d?.state === DepState.DepOutdated;
      const busy = queuing || !!upscalerJob;
      banners.push(
        <Banner
          key={id}
          tone="info"
          title={outdated ? "The upscaler engine needs an update" : "The upscaler engine isn't installed"}
          action={
            <Button
              variant="primary"
              size="sm"
              loading={busy}
              data-tip={outdated ? "Download the newer upscaler program (about 50 MB)" : "Download the small GPU upscaler program (about 50 MB); it runs only on this computer"}
              onClick={() => void installUpscaler()}
            >
              {outdated ? "Update upscaler" : "Install upscaler"}
            </Button>
          }
        >
          {busy && upscalerJob?.message
            ? upscalerJob.message
            : "The upscaler runs on your GPU through a small separate program (about 50 MB download)."}
        </Banner>,
      );
    } else if (id === "ffmpeg" || id === "ffprobe") {
      if (ffDone) continue;
      ffDone = true;
      const busy = queuing || !!ffmpegJob;
      banners.push(
        <Banner
          key="ffmpeg"
          tone="warn"
          title="ffmpeg is required"
          action={
            <Button
              size="sm"
              variant="primary"
              icon="download"
              loading={busy}
              data-tip="Download FFmpeg, the program that reads and writes audio and video; it runs only on this computer"
              onClick={() => void installFfmpeg()}
            >
              Install FFmpeg
            </Button>
          }
        >
          {busy && ffmpegJob?.message ? ffmpegJob.message : "The audio and video tools use FFmpeg to read and write files."}
        </Banner>,
      );
    } else {
      const hint = d?.installHint ?? "";
      banners.push(
        <Banner key={id} tone="warn" title={`${d?.name ?? id} isn't installed`}>
          {hint && (
            <code className={styles.hint} data-tip="Run this command in a terminal to install it">
              {hint}
            </code>
          )}
        </Banner>,
      );
    }
  }
  if (banners.length === 0) return null;
  // One message, not buttons + a banner per dependency (polish rule 3): when
  // everything missing is simply not installed and a pack offers it, a single
  // banner names what's missing and carries the pack's install buttons.
  const missing = requires.map((id) => byId[id]).filter((d) => !isOk(d));
  const allPlainMissing = missing.every((d) => !d || d.state === DepState.DepMissing) && !job && !exifJob && !upscalerJob && !ffmpegJob;
  if (allPlainMissing && packOffered(packs, moduleId, requires)) {
    const names = missing.map((d) => d?.name ?? "").filter(Boolean);
    const title = names.length === 1 ? `${names[0]} isn't installed` : names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} aren't installed` : "This tool needs a download";
    return (
      <div className={styles.root}>
        <Banner tone="warn" title={title} action={<PackButtons moduleId={moduleId} requires={requires} />} />
      </div>
    );
  }
  return (
    <div className={styles.root}>
      <PackButtons moduleId={moduleId} requires={requires} />
      {banners}
    </div>
  );
}

/** Whether a pack can install what this module needs here (the same test PackButtons uses). */
function packOffered(packs: ReturnType<typeof usePacks.getState>["list"], moduleId: string, requires: string[]): boolean {
  const pack = moduleNeeds(packs, moduleId, requires).pack;
  return !!pack && pack.state !== PackState.PackUnsupported && pack.state !== PackState.PackInstalled;
}
