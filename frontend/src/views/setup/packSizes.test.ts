import { describe, expect, it } from "vitest";
import { PackComponentState, PackState } from "@/lib/api";
import { comp, pack, samplePacks } from "./packFixtures";
import { formatSize, initialSelection, moduleNeeds, packSizes } from "./packSizes";

describe("packSizes", () => {
  it("counts a shared component once, in catalog order", () => {
    const packs = samplePacks();
    const s = packSizes(packs, ["music", "image"]);
    // Music pays for the engine; Image lists it as "with Music".
    expect(s.byPack.music?.components.engine?.kind).toBe("counted");
    expect(s.byPack.image?.components.engine).toMatchObject({ kind: "with", withPack: "Music", disk: 0 });
    expect(s.byPack.music?.disk).toBe(1600e6 + 200e6 + 80e6);
    expect(s.byPack.image?.disk).toBe(220e6 + 35e6);
    expect(s.totalDisk).toBe(1600e6 + 200e6 + 80e6 + 220e6 + 35e6);
  });

  it("counts FFmpeg once when Media and Music are both selected", () => {
    const s = packSizes(samplePacks(), ["media", "music"]);
    expect(s.byPack.media?.components.ffmpeg?.kind).toBe("counted");
    expect(s.byPack.music?.components.ffmpeg).toMatchObject({ kind: "with", withPack: "Media" });
    expect(s.totalDisk).toBe(200e6 + 20e6 + 100e6 + 1600e6 + 80e6);
  });

  it("moves the shared size to the next selected pack when the owner is deselected", () => {
    const s = packSizes(samplePacks(), ["image"]);
    expect(s.byPack.image?.components.engine?.kind).toBe("counted");
    expect(s.totalDisk).toBe(1600e6 + 220e6 + 35e6);
    // Music (unselected) now shows the engine as paid by Image.
    expect(s.byPack.music?.components.engine).toMatchObject({ kind: "with", withPack: "Image" });
  });

  it("costs nothing for installed and system components", () => {
    const packs = [
      pack("media", "Media", PackState.PackPartial, [
        comp("ffmpeg", PackComponentState.ComponentSystem, 200e6, ["media"]),
        comp("yt-dlp", PackComponentState.ComponentInstalled, 20e6, ["media"]),
        comp("deno", PackComponentState.ComponentMissing, 100e6, ["media"]),
      ]),
    ];
    const s = packSizes(packs, ["media"]);
    expect(s.byPack.media?.components.ffmpeg).toMatchObject({ kind: "system", disk: 0 });
    expect(s.byPack.media?.components["yt-dlp"]).toMatchObject({ kind: "installed", disk: 0 });
    expect(s.totalDisk).toBe(100e6);
    expect(s.totalDownload).toBe(50e6);
  });

  it("ignores unselected packs in the totals", () => {
    const s = packSizes(samplePacks(), []);
    expect(s.totalDisk).toBe(0);
    expect(s.byPack.media?.disk).toBe(320e6);
  });
});

describe("helpers", () => {
  it("formats decimal sizes", () => {
    expect(formatSize(311e6)).toBe("311 MB");
    expect(formatSize(1.1e9)).toBe("1.1 GB");
    expect(formatSize(2.5e9)).toBe("2.5 GB");
    expect(formatSize(12.4e9)).toBe("12 GB");
    expect(formatSize(100)).toBe("1 MB");
    expect(formatSize(0)).toBe("0 MB");
  });

  it("pre-selects Media on a fresh install, and updates otherwise", () => {
    expect(initialSelection(samplePacks())).toEqual(["media"]);
    const packs = samplePacks();
    packs[0] = { ...packs[0]!, state: PackState.PackInstalled };
    expect(initialSelection(packs)).toEqual([]);
    packs[1] = { ...packs[1]!, state: PackState.PackOutdated };
    expect(initialSelection(packs)).toEqual(["music"]);
  });

  it("estimates what a module needs", () => {
    const n = moduleNeeds(samplePacks(), "stems", ["audio-engine", "ffmpeg"]);
    expect(n.pack?.id).toBe("music");
    expect(n.disk).toBe(1600e6 + 200e6 + 80e6);
    expect(moduleNeeds(samplePacks(), "nope", []).pack).toBeUndefined();
  });
});
