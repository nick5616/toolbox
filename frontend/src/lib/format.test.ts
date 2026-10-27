import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatDuration,
  formatElapsed,
  formatRelativeTime,
  formatSpeed,
  formatTimecode,
} from "./format";

describe("formatBytes", () => {
  it("formats binary units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KiB");
    expect(formatBytes(4.2 * 1024 * 1024)).toBe("4.2 MiB");
    expect(formatBytes(1024 ** 3 * 2.5)).toBe("2.5 GiB");
  });
  it("does not show 1024.0 of a unit", () => {
    expect(formatBytes(1024 * 1024 - 1)).toBe("1.0 MiB");
  });
});

describe("formatSpeed", () => {
  it("appends /s", () => {
    expect(formatSpeed(4.2 * 1024 * 1024)).toBe("4.2 MiB/s");
  });
});

describe("formatDuration", () => {
  it("formats m:ss and h:mm:ss", () => {
    expect(formatDuration(31)).toBe("0:31");
    expect(formatDuration(125)).toBe("2:05");
    expect(formatDuration(3723)).toBe("1:02:03");
    expect(formatDuration(-3)).toBe("0:00");
    expect(formatDuration(Number.NaN)).toBe("0:00");
  });
});

describe("formatTimecode", () => {
  it("formats with tenths", () => {
    expect(formatTimecode(65.5)).toBe("1:05.5");
    expect(formatTimecode(0)).toBe("0:00.0");
    expect(formatTimecode(59.96)).toBe("1:00.0");
    expect(formatTimecode(3723.04)).toBe("1:02:03.0");
  });
});

describe("formatRelativeTime", () => {
  const now = new Date(2026, 9, 27, 15, 0, 0).getTime();
  it("handles recent times", () => {
    expect(formatRelativeTime(now - 10_000, now)).toBe("just now");
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe("3h ago");
  });
  it("handles yesterday and older", () => {
    expect(formatRelativeTime(new Date(2026, 9, 26, 23, 0).getTime(), now)).toBe("yesterday");
    expect(formatRelativeTime(new Date(2026, 9, 12, 9, 0).getTime(), now)).toBe("Oct 12");
    expect(formatRelativeTime(new Date(2025, 9, 12, 9, 0).getTime(), now)).toBe("Oct 12, 2025");
  });
});

describe("formatElapsed", () => {
  it("measures between instants", () => {
    expect(formatElapsed(1000, 32_000)).toBe("0:31");
    expect(formatElapsed(5000, 1000)).toBe("0:00");
  });
});
