import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueue = vi.hoisted(() => vi.fn());
const readText = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    TranscribeService: {
      Defaults: async () => ({}),
      Presets: async () => [
        { id: "base", label: "Base", group: "", kind: "", ext: "", acceptsKinds: null, downloadBytes: 142e6, stems: null, speed: "fast" },
        { id: "small", label: "Small", group: "", kind: "", ext: "", acceptsKinds: null, downloadBytes: 464e6, stems: null, speed: "balanced" },
        { id: "turbo", label: "Turbo", group: "", kind: "", ext: "", acceptsKinds: null, downloadBytes: 1.6e9, stems: null, speed: "best" },
      ],
      Languages: async () => [
        { code: "en", name: "English" },
        { code: "fr", name: "French" },
      ],
      Enqueue: (...a: unknown[]) => enqueue(...a),
    },
    FilesService: {
      Pick: async () => ["/a.mp3"],
      Stat: async (p: string[]) => p.map((path) => ({ path, name: path, sizeBytes: 10, exists: true, isDir: false, kind: "audio" })),
      ReadText: (...a: unknown[]) => readText(...a),
    },
    SettingsService: { ModuleState: async () => "", SetModuleState: async () => undefined },
    LibraryService: { Reveal: async () => undefined, Open: async () => undefined, RevealPath: async () => undefined },
  };
});

import { JobStatus, type Job } from "@/lib/api";
import { useJobs } from "@/state/jobs";
import TranscribeView from "./TranscribeView";
import { DEFAULT_TRANSCRIBE_OPTIONS, previewPath, sanitizeTranscribeOptions, toggleFormat } from "./options";

describe("transcribe options helpers", () => {
  it("enforces at least one format", () => {
    expect(toggleFormat(["txt"], "txt")).toEqual(["txt"]);
    expect(toggleFormat(["txt", "srt"], "txt")).toEqual(["srt"]);
    expect(toggleFormat(["srt"], "json")).toEqual(["srt", "json"]);
  });
  it("sanitizes saved options", () => {
    expect(sanitizeTranscribeOptions({ model: "turbo", formats: [], language: "fr", vad: false }, DEFAULT_TRANSCRIBE_OPTIONS)).toEqual({
      ...DEFAULT_TRANSCRIBE_OPTIONS,
      model: "turbo",
      language: "fr",
      vad: false,
    });
    expect(sanitizeTranscribeOptions({ model: "huge", task: 3 }, DEFAULT_TRANSCRIBE_OPTIONS)).toEqual(DEFAULT_TRANSCRIBE_OPTIONS);
  });
  it("prefers txt for preview", () => {
    expect(previewPath(["/o/a.srt", "/o/a.txt"])).toBe("/o/a.txt");
    expect(previewPath(["/o/a.json", "/o/a.vtt"])).toBe("/o/a.vtt");
    expect(previewPath(["/o/a.json"])).toBeUndefined();
  });
});

describe("TranscribeView", () => {
  beforeEach(() => {
    enqueue.mockReset();
    readText.mockReset();
    useJobs.setState({ byId: {} });
  });

  it("renders model cards, languages and enqueues with options", async () => {
    enqueue.mockResolvedValue([{}]);
    const user = userEvent.setup();
    render(<TranscribeView moduleId="transcribe" />);
    await screen.findByRole("radio", { name: /Turbo/ });
    expect(screen.getByText(/Slower on CPU/)).toBeTruthy();
    expect(await screen.findByRole("option", { name: "French" })).toBeTruthy();

    await user.click(screen.getByRole("radio", { name: /Turbo/ }));
    await user.selectOptions(screen.getByLabelText("Language"), "fr");
    await user.click(screen.getByRole("radio", { name: "Translate to English" }));
    await user.click(screen.getByRole("button", { name: "VTT" }));
    await user.click(screen.getByRole("button", { name: "SRT" }));
    await user.click(screen.getByRole("switch", { name: "Skip silence" }));

    await user.click(screen.getByRole("button", { name: "Add files…" }));
    const run = await screen.findByRole("button", { name: /Transcribe 1 file/ });
    await waitFor(() => expect((run as HTMLButtonElement).disabled).toBe(false));
    await user.click(run);
    await waitFor(() =>
      expect(enqueue).toHaveBeenCalledWith(["/a.mp3"], {
        model: "turbo",
        language: "fr",
        task: "translate",
        formats: ["txt", "vtt"],
        vad: false,
      }),
    );
  });

  it("cannot turn off the last format", async () => {
    const user = userEvent.setup();
    render(<TranscribeView moduleId="transcribe" />);
    await screen.findByRole("radio", { name: /Turbo/ });
    await user.click(screen.getByRole("button", { name: "SRT" }));
    await user.click(screen.getByRole("button", { name: "TXT" }));
    expect(screen.getByRole("button", { name: "TXT" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "SRT" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("previews the TXT output of a finished job", async () => {
    readText.mockResolvedValue(Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n"));
    useJobs.getState().upsert({
      id: "j1",
      moduleId: "transcribe",
      title: "talk.mp3",
      status: JobStatus.JobDone,
      progress: 1,
      message: "",
      inputs: ["/talk.mp3"],
      optionsJson: JSON.stringify({ language: "" }),
      errorCode: "",
      error: "",
      errorHint: "",
      attempt: 1,
      cancelRequested: false,
      createdAt: 1,
      startedAt: 1,
      finishedAt: 2,
      outputs: [],
      resultJson: JSON.stringify({
        language: "en",
        languageProbability: 0.97,
        durationSec: 250,
        segments: 212,
        outputs: ["/o/talk.srt", "/o/talk.txt"],
      }),
    } as unknown as Job);
    const user = userEvent.setup();
    render(<TranscribeView moduleId="transcribe" />);
    await screen.findByText("English · 97%");
    expect(screen.getByText("212 segments")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(readText).toHaveBeenCalledWith("/o/talk.txt", 64 * 1024));
    const panel = await screen.findByRole("complementary", { name: "Transcript preview" });
    expect(await screen.findByText(/line 49/)).toBeTruthy();
    expect(panel.textContent).not.toContain("line 50");
    await user.click(screen.getByRole("button", { name: "Close preview" }));
    expect(screen.queryByRole("complementary")).toBeNull();
  });
});
