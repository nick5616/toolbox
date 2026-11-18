/**
 * The Source panel (SPEC Phase 11 §5.5; formerly the Source step's file card):
 * what the visuals are made for, change the file, and for a video whether the
 * visuals draw over the picture or replace it. Opened from the header's source
 * chip. The empty state (`EmptySource`) stays the drop zone.
 */
import { useCallback, useEffect, useState } from "react";
import { Button, DropZone, Icon, Section, SegmentedControl, Spinner, toast } from "@/components";
import { formatMs, useMediaSource } from "@/components/media";
import { FilesService, MediaService } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { useModules } from "@/state/modules";
import { FromLibraryButton } from "@/blocks/library-picker";
import { DepsGate } from "@/tools/_kit";
import { basename, isVideoPath } from "./source/logic";
import { useVisualizer, VISUALIZER_ID } from "./store";
import styles from "./SourcePanel.module.css";

/** Makes a picked file the source (shared by the native picker and From Library). */
export function useApplySource(): (paths: string[]) => void {
  return useCallback((paths: string[]) => {
    const first = paths[0];
    if (!first) return;
    const s = useVisualizer.getState();
    s.setInput(first, isVideoPath(first));
    s.setSeed(null, null);
  }, []);
}

/** The extensions a song or video source may have (null = any). */
export function useSourceExts(): string[] | null {
  const exts = useModules((s) => s.byId[VISUALIZER_ID]?.accepts.extensions);
  return exts && exts.length > 0 ? exts : null;
}

/** Opens the file picker for a song or video and makes the answer the source. */
export function useChooseSource(): () => Promise<void> {
  const exts = useSourceExts();
  const apply = useApplySource();
  return useCallback(async () => {
    try {
      apply((await FilesService.PickWith("Choose a song or video", exts, false)) ?? []);
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    }
  }, [exts, apply]);
}

/** Nothing chosen yet: the drop zone. */
export function EmptySource() {
  const choose = useChooseSource();
  const exts = useSourceExts();
  const apply = useApplySource();
  return (
    <div className={styles.empty}>
      <DropZone id="tool-drop:visualizer" icon="sparkles" label="Drop a song or video" hint="Visuals that follow the instruments, the beat, the chords and the words.">
        <div className={styles.buttonRow}>
          <Button icon="plus" onClick={() => void choose()} data-tip="Pick an audio or video file from your computer">
            Choose a file…
          </Button>
          <FromLibraryButton title="Choose a song or video from Library" exts={exts} multiple={false} onPick={apply} tip="Use a song or video Toolbox already made (the Library)" />
        </div>
      </DropZone>
      <DepsGate moduleId={VISUALIZER_ID} />
    </div>
  );
}

export default function SourcePanel() {
  const input = useVisualizer((s) => s.input);
  const isVideo = useVisualizer((s) => s.isVideo);
  const mode = useVisualizer((s) => s.mode);
  const choose = useChooseSource();
  const exts = useSourceExts();
  const apply = useApplySource();
  const media = useMediaSource(input);
  const info = media.source?.info;
  const [coverUrl, setCoverUrl] = useState<string | undefined>(undefined);

  useEffect(() => {
    setCoverUrl(undefined);
    if (!input || media.status !== "ready" || !info) return;
    if (!info.hasCover && !info.video) return;
    let cancelled = false;
    const at = info.video ? Math.min(1000, Math.round(info.durationMs / 10)) : 0;
    MediaService.Frame(input, at, 640)
      .then((u) => !cancelled && setCoverUrl(u))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [input, media.status, info]);

  if (!input) return null;
  const tagTitle = info?.tags?.title;
  const tagArtist = info?.tags?.artist;
  return (
    <div className={styles.panel}>
      <div className={styles.card}>
        <div className={styles.cover} aria-label={isVideo ? "Video still" : "Cover art"} data-tip={isVideo ? "A still frame from the video" : "The cover art embedded in the file"}>
          {coverUrl ? <img src={coverUrl} alt="" /> : <Icon name={isVideo ? "film" : "music"} size={32} />}
        </div>
        <div className={styles.info}>
          <div className={styles.fileName} data-tip={input}>
            {tagTitle || basename(input)}
          </div>
          <div className={styles.meta}>
            {media.status === "loading" && (
              <>
                <Spinner size={12} /> Reading the file…
              </>
            )}
            {media.status === "preparing" && "Preparing a preview copy…"}
            {media.status === "error" && (media.error?.message ?? "Couldn't read this file")}
            {info && [tagArtist, isVideo ? "Video" : "Audio", formatMs(info.durationMs)].filter(Boolean).join(" · ")}
          </div>
        </div>
        <Button size="sm" variant="ghost" onClick={() => void choose()} data-tip="Choose a different song or video">
          Change
        </Button>
        <FromLibraryButton iconOnly variant="ghost" title="Choose a song or video from Library" label="Change from Library…" exts={exts} multiple={false} have={[input]} onPick={apply} tip="Use a song or video Toolbox already made (the Library)" />
      </div>

      {isVideo && (
        <Section label="Video" tip="Whether the visuals draw over the picture or replace it">
          <SegmentedControl
            aria-label="Video"
            value={mode}
            options={[
              { value: "overlay", label: "Over the video", tip: "Draw the visuals on top of your video and keep its picture" },
              { value: "full", label: "Use only its sound", tip: "Ignore the picture and make full-screen visuals for the soundtrack" },
            ]}
            onChange={(v) => useVisualizer.getState().setMode(v)}
          />
        </Section>
      )}
    </div>
  );
}
