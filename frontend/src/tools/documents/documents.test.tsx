import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueue = vi.hoisted(() => vi.fn());
const picked = vi.hoisted(() => ({ paths: ["/a.md"] as string[] }));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    DocumentsService: { Defaults: async () => ({}), Enqueue: (...a: unknown[]) => enqueue(...a) },
    LyricVideoService: { Fonts: async () => ["Inter", "Lora"] },
    PdfService: { Thumbnail: async () => "data:image/jpeg;base64,AAAA" },
    FilesService: {
      Pick: async () => picked.paths,
      PickWith: async () => ["/styles.docx"],
      ReadText: async () => "# Hello from the converted file",
      Stat: async (p: string[]) => p.map((path) => ({ path, name: path, sizeBytes: 10, exists: true, isDir: false, kind: "document" })),
    },
    SettingsService: { ModuleState: async () => "", SetModuleState: async () => undefined },
    LibraryService: { Reveal: async () => undefined, Open: async () => undefined, RevealPath: async () => undefined },
  };
});

import { DocumentFormat, ModuleStatus, type Descriptor } from "@/lib/api";
import { useEmbed } from "@/lib/embed";
import { registerToolViews } from "@/lib/toolActions";
import { useLibrary } from "@/state/library";
import { useModules } from "@/state/modules";
import { useUI } from "@/state/ui";
import DocumentsView from "./DocumentsView";
import { DEFAULT_DOCUMENT_OPTIONS, applicable, disabledTargets, inputProblems, sanitizeDocumentOptions } from "./options";

const mod = (id: string, name: string, exts: string[] = []) =>
  ({ id, name, icon: "box", status: ModuleStatus.StatusReady, accepts: { extensions: exts, urls: false, any: false } }) as unknown as Descriptor;

describe("document options", () => {
  it("sanitizes saved options", () => {
    expect(sanitizeDocumentOptions({ to: "pdf", marginMm: 30, pageSize: "letter" }, DEFAULT_DOCUMENT_OPTIONS)).toEqual({ ...DEFAULT_DOCUMENT_OPTIONS, to: "pdf", marginMm: 30, pageSize: "letter" });
    expect(sanitizeDocumentOptions({ to: "exe", marginMm: 99, fontSizePt: "x" }, DEFAULT_DOCUMENT_OPTIONS)).toEqual(DEFAULT_DOCUMENT_OPTIONS);
  });

  it("knows which options apply", () => {
    expect(applicable(DocumentFormat.FormatPDF)).toMatchObject({ layout: true, toc: true, referenceDoc: false, embed: false, extractMedia: false });
    expect(applicable(DocumentFormat.FormatDOCX)).toMatchObject({ layout: false, referenceDoc: true });
    expect(applicable(DocumentFormat.FormatHTML)).toMatchObject({ embed: true, extractMedia: true });
    expect(applicable(DocumentFormat.FormatRTF)).toEqual({ layout: false, toc: false, referenceDoc: false, embed: false, extractMedia: false });
  });

  it("flags same-format and PowerPoint inputs", () => {
    expect(inputProblems(["/a.docx", "/b.md", "/c.pptx"], DocumentFormat.FormatDOCX)).toEqual({
      "/a.docx": "This is already a Word (docx) file",
      "/c.pptx": "PowerPoint files can't be read, only written",
    });
    expect([...disabledTargets(["/a.md", "/b.markdown"])]).toEqual([DocumentFormat.FormatMD]);
    expect(disabledTargets(["/a.md", "/b.docx"]).size).toBe(0);
  });
});

describe("DocumentsView", () => {
  beforeEach(() => {
    enqueue.mockReset();
    picked.paths = ["/a.md"];
    useLibrary.setState({ items: [] });
    useUI.setState({ handoff: null });
    useModules.getState().setAll([mod("documents", "Document Converter", [".md", ".docx", ".txt"]), mod("pdf", "PDF Toolkit"), mod("ocr", "OCR")]);
  });

  it("shows the empty state with the target select", async () => {
    render(<DocumentsView moduleId="documents" />);
    expect(screen.getByText("Drop files here")).toBeTruthy();
    expect(screen.getByLabelText("Convert to")).toBeTruthy();
    expect(screen.getByText("Nothing converted yet.")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Convert/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows only the Advanced options that apply and a summary", async () => {
    const user = userEvent.setup();
    render(<DocumentsView moduleId="documents" />);
    const adv = screen.getByRole("button", { name: /Advanced/ });
    expect(adv.textContent).toContain("default styles");
    await user.click(adv);
    expect(await screen.findByText("Styles from")).toBeTruthy();
    expect(screen.queryByLabelText("Page size")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Close" }));

    await user.selectOptions(screen.getByLabelText("Convert to"), "pdf");
    expect(screen.getByRole("button", { name: /Advanced/ }).textContent).toContain("A4, 25 mm margins, 11 pt");
    await user.click(screen.getByRole("button", { name: /Advanced/ }));
    expect(await screen.findByLabelText("Page size")).toBeTruthy();
    expect(screen.getByLabelText("Margins (mm)")).toBeTruthy();
    expect(screen.getByLabelText("Font size (pt)")).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("option", { name: "Lora" })).toBeTruthy());
    expect(screen.getByRole("switch", { name: "Table of contents" })).toBeTruthy();
    expect(screen.queryByText("Styles from")).toBeNull();
    expect(screen.queryByRole("switch", { name: "Embed images and styles" })).toBeNull();
  });

  it("disables a same-format target and enqueues the files with the options", async () => {
    enqueue.mockResolvedValue([{}]);
    const user = userEvent.setup();
    render(<DocumentsView moduleId="documents" />);
    await user.click(screen.getByRole("button", { name: "Add files…" }));
    const btn = await screen.findByRole("button", { name: /Convert 1 document/ });
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByRole("option", { name: "Markdown" }) as HTMLOptionElement).disabled).toBe(true);
    expect((screen.getByRole("option", { name: "EPUB" }) as HTMLOptionElement).disabled).toBe(false);
    await user.selectOptions(screen.getByLabelText("Convert to"), "epub");
    await user.click(btn);
    await waitFor(() => expect(enqueue).toHaveBeenCalledWith(["/a.md"], expect.objectContaining({ to: "epub", pageSize: "a4", marginMm: 25 })));
  });

  it("shows a one-line OCR note for a PDF input instead of a submit error", async () => {
    function FakeOcr() {
      return <p>ocr: {useEmbed()?.handoff.inputs.join(",")}</p>;
    }
    registerToolViews({ ocr: FakeOcr });
    const user = userEvent.setup();
    render(<DocumentsView moduleId="documents" />);
    useUI.getState().handOff({ moduleId: "documents", inputs: ["/scan.pdf"] });
    expect(await screen.findByText(/scan\.pdf is a PDF/)).toBeTruthy();
    expect(enqueue).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /Get the text with OCR/ }));
    expect((await screen.findByText(/^ocr:/)).textContent).toBe("ocr: /scan.pdf");
  });

  it("gives result rows Send to, a preview, and PDF follow-ups", async () => {
    const user = userEvent.setup();
    const out = (id: string, name: string) => ({ id, moduleId: "documents", name, path: `/o/${name}`, sizeBytes: 10, createdAt: Date.now(), missing: false, kind: "document" }) as never;
    useLibrary.setState({ items: [out("1", "notes.md"), out("2", "report.pdf")] });
    function ActionView() {
      return <p>pdf action: {useEmbed()?.handoff.action}</p>;
    }
    registerToolViews({ pdf: ActionView });
    render(<DocumentsView moduleId="documents" />);
    expect(await screen.findByText("notes.md")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Send to/ }).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "PDF Toolkit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Make searchable" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "PDF Toolkit" }));
    expect(await screen.findByText("pdf action: compress")).toBeTruthy();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "Preview notes.md" }));
    expect((await screen.findByLabelText("Text preview")).textContent).toBe("# Hello from the converted file");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Preview report.pdf" }));
    expect(await screen.findByAltText("First page")).toBeTruthy();
  });
});
