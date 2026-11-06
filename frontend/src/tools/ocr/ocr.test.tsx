import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueue = vi.hoisted(() => vi.fn());
const reveal = vi.hoisted(() => vi.fn(async () => undefined));
const copyTextMock = vi.hoisted(() => vi.fn(async (_text: string) => true));
vi.mock("@/lib/copy", () => ({ copyText: (t: string) => copyTextMock(t) }));

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
      ReadText: async () => "Hello Toolbox OCR (full)",
      Stat: async (p: string[]) =>
        p.map((path) => ({ path, name: path, sizeBytes: 10, exists: true, isDir: false, kind: "image" })),
    },
    SettingsService: { ModuleState: async () => "", SetModuleState: async () => undefined },
    LibraryService: { Reveal: reveal, Open: async () => undefined, RevealPath: reveal },
  };
});

import { ErrorCode, JobStatus, ModuleStatus, type Descriptor } from "@/lib/api";
import { useEmbed } from "@/lib/embed";
import { registerToolViews } from "@/lib/toolActions";
import { useModules } from "@/state/modules";
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
    await user.click(screen.getByRole("button", { name: /Advanced/ }));
    await user.click(await screen.findByRole("radio", { name: "Both" }));
    await user.click(screen.getByRole("switch", { name: "Skip pages that already have text" }));
    expect(screen.getByRole("button", { name: /Advanced/ }).textContent).toContain("PDF + text");

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
    const writeText = copyTextMock;
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
      pipelineRunId: "",
      pipelineStepId: "",
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
    // Ask Local Chat: the chat gets the recognised text and prompts.
    function FakeChat() {
      const t = useEmbed()?.handoff.text;
      return <p>chat: {t?.title} | {t?.body} | {t?.prompts?.join(",")}</p>;
    }
    registerToolViews({ "llm-chat": FakeChat });
    const d = (id: string, name: string) => ({ id, name, icon: "box", status: ModuleStatus.StatusReady, accepts: { extensions: [], urls: false, any: false } }) as unknown as Descriptor;
    useModules.getState().setAll([d("llm-chat", "Local Chat"), d("ocr", "OCR")]);
    await user.click(screen.getByRole("button", { name: /Ask Local Chat/ }));
    expect((await screen.findByText(/^chat:/)).textContent).toBe("chat: Text of a.png | Hello Toolbox OCR (full) | Summarise,Extract a table,Fix typos");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Copy text" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Hello\nToolbox OCR"));
    await user.click(screen.getByRole("button", { name: "Show file" }));
    expect(reveal).toHaveBeenCalledWith("o1");
  });

  it("offers Save as document… with the text file as the Document Converter's input", async () => {
    const user = userEvent.setup();
    useJobs.getState().upsert({
      id: "j2",
      moduleId: "ocr",
      title: "b.png",
      status: JobStatus.JobDone,
      progress: 1,
      message: "",
      inputs: ["/b.png"],
      optionsJson: "{}",
      errorCode: ErrorCode.$zero,
      error: "",
      errorHint: "",
      pipelineRunId: "",
      pipelineStepId: "",
      attempt: 1,
      cancelRequested: false,
      createdAt: 1,
      startedAt: 1,
      finishedAt: 2,
      outputs: [{ id: "o2", path: "/o/b (text).txt" } as never],
      resultJson: JSON.stringify({ kind: "image", lines: 1, characters: 5, meanConfidence: 0.9, preview: "Hello", outputs: ["/o/b (text).txt"] }),
    });
    function FakeDocs() {
      const h = useEmbed()?.handoff;
      return <p>docs: {h?.inputs.join(",")}</p>;
    }
    registerToolViews({ documents: FakeDocs });
    const d = (id: string, name: string) => ({ id, name, icon: "box", status: ModuleStatus.StatusReady, accepts: { extensions: [], urls: false, any: false } }) as unknown as Descriptor;
    useModules.getState().setAll([d("documents", "Document Converter"), d("ocr", "OCR")]);
    render(<OcrView moduleId="ocr" />);
    await user.click(await screen.findByRole("button", { name: /Save as document/ }));
    expect((await screen.findByText(/^docs:/)).textContent).toBe("docs: /o/b (text).txt");
  });
});
