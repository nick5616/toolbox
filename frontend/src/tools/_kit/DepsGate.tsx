import { useState, type ReactNode } from "react";
import { create } from "zustand";
import { Banner, Button, toast } from "@/components";
import { DepState, DepsService } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { isOk, useDeps } from "@/state/deps";
import { isActive, useJobs, type JobView } from "@/state/jobs";
import { useModules } from "@/state/modules";
import styles from "./DepsGate.module.css";

export const AUDIO_ENGINE_ID = "audio-engine";
export const AUDIO_ENGINE_JOB_MODULE = "system-audio-engine";
export const EXIFTOOL_ID = "exiftool";
export const EXIFTOOL_JOB_MODULE = "system-exiftool-update";

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

/** The active upscaler install/update job, if any (stable reference). */
export function useUpscalerJob(): JobView | undefined {
  return useJobs((s) => Object.values(s.byId).find((j) => j.moduleId === UPSCALER_JOB_MODULE && isActive(j)));
}

async function copyHint(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast({ title: "Install command copied" });
  } catch {
    toast({ title: "Couldn't copy to the clipboard", tone: "danger" });
  }
}

/** Banners for missing/outdated dependencies with install/update actions. */
export function DepsGate({ moduleId }: { moduleId: string }) {
  const requires = useRequires(moduleId);
  const byId = useDeps((s) => s.byId);
  const loaded = useDeps((s) => s.list.length > 0);
  const job = useAudioEngineJob();
  const exifJob = useExiftoolJob();
  const upscalerJob = useUpscalerJob();
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
            <Button variant="primary" size="sm" loading={busy} onClick={() => void installEngine()}>
              {outdated ? "Update" : "Install AI engine"}
            </Button>
          }
        >
          {busy && job?.message
            ? job.message
            : outdated
              ? "Update the AI engine to keep using the audio tools, transcription, background removal and CPU upscaling."
              : "Stems, BPM & key, MIDI, transcription and background removal run locally on a Python engine (about 1.2 GB download, 1.4 GB on disk)."}
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
            <Button variant="primary" size="sm" loading={busy} onClick={() => void installExiftool()}>
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
            <Button variant="primary" size="sm" loading={busy} onClick={() => void installUpscaler()}>
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
      const hint = d?.installHint ?? "";
      banners.push(
        <Banner
          key="ffmpeg"
          tone="warn"
          title="ffmpeg is required"
          action={
            hint ? (
              <Button size="sm" variant="secondary" icon="copy" onClick={() => void copyHint(hint)}>
                Copy
              </Button>
            ) : undefined
          }
        >
          {hint && <code className={styles.hint}>{hint}</code>}
        </Banner>,
      );
    } else {
      const hint = d?.installHint ?? "";
      banners.push(
        <Banner key={id} tone="warn" title={`${d?.name ?? id} isn't installed`}>
          {hint && <code className={styles.hint}>{hint}</code>}
        </Banner>,
      );
    }
  }
  if (banners.length === 0) return null;
  return <div className={styles.root}>{banners}</div>;
}
