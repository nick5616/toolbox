import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", async (orig) => {
  const { libraryApiMock } = await import("./testSvc");
  return libraryApiMock(orig as never);
});
vi.mock("@/lib/events", async () => (await import("./testSvc")).eventsMock());
vi.mock("@/lib/wholeImage", () => ({ wholeImageUrl: () => Promise.resolve("blob:x"), releaseImageUrl: () => undefined }));

import { LibrarySort, ModuleStatus, OutputKind, ProjectKind, type Descriptor } from "@/lib/api";
import { useToastStore } from "@/components/toast";
import { DEFAULT_FILTERS, useLibrary } from "@/state/library";
import { useModules } from "@/state/modules";
import { useSearch } from "@/state/search";
import { useUI } from "@/state/ui";
import { LibraryView } from "./LibraryView";
import { emit } from "./testSvc";
import { clearPreviewCache } from "./previews/loader";
import { hit, img, out, page, resetMocks, search, status, svc } from "./testFixtures";

function mod(id: string, name = id): Descriptor {
  return { id, name, icon: "box", status: ModuleStatus.StatusReady, accepts: { extensions: [".png"], urls: false } } as unknown as Descriptor;
}

const video = out("v1", { path: "/lib/v1.mp4", name: "v1.mp4", kind: OutputKind.KindVideo, moduleId: "downloader" });
const pdf = out("d1", { path: "/lib/d1.pdf", name: "d1.pdf", kind: OutputKind.KindDocument, moduleId: "pdf" });

async function searching(text: string, p = page([]), opts: { installed?: boolean } = {}) {
  search.Status.mockResolvedValue(status({ installed: opts.installed ?? true }));
  search.Query.mockResolvedValue(p);
  useLibrary.setState({ filters: { ...DEFAULT_FILTERS, search: text } });
  return render(<LibraryView />);
}

const lastSearch = () => search.Query.mock.calls.at(-1)?.[0] as Record<string, unknown> & { filter: Record<string, unknown> };

describe("Library search", () => {
  beforeEach(() => {
    resetMocks();
    clearPreviewCache();
    localStorage.clear();
    useModules.getState().setAll([mod("downloader", "Downloader"), mod("object-eraser", "Object Eraser"), mod("paint", "Paint+"), mod("captions", "Caption Writer")]);
    useUI.setState({ view: "library", handoff: null });
  });

  describe("results", () => {
    it("shows strength dots, a snippet with bold words, source icons and moment/page/project badges", async () => {
      svc.Places.mockResolvedValue({ projects: [{ id: "p1", kind: ProjectKind.ProjectPaint, moduleId: "paint", name: "Sunset", thumb: "", render: "", updatedAt: 5 }], savedMasks: [] });
      await searching(
        "apple",
        page([
          hit(img("a"), { strength: "strong", score: 0.41 }),
          hit(video, { strength: "good", score: 0.2, via: ["speech"], snippet: "say \u0002apple\u0003 pie", pos: 42_000 }),
          hit(pdf, { strength: "good", score: 0.15, via: ["pdf"], snippet: "<b>x</b> \u0002apple\u0003", pos: 2 }),
          hit(null, { source: "project", projectId: "p1", path: "/support/projects/p1/thumb.jpg", strength: "maybe", score: 0.05 }),
          hit(img("n"), { strength: "name", score: 0, via: ["name"] }),
        ]),
      );
      await screen.findByRole("option", { name: "a.png" });

      // Dots: strong, good (×2), maybe; the name-only hit has none.
      expect(screen.getAllByRole("img", { name: "Strong" })).toHaveLength(1);
      expect(screen.getAllByRole("img", { name: "Good" })).toHaveLength(2);
      expect(screen.getByRole("img", { name: "Maybe" })).toBeTruthy();
      expect(screen.getByRole("img", { name: "Strong" }).getAttribute("data-tip")).toBe("Strong match (41%)");
      const nameOnly = screen.getByRole("option", { name: "n.png" });
      expect(within(nameOnly).queryByRole("img", { name: /Strong|Good|Maybe/ })).toBeNull();

      // Snippets: bold words are <mark>, markup from the file stays text.
      const snippets = screen.getAllByTestId("snippet");
      expect(snippets).toHaveLength(2);
      expect(snippets[0]?.querySelector("mark")?.textContent).toBe("apple");
      expect(snippets[1]?.textContent).toBe("<b>x</b> apple");
      expect(snippets[1]?.querySelector("b")).toBeNull();

      // Source icons and badges.
      expect(screen.getByRole("img", { name: "Found in what is said" })).toBeTruthy();
      expect(screen.getByRole("img", { name: "Found in the text of the document" })).toBeTruthy();
      expect(screen.getByText("0:42")).toBeTruthy();
      expect(screen.getByText("p. 3")).toBeTruthy();
      expect(await screen.findByText("Project")).toBeTruthy();
    });

    it("a video moment shows that frame", async () => {
      await searching("apple", page([hit(video, { via: ["speech"], snippet: "\u0002apple\u0003", pos: 42_000 })]));
      await screen.findByRole("option", { name: "v1.mp4" });
      await waitFor(() => expect(search.Frame).toHaveBeenCalledWith("/lib/v1.mp4", 42_000, 320));
    });

    it("a project hit opens its tool, with an Open project button", async () => {
      svc.Places.mockResolvedValue({ projects: [{ id: "p1", kind: ProjectKind.ProjectPaint, moduleId: "paint", name: "Sunset", thumb: "", render: "", updatedAt: 5 }], savedMasks: [] });
      await searching("sun", page([hit(null, { source: "project", projectId: "p1", path: "/support/projects/p1/thumb.jpg", kind: OutputKind.KindImage })]));
      await screen.findByRole("option", { name: "Sunset" });
      fireEvent.click(await screen.findByRole("button", { name: "Open project" }));
      expect(useToastStore.getState().toasts.some((t) => t.title.startsWith("Opened"))).toBe(true);
    });

    it("sends the Library's filters with the query, and fixes the sort to Best match", async () => {
      useLibrary.setState({ filters: { ...DEFAULT_FILTERS, search: "apple", type: "image", moduleId: "object-eraser", sort: LibrarySort.SortSize } });
      search.Status.mockResolvedValue(status());
      search.Query.mockResolvedValue(page([hit(img("a"))]));
      render(<LibraryView />);
      await screen.findByRole("option", { name: "a.png" });
      expect(lastSearch().text).toBe("apple");
      expect(lastSearch().filter).toMatchObject({ kinds: [OutputKind.KindImage], moduleId: "object-eraser" });
      fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
      const sort = screen.getByLabelText("Sort by") as HTMLSelectElement;
      expect(sort.disabled).toBe(true);
      expect(sort.options[sort.selectedIndex]?.textContent).toBe("Best match");
      const wrap = sort.closest("[aria-disabled='true']");
      expect(wrap?.getAttribute("data-tip")).toMatch(/best match/);
    });

    it("says when nothing matches, and Clear search returns to the normal list", async () => {
      svc.Query.mockResolvedValue({ items: [out("plain")], nextCursor: "" });
      await searching("zzz", page([]));
      expect(await screen.findByText('No files match "zzz"')).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
      expect(await screen.findByRole("option", { name: "plain.mp3" })).toBeTruthy();
      expect(useLibrary.getState().filters.search).toBe("");
      expect(useSearch.getState().page).toBeNull();
    });

    it("clearing the box shows the normal views exactly as before", async () => {
      svc.Query.mockResolvedValue({ items: [out("plain")], nextCursor: "" });
      await searching("apple", page([hit(img("a"))]));
      await screen.findByRole("option", { name: "a.png" });
      fireEvent.change(screen.getByLabelText("Search the library"), { target: { value: "" } });
      expect(await screen.findByRole("option", { name: "plain.mp3" })).toBeTruthy();
      expect(screen.queryByRole("option", { name: "a.png" })).toBeNull();
      expect(svc.Query.mock.calls.at(-1)?.[0]).toMatchObject({ search: "", sort: LibrarySort.SortNewest });
    });

    it("List and By tool show the same hits; Folders is one flat list with the folder under each name", async () => {
      const hits = page([hit(img("a", { path: "/lib/Erased/a.png" }), { strength: "good", score: 0.2 })]);
      useLibrary.setState({ view: "list" });
      const { unmount } = await searching("apple", hits);
      expect(await screen.findByRole("option", { name: "a.png" })).toBeTruthy();
      expect(screen.getByRole("img", { name: "Good" })).toBeTruthy();
      unmount();
      resetMocksKeepModules();
      useLibrary.setState({ view: "folders", filters: { ...DEFAULT_FILTERS, search: "apple" } });
      svc.Folders.mockResolvedValue({ rel: "", name: "Toolbox", path: "/lib", files: 1, registered: 1, newestMod: 0, moduleIds: [], children: [] });
      search.Status.mockResolvedValue(status());
      search.Query.mockResolvedValue(hits);
      render(<LibraryView />);
      const row = await screen.findByRole("option", { name: "a.png" });
      expect(within(row).getByText("Erased")).toBeTruthy();
    });
  });

  describe("label chips", () => {
    const labels = [
      { label: "apple", display: "apple", category: "food", count: 34, user: false, cover: "" },
      { label: "apple pie", display: "apple pie", category: "food", count: 2, user: false, cover: "" },
    ];

    it("lists the matching labels with counts; a click filters by that label and shows an active chip", async () => {
      await searching("app", page([hit(img("a"))], { labels }));
      const chip = await screen.findByRole("button", { name: /apple\s*34/ });
      expect(screen.getByRole("button", { name: /apple pie\s*2/ })).toBeTruthy();
      search.Query.mockResolvedValue(page([hit(img("a"))], { labels: labels.slice(0, 1) }));
      fireEvent.click(chip);
      await waitFor(() => expect(lastSearch().labels).toEqual(["apple"]));
      const active = await screen.findByRole("group", { name: "Search filters" });
      expect(within(active).getByText("apple")).toBeTruthy();
      // × removes it again.
      fireEvent.click(within(active).getByRole("button", { name: "Remove label apple" }));
      await waitFor(() => expect(lastSearch().labels).toEqual([]));
    });

    it("works with no text at all (labels alone are a query)", async () => {
      search.Status.mockResolvedValue(status());
      search.Query.mockResolvedValue(page([hit(img("a"))]));
      useSearch.setState({ labels: ["dog"], labelNames: { dog: "dog" } });
      render(<LibraryView />);
      await screen.findByRole("option", { name: "a.png" });
      expect(lastSearch()).toMatchObject({ text: "", labels: ["dog"] });
      expect(screen.getByText("dog")).toBeTruthy();
    });
  });

  describe("warming and merging", () => {
    it("shows the instant hits at once, re-asks on search:ready and keeps the selection where it was", async () => {
      const nameHit = hit(img("n"), { strength: "name", score: 0, via: ["name"] });
      await searching("apple", page([nameHit], { warming: true, concept: false }));
      const n = await screen.findByRole("option", { name: "n.png" });
      fireEvent.click(n);
      await screen.findByRole("complementary", { name: "Details" });
      expect(search.Query).toHaveBeenCalledTimes(1);

      // The vector is in: concept hits arrive and go above the name-only hit.
      search.Query.mockResolvedValue(page([hit(img("c"), { strength: "strong" }), hit(img("b"), { strength: "good", score: 0.2 }), nameHit]));
      await act(async () => {
        emit("search:ready", { text: "Apple" });
      });
      await waitFor(() => expect(screen.getAllByRole("option").map((o) => o.getAttribute("aria-label"))).toEqual(["c.png", "b.png", "n.png"]));
      expect(screen.getByRole("option", { name: "n.png" }).getAttribute("aria-selected")).toBe("true");
      expect(within(screen.getByRole("complementary", { name: "Details" })).getByRole("heading", { name: "n.png" })).toBeTruthy();
      expect(search.Query).toHaveBeenCalledTimes(2);
    });

    it("ignores search:ready for other text", async () => {
      await searching("apple", page([hit(img("a"))], { warming: true }));
      await screen.findByRole("option", { name: "a.png" });
      await act(async () => {
        emit("search:ready", { text: "banana" });
      });
      expect(search.Query).toHaveBeenCalledTimes(1);
    });
  });

  describe("Find similar", () => {
    it("asks for the look-alikes, shows a Similar to chip and Clear goes back", async () => {
      svc.Query.mockResolvedValue({ items: [img("a", { name: "a.png" })], nextCursor: "" });
      search.Status.mockResolvedValue(status());
      render(<LibraryView />);
      fireEvent.click(await screen.findByRole("option", { name: "a.png" }));
      const panel = await screen.findByRole("complementary", { name: "Details" });
      search.Query.mockResolvedValue(page([hit(img("s1")), hit(img("s2"))]));
      fireEvent.click(await within(panel).findByRole("button", { name: "Find similar" }));
      await waitFor(() => expect(lastSearch()).toMatchObject({ similar: "/lib/a.png", similarPos: -1, text: "" }));
      expect(await screen.findByTestId("similar-chip")).toBeTruthy();
      expect(screen.getByRole("option", { name: "s1.png" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Clear similar" }));
      expect(await screen.findByRole("option", { name: "a.png" })).toBeTruthy();
      expect(useSearch.getState().similar).toBeNull();
    });
  });

  describe("status line and the first-time hint", () => {
    it.each([
      [{ stage: "pictures", pending: 5, done: 1240, total: 3100 }, "Indexing pictures 1,240 of 3,100"],
      [{ stage: "text", pending: 5, done: 80, total: 300 }, "Reading text 80 of 300"],
      [{ stage: "speech", speechPending: 12, speechDone: 2, current: "/lib/meeting.mp4" }, "Transcribing 2 of 14 (meeting.mp4)"],
      [{ paused: true }, "Paused"],
      [{ waiting: true }, "Waiting for your jobs to finish"],
      [{ total: 3100 }, "Up to date · 3,100 files"],
      [{ failed: 3 }, "3 files couldn't be indexed"],
    ])("shows %j as %s", async (over, text) => {
      search.Status.mockResolvedValue(status(over));
      render(<LibraryView />);
      const line = await screen.findByTestId("search-status");
      expect(line.textContent).toContain(text);
    });

    it("updates from search:status events and a click opens Settings → Search", async () => {
      search.Status.mockResolvedValue(status());
      render(<LibraryView />);
      await screen.findByText(/Up to date/);
      await act(async () => {
        emit("search:status", status({ stage: "pictures", pending: 9, done: 1, total: 10 }));
      });
      const btn = await screen.findByRole("button", { name: /Indexing pictures 1 of 10/ });
      fireEvent.click(btn);
      expect(useUI.getState().view).toBe("settings");
    });

    it("Paused has a Resume that turns indexing back on", async () => {
      search.Status.mockResolvedValue(status({ paused: true }));
      search.Settings.mockResolvedValue({ enabled: true, paused: true, readText: true, speech: true, speechMaxMin: 60, skip: [] });
      render(<LibraryView />);
      fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
      await waitFor(() => expect(search.SetSettings).toHaveBeenCalledWith(expect.objectContaining({ paused: false })));
    });

    it("lists the files that couldn't be indexed with their reasons, and Retry", async () => {
      search.Status.mockResolvedValue(status({ failed: 2 }));
      search.Failures.mockResolvedValue([
        { path: "/lib/a.pdf", reason: "password protected", state: "failed", stage: "text", attempts: 3, at: 1 },
        { path: "/lib/b.mp4", reason: "needs FFmpeg", state: "failed", stage: "pictures", attempts: 1, at: 2 },
      ]);
      render(<LibraryView />);
      fireEvent.click(await screen.findByRole("button", { name: "Show" }));
      expect(search.Failures).toHaveBeenCalledWith(100);
      const dlg = await screen.findByRole("dialog");
      expect(await within(dlg).findByText("password protected")).toBeTruthy();
      expect(within(dlg).getByText("needs FFmpeg")).toBeTruthy();
      fireEvent.click(within(dlg).getAllByRole("button", { name: "Retry" })[0] as HTMLElement);
      await waitFor(() => expect(search.Retry).toHaveBeenCalledWith(["/lib/a.pdf"]));
    });

    it("not installed: the box's hint row is the install gate with the Smart search pack button", async () => {
      const { usePacks } = await import("@/state/packs");
      const { PackState } = await import("@/lib/api");
      usePacks.getState().setAll([{ id: "search", name: "Smart search", icon: "scan-eye", description: "", state: PackState.PackMissing, unsupportedReason: "", components: [], unlocks: [], jobId: "" } as never]);
      search.Status.mockResolvedValue(status({ installed: false }));
      render(<LibraryView />);
      await screen.findByTestId("search-status");
      fireEvent.focus(screen.getByLabelText("Search the library"));
      const gate = await screen.findByTestId("search-gate");
      expect(within(gate).getByText("Search by what's in your pictures and what your files say")).toBeTruthy();
      fireEvent.click(within(gate).getByRole("button", { name: /Install Smart search/ }));
      await waitFor(() => expect(search.PacksInstall).toHaveBeenCalledWith(["search"], ""));
      expect(search.Warm).toHaveBeenCalledTimes(1);
    });

    it("installed: focusing an empty box warms the vector (once a minute) and shows the Try hint", async () => {
      search.Status.mockResolvedValue(status());
      render(<LibraryView />);
      await screen.findByTestId("search-status");
      const box = screen.getByLabelText("Search the library");
      fireEvent.focus(box);
      const hint = await screen.findByTestId("search-hint");
      expect(hint.textContent).toBe("Try: apple, dog on a beach, receipt");
      fireEvent.blur(box);
      fireEvent.focus(box);
      expect(search.Warm).toHaveBeenCalledTimes(1);
      fireEvent.click(within(screen.getByTestId("search-hint")).getByRole("button", { name: "receipt" }));
      expect((box as HTMLInputElement).value).toBe("receipt");
    });

    it("the placeholder says what the box searches", () => {
      render(<LibraryView />);
      expect(screen.getByPlaceholderText("Search names, what's in pictures and what files say")).toBeTruthy();
    });
  });

  describe("at 960 × 600", () => {
    it("moves the status line into the Filters drawer", async () => {
      const mm = window.matchMedia;
      window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener: () => undefined, removeEventListener: () => undefined }) as unknown as MediaQueryList) as typeof window.matchMedia;
      try {
        search.Status.mockResolvedValue(status({ total: 42 }));
        render(<LibraryView />);
        await waitFor(() => expect(useSearch.getState().statusLoaded).toBe(true));
        expect(screen.queryByTestId("search-status")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
        expect((await screen.findByTestId("search-status")).textContent).toContain("Up to date · 42 files");
      } finally {
        window.matchMedia = mm;
      }
    });
  });

  describe("palette", () => {
    it("registers the search commands", async () => {
      search.Status.mockResolvedValue(status());
      render(<LibraryView />);
      const { useCommandRegistry } = await import("@/lib/commands");
      await waitFor(() => expect(useCommandRegistry.getState().commands["search.focus"]).toBeTruthy());
      const cmds = useCommandRegistry.getState().commands;
      expect(cmds["search.focus"]?.title).toBe("Search pictures and text for…");
      expect(cmds["search.similar"]?.title).toBe("Find similar to selected");
      expect(cmds["search.toggle-pause"]?.title).toBe("Pause indexing");
      cmds["search.focus"]?.run();
      await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Search the library")));
    });
  });
});

/** After an unmount in one test: reset mocks but keep the modules the tests registered. */
function resetMocksKeepModules(): void {
  resetMocks();
}
