import { describe, expect, it } from "vitest";
import { normalizeProject } from "@/viz/edit/defaults";
import { fixtureProject } from "@/viz/edit/fixture";
import { fitPps, formatTimecode, keepsRange, nextRate, parseTimecode, songVolume, visibleLanes } from "./logic";

describe("timecode", () => {
  it("formats HH:MM:SS:FF", () => {
    expect(formatTimecode(0, 30)).toBe("00:00:00:00");
    expect(formatTimecode(1000, 30)).toBe("00:00:01:00");
    expect(formatTimecode(1034, 30)).toBe("00:00:01:01");
    expect(formatTimecode(999, 30)).toBe("00:00:00:29");
    expect(formatTimecode(3_723_500, 24)).toBe("01:02:03:12");
    expect(formatTimecode(-5, 30)).toBe("00:00:00:00");
  });
  it("parses typed times and plain seconds", () => {
    expect(parseTimecode("00:00:05:15", 30)).toBe(5500);
    expect(parseTimecode("1:05:15", 30)).toBe(65_500);
    expect(parseTimecode("5:15", 30)).toBe(5500);
    expect(parseTimecode("12", 30)).toBe(12_000);
    expect(parseTimecode("1:05.5", 30)).toBe(65_500);
    expect(parseTimecode("2.25", 30)).toBe(2250);
  });
  it("refuses nonsense and frames past the rate", () => {
    expect(parseTimecode("", 30)).toBeNull();
    expect(parseTimecode("abc", 30)).toBeNull();
    expect(parseTimecode("00:00:01:30", 30)).toBeNull();
    expect(parseTimecode("00:75:00:00", 30)).toBeNull();
    expect(parseTimecode("1:2:3:4:5", 30)).toBeNull();
  });
});

const song = { gainDb: 0, fadeInMs: 1000, fadeOutMs: 500 };

describe("songVolume", () => {
  it("applies fades and caps the gain at 1", () => {
    expect(songVolume(song, 0, 10_000)).toBe(0);
    expect(songVolume(song, 500, 10_000)).toBeCloseTo(0.5);
    expect(songVolume(song, 5000, 10_000)).toBe(1);
    expect(songVolume(song, 9750, 10_000)).toBeCloseTo(0.5);
    expect(songVolume(song, 10_000, 10_000)).toBe(0);
    expect(songVolume({ ...song, gainDb: 6 }, 5000, 10_000)).toBe(1);
  });
  it("lowers the volume for negative gain", () => {
    expect(songVolume({ gainDb: -20, fadeInMs: 0, fadeOutMs: 0 }, 5000, 10_000)).toBeCloseTo(0.1);
  });
});

describe("transport helpers", () => {
  it("L cycles 1x, 1.5x, 2x", () => {
    expect(nextRate(1)).toBe(1.5);
    expect(nextRate(1.5)).toBe(2);
    expect(nextRate(2)).toBe(2);
  });
  it("visibleLanes follows the lane settings", () => {
    const p = normalizeProject(fixtureProject());
    const lanes = visibleLanes(p);
    expect(lanes[0]).toBe("beat");
    expect(lanes).not.toContain("hats");
    const withHats = { ...p, markers: { ...p.markers, lanes: { ...p.markers.lanes, hats: { visible: true, minStrength: 0, every: 1, firstOfBar: false, nudgeMs: 0 } } } };
    expect(visibleLanes(withHats)).toContain("hats");
  });
  it("fitPps clamps", () => {
    expect(fitPps(1000, 10_000)).toBe(100);
    expect(fitPps(10, 600_000)).toBe(6);
    expect(fitPps(100_000, 1000)).toBe(800);
    expect(fitPps(0, 1000)).toBe(80);
  });
  it("keepsRange when the new file still holds the range", () => {
    expect(keepsRange(200_000, { endMs: 200_500 })).toBe(true);
    expect(keepsRange(100_000, { endMs: 200_000 })).toBe(false);
    expect(keepsRange(0, { endMs: 1 })).toBe(false);
  });
});
