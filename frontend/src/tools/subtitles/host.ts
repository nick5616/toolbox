/**
 * What only the main Subtitles window does (a replica never does any of it):
 * loads and saves the prefs, loads the lists, follows jobs and applies their
 * results, and opens the media (summarising it into the store for panels).
 */
import { createContext, useEffect } from "react";
import { JobStatus, SettingsService } from "@/lib/api";
import { useMediaSource, type MediaSourceState } from "@/components/media";
import { useJobs } from "@/state/jobs";
import { MODULE_ID, NO_MEDIA, RUN_KEYS, useSubtitles, type MediaSummary } from "./store";

const SAVE_DEBOUNCE_MS = 300;

/** Applies a finished job's result once (the result opens cues, marks a save, adds a translation). */
export function useJobWatcher(): void {
  useEffect(() => {
    const check = () => {
      const s = useSubtitles.getState();
      for (const key of RUN_KEYS) {
        const id = s.runs[key].jobId;
        if (!id || s.handled.includes(id)) continue;
        const job = useJobs.getState().byId[id];
        if (job && job.status === JobStatus.JobDone) {
          useSubtitles.setState((st) => ({ handled: [...st.handled, id] }));
          s.onJobDone(key, job);
        }
      }
    };
    check();
    const offJobs = useJobs.subscribe(check);
    const offStore = useSubtitles.subscribe(check);
    return () => {
      offJobs();
      offStore();
    };
  }, []);
}

/** Loads the saved prefs once and writes changes back (debounced). */
export function usePrefsPersistence(): void {
  const prefs = useSubtitles((s) => s.prefs);
  const loaded = useSubtitles((s) => s.prefsLoaded);
  useEffect(() => {
    void useSubtitles.getState().loadPrefs();
    void useSubtitles.getState().loadStatic();
  }, []);
  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => {
      SettingsService.SetModuleState(MODULE_ID, JSON.stringify(prefs)).catch(() => undefined);
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [prefs, loaded]);
}

/** The media as the panels need to know it. */
export function summarizeMedia(path: string | null, media: MediaSourceState): MediaSummary {
  if (!path) return NO_MEDIA;
  const info = media.source?.info;
  return {
    status: media.status === "idle" ? "loading" : media.status,
    errorMessage: media.error?.message ?? "",
    errorHint: media.error?.hint ?? "",
    isVideo: !!info?.video,
    width: info?.video?.width ?? 0,
    height: info?.video?.height ?? 0,
    fps: info?.video?.fps ?? 0,
    durationMs: info?.durationMs ?? 0,
    subtitles: (info?.subtitles ?? []).map((t) => ({ index: t.index, codec: t.codec, language: t.language, title: t.title, text: t.text })),
  };
}

/** The main window's open media; the preview there shares it instead of opening the file twice. */
export const MediaCtx = createContext<MediaSourceState | null>(null);

/** Main window: opens the file and writes its summary into the store. */
export function useHostMedia(): MediaSourceState {
  const path = useSubtitles((s) => s.mediaPath);
  const media = useMediaSource(path);
  const setMedia = useSubtitles((s) => s.setMedia);
  const { status, source, error } = media;
  useEffect(() => {
    setMedia(summarizeMedia(path, { status, source, error, retry: media.retry }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, status, source, error, setMedia]);
  return media;
}
