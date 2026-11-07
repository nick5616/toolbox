import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryQuery, Output, ProjectInfo } from "@/lib/api";

const h = vi.hoisted(() => ({
  query: vi.fn(),
  exportComp: vi.fn(),
}));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    LibraryService: { Query: (q: LibraryQuery) => h.query(q) },
    ComposerService: { Export: (id: string) => h.exportComp(id), LoadImage: async () => "" },
    FilesService: { ImageThumb: async () => "" },
    MediaService: { Frame: async () => "" },
  };
});

import { LibraryPickerDialog } from "./LibraryPickerDialog";
import { MEDIA_EXTS } from "./SourcesPanel";

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
  h.query.mockImplementation(async (q: LibraryQuery) => ({ items: OUTPUTS.filter((o) => !q.moduleId || o.moduleId === q.moduleId), nextCursor: "" }));
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
    render(<LibraryPickerDialog exts={MEDIA_EXTS} have={new Set(["c:\\lib\\compositions\\c.png"])} compositions={[comp("k1", "Collage")]} onAdd={onAdd} onClose={onClose} />);

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
    await waitFor(() => expect(h.query).toHaveBeenLastCalledWith(expect.objectContaining({ moduleId: "scenes" })));
    await waitFor(() => expect(screen.queryByRole("button", { name: /a\.jpg/ })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /b\.mp4/ }));

    // A pick survives switching tabs; a composition is exported into the Library first.
    fireEvent.click(screen.getByRole("radio", { name: "Compositions" }));
    fireEvent.click(screen.getByRole("button", { name: /Collage/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add 2 to sources" }));

    await waitFor(() => expect(onAdd).toHaveBeenCalledWith(["C:/lib/Scenes/b.mp4", "C:/lib/Compositions/k1.png"]));
    expect(h.exportComp).toHaveBeenCalledWith("k1");
    expect(onClose).toHaveBeenCalled();
  });
});
