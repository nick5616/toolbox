import { useState, type ReactNode } from "react";
import { Banner, Button, toast } from "@/components";
import { DepState, DepsService } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { isOk, useDeps } from "@/state/deps";
import { isActive, useJobs, type JobView } from "@/state/jobs";
import { useModules } from "@/state/modules";
import styles from "./DepsGate.module.css";

export const AUDIO_ENGINE_ID = "audio-engine";
export const AUDIO_ENGINE_JOB_MODULE = "system-audio-engine";

export interface DepsGateState {
  /** True while a required dependency (incl. the audio engine) isn't OK. */
  blocked: boolean;
  /** User-facing reason shown under the run button when blocked. */
  reason: string;
}

function reasonFor(id: string, name: string, state: DepState | undefined): string {
  if (id === AUDIO_ENGINE_ID) {
    return state === DepState.DepOutdated ? "The audio engine needs an update" : "The audio engine isn't installed";
  }
  if (id === "ffmpeg" || id === "ffprobe") return "ffmpeg is required";
  return `${name} isn't installed`;
}

/** Computes whether a module can run, from its descriptor's `requires`. */
export function useDepsGate(moduleId: string): DepsGateState {
  const requires = useModules((s) => s.byId[moduleId]?.requires);
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
  const requires = useModules((s) => s.byId[moduleId]?.requires);
  const byId = useDeps((s) => s.byId);
  const loaded = useDeps((s) => s.list.length > 0);
  const job = useAudioEngineJob();
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
          title={outdated ? "The audio engine needs an update" : "The audio engine isn't installed"}
          action={
            <Button variant="primary" size="sm" loading={busy} onClick={() => void installEngine()}>
              {outdated ? "Update" : "Install audio engine"}
            </Button>
          }
        >
          {busy && job?.message
            ? job.message
            : outdated
              ? "Update the Python engine to keep using stem splitting, BPM & key and MIDI."
              : "Stem splitting, BPM & key and MIDI run locally on a Python engine (about 1 GB download, 1.2 GB on disk)."}
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
