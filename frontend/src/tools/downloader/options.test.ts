import { describe, expect, it } from "vitest";
import { AudioFormat, AudioQuality, DownloadMode, MaxResolution, type DownloaderOptions } from "@/lib/api";
import { extrasSummary, formatSummary, mergeOptions, trimSummary } from "./options";

const defaults: DownloaderOptions = {
  mode: DownloadMode.ModeAudio, audioFormat: AudioFormat.FormatMP3, audioQuality: AudioQuality.QualityBest,
  maxResolution: MaxResolution.ResBest, trimEnabled: false, trimStart: "", trimEnd: "",
  embedMetadata: true, embedThumbnail: true, playlist: false,
};

describe("click-in summaries", () => {
  it("formatSummary", () => {
    expect(formatSummary({ ...defaults, audioQuality: AudioQuality.Quality320 })).toBe("MP3 · 320k");
    expect(formatSummary({ ...defaults, audioQuality: AudioQuality.QualityBest })).toBe("MP3 · best");
    expect(formatSummary({ ...defaults, audioFormat: AudioFormat.FormatFLAC })).toBe("FLAC");
    expect(formatSummary({ ...defaults, mode: DownloadMode.ModeVideo, maxResolution: MaxResolution.Res720 })).toBe("MP4 · 720p");
    expect(formatSummary({ ...defaults, mode: DownloadMode.ModeVideo })).toBe("MP4 · best");
  });
  it("trimSummary", () => {
    expect(trimSummary(defaults)).toBe("Whole file");
    expect(trimSummary({ ...defaults, trimEnabled: true, trimStart: "0:05" })).toBe("0:05 – end");
  });
  it("extrasSummary", () => {
    expect(extrasSummary(defaults)).toBe("metadata · thumbnail");
    expect(extrasSummary({ ...defaults, audioFormat: AudioFormat.FormatWAV, playlist: true })).toBe("metadata · playlists");
    expect(extrasSummary({ ...defaults, embedMetadata: false, embedThumbnail: false })).toBe("Nothing embedded");
  });
});

describe("mergeOptions", () => {
  it("returns defaults for empty or broken input", () => {
    expect(mergeOptions(defaults, "")).toEqual(defaults);
    expect(mergeOptions(defaults, "{nope")).toEqual(defaults);
    expect(mergeOptions(defaults, "[1]")).toEqual(defaults);
    expect(mergeOptions(defaults, "null")).toEqual(defaults);
  });
  it("applies valid saved fields", () => {
    const r = mergeOptions(defaults, JSON.stringify({ mode: "video", maxResolution: "720", trimEnabled: true, trimStart: "0:05", playlist: true }));
    expect(r).toMatchObject({ mode: "video", maxResolution: "720", trimEnabled: true, trimStart: "0:05", playlist: true, audioFormat: "mp3" });
  });
  it("ignores junk and unknown fields", () => {
    const r = mergeOptions(defaults, JSON.stringify({ mode: "bogus", audioFormat: 3, audioQuality: "", trimEnabled: "yes", embedMetadata: null, extra: 1, trimEnd: 5 }));
    expect(r).toEqual(defaults);
    expect(r).not.toHaveProperty("extra");
  });
});
