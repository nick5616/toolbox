import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryQuery, Output, ProjectInfo } from "@/lib/api";

const h = vi.hoisted(() => ({
  query: vi.fn(),
  exportComp: vi.fn(),
  listComps: vi.fn(),
}));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    LibraryService: { Query: (q: LibraryQuery) => h.query(q) },
    ComposerService: { Export: (id: string) => h.exportComp(id), List: () => h.listComps(), LoadImage: async () => "" },
    FilesService: { ImageThumb: async () => "" },
    MediaService: { Frame: async () => "" },
  };
});

import { clearSourceCaches } from "@/blocks/sources/sourceThumbs";
import { clearLibraryPickerCache, LibraryPickerDialog } from "./LibraryPickerDialog";
import { LibraryPickerHost } from "./LibraryPickerHost";
import { normExts } from "./options";
import { pickFromLibrary } from "./pick";

const MEDIA_EXTS = [".jpg", ".jpeg", ".png", ".mp4", ".mov"];

const out = (id: string, path: string, moduleId: string, kind = "image"): Output => ({
  id,
  jobId: "",
  moduleId,
  path,
  name: path.split("/").pop() ?? path,
  kind: kind as Output["kind"],
  sizeBytes: 1,
  createdAt: 1,
  tags: [],
  missing: false,
});

const OUTPUTS = [
  out("o1", "C:/lib/Compress/a.jpg", "compress"),
  out("o2", "C:/lib/Scenes/b.mp4", "scenes", "video"),
  out("o3", "C:/lib/Compositions/c.png", "photo-composer"),
  out("o4", "C:/lib/Docs/d.gif", "gif"), // not a pool format
];

const comp = (id: string, name: string): ProjectInfo => ({ id, kind: "composition" as ProjectInfo["kind"], name, thumb: "", items: 0, missing: 0, updatedAt: 1, flags: [] });

beforeEach(() => {
  clearLibraryPickerCache();
  clearSourceCaches();
  h.query.mockImplementation(async (q: LibraryQuery) => ({ items: OUTPUTS.filter((o) => !q.moduleId || o.moduleId === q.moduleId), nextCursor: "" }));
  h.listComps.mockResolvedValue([]);
  h.exportComp.mockImplementation(async (id: string) => out("x", `C:/lib/Compositions/${id}.png`, "photo-composer"));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("LibraryPickerDialog", () => {
  it("lists Library pictures and videos the pool accepts, filters by tool, and adds files plus exported compositions", async () => {
    const onAdd = vi.fn();
    const onClose = vi.fn();
    h.listComps.mockResolvedValue([comp("k1", "Collage")]);
    render(<LibraryPickerDialog exts={MEDIA_EXTS} have={["C:/lib/Compositions/c.png"]} onAdd={onAdd} onClose={onClose} />);

    await screen.findByRole("button", { name: /a\.jpg/ });
    expect(screen.getByRole("button", { name: /b\.mp4/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /d\.gif/ })).toBeNull();
    // Already in the pool: shown, but not pickable.
    expect((screen.getByRole("button", { name: /c\.png/ }) as HTMLButtonElement).disabled).toBe(true);

    // The tool filter lists the tools that made pool-ready files and queries by module.
    const tool = screen.getByLabelText("Made with") as HTMLSelectElement;
    await waitFor(() => expect([...tool.options].map((o) => o.value)).toEqual(expect.arrayContaining(["", "compress", "scenes", "photo-composer"])));
    expect([...tool.options].map((o) => o.value)).not.toContain("gif");
    fireEvent.change(tool, { target: { value: "scenes" } });
    await waitFor(() => expect(h.query).toHaveBeenLastCalledWith(expect.objectContaining({ moduleId: "scenes", exts: MEDIA_EXTS })));
    await waitFor(() => expect(screen.queryByRole("button", { name: /a\.jpg/ })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /b\.mp4/ }));

    // A pick survives switching tabs; a composition is exported into the Library first.
    fireEvent.click(screen.getByRole("radio", { name: "Compositions" }));
    fireEvent.click(await screen.findByRole("button", { name: /Collage/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add 2" }));

    await waitFor(() => expect(onAdd).toHaveBeenCalledWith(["C:/lib/Scenes/b.mp4", "C:/lib/Compositions/k1.png"]));
    expect(h.exportComp).toHaveBeenCalledWith("k1");
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the last listing at once when it opens again, then lists again", async () => {
    const props = { exts: MEDIA_EXTS, onAdd: vi.fn(), onClose: vi.fn() };
    const first = render(<LibraryPickerDialog {...props} />);
    await screen.findByRole("button", { name: /a\.jpg/ });
    first.unmount();

    let release = () => {};
    h.query.mockImplementation(
      (q: LibraryQuery) =>
        new Promise((resolve) => {
          release = () => resolve({ items: OUTPUTS.filter((o) => !q.moduleId || o.moduleId === q.moduleId).slice(1), nextCursor: "" });
        }),
    );
    render(<LibraryPickerDialog {...props} />);
    // Shown before the new listing came back.
    expect(screen.getByRole("button", { name: /a\.jpg/ })).toBeTruthy();
    expect(h.query).toHaveBeenCalled();
    release();
    await waitFor(() => expect(screen.queryByRole("button", { name: /a\.jpg/ })).toBeNull());
  });

  it("picks one file: a tile replaces the pick, double-click uses it, and no compositions for non-pictures", async () => {
    const onAdd = vi.fn();
    const onClose = vi.fn();
    render(<LibraryPickerDialog exts={["MP4"]} multiple={false} onAdd={onAdd} onClose={onClose} />);
    await waitFor(() => expect(h.query).toHaveBeenCalledWith(expect.objectContaining({ exts: [".mp4"] })));
    expect(screen.getByRole("dialog", { name: "Choose from Library" })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: "Compositions" })).toBeNull();
    expect(h.listComps).not.toHaveBeenCalled();
    fireEvent.doubleClick(await screen.findByRole("button", { name: /b\.mp4/ }));
    await waitFor(() => expect(onAdd).toHaveBeenCalledWith(["C:/lib/Scenes/b.mp4"]));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("pickFromLibrary", () => {
  it("shows the request in the host and resolves with the pick, or [] when cancelled", async () => {
    render(<LibraryPickerHost />);
    const picked = pickFromLibrary({ exts: MEDIA_EXTS });
    fireEvent.click(await screen.findByRole("button", { name: /a\.jpg/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add 1" }));
    await expect(picked).resolves.toEqual(["C:/lib/Compress/a.jpg"]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    const cancelled = pickFromLibrary({ exts: MEDIA_EXTS, multiple: false });
    fireEvent.click(await screen.findByRole("button", { name: /^Cancel/ }));
    await expect(cancelled).resolves.toEqual([]);
  });

  it("resolves [] at once without a host", async () => {
    await expect(pickFromLibrary({})).resolves.toEqual([]);
  });

  it("normalises extensions", () => {
    expect(normExts([" JPG", ".png", "jpg", "", "."])).toEqual([".jpg", ".png"]);
    expect(normExts(null)).toEqual([]);
  });
});
