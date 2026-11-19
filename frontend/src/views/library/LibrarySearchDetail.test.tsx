import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ seek: vi.fn(), copy: vi.fn(), openTool: vi.fn() }));

vi.mock("@/lib/api", async (orig) => {
  const { libraryApiMock } = await import("./testSvc");
  const m = await libraryApiMock(orig as never);
  return { ...m, ClipboardService: { ...(m as unknown as { ClipboardService: object }).ClipboardService, CopyText: h.copy } };
});
vi.mock("@/lib/events", async () => (await import("./testSvc")).eventsMock());
vi.mock("@/lib/wholeImage", () => ({ wholeImageUrl: () => Promise.resolve("blob:x"), releaseImageUrl: () => undefined }));
vi.mock("@/lib/openTool", () => ({ openTool: h.openTool, openToolItems: vi.fn() }));
vi.mock("@/components/media", async (orig) => {
  const actual = await orig<typeof import("@/components/media")>();
  const React = await import("react");
  return {
    ...actual,
    useMediaSource: () => ({ status: "ready", source: { url: "/media/x/y.mp4", info: {} }, error: null }),
    MediaPlayer: React.forwardRef(function Player(_p: object, ref: React.Ref<unknown>) {
      React.useImperativeHandle(ref, () => ({ seek: h.seek, play: vi.fn(), pause: vi.fn() }));
      return React.createElement("div", { "data-testid": "player" });
    }),
  };
});

import { ModuleStatus, OutputKind, type Descriptor, type LabelCount } from "@/lib/api";
import { DEFAULT_FILTERS, useLibrary } from "@/state/library";
import { useModules } from "@/state/modules";
import { useSearch } from "@/state/search";
import { useUI } from "@/state/ui";
import { LibraryView } from "./LibraryView";
import { clearPreviewCache } from "./previews/loader";
import { hit, img, out, page, resetMocks, search, status, svc } from "./testFixtures";

function mod(id: string, name = id): Descriptor {
  return { id, name, icon: "box", status: ModuleStatus.StatusReady, accepts: { extensions: [], urls: false } } as unknown as Descriptor;
}

const video = out("v1", { path: "/lib/v1.mp4", name: "v1.mp4", kind: OutputKind.KindVideo, moduleId: "downloader" });
const pdf = out("d1", { path: "/lib/d1.pdf", name: "d1.pdf", kind: OutputKind.KindDocument, moduleId: "pdf" });

async function openHit(output = img("a"), over: Parameters<typeof hit>[1] = {}, installed = true) {
  search.Status.mockResolvedValue(status({ installed }));
  search.Query.mockResolvedValue(page([hit(output, over)]));
  useLibrary.setState({ filters: { ...DEFAULT_FILTERS, search: "apple" } });
  render(<LibraryView />);
  fireEvent.click(await screen.findByRole("option", { name: output.name }));
  return screen.findByRole("complementary", { name: "Details" });
}

const lastSearch = () => search.Query.mock.calls.at(-1)?.[0] as Record<string, unknown>;

describe("Library detail panel, Smart search sections", () => {
  beforeEach(() => {
    resetMocks();
    clearPreviewCache();
    localStorage.clear();
    h.seek.mockReset();
    h.copy.mockReset().mockResolvedValue(undefined);
    h.openTool.mockReset().mockResolvedValue(undefined);
    useModules.getState().setAll([mod("downloader", "Downloader"), mod("captions", "Caption Writer")]);
    useUI.setState({ view: "library", handoff: null });
  });

  describe("In this picture", () => {
    const labels = [
      { label: "apple", display: "apple", source: "auto", score: 0.9, pos: -1 },
      { label: "mine", display: "mine", source: "user", score: 1, pos: -1 },
      { label: "secret", display: "secret", source: "hidden", score: 0.8, pos: -1 },
    ];

    it("shows auto and your labels (yours with a dot), never hidden ones; × hides, a click filters", async () => {
      search.Labels.mockResolvedValue(labels);
      const panel = await openHit();
      const section = await within(panel).findByRole("region", { name: "In this picture" });
      expect(await within(section).findByText("apple")).toBeTruthy();
      expect(within(section).getByText("mine")).toBeTruthy();
      expect(within(section).queryByText("secret")).toBeNull();
      expect(within(section).getAllByTestId("user-dot")).toHaveLength(1);
      expect(within(section).getByText("apple").closest("button")?.getAttribute("data-tip")).toContain("90%");

      search.Labels.mockResolvedValue(labels.slice(1));
      fireEvent.click(within(section).getByRole("button", { name: "Remove label apple" }));
      await waitFor(() => expect(search.SetLabel).toHaveBeenCalledWith("/lib/a.png", "apple", false));
      await waitFor(() => expect(within(section).queryByText("apple")).toBeNull());

      fireEvent.click(within(section).getByText("mine"));
      await waitFor(() => expect(lastSearch().labels).toEqual(["mine"]));
    });

    it("caps auto labels at 8", async () => {
      search.Labels.mockResolvedValue(Array.from({ length: 12 }, (_, i) => ({ label: `l${i}`, display: `lab${i}`, source: "auto", score: 1 - i / 20, pos: -1 })));
      const panel = await openHit();
      const section = await within(panel).findByRole("region", { name: "In this picture" });
      await within(section).findByText("lab0");
      expect(within(section).getAllByRole("button", { name: /^Remove label/ })).toHaveLength(8);
    });

    it("+ Label: completions from the vocabulary and your labels, free text, vocabulary names resolve to their id", async () => {
      search.Labels.mockResolvedValue([]);
      const things: LabelCount[] = [
        { label: "apple_id", display: "apple", category: "food", count: 5, user: false, cover: "" },
        { label: "apple pie", display: "apple pie", category: "", count: 2, user: true, cover: "" },
      ];
      search.Things.mockResolvedValue(things);
      const panel = await openHit();
      const section = await within(panel).findByRole("region", { name: "In this picture" });
      fireEvent.click(within(section).getByRole("button", { name: "Label" }));
      const input = within(section).getByLabelText("New label") as HTMLInputElement;
      expect(input.maxLength).toBe(40);
      fireEvent.change(input, { target: { value: "app" } });
      const list = await within(section).findByRole("listbox", { name: "Label suggestions" });
      expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual(["apple pie", "apple"]);
      fireEvent.click(within(list).getByRole("option", { name: "apple pie" }));
      await waitFor(() => expect(search.SetLabel).toHaveBeenCalledWith("/lib/a.png", "apple pie", true));

      // Free text and Enter.
      fireEvent.click(await within(section).findByRole("button", { name: "Label" }));
      const again = within(section).getByLabelText("New label");
      fireEvent.change(again, { target: { value: "my trip" } });
      fireEvent.keyDown(again, { key: "Enter" });
      await waitFor(() => expect(search.SetLabel).toHaveBeenCalledWith("/lib/a.png", "my trip", true));

      // A vocabulary word typed out is the vocabulary label.
      fireEvent.click(await within(section).findByRole("button", { name: "Label" }));
      const third = within(section).getByLabelText("New label");
      fireEvent.change(third, { target: { value: "Apple" } });
      fireEvent.keyDown(third, { key: "Enter" });
      await waitFor(() => expect(search.SetLabel).toHaveBeenCalledWith("/lib/a.png", "apple_id", true));
    });

    it("isn't shown when Smart search isn't installed", async () => {
      const panel = await openHit(img("a"), {}, false);
      expect(within(panel).queryByRole("region", { name: "In this picture" })).toBeNull();
      expect(within(panel).queryByRole("button", { name: "Find similar" })).toBeNull();
    });
  });

  describe("Text in this file", () => {
    const speech = [
      { source: "speech", pos: 12_000, endPos: 20_000, text: "hello apple pie" },
      { source: "speech", pos: 65_000, endPos: 70_000, text: "bye now" },
    ];

    it("groups by source, stamps speech lines, highlights the search words and seeks the player on a click", async () => {
      search.Texts.mockResolvedValue(speech);
      const panel = await openHit(video, { via: ["speech"], snippet: "\u0002apple\u0003", pos: 12_000, kind: OutputKind.KindVideo });
      const box = await within(panel).findByTestId("found-text");
      expect(within(box).getByText("What is said")).toBeTruthy();
      expect(within(box).getByText("[0:12]")).toBeTruthy();
      expect(within(box).getByText("[1:05]")).toBeTruthy();
      expect(box.querySelector("mark")?.textContent).toBe("apple");
      // Opened from a hit with a position: the player starts there.
      await waitFor(() => expect(h.seek).toHaveBeenCalledWith(12_000));
      h.seek.mockClear();
      fireEvent.click(within(box).getByText("bye now").closest("button") as HTMLElement);
      await waitFor(() => expect(h.seek).toHaveBeenCalledWith(65_000));
    });

    it("lists up to 5 other moments and a click seeks there", async () => {
      const panel = await openHit(video, { via: ["speech"], pos: 1_000, moments: [5_000, 9_000, 61_000, 70_000, 80_000, 99_000], kind: OutputKind.KindVideo });
      const sect = await within(panel).findByRole("region", { name: "Other moments" });
      expect(within(sect).getAllByRole("button").map((b) => b.textContent)).toEqual(["0:05", "0:09", "1:01", "1:10", "1:20"]);
      h.seek.mockClear();
      fireEvent.click(within(sect).getByRole("button", { name: "1:01" }));
      await waitFor(() => expect(h.seek).toHaveBeenCalledWith(61_000));
    });

    it("Copy, Save as .txt, Save as .srt (speech only) and Read again", async () => {
      search.Texts.mockResolvedValue(speech);
      search.SaveText.mockResolvedValue("/dest/v1.txt");
      const panel = await openHit(video, { via: ["speech"], pos: 0, kind: OutputKind.KindVideo });
      await within(panel).findByTestId("found-text");
      fireEvent.click(within(panel).getByRole("button", { name: "Copy" }));
      await waitFor(() => expect(h.copy).toHaveBeenCalledWith("[0:12] hello apple pie\n[1:05] bye now"));
      fireEvent.click(within(panel).getByRole("button", { name: "Save as .txt…" }));
      await waitFor(() => expect(search.SaveText).toHaveBeenCalledWith("/lib/v1.mp4", "txt"));
      fireEvent.click(within(panel).getByRole("button", { name: "Save as .srt…" }));
      await waitFor(() => expect(search.SaveText).toHaveBeenCalledWith("/lib/v1.mp4", "srt"));
      fireEvent.click(within(panel).getByRole("button", { name: "Read again" }));
      await waitFor(() => expect(search.ReadAgain).toHaveBeenCalledWith("/lib/v1.mp4"));
    });

    it("a picture's OCR text has no .srt", async () => {
      search.Texts.mockResolvedValue([{ source: "ocr", pos: -1, endPos: -1, text: "TOTAL 4471" }]);
      const panel = await openHit(img("a"), { via: ["ocr"] });
      const box = await within(panel).findByTestId("found-text");
      expect(within(box).getByText("Text in the picture")).toBeTruthy();
      expect(within(panel).queryByRole("button", { name: "Save as .srt…" })).toBeNull();
      expect(within(panel).getByRole("button", { name: "Save as .txt…" })).toBeTruthy();
    });

    it("says so when there's no text", async () => {
      const panel = await openHit();
      expect(await within(panel).findByText("No text found in this file.")).toBeTruthy();
      expect((within(panel).getByRole("button", { name: "Copy" }) as HTMLButtonElement).getAttribute("aria-disabled")).toBe("true");
    });

    it("a PDF hit opens on its page", async () => {
      const scroll = vi.fn();
      HTMLElement.prototype.scrollIntoView = scroll;
      await openHit(pdf, { via: ["pdf"], pos: 2, kind: OutputKind.KindDocument });
      await waitFor(() => expect(scroll).toHaveBeenCalled());
      expect((scroll.mock.contexts.at(-1) as HTMLElement).dataset.page).toBe("3");
    });
  });

  describe("Caption and Write caption", () => {
    it("shows the caption Caption Writer wrote, with a way to open it there", async () => {
      search.Texts.mockResolvedValue([
        { source: "caption", pos: -1, endPos: -1, text: "A red apple on a table" },
        { source: "ocr", pos: -1, endPos: -1, text: "FRESH" },
      ]);
      const panel = await openHit();
      const section = await within(panel).findByRole("region", { name: "Caption" });
      expect(within(section).getByText("A red apple on a table")).toBeTruthy();
      fireEvent.click(within(section).getByRole("button", { name: "Open in Caption Writer" }));
      expect(h.openTool).toHaveBeenCalledWith("captions", ["/lib/a.png"]);
      // The caption isn't mixed into "Text in this file".
      expect(within(await within(panel).findByTestId("found-text")).queryByText("A red apple on a table")).toBeNull();
    });

    it("Write caption… is offered for images and videos", async () => {
      const panel = await openHit();
      fireEvent.click(within(panel).getByRole("button", { name: "Write caption…" }));
      expect(h.openTool).toHaveBeenCalledWith("captions", ["/lib/a.png"]);
    });

    it("Write caption… isn't offered for a PDF", async () => {
      const panel = await openHit(pdf, { kind: OutputKind.KindDocument });
      expect(within(panel).queryByRole("button", { name: "Write caption…" })).toBeNull();
    });
  });
});

describe("Things view", () => {
  const l = (label: string, category: string, count = 3, user = false): LabelCount => ({ label, display: label, category, count, user, cover: `/lib/${label}.png` });

  beforeEach(() => {
    resetMocks();
    clearPreviewCache();
    localStorage.clear();
    useModules.getState().setAll([]);
    useUI.setState({ view: "library", handoff: null });
    useLibrary.setState({ view: "things" });
    search.Status.mockResolvedValue(status());
  });

  it("groups labels in the spec's order with Your labels first, and a card opens the Grid filtered by it", async () => {
    search.Things.mockResolvedValue([l("car", "vehicles", 4), l("dog", "animals", 12), l("mine", "", 3, true), l("pasta", "food", 7), l("receipt", "documents", 9), l("kitchen", "things")]);
    svc.Query.mockResolvedValue({ items: [out("plain")], nextCursor: "" });
    render(<LibraryView />);
    await screen.findByTestId("things");
    expect(screen.getAllByRole("heading", { level: 3 }).map((e) => e.textContent)).toEqual(["Your labels", "Animals", "Food & drink", "Things", "Vehicles", "Documents & screens"]);
    const dog = screen.getByRole("button", { name: "dog, 12 files" });
    expect(dog.textContent).toContain("12");
    search.Query.mockResolvedValue(page([hit(img("a"))]));
    fireEvent.click(dog);
    expect(useLibrary.getState().view).toBe("grid");
    expect(useSearch.getState().labels).toEqual(["dog"]);
    await waitFor(() => expect(lastSearch().labels).toEqual(["dog"]));
    expect(await screen.findByRole("option", { name: "a.png" })).toBeTruthy();
  });

  it("is remembered as the view like the others", () => {
    useLibrary.getState().setView("things");
    expect(JSON.parse(localStorage.getItem("toolbox.library") ?? "{}").view).toBe("things");
  });

  it("windows above 300 cards: only nearby chunks stay mounted", async () => {
    search.Things.mockResolvedValue(Array.from({ length: 301 }, (_, i) => l(`thing${i}`, "things")));
    render(<LibraryView />);
    const things = await screen.findByTestId("things");
    expect(things.getAttribute("data-windowed")).toBe("true");
    expect(things.querySelectorAll("[data-chunk]").length).toBe(6);
  });

  it("below 300 cards nothing is windowed", async () => {
    search.Things.mockResolvedValue([l("dog", "animals")]);
    render(<LibraryView />);
    expect((await screen.findByTestId("things")).getAttribute("data-windowed")).toBeNull();
  });

  it("empty and installed: says nothing is recognised yet and shows the index state", async () => {
    search.Status.mockResolvedValue(status({ stage: "pictures", pending: 4, done: 1, total: 5 }));
    render(<LibraryView />);
    expect(await screen.findByText("Nothing recognised yet")).toBeTruthy();
    await waitFor(() => expect(screen.getAllByTestId("search-status").length).toBeGreaterThan(0));
  });

  it("empty and not installed: the install gate", async () => {
    search.Status.mockResolvedValue(status({ installed: false }));
    render(<LibraryView />);
    expect(await screen.findByText("Things appear once pictures are indexed")).toBeTruthy();
    expect(await screen.findByTestId("search-gate")).toBeTruthy();
  });
});
