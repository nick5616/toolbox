import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueue = vi.hoisted(() => vi.fn());
const reveal = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    OcrService: {
      Languages: async () => [
        { id: "latin", label: "Latin", downloadBytes: 0 },
        { id: "cyrillic", label: "Cyrillic", downloadBytes: 13e6 },
      ],
      Enqueue: (...a: unknown[]) => enqueue(...a),
    },
    FilesService: {
      Pick: async () => ["/a.png"],
      Stat: async (p: string[]) =>
        p.map((path) => ({ path, name: path, sizeBytes: 10, exists: true, isDir: false, kind: "image" })),
    },
    SettingsService: { ModuleState: async () => "", SetModuleState: async () => undefined },
    LibraryService: { Reveal: reveal, Open: async () => undefined, RevealPath: reveal },
  };
});

import { ErrorCode, JobStatus } from "@/lib/api";
import { useJobs } from "@/state/jobs";
import OcrView from "./OcrView";
import { DEFAULT_OCR_OPTIONS, sanitizeOcrOptions } from "./options";

describe("ocr options", () => {
  it("sanitizes saved options", () => {
    expect(sanitizeOcrOptions({ language: "greek", pdfOutput: "both", skipText: false }, DEFAULT_OCR_OPTIONS)).toEqual({
      ...DEFAULT_OCR_OPTIONS,
      language: "greek",
      pdfOutput: "both",
      skipText: false,
    });
    expect(sanitizeOcrOptions({ language: "klingon", imageOutput: 3 }, DEFAULT_OCR_OPTIONS)).toEqual(DEFAULT_OCR_OPTIONS);
  });
});

describe("OcrView", () => {
  beforeEach(() => {
    enqueue.mockReset();
    reveal.mockClear();
    useJobs.setState({ byId: {} });
  });

  it("shows the download note for non-Latin and enqueues the chosen options", async () => {
    enqueue.mockResolvedValue([{}]);
    const user = userEvent.setup();
    render(<OcrView moduleId="ocr" />);
    await screen.findByRole("option", { name: /Cyrillic/ });
    expect(screen.queryByText("downloads ~13 MB on first use")).toBeNull();
    await user.selectOptions(screen.getByLabelText("Language"), "cyrillic");
    expect(screen.getByText("downloads ~13 MB on first use")).toBeTruthy();
    await user.click(screen.getByRole("radio", { name: "Both" }));
    await user.click(screen.getByRole("switch", { name: "Skip pages that already have text" }));

    await user.click(screen.getByRole("button", { name: "Add files…" }));
    const run = await screen.findByRole("button", { name: /Read text from/ });
    await waitFor(() => expect((run as HTMLButtonElement).disabled).toBe(false));
    await user.click(run);
    await waitFor(() =>
      expect(enqueue).toHaveBeenCalledWith(
        ["/a.png"],
        expect.objectContaining({ language: "cyrillic", pdfOutput: "both", skipText: false }),
      ),
    );
  });

  it("renders an image result with a text preview and copies it", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    useJobs.getState().upsert({
      id: "j1",
      moduleId: "ocr",
      title: "a.png",
      status: JobStatus.JobDone,
      progress: 1,
      message: "",
      inputs: ["/a.png"],
      optionsJson: "{}",
      errorCode: ErrorCode.$zero,
      error: "",
      errorHint: "",
      attempt: 1,
      cancelRequested: false,
      createdAt: 1,
      startedAt: 1,
      finishedAt: 2,
      outputs: [{ id: "o1", path: "/o/a (text).txt" } as never],
      resultJson: JSON.stringify({
        kind: "image",
        lines: 2,
        characters: 17,
        meanConfidence: 0.93,
        preview: "Hello\nToolbox OCR",
        outputs: ["/o/a (text).txt"],
      }),
    });
    render(<OcrView moduleId="ocr" />);
    expect(await screen.findByText(/2 lines · 17 characters · 93% confidence/)).toBeTruthy();
    expect(screen.getByLabelText("Text preview").textContent).toBe("Hello\nToolbox OCR");
    await user.click(screen.getByRole("button", { name: "Copy text" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Hello\nToolbox OCR"));
    await user.click(screen.getByRole("button", { name: "Save as…" }));
    expect(reveal).toHaveBeenCalledWith("o1");
  });
});
