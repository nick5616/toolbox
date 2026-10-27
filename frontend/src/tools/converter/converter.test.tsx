import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueue = vi.hoisted(() => vi.fn());
const setState = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => undefined));
const picked = vi.hoisted(() => ({ paths: ["/a.mp3"] as string[] }));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    ConverterService: {
      Defaults: async () => ({}),
      Presets: async () => [
        { id: "mp3-320", label: "MP3 · 320 kbps", group: "Audio", kind: "audio", ext: ".mp3", acceptsKinds: ["audio", "video"], downloadBytes: 0, stems: null, speed: "" },
        { id: "mp4-h264", label: "MP4 · H.264", group: "Video", kind: "video", ext: ".mp4", acceptsKinds: ["video"], downloadBytes: 0, stems: null, speed: "" },
      ],
      Enqueue: (...a: unknown[]) => enqueue(...a),
    },
    FilesService: {
      Pick: async () => picked.paths,
      Stat: async (p: string[]) =>
        p.map((path) => ({ path, name: path, sizeBytes: 10, exists: true, isDir: false, kind: path.endsWith(".png") ? "image" : "audio" })),
    },
    SettingsService: { ModuleState: async () => "", SetModuleState: (...a: unknown[]) => setState(...a) },
  };
});

import { OutputKind, type FileInfo, type PresetInfo } from "@/lib/api";
import ConverterView from "./ConverterView";
import { DEFAULT_CONVERTER_OPTIONS, incompatibleInputs, presetHint, presetSelectOptions, sanitizeConverterOptions } from "./options";

const mp3 = { id: "mp3-320", label: "MP3 · 320 kbps", group: "Audio", kind: OutputKind.KindAudio, ext: ".mp3", acceptsKinds: [OutputKind.KindAudio, OutputKind.KindVideo], downloadBytes: 0, stems: null, speed: "" } as PresetInfo;
const fi = (path: string, kind: OutputKind) => ({ path, name: path, sizeBytes: 1, exists: true, isDir: false, kind }) as FileInfo;

describe("converter options", () => {
  it("sanitize", () => {
    expect(sanitizeConverterOptions({ preset: "flac", maxHeight: "720", keepMetadata: false }, DEFAULT_CONVERTER_OPTIONS)).toEqual({ preset: "flac", maxHeight: "720", keepMetadata: false });
    expect(sanitizeConverterOptions({ preset: 3, maxHeight: "999", keepMetadata: "y" }, DEFAULT_CONVERTER_OPTIONS)).toEqual(DEFAULT_CONVERTER_OPTIONS);
  });

  it("flags kind mismatches", () => {
    const errs = incompatibleInputs([fi("/a.mp3", OutputKind.KindAudio), fi("/b.png", OutputKind.KindImage)], mp3);
    expect(errs).toEqual({ "/b.png": "MP3 · 320 kbps can't take an image file" });
    expect(incompatibleInputs([fi("/v.mp4", OutputKind.KindVideo)], undefined)).toEqual({});
  });

  it("hint and select options", () => {
    expect(presetHint(mp3)).toBe("Outputs .mp3 · accepts audio, video");
    expect(presetSelectOptions([mp3])).toEqual([{ value: "mp3-320", label: "Audio · MP3 · 320 kbps" }]);
  });
});

describe("ConverterView", () => {
  beforeEach(() => {
    enqueue.mockReset();
    setState.mockClear();
    picked.paths = ["/a.mp3"];
  });

  it("persists the preset and enqueues", async () => {
    enqueue.mockResolvedValue([{}]);
    const user = userEvent.setup();
    render(<ConverterView moduleId="converter" />);
    await screen.findByRole("option", { name: "Video · MP4 · H.264" });
    await user.selectOptions(screen.getByLabelText("Preset"), "mp4-h264");
    expect(await screen.findByLabelText("Max height")).toBeTruthy();
    await waitFor(() => expect(JSON.parse(String(setState.mock.calls.at(-1)?.[1]))).toMatchObject({ preset: "mp4-h264" }));
    await user.selectOptions(screen.getByLabelText("Preset"), "mp3-320");
    expect(screen.queryByLabelText("Max height")).toBeNull();
    picked.paths = ["/a.mp3"];
    await user.click(screen.getByRole("button", { name: "Add files…" }));
    const btn = await screen.findByRole("button", { name: /Convert 1 file/ });
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    await user.click(btn);
    await waitFor(() => expect(enqueue).toHaveBeenCalledWith(["/a.mp3"], expect.objectContaining({ preset: "mp3-320", keepMetadata: true })));
  });

  it("flags incompatible files and disables run", async () => {
    picked.paths = ["/pic.png"];
    const user = userEvent.setup();
    render(<ConverterView moduleId="converter" />);
    await screen.findByRole("option", { name: "Audio · MP3 · 320 kbps" });
    await user.click(screen.getByRole("button", { name: "Add files…" }));
    expect(await screen.findByText("MP3 · 320 kbps can't take an image file")).toBeTruthy();
    const btn = screen.getByRole("button", { name: /Convert 0 files/ });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it("maps inputs.N errors", async () => {
    enqueue.mockRejectedValue({ cause: JSON.stringify({ code: "validation", message: "bad", fields: { "inputs.0": "Corrupt" } }) });
    const user = userEvent.setup();
    render(<ConverterView moduleId="converter" />);
    await screen.findByRole("option", { name: "Audio · MP3 · 320 kbps" });
    await user.click(screen.getByRole("button", { name: "Add files…" }));
    const btn = await screen.findByRole("button", { name: /Convert 1 file/ });
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    await user.click(btn);
    expect(await screen.findByText("Corrupt")).toBeTruthy();
  });
});
