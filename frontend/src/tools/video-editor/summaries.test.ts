import { describe, expect, it } from "vitest";
import type { VideoClip } from "@/lib/api";
import { pictureSummary, playbackSummary, songSummary, songTimingSummary, titleStyleSummary, titleTextSummary, titleTimingSummary, transitionSummary, trimSummary } from "./summaries";

const clip = (over: Partial<VideoClip> = {}): VideoClip =>
  ({ id: "c", kind: "video", path: "/v/a.mp4", inMs: 1000, outMs: 4500, durationMs: 3000, speed: 1, volume: 1, motion: "", fit: "fill", look: "none", transition: { kind: "cut", durationMs: 0 }, ...over }) as unknown as VideoClip;

describe("click-in summaries", () => {
  it("summarises trim, playback, picture and the transition", () => {
    expect(trimSummary(clip())).toBe("0:01.000 – 0:04.500");
    expect(trimSummary(clip({ kind: "photo" }))).toBe("3.0 s");
    expect(playbackSummary(clip())).toBe("1× · 100%");
    expect(playbackSummary(clip({ speed: 2, volume: 0 }))).toBe("2× · muted");
    expect(playbackSummary(clip({ kind: "photo", motion: "in" }))).toBe("Zoom in");
    expect(playbackSummary(clip({ kind: "photo", motion: "" }))).toBe("Still");
    expect(pictureSummary(clip())).toBe("Fill the frame");
    expect(pictureSummary(clip({ fit: "fit-blur", look: "warm" }))).toBe("Fit, blurred edges · Warm");
    expect(transitionSummary(clip())).toBe("Cut");
    expect(transitionSummary(clip({ transition: { kind: "fade", durationMs: 500 } }))).toBe("Fade · 0.5 s");
  });

  it("summarises titles and the song", () => {
    expect(titleTextSummary({ text: "  Hello\n world " })).toBe("Hello world");
    expect(titleTextSummary({ text: " " })).toBe("Empty");
    expect(titleStyleSummary({ style: "lower-third", position: "bottom" })).toBe("Lower third · Bottom");
    expect(titleTimingSummary({ startMs: 2000, durationMs: 3000 })).toBe("0:02.000 · 3.0 s");
    expect(songSummary({ path: "C:\\music\\song.mp3", volume: 0.8 })).toBe("song.mp3 · 80%");
    expect(songTimingSummary({ offsetMs: 0, fadeInMs: 1000, fadeOutMs: 2000, duck: true, endWithMusic: false })).toBe("Fades 1.0 s / 2.0 s · ducks");
    expect(songTimingSummary({ offsetMs: 0, fadeInMs: 0, fadeOutMs: 0, duck: false, endWithMusic: true })).toBe("Fades 0.0 s / 0.0 s · sets the length");
  });
});
