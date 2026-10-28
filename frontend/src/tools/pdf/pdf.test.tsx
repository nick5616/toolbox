import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueue = vi.hoisted(() => vi.fn());
const moduleState = vi.hoisted(() => ({ value: "" }));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    PdfService: {
      Info: async (path: string) => ({
        path,
        pages: 6,
        encrypted: false,
        needsPassword: false,
        restricted: false,
        title: "",
        pageSizes: [],
        bytes: 1000,
        hasBookmarks: false,
      }),
      Thumbnail: async () => "data:image/jpeg;base64,AAAA",
      Enqueue: (...a: unknown[]) => enqueue(...a),
    },
    FilesService: {
      Pick: async () => [],
      Stat: async (p: string[]) => p.map((path) => ({ path, name: path, sizeBytes: 100, exists: true, isDir: false, kind: "file" })),
      ImageThumb: async () => "data:image/png;base64,AAAA",
    },
    SettingsService: { ModuleState: async () => moduleState.value, SetModuleState: async () => undefined },
    LibraryService: { Reveal: async () => undefined, Open: async () => undefined, RevealPath: async () => undefined },
  };
});

import { PdfAction, type Descriptor } from "@/lib/api";
import { useToastStore } from "@/components/toast";
import { normalizeModule, useModules } from "@/state/modules";
import { useUI } from "@/state/ui";
import PdfView from "./PdfView";
import { usePdfIntent } from "./intent";
import { routeAction } from "./options";
import { clearPdfThumbCache } from "./thumbs";

const desc = {
  id: "pdf",
  name: "PDF Toolkit",
  tagline: "t",
  description: "",
  icon: "file-text",
  status: "ready",
  accepts: { extensions: [".pdf", ".jpg", ".png"], urls: false },
  requires: null,
  recommends: null,
  maxInputs: 500,
} as unknown as Descriptor;

async function open(inputs: string[], savedAction?: string) {
  moduleState.value = savedAction ? JSON.stringify({ action: savedAction }) : "";
  useUI.getState().handOff({ moduleId: "pdf", inputs });
  render(<PdfView moduleId="pdf" />);
  await screen.findByText(/\d+ files? ·/);
  return userEvent.setup();
}

const checked = () => within(screen.getByRole("radiogroup", { name: "PDF action" })).getByRole("radio", { checked: true });
const action = (name: RegExp) => screen.getByRole("radio", { name });

describe("routeAction", () => {
  it("routes dropped files", () => {
    expect(routeAction(PdfAction.ActionMerge, ["/a.png"])).toBe(PdfAction.ActionImagesToPDF);
    expect(routeAction(PdfAction.ActionImagesToPDF, ["/a.pdf", "/b.pdf"])).toBe(PdfAction.ActionMerge);
    expect(routeAction(PdfAction.ActionImagesToPDF, ["/a.pdf"])).toBe(PdfAction.ActionSplit);
    expect(routeAction(PdfAction.ActionOrganize, ["/a.pdf", "/b.pdf"])).toBe(PdfAction.ActionMerge);
    expect(routeAction(PdfAction.ActionCompress, ["/a.pdf", "/b.pdf"])).toBe(PdfAction.ActionCompress);
    expect(routeAction(PdfAction.ActionCompress, ["/a.pdf"])).toBe(PdfAction.ActionCompress);
  });
});

describe("PdfView", () => {
  beforeEach(() => {
    enqueue.mockReset();
    enqueue.mockResolvedValue([]);
    clearPdfThumbCache();
    useToastStore.setState({ toasts: [] });
    useModules.setState({ byId: { pdf: normalizeModule(desc) } });
    usePdfIntent.getState().clear();
    useUI.setState({ handoff: null });
  });

  it("switches to images to PDF for dropped images", async () => {
    await open(["/a.png", "/b.jpg"]);
    await waitFor(() => expect(checked().textContent).toMatch(/Images to PDF/));
  });

  it("switches to merge for several PDFs and lets you reorder them", async () => {
    const user = await open(["/a.pdf", "/b.pdf"], PdfAction.ActionCompress);
    expect(checked().textContent).toMatch(/Compress/);
    // saved action fits several PDFs, so it stays; pick merge explicitly
    await user.click(action(/Merge PDFs/));
    await screen.findByText("12 pages in total");
    await user.click(screen.getByRole("button", { name: "Move b.pdf up" }));
    await user.click(screen.getByRole("button", { name: /Merge 2 PDFs/ }));
    await waitFor(() => expect(enqueue).toHaveBeenCalled());
    const [paths, opts, pw, newPw] = enqueue.mock.calls[0] as [string[], { action: string; passwordRef: string }, string, string];
    expect(paths).toEqual(["/b.pdf", "/a.pdf"]);
    expect(opts.action).toBe("merge");
    expect(opts.passwordRef).toBe("");
    expect([pw, newPw]).toEqual(["", ""]);
  });

  it("shows live range chips and the file count for split", async () => {
    const user = await open(["/a.pdf"], PdfAction.ActionSplit);
    await user.click(screen.getByRole("radio", { name: "Custom ranges" }));
    await user.type(screen.getByRole("textbox", { name: "Page ranges" }), "1-3, 5, 6-");
    const chips = screen.getByRole("list", { name: "Parsed ranges" });
    expect(chips.textContent).toBe("1–35" + "6–end");
    expect(screen.getByText("Creates 3 files")).toBeTruthy();
    await user.type(screen.getByRole("textbox", { name: "Page ranges" }), ", 9");
    expect((await screen.findByRole("alert")).textContent).toMatch(/past the last page/);
  });

  it("organizes pages: select, rotate, delete, keyboard move, summary and save", async () => {
    const user = await open(["/a.pdf"], PdfAction.ActionOrganize);
    await screen.findByRole("option", { name: "Page 6" });
    expect(screen.getByRole("status").textContent).toBe("6 pages");

    await user.click(screen.getByRole("option", { name: "Page 2" }));
    await user.keyboard("{Shift>}");
    await user.click(screen.getByRole("option", { name: "Page 3" }));
    await user.keyboard("{/Shift}");
    expect(screen.getByRole("option", { name: "Page 3" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getAllByRole("option", { selected: true })).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Rotate right" }));
    expect(screen.getByRole("status").textContent).toBe("6 pages (2 rotated)");
    expect(screen.getByRole("option", { name: "Page 2, rotated 90°" })).toBeTruthy();

    await user.click(screen.getByRole("option", { name: "Page 6" }));
    await user.click(screen.getByRole("button", { name: "Delete selected" }));
    expect(screen.getByRole("status").textContent).toBe("5 pages (1 removed, 2 rotated)");

    screen.getByRole("option", { name: "Page 1" }).focus();
    await user.keyboard("{Alt>}{ArrowRight}{/Alt}");
    const order = screen.getAllByRole("option").map((o) => o.getAttribute("aria-label"));
    expect(order[0]).toBe("Page 2, rotated 90°");
    expect(order[1]).toBe("Page 1");

    await user.keyboard("{Control>}a{/Control}");
    expect(screen.getAllByRole("option", { selected: true })).toHaveLength(5);

    await user.click(screen.getByRole("button", { name: /Save as new PDF/ }));
    await waitFor(() => expect(enqueue).toHaveBeenCalled());
    const opts = enqueue.mock.calls[0]?.[1] as { action: string; pages: Array<{ page: number; rotate: number }> };
    expect(opts.action).toBe("organize");
    expect(opts.pages).toEqual([
      { page: 2, rotate: 90 },
      { page: 1, rotate: 0 },
      { page: 3, rotate: 90 },
      { page: 4, rotate: 0 },
      { page: 5, rotate: 0 },
    ]);
  });

  it("requires matching passwords when protecting and never puts them in options", async () => {
    const user = await open(["/a.pdf"], PdfAction.ActionProtect);
    await user.type(screen.getByLabelText("New password"), "secret");
    await user.type(screen.getByLabelText("Confirm password"), "secre");
    expect(screen.getByText("Passwords don't match")).toBeTruthy();
    const run = screen.getByRole("button", { name: /Add password/ });
    expect((run as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText("Confirm password"), "t");
    expect((run as HTMLButtonElement).disabled).toBe(false);
    await user.click(run);
    await waitFor(() => expect(enqueue).toHaveBeenCalled());
    const [, opts, pw, newPw] = enqueue.mock.calls[0] as [string[], object, string, string];
    expect(JSON.stringify(opts)).not.toContain("secret");
    expect([pw, newPw]).toEqual(["", "secret"]);
  });

  it("applies a palette-requested action", async () => {
    usePdfIntent.getState().request(PdfAction.ActionCompress);
    render(<PdfView moduleId="pdf" />);
    await waitFor(() => expect(checked().textContent).toMatch(/Compress PDF/));
  });
});
