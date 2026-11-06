import { useEffect, useRef, useState } from "react";
import { IconButton, toast } from "@/components";
import { MediaService } from "@/lib/api";
import { toAppError } from "@/lib/errors";

export const INLINE_AUDIO_EXTENSIONS = [".mp3", ".wav", ".m4a", ".flac", ".ogg", ".aac", ".opus", ".wma", ".aiff", ".aif"];

export function isInlineAudio(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot >= 0 && INLINE_AUDIO_EXTENSIONS.includes(path.slice(dot).toLowerCase());
}

/** Stops whichever result is playing; set by the player that currently owns the sound. */
let stopCurrent: (() => void) | null = null;

/**
 * A play/pause button for an audio file (a result row). The file reaches the
 * webview through MediaService.Open (a /media/<token>/ URL, never a path);
 * only one result plays at a time.
 */
export function InlinePlay({ path, disabled }: { path: string; disabled?: boolean }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const stop = useRef<() => void>(() => undefined);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);

  stop.current = () => {
    audio.current?.pause();
    setPlaying(false);
  };

  useEffect(
    () => () => {
      const el = audio.current;
      if (el) {
        el.pause();
        el.removeAttribute("src");
      }
      audio.current = null;
      if (stopCurrent === stop.current) stopCurrent = null;
    },
    [],
  );

  const toggle = async () => {
    if (playing) {
      stop.current();
      return;
    }
    if (stopCurrent && stopCurrent !== stop.current) stopCurrent();
    const mine = () => stop.current();
    stopCurrent = mine;
    let el = audio.current;
    if (!el) {
      setLoading(true);
      try {
        const source = await MediaService.Open(path);
        if (!source.url) {
          toast({ title: "This audio is being prepared for playback; try again in a moment", tone: "neutral" });
          if (stopCurrent === mine) stopCurrent = null;
          return;
        }
        el = new Audio(source.url);
        el.addEventListener("ended", () => setPlaying(false));
        el.addEventListener("pause", () => setPlaying(false));
        el.addEventListener("play", () => setPlaying(true));
        audio.current = el;
      } catch (e) {
        if (stopCurrent === mine) stopCurrent = null;
        toast({ title: toAppError(e).message, tone: "danger" });
        return;
      } finally {
        setLoading(false);
      }
    }
    // Someone else may have started while the file was opening.
    if (stopCurrent !== mine) return;
    void el.play().catch(() => setPlaying(false));
  };

  return (
    <IconButton
      size="sm"
      icon={playing ? "pause" : "play"}
      label={playing ? "Pause" : "Play"}
      data-tip={playing ? "Pause this result" : "Play this result here"}
      disabled={disabled || loading}
      onClick={() => void toggle()}
    />
  );
}
