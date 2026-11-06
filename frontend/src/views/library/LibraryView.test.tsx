import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", async (orig) => {
  const { libraryApiMock } = await import("./testSvc");
  return libraryApiMock(orig as never);
});
vi.mock("@/lib/wholeImage", () => ({ wholeImageUrl: () => Promise.resolve("blob:x"), releaseImageUrl: () => undefined }));

import { LibrarySort, ModuleStatus, OutputKind, type Descriptor } from "@/lib/api";
import { useToastStore } from "@/components/toast";
import { PATHS_MIME } from "@/lib/fileDrag";
import { revealLabel } from "@/lib/platform";
import { useLibrary } from "@/state/library";
import { useModules } from "@/state/modules";
import { useUI } from "@/state/ui";
import { LibraryView } from "./LibraryView";
import { entry, folder, img, notImplemented, out, project, resetMocks, svc } from "./testFixtures";

function mod(id: string, name = `Mod ${id}`): Descriptor {
  return { id, name, icon: "box", status: ModuleStatus.StatusReady, accepts: { extensions: [], urls: false } } as unknown as Descriptor;
}

async function show(items = [out("a"), out("b", { missing: true })], view: "grid" | "list" | "folders" | "bytool" = "grid") {
  svc.Query.mockResolvedValue({ items, nextCursor: "" });
  useLibrary.setState({ view });
  const r = render(<LibraryView />);
  if (view !== "folders" && items.length > 0) await screen.findByText(items[0]?.name ?? "");
  return r;
}

const lastQuery = () => svc.Query.mock.calls.at(-1)?.[0] as Record<string, unknown>;

describe("LibraryView", () => {
  beforeEach(() => {
    resetMocks();
    useModules.getState().setAll([mod("downloader", "Downloader"), mod("object-eraser", "Object Eraser"), mod("stems", "Stems")]);
    useUI.setState({ view: "library", handoff: null });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("views from fixtures", () => {
    it("Grid (the default) renders cards and flags missing files", async () => {
      await show();
      const cards = screen.getAllByRole("option");
      expect(cards).toHaveLength(2);
      expect(screen.getByText("MISSING")).toBeTruthy();
      expect(screen.getByRole("listbox", { name: "Outputs" })).toBeTruthy();
      // Missing files can't be sent anywhere.
      expect(within(cards[1] as HTMLElement).queryByRole("button", { name: "Send to…" })).toBeNull();
    });

    it("List renders dense rows with a disabled Reveal for missing files", async () => {
      await show(undefined, "list");
      const reveals = screen.getAllByRole("button", { name: revealLabel });
      expect((reveals[0] as HTMLButtonElement).getAttribute("aria-disabled")).toBeNull();
      expect((reveals[1] as HTMLButtonElement).getAttribute("aria-disabled")).toBe("true");
      expect(screen.getByText("MISSING")).toBeTruthy();
    });

    it("Folders shows the tree with counts and the folder's files, dimming files no job made", async () => {
      svc.Folders.mockResolvedValue(folder("Toolbox", 1, [folder("Erased", 27, [], { rel: "Erased", registered: 27 })]));
      svc.ListDir.mockResolvedValue({
        entries: [entry("one.png", { output: img("one", { path: "/lib/Erased/one.png", name: "one.png" }) }), entry("loose.png")],
        truncated: false,
      });
      useLibrary.setState({ view: "folders", folder: "Erased" });
      render(<LibraryView />);
      await screen.findByText("loose.png");
      const tree = screen.getByRole("navigation", { name: "Folders" });
      expect(within(tree).getByText("Erased")).toBeTruthy();
      expect(within(tree).getByText("27")).toBeTruthy();
      expect(svc.ListDir).toHaveBeenCalledWith("Erased", 5000);
      // Only the unregistered file carries the dot.
      expect(screen.getAllByRole("img", { name: "Not from a job" })).toHaveLength(1);
      fireEvent.click(within(tree).getByRole("treeitem", { name: /Toolbox/ }));
      await waitFor(() => expect(svc.ListDir).toHaveBeenLastCalledWith("", 5000));
    });

    it("Folders opens a sub-folder from its card and warns about 5000+ entries", async () => {
      svc.ListDir.mockResolvedValue({ entries: [entry("Sub", { isDir: true, rel: "Sub", path: "/lib/Sub", kind: OutputKind.KindOther })], truncated: true });
      useLibrary.setState({ view: "folders" });
      render(<LibraryView />);
      const card = await screen.findByRole("option", { name: "Sub" });
      expect(screen.getByText(/more than 5000 entries/)).toBeTruthy();
      fireEvent.doubleClick(card);
      await waitFor(() => expect(svc.ListDir).toHaveBeenLastCalledWith("Sub", 5000));
    });

    it("Folders collapses the tree into a breadcrumb when narrow", async () => {
      const mm = window.matchMedia;
      window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener: () => undefined, removeEventListener: () => undefined }) as unknown as MediaQueryList) as typeof window.matchMedia;
      try {
        svc.Folders.mockResolvedValue(folder("Toolbox", 0, [folder("Erased", 3, [], { rel: "Erased" })]));
        useLibrary.setState({ view: "folders", folder: "Erased" });
        render(<LibraryView />);
        const crumbs = await screen.findByRole("navigation", { name: "Folder path" });
        await waitFor(() => expect(within(crumbs).getByText("Erased")).toBeTruthy());
        expect(screen.queryByRole("navigation", { name: "Folders" })).toBeNull();
      } finally {
        window.matchMedia = mm;
      }
    });

    it("By tool: a section per tool with its first 12 files and Show all", async () => {
      const items = [...Array.from({ length: 14 }, (_, i) => img(`e${i}`, { createdAt: 5000 - i })), out("d1", { createdAt: 1 })];
      await show(items, "bytool");
      const eraser = screen.getByRole("region", { name: "Object Eraser" });
      expect(within(eraser).getAllByRole("option")).toHaveLength(12);
      const dl = screen.getByRole("region", { name: "Downloader" });
      expect(within(dl).getAllByRole("option")).toHaveLength(1);
      expect(within(dl).queryByRole("button", { name: /Show all/ })).toBeNull();
      fireEvent.click(within(eraser).getByRole("button", { name: "Show all 14" }));
      expect(useLibrary.getState().filters.moduleId).toBe("object-eraser");
      expect(useLibrary.getState().view).toBe("grid");
    });

    it("By tool: Open folder and Open tool", async () => {
      svc.Folders.mockResolvedValue(folder("Toolbox", 0, [folder("Erased", 3, [], { rel: "Erased", moduleIds: ["object-eraser"] })]));
      await show([img("e1")], "bytool");
      const eraser = screen.getByRole("region", { name: "Object Eraser" });
      await waitFor(() => expect(within(eraser).getByText("Erased")).toBeTruthy());
      fireEvent.click(within(eraser).getByRole("button", { name: "Open folder" }));
      expect(svc.OpenLibraryFolder).toHaveBeenCalledWith("Erased");
      fireEvent.click(within(eraser).getByRole("button", { name: "Open tool" }));
      expect(useUI.getState().view).toBe("object-eraser");
    });

    it("Other places: projects, saved masks and Received by device", async () => {
      svc.Folders.mockResolvedValue(folder("Toolbox", 0, [folder("Received", 0, [folder("Pixel 8", 4, [], { rel: "Received/Pixel 8" })], { rel: "Received" })]));
      svc.Places.mockResolvedValue({ projects: [project], savedMasks: [{ id: "m1", name: "Sky", width: 10, height: 20, createdAt: 1 }] });
      await show([img("e1")], "bytool");
      const places = await screen.findByRole("region", { name: "Other places" });
      await within(places).findByRole("button", { name: "Open project Sunset" });
      fireEvent.click(within(places).getByRole("button", { name: "Open saved mask Sky" }));
      expect(useUI.getState().view).toBe("object-eraser");
      fireEvent.click(within(places).getByRole("button", { name: "Received from Pixel 8" }));
      expect(useLibrary.getState().folder).toBe("Received/Pixel 8");
      expect(useLibrary.getState().view).toBe("folders");
    });

    it("Places says so when the backend can't list them yet", async () => {
      svc.Places.mockRejectedValue(notImplemented());
      await show([img("e1")], "bytool");
      await screen.findByText(/can't be listed yet/);
    });

    it("remembers the view and card size", async () => {
      await show();
      fireEvent.click(screen.getByRole("radio", { name: "List" }));
      fireEvent.click(screen.getByRole("radio", { name: "By tool" }));
      expect(JSON.parse(localStorage.getItem("toolbox.library") ?? "{}")).toMatchObject({ view: "bytool" });
      fireEvent.click(screen.getByRole("radio", { name: "L" }));
      expect(useLibrary.getState().size).toBe("l");
    });
  });

  describe("server filters", () => {
    it("asks Query for the first page with the defaults", async () => {
      await show();
      expect(lastQuery()).toMatchObject({ moduleId: "", search: "", kinds: [], since: 0, sort: LibrarySort.SortNewest, folder: "", limit: 100, cursor: "" });
    });

    it("type chips become kinds", async () => {
      await show();
      fireEvent.click(screen.getByRole("radio", { name: "Video" }));
      await waitFor(() => expect(lastQuery().kinds).toEqual([OutputKind.KindVideo]));
      fireEvent.click(screen.getByRole("radio", { name: "Other" }));
      await waitFor(() => expect(lastQuery().kinds).toEqual([OutputKind.KindOther]));
    });

    it("tool, date range and sort go to the server", async () => {
      await show();
      fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
      fireEvent.change(screen.getByLabelText("Filter by tool"), { target: { value: "stems" } });
      await waitFor(() => expect(lastQuery().moduleId).toBe("stems"));
      fireEvent.change(screen.getByLabelText("Filter by date"), { target: { value: "today" } });
      await waitFor(() => expect(Number(lastQuery().since)).toBeGreaterThan(0));
      fireEvent.change(screen.getByLabelText("Sort by"), { target: { value: "size" } });
      await waitFor(() => expect(lastQuery().sort).toBe(LibrarySort.SortSize));
      expect(screen.getByRole("button", { name: /Filters/ }).textContent).toContain("Stems");
    });

    it("debounces search into one query", async () => {
      await show();
      vi.useFakeTimers();
      const before = svc.Query.mock.calls.length;
      fireEvent.change(screen.getByLabelText("Search outputs"), { target: { value: "cat" } });
      expect(svc.Query.mock.calls.length).toBe(before);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      expect(lastQuery().search).toBe("cat");
      expect(svc.Query.mock.calls.length).toBe(before + 1);
    });

    it("pages with Load more", async () => {
      svc.Query.mockResolvedValueOnce({ items: [out("a")], nextCursor: "c1" }).mockResolvedValueOnce({ items: [out("z")], nextCursor: "" });
      render(<LibraryView />);
      await screen.findByText("a.mp3");
      fireEvent.click(screen.getByRole("button", { name: "Load more" }));
      await screen.findByText("z.mp3");
      expect(lastQuery().cursor).toBe("c1");
    });
  });

  describe("when the backend isn't ready", () => {
    it("falls back to Recent for the list and says so", async () => {
      svc.Query.mockRejectedValue(notImplemented());
      svc.Recent.mockResolvedValue({ items: [out("a"), img("b", { moduleId: "object-eraser" })], nextCursor: "" });
      render(<LibraryView />);
      await screen.findByText("a.mp3");
      expect(screen.getByText(/recent files only/)).toBeTruthy();
      // Kinds the Recent call doesn't know are applied here.
      fireEvent.click(screen.getByRole("radio", { name: "Images" }));
      await waitFor(() => expect(screen.queryByText("a.mp3")).toBeNull());
      expect(screen.getByText("b.png")).toBeTruthy();
      expect(svc.Recent).toHaveBeenCalled();
    });

    it("Folders says it isn't available yet", async () => {
      svc.Folders.mockRejectedValue(notImplemented());
      svc.ListDir.mockRejectedValue(notImplemented());
      useLibrary.setState({ view: "folders" });
      render(<LibraryView />);
      await screen.findByText(/folder view isn't available yet/);
    });
  });

  describe("forget", () => {
    it("hides now with an Undo window, then removes through the service", async () => {
      await show();
      vi.useFakeTimers();
      fireEvent.click(screen.getAllByRole("button", { name: "Forget" })[0] as HTMLElement);
      expect(screen.queryByText("a.mp3")).toBeNull();
      expect(svc.Remove).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6100);
      });
      expect(svc.Remove).toHaveBeenCalledWith("a");
    });

    it("Undo brings a forgotten entry back without removing it", async () => {
      await show();
      vi.useFakeTimers();
      fireEvent.click(screen.getAllByRole("button", { name: "Forget" })[0] as HTMLElement);
      const t = useToastStore.getState().toasts.at(-1);
      expect(t?.action?.label).toBe("Undo");
      act(() => t?.action?.onClick());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(7000);
      });
      expect(screen.getByText("a.mp3")).toBeTruthy();
      expect(svc.Remove).not.toHaveBeenCalled();
    });
  });

  describe("multi-select", () => {
    const card = (n: string) => screen.getByRole("option", { name: `${n}.mp3` });
    const sel = () => screen.getAllByRole("option").filter((o) => o.getAttribute("aria-selected") === "true").length;
    beforeEach(async () => {
      await show([out("a"), out("b"), out("c")]);
    });

    it("click, Mod-click and Shift-click build a selection with a bulk bar", () => {
      fireEvent.click(card("a"));
      expect(sel()).toBe(1);
      expect(screen.queryByRole("toolbar", { name: "Selected files" })).toBeNull();
      fireEvent.click(card("c"), { ctrlKey: true });
      expect(sel()).toBe(2);
      expect(screen.getByText("2 selected")).toBeTruthy();
      fireEvent.click(card("a"));
      fireEvent.click(card("c"), { shiftKey: true });
      expect(sel()).toBe(3);
    });

    it("Mod+A selects everything and bulk Forget hides them all", async () => {
      fireEvent.keyDown(window, { key: "a", ctrlKey: true });
      fireEvent.keyDown(window, { key: "a", metaKey: true });
      expect(sel()).toBe(3);
      vi.useFakeTimers();
      fireEvent.click(within(screen.getByRole("toolbar", { name: "Selected files" })).getByRole("button", { name: "Forget" }));
      expect(screen.queryAllByRole("option")).toHaveLength(0);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6100);
      });
      expect(svc.Remove).toHaveBeenCalledTimes(3);
    });

    it("dragging a selected card carries every selected file", () => {
      fireEvent.click(card("a"));
      fireEvent.click(card("b"), { ctrlKey: true });
      const data: Record<string, string> = {};
      const dataTransfer = { setData: (k: string, v: string) => (data[k] = v), types: [] as string[], effectAllowed: "" };
      fireEvent.dragStart(card("a"), { dataTransfer });
      expect(JSON.parse(data[PATHS_MIME] ?? "[]")).toEqual(["/lib/a.mp3", "/lib/b.mp3"]);
      fireEvent.dragStart(card("c"), { dataTransfer });
      expect(JSON.parse(data[PATHS_MIME] ?? "[]")).toEqual(["/lib/c.mp3"]);
    });

    it("bulk Save copies sends the output ids to SaveCopies", async () => {
      fireEvent.click(card("a"));
      fireEvent.click(card("b"), { ctrlKey: true });
      fireEvent.click(screen.getByRole("button", { name: "Save copies to a folder…" }));
      await waitFor(() => expect(svc.SaveCopies).toHaveBeenCalledWith(["a", "b"]));
      await waitFor(() => expect(useToastStore.getState().toasts.some((t) => t.title.includes("2 copies"))).toBe(true));
    });

    it("bulk Reveal shows every selected file", () => {
      fireEvent.click(card("a"));
      fireEvent.click(card("b"), { ctrlKey: true });
      const bar = screen.getByRole("toolbar", { name: "Selected files" });
      fireEvent.click(within(bar).getByRole("button", { name: revealLabel }));
      expect(svc.Reveal).toHaveBeenCalledWith("a");
      expect(svc.Reveal).toHaveBeenCalledWith("b");
    });

    it("bulk Send to lists the tools that accept the files", async () => {
      svc.Match.mockResolvedValue({ matches: [{ module: mod("stems"), paths: ["/lib/a.mp3", "/lib/b.mp3"] }], unmatched: null });
      fireEvent.click(card("a"));
      fireEvent.click(card("b"), { ctrlKey: true });
      const bar = screen.getByRole("toolbar", { name: "Selected files" });
      fireEvent.click(within(bar).getByRole("button", { name: "Send to…" }));
      await waitFor(() => expect(svc.Match).toHaveBeenCalledWith(["/lib/a.mp3", "/lib/b.mp3"]));
      fireEvent.click(await screen.findByRole("menuitem", { name: "Open in Mod stems (2 files)" }));
      expect(useUI.getState().handoff).toEqual({ moduleId: "stems", inputs: ["/lib/a.mp3", "/lib/b.mp3"] });
    });

    it("bulk Delete confirms with the count, then trashes the ids", async () => {
      svc.Trash.mockResolvedValue({ trashed: ["/lib/a.mp3", "/lib/b.mp3"], failed: null });
      fireEvent.click(card("a"));
      fireEvent.click(card("b"), { ctrlKey: true });
      fireEvent.click(within(screen.getByRole("toolbar", { name: "Selected files" })).getByRole("button", { name: "Delete" }));
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText(/Move 2 files to the/)).toBeTruthy();
      expect(svc.Trash).not.toHaveBeenCalled();
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete 2 files" }));
      await waitFor(() => expect(svc.Trash).toHaveBeenCalledWith(["a", "b"], []));
      await waitFor(() => expect(screen.queryByText("a.mp3")).toBeNull());
      expect(screen.getByText("c.mp3")).toBeTruthy();
      expect(useToastStore.getState().toasts.at(-1)?.description).toMatch(/restore them from the/);
    });
  });

  describe("keyboard", () => {
    beforeEach(async () => {
      await show([out("a"), out("b"), out("c")]);
    });

    it("arrows move the selection, Enter opens, Delete confirms, F2 starts a rename", async () => {
      const a = screen.getByRole("option", { name: "a.mp3" });
      fireEvent.click(a);
      a.focus();
      fireEvent.keyDown(a, { key: "ArrowRight" });
      expect(screen.getByRole("option", { name: "b.mp3" }).getAttribute("aria-selected")).toBe("true");
      expect(a.getAttribute("aria-selected")).toBe("false");
      const b = screen.getByRole("option", { name: "b.mp3" });
      fireEvent.keyDown(b, { key: "Enter" });
      await waitFor(() => expect(svc.Open).toHaveBeenCalledWith("b"));
      fireEvent.keyDown(b, { key: "Delete" });
      expect(await screen.findByRole("dialog")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(svc.Trash).not.toHaveBeenCalled();
      fireEvent.keyDown(b, { key: "F2" });
      expect(await screen.findByLabelText("File name")).toBeTruthy();
    });

    it("Space toggles the details of the focused file", async () => {
      const a = screen.getByRole("option", { name: "a.mp3" });
      fireEvent.keyDown(a, { key: " " });
      expect(await screen.findByRole("complementary", { name: "Details" })).toBeTruthy();
      fireEvent.keyDown(a, { key: " " });
      expect(screen.queryByRole("complementary", { name: "Details" })).toBeNull();
    });
  });

  describe("live updates", () => {
    it("library:added puts a new output at the top; library:removed drops it", async () => {
      await show([out("a")]);
      act(() => useLibrary.getState().add(out("new", { name: "new.mp3" })));
      expect(screen.getAllByRole("option").map((o) => o.getAttribute("aria-label"))).toEqual(["new.mp3", "a.mp3"]);
      act(() => useLibrary.getState().removeLocal(["a"]));
      expect(screen.queryByText("a.mp3")).toBeNull();
    });

    it("an added output the filters exclude doesn't show", async () => {
      await show([out("a")]);
      fireEvent.click(screen.getByRole("radio", { name: "Video" }));
      await waitFor(() => expect(lastQuery().kinds).toEqual([OutputKind.KindVideo]));
      act(() => useLibrary.getState().add(out("new")));
      expect(screen.queryByText("new.mp3")).toBeNull();
    });

    it("Refresh rescans the folders", async () => {
      useLibrary.setState({ view: "folders" });
      render(<LibraryView />);
      await waitFor(() => expect(svc.Folders).toHaveBeenCalledTimes(1));
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
      await waitFor(() => expect(svc.Folders).toHaveBeenCalledTimes(2));
    });
  });
});
