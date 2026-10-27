import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueue = vi.hoisted(() => vi.fn());
const setState = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => undefined));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    MidiService: { Enqueue: (...a: unknown[]) => enqueue(...a) },
    FilesService: {
      Pick: async () => ["/a.wav"],
      Stat: async (p: string[]) => p.map((path) => ({ path, name: path, sizeBytes: 10, exists: true, isDir: false, kind: "audio" })),
    },
    SettingsService: { ModuleState: async () => "", SetModuleState: (...a: unknown[]) => setState(...a) },
  };
});

import MidiView from "./MidiView";
import { DEFAULT_MIDI_OPTIONS, formatPitchRange, noteName, parseMidiResult, sanitizeMidiOptions } from "./options";

describe("midi options", () => {
  it("sanitize clamps by rejecting out-of-range values", () => {
    expect(sanitizeMidiOptions({ sensitivity: 0.7, noteFloor: 0.2, minNoteMs: 60, range: "bass", melodiaTrick: false }, DEFAULT_MIDI_OPTIONS)).toEqual({
      sensitivity: 0.7, noteFloor: 0.2, minNoteMs: 60, range: "bass", melodiaTrick: false,
    });
    expect(sanitizeMidiOptions({ sensitivity: 5, noteFloor: "x", minNoteMs: 1, range: "wide", melodiaTrick: 1 }, DEFAULT_MIDI_OPTIONS)).toEqual(DEFAULT_MIDI_OPTIONS);
    expect(sanitizeMidiOptions([], DEFAULT_MIDI_OPTIONS)).toEqual(DEFAULT_MIDI_OPTIONS);
  });

  it("formats note names", () => {
    expect(noteName(60)).toBe("C4");
    expect(noteName(36)).toBe("C2");
    expect(noteName(61)).toBe("C#4");
    expect(noteName(79)).toBe("G5");
    expect(formatPitchRange([36, 79])).toBe("C2–G5");
    expect(formatPitchRange([])).toBe("");
    expect(formatPitchRange(null)).toBe("");
  });

  it("parses results safely", () => {
    expect(parseMidiResult('{"notes":412,"pitchRange":[36,79],"durationSec":3}')).toEqual({ notes: 412, pitchRange: [36, 79], durationSec: 3 });
    expect(parseMidiResult("bad")).toBeNull();
  });
});

describe("MidiView", () => {
  beforeEach(() => {
    enqueue.mockReset();
    setState.mockClear();
  });

  it("persists options, resets, and enqueues", async () => {
    enqueue.mockResolvedValue([{}]);
    const user = userEvent.setup();
    render(<MidiView moduleId="audio-to-midi" />);
    await user.click(await screen.findByRole("radio", { name: "Bass" }));
    await waitFor(() => expect(JSON.parse(String(setState.mock.calls.at(-1)?.[1]))).toMatchObject({ range: "bass" }));
    await user.click(screen.getByRole("switch", { name: "Melodia trick" }));
    await user.click(screen.getByRole("button", { name: "Add files…" }));
    const btn = await screen.findByRole("button", { name: /Transcribe 1 file/ });
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    await user.click(btn);
    await waitFor(() => expect(enqueue).toHaveBeenCalledWith(["/a.wav"], { ...DEFAULT_MIDI_OPTIONS, range: "bass", melodiaTrick: false }));
  });

  it("reset restores defaults", async () => {
    const user = userEvent.setup();
    render(<MidiView moduleId="audio-to-midi" />);
    await user.click(await screen.findByRole("radio", { name: "Melody" }));
    await user.click(screen.getByRole("button", { name: "Reset to defaults" }));
    expect(screen.getByRole("radio", { name: "Full" }).getAttribute("aria-checked")).toBe("true");
  });

  it("maps inputs.N errors", async () => {
    enqueue.mockRejectedValue({ cause: JSON.stringify({ code: "validation", message: "bad", fields: { "inputs.0": "Too long" } }) });
    const user = userEvent.setup();
    render(<MidiView moduleId="audio-to-midi" />);
    await user.click(await screen.findByRole("button", { name: "Add files…" }));
    const btn = await screen.findByRole("button", { name: /Transcribe 1 file/ });
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    await user.click(btn);
    expect(await screen.findByText("Too long")).toBeTruthy();
  });
});
