import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", async (orig) => {
  const { libraryApiMock } = await import("./testSvc");
  return libraryApiMock(orig as never);
});
vi.mock("@/lib/wholeImage", () => ({ wholeImageUrl: () => Promise.resolve("blob:x"), releaseImageUrl: () => undefined }));

import { ModuleStatus, OutputKind, type Descriptor } from "@/lib/api";
import { useToastStore } from "@/components/toast";
import { useLibrary } from "@/state/library";
import { useModules } from "@/state/modules";
import { useUI } from "@/state/ui";
import { formatBytes } from "@/lib/format";
import { LibraryView } from "./LibraryView";
import { optionRows } from "./DetailPanel";
import { detail, img, out, resetMocks, svc } from "./testFixtures";

function mod(id: string, name = id): Descriptor {
  return { id, name, icon: "box", status: ModuleStatus.StatusReady, accepts: { extensions: [".png"], urls: false } } as unknown as Descriptor;
}

async function open(items = [img("e2", { path: "/lib/Erased/e2.png", name: "e2.png" })], d: ReturnType<typeof detail> | null = detail(items[0] ?? img("x"))) {
  svc.Query.mockResolvedValue({ items, nextCursor: "" });
  if (d) svc.Detail.mockResolvedValue(d);
  render(<LibraryView />);
  const card = await screen.findByRole("option", { name: items[0]?.name ?? "" });
  fireEvent.click(card);
  return screen.findByRole("complementary", { name: "Details" });
}

describe("Library detail panel", () => {
  beforeEach(() => {
    resetMocks();
    useModules.getState().setAll([mod("object-eraser", "Object Eraser"), mod("paint", "Paint+"), mod("gif", "GIF & Contact Sheet")]);
    useUI.setState({ view: "library", handoff: null });
    useLibrary.setState({ view: "grid" });
  });

  it("shows the file's details and its settings summary", async () => {
    const o = img("e2", { path: "/lib/Erased/e2.png", name: "e2.png", sizeBytes: 2048 });
    const panel = await open([o], detail(o, { summary: "Brush 40, 2 passes", width: 800, height: 600 }));
    expect(within(panel).getByRole("heading", { name: "e2.png" })).toBeTruthy();
    expect(await within(panel).findByText("Brush 40, 2 passes")).toBeTruthy();
    expect(within(panel).getByText("800 × 600")).toBeTruthy();
    expect(within(panel).getByText("Object Eraser")).toBeTruthy();
    expect(within(panel).getByText(formatBytes(2048))).toBeTruthy();
    expect(svc.Detail).toHaveBeenCalledWith("e2");
    // The folder button reveals the file.
    fireEvent.click(within(panel).getByRole("button", { name: "Erased" }));
    expect(svc.RevealPath).toHaveBeenCalledWith("/lib/Erased/e2.png");
  });

  it("falls back to the options as key/values when there's no summary", async () => {
    const o = img("e2");
    const panel = await open([o], detail(o, { options: JSON.stringify({ passes: 6, feather: 2, empty: "", nested: { a: 1 } }) }));
    expect(await within(panel).findByText("passes")).toBeTruthy();
    expect(within(panel).getByText("6")).toBeTruthy();
    expect(within(panel).queryByText("empty")).toBeNull();
    expect(within(panel).getByText('{"a":1}')).toBeTruthy();
    expect(optionRows("not json")).toEqual([]);
  });

  it("Made from: library inputs are links, outside inputs offer Reveal input; Made into links on", async () => {
    svc.Folders.mockResolvedValue({ rel: "", name: "Toolbox", path: "/lib", files: 0, registered: 0, newestMod: 0, moduleIds: [], children: [] });
    const o = img("e2");
    const next = img("e3");
    const panel = await open(
      [o],
      detail(o, { madeFrom: ["/lib/Erased/e1.png", "/Users/me/Pictures/photo.png"], madeInto: [next] }),
    );
    const from = await within(panel).findByRole("region", { name: "Made from" });
    fireEvent.click(within(from).getByRole("button", { name: "Reveal input" }));
    expect(svc.RevealPath).toHaveBeenCalledWith("/Users/me/Pictures/photo.png");
    fireEvent.click(within(panel).getByRole("button", { name: "Go to e3.png" }));
    await waitFor(() => expect(svc.Detail).toHaveBeenLastCalledWith("e3"));
    fireEvent.click(await screen.findByRole("button", { name: "Go to e1.png" }));
    await waitFor(() => expect(svc.Detail).toHaveBeenLastCalledWith("/lib/Erased/e1.png"));
  });

  it("says 'Origin unknown' when no lineage was recorded", async () => {
    const plain = img("e9", { jobId: "" });
    const panel = await open([plain], detail(plain, { madeFrom: [], unknown: true }));
    await within(panel).findByRole("region", { name: "Made from" });
    expect(within(panel).getByText("Origin unknown.")).toBeTruthy();
  });

  it("says 'No inputs recorded' for a known job without inputs", async () => {
    const o = img("e8");
    const panel = await open([o], detail(o, { madeFrom: [] }));
    await within(panel).findByRole("region", { name: "Made from" });
    expect(within(panel).getByText("No inputs recorded.")).toBeTruthy();
  });

  describe("generations", () => {
    const chain = [img("g1"), img("g2"), img("g3")];
    const mk = () => detail(chain[1] ?? img("g2"), { chain, chainAt: 1 });

    it("shows a strip across the chain with the current one marked, and a scrubber", async () => {
      const panel = await open([chain[1] ?? img("g2")], mk());
      const strip = await within(panel).findByRole("region", { name: "Generations" });
      const thumbs = within(strip).getAllByRole("button", { name: /^Generation \d/ });
      expect(thumbs).toHaveLength(3);
      expect(thumbs.map((t) => t.getAttribute("aria-current"))).toEqual([null, "true", null]);
      expect(within(strip).getByText("2 of 3")).toBeTruthy();
      const scrub = within(strip).getByLabelText("Generation") as HTMLInputElement;
      expect(scrub.max).toBe("2");
      expect(scrub.value).toBe("1");
      fireEvent.change(scrub, { target: { value: "2" } });
      await waitFor(() => expect(svc.Detail).toHaveBeenLastCalledWith("g3"));
    });

    it("has no strip for a single file", async () => {
      const panel = await open([img("solo")], detail(img("solo"), { chain: [img("solo")] }));
      await within(panel).findByRole("region", { name: "Made from" });
      expect(within(panel).queryByRole("region", { name: "Generations" })).toBeNull();
    });

    it("Open in Paint+ and Export strip hand the files off", async () => {
      const panel = await open([chain[1] ?? img("g2")], mk());
      fireEvent.click(await within(panel).findByRole("button", { name: "Open in Paint+" }));
      expect(useUI.getState().handoff).toEqual({ moduleId: "paint", inputs: ["/lib/g2.png"] });
      fireEvent.click(within(panel).getByRole("button", { name: /Export strip as GIF/ }));
      expect(useUI.getState().handoff).toEqual({ moduleId: "gif", inputs: ["/lib/g1.png", "/lib/g2.png", "/lib/g3.png"] });
    });
  });

  describe("rename", () => {
    it("renames through the service and updates the list", async () => {
      const o = img("e2", { path: "/lib/Erased/e2.png", name: "e2.png" });
      const renamed = { ...o, name: "face.png", path: "/lib/Erased/face.png" };
      svc.Rename.mockResolvedValue(renamed);
      const panel = await open([o]);
      fireEvent.click(within(panel).getByRole("button", { name: "Rename" }));
      const field = within(panel).getByLabelText("File name") as HTMLInputElement;
      expect(field.value).toBe("e2.png");
      fireEvent.change(field, { target: { value: "face.png" } });
      fireEvent.keyDown(field, { key: "Enter" });
      await waitFor(() => expect(svc.Rename).toHaveBeenCalledWith("e2", "face.png"));
      await waitFor(() => expect(screen.getAllByText("face.png").length).toBeGreaterThan(0));
      expect(useLibrary.getState().list[0]?.name).toBe("face.png");
    });

    it("keeps the editor open and says why when the service refuses", async () => {
      svc.Rename.mockRejectedValue({ code: "validation", message: "A file with that name already exists" });
      const panel = await open([img("e2")]);
      fireEvent.click(within(panel).getByRole("button", { name: "Rename" }));
      const field = within(panel).getByLabelText("File name");
      fireEvent.change(field, { target: { value: "dupe.png" } });
      fireEvent.keyDown(field, { key: "Enter" });
      await waitFor(() => expect(useToastStore.getState().toasts.some((t) => t.title.includes("already exists"))).toBe(true));
      expect(within(panel).getByLabelText("File name")).toBeTruthy();
    });

    it("Escape cancels without calling the service", async () => {
      const panel = await open([img("e2")]);
      fireEvent.click(within(panel).getByRole("button", { name: "Rename" }));
      fireEvent.keyDown(within(panel).getByLabelText("File name"), { key: "Escape" });
      expect(within(panel).queryByLabelText("File name")).toBeNull();
      expect(svc.Rename).not.toHaveBeenCalled();
    });
  });

  describe("delete", () => {
    it("asks first, naming the file and where it goes, then trashes it and says it can be restored", async () => {
      const o = img("e2", { path: "/lib/Erased/e2.png", name: "e2.png" });
      svc.Trash.mockResolvedValue({ trashed: ["/lib/Erased/e2.png"], failed: null });
      const panel = await open([o]);
      fireEvent.click(within(panel).getByRole("button", { name: "Delete" }));
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText(/Move e2\.png to the (Recycle Bin|Trash)\?/)).toBeTruthy();
      expect(within(dialog).getByText(/restore it from the (Recycle Bin|Trash)/)).toBeTruthy();
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete file" }));
      await waitFor(() => expect(svc.Trash).toHaveBeenCalledWith(["e2"], []));
      await waitFor(() => expect(screen.queryByRole("option", { name: "e2.png" })).toBeNull());
      const t = useToastStore.getState().toasts.at(-1);
      expect(t?.title).toMatch(/Moved e2\.png to the/);
      expect(t?.description).toMatch(/restore it from the/);
    });

    it("reports the files that couldn't be trashed and carries on", async () => {
      const a = img("a", { path: "/lib/a.png", name: "a.png" });
      const b = img("b", { path: "/lib/b.png", name: "b.png" });
      svc.Query.mockResolvedValue({ items: [a, b], nextCursor: "" });
      svc.Trash.mockResolvedValue({ trashed: ["/lib/a.png"], failed: { "/lib/b.png": "in use by another program" } });
      render(<LibraryView />);
      await screen.findByText("a.png");
      fireEvent.click(screen.getByRole("option", { name: "a.png" }));
      fireEvent.click(screen.getByRole("option", { name: "b.png" }), { ctrlKey: true });
      fireEvent.click(within(screen.getByRole("toolbar", { name: "Selected files" })).getByRole("button", { name: "Delete" }));
      fireEvent.click(await screen.findByRole("button", { name: "Delete 2 files" }));
      await waitFor(() => expect(useToastStore.getState().toasts.some((t) => (t.description ?? "").includes("in use by another program"))).toBe(true));
      expect(screen.queryByRole("option", { name: "a.png" })).toBeNull();
      expect(screen.getByRole("option", { name: "b.png" })).toBeTruthy();
    });

    it("Cancel leaves everything alone", async () => {
      const panel = await open([img("e2")]);
      fireEvent.click(within(panel).getByRole("button", { name: "Delete" }));
      fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
      expect(svc.Trash).not.toHaveBeenCalled();
      expect(screen.getByRole("option", { name: "e2.png" })).toBeTruthy();
    });

    it("is disabled with the reason when trashing isn't available", async () => {
      svc.TrashAvailable.mockResolvedValue(false);
      const panel = await open([img("e2")]);
      const del = within(panel).getByRole("button", { name: "Delete" });
      await waitFor(() => expect(del.getAttribute("data-tip")).toMatch(/isn't available on this computer/));
      expect(del.getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(del);
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(svc.Trash).not.toHaveBeenCalled();
    });

    it("says it isn't available yet when the backend has no trash", async () => {
      svc.TrashAvailable.mockRejectedValue({ code: "not_implemented", message: "not implemented" });
      const panel = await open([img("e2")]);
      const del = within(panel).getByRole("button", { name: "Delete" });
      await waitFor(() => expect(del.getAttribute("data-tip")).toMatch(/isn't available yet/));
    });
  });

  it("shows what it can when Detail isn't implemented yet", async () => {
    svc.Detail.mockRejectedValue({ code: "not_implemented", message: "not implemented" });
    const panel = await open([img("e2")], null);
    expect(await within(panel).findByText(/aren't available yet/)).toBeTruthy();
    expect(within(panel).getByRole("heading", { name: "e2.png" })).toBeTruthy();
  });

  it("Forget and Open work from the panel; Close hides it", async () => {
    const panel = await open([out("a", { kind: OutputKind.KindOther, path: "/lib/a.bin", name: "a.bin" })]);
    fireEvent.click(within(panel).getByRole("button", { name: "Open" }));
    expect(svc.Open).toHaveBeenCalledWith("a");
    fireEvent.click(within(panel).getByRole("button", { name: "Close details" }));
    expect(screen.queryByRole("complementary", { name: "Details" })).toBeNull();
  });

  it("is a drawer over the list when the window is narrow", async () => {
    const mm = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener: () => undefined, removeEventListener: () => undefined }) as unknown as MediaQueryList) as typeof window.matchMedia;
    try {
      const panel = await open([img("e2")]);
      expect(panel.parentElement?.className).toMatch(/detailDrawer/);
    } finally {
      window.matchMedia = mm;
    }
  });
});
