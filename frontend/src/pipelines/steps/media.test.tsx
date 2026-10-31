import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ComponentType } from "react";

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    ConverterService: {
      Presets: async () => [
        { id: "mp3-320", label: "MP3 · 320 kbps", group: "Audio", kind: "audio", ext: ".mp3", acceptsKinds: ["audio", "video"], downloadBytes: 0, stems: null, speed: "" },
        { id: "mp4-h264", label: "MP4 · H.264", group: "Video", kind: "video", ext: ".mp4", acceptsKinds: ["video"], downloadBytes: 0, stems: null, speed: "" },
        { id: "png", label: "PNG", group: "Image", kind: "image", ext: ".png", acceptsKinds: ["image"], downloadBytes: 0, stems: null, speed: "" },
      ],
    },
    TranscribeService: {
      Languages: async () => [
        { code: "en", name: "English" },
        { code: "de", name: "German" },
      ],
    },
  };
});

import { registeredStepTypes, stepUI, type StepEditorProps } from "./index";

const TYPES = ["downloader", "converter", "trimmer", "audio-cleanup", "redact", "stems", "bpm-key", "audio-to-midi", "transcribe", "ocr"];

function mount(type: string, value: unknown) {
  const ui = stepUI(type);
  if (!ui) throw new Error(`no editor for ${type}`);
  const Editor = ui.Editor as ComponentType<StepEditorProps<unknown>>;
  const onChange = vi.fn();
  render(<Editor value={value} onChange={onChange} check={undefined} vars={[]} />);
  return { ui, onChange };
}

/** The last value an editor reported. */
function lastChange(onChange: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = onChange.mock.calls.at(-1);
  if (!call) throw new Error("onChange was not called");
  return call[0] as Record<string, unknown>;
}

describe("media step editors", () => {
  it("registers all ten types", () => {
    for (const t of TYPES) expect(registeredStepTypes()).toContain(t);
  });

  it.each(TYPES)("%s: parse never throws and renders its defaults", async (type) => {
    const ui = stepUI(type);
    expect(ui).toBeDefined();
    for (const bad of ["", "not json", "null", "[1]", '{"mode":42,"preset":{},"formats":"x","seconds":"s"}']) {
      expect(() => ui?.parse(bad)).not.toThrow();
    }
    const value = ui?.parse("{}");
    mount(type, value);
    // Async content (presets, languages) settles without errors.
    await waitFor(() => expect(document.body.textContent).not.toBeNull());
  });

  it.each(TYPES)("%s: parse is idempotent over its own output", (type) => {
    const ui = stepUI(type);
    const once = ui?.parse("{}");
    expect(ui?.parse(JSON.stringify(once))).toEqual(once);
  });

  it("downloader: no trim fields; playlists off by default; edits round-trip", async () => {
    const ui = stepUI("downloader");
    const value = ui?.parse("") as Record<string, unknown>;
    expect(value).toMatchObject({ mode: "audio", audioFormat: "mp3", audioQuality: "320", playlist: false, trimEnabled: false });
    const { onChange } = mount("downloader", value);
    expect(screen.queryByText(/trim/i)).toBeNull();
    await userEvent.click(screen.getByRole("radio", { name: "Video" }));
    const next = lastChange(onChange);
    expect(next.mode).toBe("video");
    expect(ui?.parse(JSON.stringify(next))).toEqual(next);
    // A saved trim is dropped: trimming belongs to the Trimmer step.
    expect(ui?.parse('{"trimEnabled":true,"trimStart":"0:05","trimEnd":"0:10"}')).toMatchObject({ trimEnabled: false, trimStart: "", trimEnd: "" });
  });

  it("converter: shows the height control for video and image presets only", async () => {
    const ui = stepUI("converter");
    mount("converter", { ...(ui?.parse("{}") as object), preset: "mp3-320" });
    await screen.findByText(/Audio · MP3/);
    expect(screen.queryByLabelText("Max height")).toBeNull();
    cleanup();
    mount("converter", { ...(ui?.parse("{}") as object), preset: "png" });
    expect(await screen.findByLabelText("Max height")).toBeTruthy();
    cleanup();
    mount("converter", { ...(ui?.parse("{}") as object), preset: "mp4-h264" });
    expect(await screen.findByLabelText("Max height")).toBeTruthy();
  });

  it("trimmer: keep modes, timecodes and fast mode", async () => {
    const ui = stepUI("trimmer");
    const d = ui?.parse("{}") as Record<string, unknown>;
    expect(d).toMatchObject({ keep: "whole", seconds: 30, mode: "precise", aspect: "keep", cropX: 0.5, cropY: 0.5, maxSizeMB: 0, maxHeight: 0, removeAudio: false });

    const first = mount("trimmer", d);
    await userEvent.click(screen.getByRole("radio", { name: "First…" }));
    expect(lastChange(first.onChange).keep).toBe("first");
    cleanup();

    const range = mount("trimmer", { ...d, keep: "range", from: "", to: "" });
    await userEvent.type(screen.getByLabelText("From"), "1");
    expect(lastChange(range.onChange).from).toBe("1");
    cleanup();

    // Switching to Fast clears what only Precise can do.
    const fast = mount("trimmer", { ...d, aspect: "9:16", maxSizeMB: 50, maxHeight: 720 });
    await userEvent.click(screen.getByRole("radio", { name: "Fast (no re-encode)" }));
    expect(lastChange(fast.onChange)).toMatchObject({ mode: "fast", aspect: "keep", maxSizeMB: 0, maxHeight: 0 });

    // Sanitising: out-of-range numbers are clamped, fast mode drops shape and size.
    expect(ui?.parse('{"seconds":99999,"cropX":3,"maxSizeMB":9000}')).toMatchObject({ seconds: 36000, cropX: 1, maxSizeMB: 4000 });
    expect(ui?.parse('{"mode":"fast","aspect":"1:1","maxSizeMB":10,"maxHeight":720}')).toMatchObject({ aspect: "keep", maxSizeMB: 0, maxHeight: 0 });
    expect(ui?.parse('{"maxHeight":999}')).toMatchObject({ maxHeight: 0 });
  });

  it("audio-cleanup: only the step fields, no preview", async () => {
    const ui = stepUI("audio-cleanup");
    const d = ui?.parse('{"preview":true,"previewStartMs":5}') as Record<string, unknown>;
    expect(Object.keys(d).sort()).toEqual(["denoise", "format", "highPass", "hum", "loudness"]);
    const { onChange } = mount("audio-cleanup", d);
    await userEvent.click(screen.getByRole("radio", { name: "Light" }));
    const next = lastChange(onChange);
    expect(next.denoise).toBe("light");
    expect(ui?.parse(JSON.stringify(next))).toEqual(next);
  });

  it("redact: the full options panel edits the step options", async () => {
    const ui = stepUI("redact");
    const d = ui?.parse("{}") as Record<string, unknown>;
    expect(d).toMatchObject({ faces: true, plates: true, style: "blur", strength: 6, padding: 15, stripMetadata: true });
    const { onChange } = mount("redact", d);
    await userEvent.click(screen.getByRole("radio", { name: "Solid" }));
    const next = lastChange(onChange);
    expect(next.style).toBe("solid");
    expect(ui?.parse(JSON.stringify(next))).toEqual(next);
  });

  it("stems: preset and format", async () => {
    const ui = stepUI("stems");
    const d = ui?.parse("{}") as Record<string, unknown>;
    expect(d).toMatchObject({ preset: "four-fast", format: "flac" });
    const { onChange } = mount("stems", d);
    await userEvent.click(screen.getByRole("radio", { name: "MP3" }));
    expect(lastChange(onChange).format).toBe("mp3");
  });

  it("bpm-key: an explanation and no options", () => {
    const ui = stepUI("bpm-key");
    expect(ui?.parse('{"x":1}')).toEqual({});
    mount("bpm-key", {});
    expect(screen.getByText(/tempo and key/i)).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("audio-to-midi: range and sliders keep their limits", async () => {
    const ui = stepUI("audio-to-midi");
    expect(ui?.parse('{"sensitivity":5,"range":"nope"}')).toMatchObject({ sensitivity: 0.5, range: "full" });
    const { onChange } = mount("audio-to-midi", ui?.parse("{}"));
    await userEvent.click(screen.getByRole("radio", { name: "Bass" }));
    expect(lastChange(onChange).range).toBe("bass");
  });

  it("transcribe: formats keep at least one and a stable order", async () => {
    const ui = stepUI("transcribe");
    const d = ui?.parse("{}") as Record<string, unknown>;
    expect(d).toMatchObject({ model: "small", language: "", task: "transcribe", formats: ["txt", "srt"], vad: true });
    const { onChange } = mount("transcribe", d);
    await userEvent.click(screen.getByRole("switch", { name: "VTT" }));
    expect(lastChange(onChange).formats).toEqual(["txt", "srt", "vtt"]);
    expect(await screen.findByRole("option", { name: "German" })).toBeTruthy();
    expect(ui?.parse('{"formats":["json","txt"]}')).toMatchObject({ formats: ["txt", "json"] });
    expect(ui?.parse('{"formats":[]}')).toMatchObject({ formats: ["txt", "srt"] });
  });

  it("ocr: outputs", async () => {
    const ui = stepUI("ocr");
    const d = ui?.parse("{}") as Record<string, unknown>;
    expect(d).toMatchObject({ language: "latin", pdfOutput: "searchable", imageOutput: "text", skipText: true });
    const { onChange } = mount("ocr", d);
    await userEvent.selectOptions(screen.getByLabelText("PDF output"), "both");
    const next = lastChange(onChange);
    expect(next.pdfOutput).toBe("both");
    expect(ui?.parse(JSON.stringify(next))).toEqual(next);
  });
});
