import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const svc = vi.hoisted(() => ({
  Enqueue: vi.fn(),
  SpeakText: vi.fn(),
  Preview: vi.fn(),
  Voices: vi.fn(),
  DiscardPreviews: vi.fn(async () => undefined),
}));
const setState = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => undefined));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    TtsService: svc,
    FilesService: {
      Pick: async () => ["/a.txt"],
      Stat: async (p: string[]) => p.map((path) => ({ path, name: path, sizeBytes: 10, exists: true, isDir: false, kind: "document" })),
    },
    SettingsService: { ModuleState: async () => "", SetModuleState: (...a: unknown[]) => setState(...a) },
    MediaService: { URLFor: async (p: string) => `/media/t/${p}` },
  };
});

import { parseTtsStep } from "@/pipelines/steps/tts";
import TtsView from "./TtsView";
import { DEFAULT_TTS_OPTIONS, formatSpeechLength, formatSpeed, orderVoices, parseTtsResult, previewKey, sanitizeTtsOptions } from "./options";
import { TtsFormat, TtsSplit } from "@/lib/api";

const VOICES = [
  { id: "am_adam", name: "Adam", group: "American English", lang: "en-us", gender: "male", sample: "x", featured: false },
  { id: "af_heart", name: "Heart", group: "American English", lang: "en-us", gender: "female", sample: "x", featured: true },
];

describe("tts options", () => {
  it("sanitizes saved options over the defaults and never keeps preview", () => {
    expect(sanitizeTtsOptions({ voice: "bm_george", speed: 1.5, split: "headings", format: "wav", preview: true }, DEFAULT_TTS_OPTIONS)).toEqual({
      voice: "bm_george",
      speed: 1.5,
      split: "headings",
      format: "wav",
      preview: false,
    });
    expect(sanitizeTtsOptions({ voice: "Not A Voice", speed: 9, split: "x", format: "ogg" }, DEFAULT_TTS_OPTIONS)).toEqual(DEFAULT_TTS_OPTIONS);
    expect(sanitizeTtsOptions(null, DEFAULT_TTS_OPTIONS)).toEqual(DEFAULT_TTS_OPTIONS);
  });

  it("parses results safely", () => {
    const r = parseTtsResult('{"files":[{"path":"/a.mp3","title":"","seconds":3,"chapter":false}],"seconds":3,"voice":"af_heart","previewPath":""}');
    expect(r?.files?.[0]?.path).toBe("/a.mp3");
    expect(parseTtsResult("bad")).toBeNull();
    expect(parseTtsResult("")).toBeNull();
    expect(parseTtsResult('{"files":[{"x":1}]}')?.files).toEqual([]);
  });

  it("formats lengths and speeds", () => {
    expect(formatSpeechLength(65)).toBe("1:05");
    expect(formatSpeechLength(3723)).toBe("1:02:03");
    expect(formatSpeed(1)).toBe("1.0×");
    expect(formatSpeed(1.25)).toBe("1.25×");
  });

  it("lists featured voices first and keys previews by voice and speed", () => {
    expect(orderVoices(VOICES).map((v) => v.id)).toEqual(["af_heart", "am_adam"]);
    expect(previewKey({ voice: "a_b", speed: 1 })).not.toBe(previewKey({ voice: "a_b", speed: 1.1 }));
  });
});

describe("tts step", () => {
  it("parses over the defaults, keeps unknown fields and never throws", () => {
    expect(parseTtsStep("")).toEqual({ voice: "af_heart", speed: 1, split: "none", format: "mp3" });
    expect(parseTtsStep('{"voice":"bf_emma","speed":1.2,"split":"headings","format":"m4a","extra":1}')).toEqual({
      voice: "bf_emma",
      speed: 1.2,
      split: "headings",
      format: "m4a",
      extra: 1,
    });
    expect(parseTtsStep('{"speed":99,"format":"ogg"}')).toMatchObject({ speed: 1, format: "mp3" });
    expect(parseTtsStep("[1]")).toMatchObject({ voice: "af_heart" });
  });
});

describe("TtsView", () => {
  beforeEach(() => {
    for (const f of [svc.Enqueue, svc.SpeakText, svc.Preview, svc.Voices]) f.mockReset();
    svc.Voices.mockResolvedValue(VOICES);
    setState.mockClear();
  });

  it("offers the voices, remembers the choice and starts a preview", async () => {
    svc.Preview.mockResolvedValue([]);
    const user = userEvent.setup();
    render(<TtsView moduleId="tts" />);
    const select = await screen.findByLabelText("Voice");
    await waitFor(() => expect(screen.getByRole("option", { name: /Heart/ })).toBeTruthy());
    await user.selectOptions(select, "am_adam");
    await waitFor(() => expect(JSON.parse(String(setState.mock.calls.at(-1)?.[1]))).toMatchObject({ voice: "am_adam" }));
    await user.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(svc.Preview).toHaveBeenCalledWith({ ...DEFAULT_TTS_OPTIONS, voice: "am_adam", preview: true }));
  });

  it("speaks pasted text with the current options", async () => {
    svc.SpeakText.mockResolvedValue([]);
    const user = userEvent.setup();
    render(<TtsView moduleId="tts" />);
    const button = await screen.findByRole("button", { name: "Read text aloud" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText("Text to read aloud"), "Hello there");
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    await user.click(button);
    await waitFor(() => expect(svc.SpeakText).toHaveBeenCalledWith("Hello there", { ...DEFAULT_TTS_OPTIONS, preview: false }));
    await waitFor(() => expect((screen.getByLabelText("Text to read aloud") as HTMLTextAreaElement).value).toBe(""));
  });

  it("enqueues dropped files with the advanced options", async () => {
    svc.Enqueue.mockResolvedValue([]);
    const user = userEvent.setup();
    render(<TtsView moduleId="tts" />);
    await user.click(await screen.findByRole("button", { name: /Advanced/ }));
    await user.click(await screen.findByRole("radio", { name: "By heading" }));
    await user.click(screen.getByRole("button", { name: "Add files…" }));
    const run = await screen.findByRole("button", { name: /Read 1 file aloud/ });
    await waitFor(() => expect((run as HTMLButtonElement).disabled).toBe(false));
    await user.click(run);
    await waitFor(() =>
      expect(svc.Enqueue).toHaveBeenCalledWith(["/a.txt"], { ...DEFAULT_TTS_OPTIONS, split: TtsSplit.SplitHeadings, format: TtsFormat.FormatMP3, preview: false }),
    );
  });
});
