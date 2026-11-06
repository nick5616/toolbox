import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  paint: {} as ReturnType<typeof import("./testing/env").paintServiceMock>,
  pickWith: vi.fn(async (): Promise<string[]> => []),
  imageSize: vi.fn(async () => ({ w: 100, h: 100 })),
}));

vi.mock("@/lib/api", async (orig) => {
  const real = await orig<typeof import("@/lib/api")>();
  return {
    ...real,
    PaintService: new Proxy({}, { get: (_t, k: string) => (h.paint as Record<string, unknown>)[k] }),
    FilesService: { ...real.FilesService, PickWith: () => h.pickWith(), ImageSize: () => h.imageSize(), ImageThumb: async () => "" },
    LibraryService: { ...real.LibraryService, RevealPath: vi.fn(async () => undefined) },
  };
});

import { paintServiceMock, setViewport } from "./testing/env";
import Gallery from "./Gallery";
import { useOpenImages } from "./useOpenImages";

function Harness({ onOpen }: { onOpen: (id: string) => void }) {
  const openImages = useOpenImages();
  return (
    <>
      <Gallery openImages={openImages} onOpen={onOpen} studio={false} onToggleStudio={() => undefined} compact={false} />
      {openImages.dialogs}
    </>
  );
}

const project = { id: "p1", kind: "paint", name: "Sunset", thumb: "", items: 3, missing: 0, updatedAt: 1_700_000_000_000, flags: [] };

beforeEach(() => {
  setViewport(1400, 800);
  h.paint = paintServiceMock();
  h.pickWith.mockReset().mockResolvedValue([]);
  h.imageSize.mockReset().mockResolvedValue({ w: 100, h: 100 });
});

describe("Gallery", () => {
  it("lists the presets with 16:9 first and creates a canvas from one", async () => {
    const onOpen = vi.fn();
    render(<Harness onOpen={onOpen} />);
    const tiles = within(screen.getByRole("list", { name: "Canvas sizes" })).getAllByRole("button");
    expect(tiles[0]?.textContent).toMatch(/Screen 16:9/);
    expect(tiles[0]?.textContent).toMatch(/1920 × 1080/);
    expect(tiles.map((t) => t.textContent).join("|")).toMatch(/Square.*Portrait 9:16.*A4/);
    fireEvent.click(tiles[0] as HTMLElement);
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith("p-new"));
    expect(h.paint.Create).toHaveBeenCalledWith("Untitled", 1920, 1080, "#ffffff");
  });

  it("passes a transparent background through", async () => {
    render(<Harness onOpen={() => undefined} />);
    fireEvent.click(screen.getByRole("radio", { name: "Transparent" }));
    fireEvent.click(within(screen.getByRole("list", { name: "Canvas sizes" })).getAllByRole("button")[2] as HTMLElement);
    await waitFor(() => expect(h.paint.Create).toHaveBeenCalledWith("Untitled", 3840, 2160, "transparent"));
  });

  it("shows the limits in the custom dialog and refuses a canvas over 40 MP", async () => {
    render(<Harness onOpen={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: /Custom/ }));
    const dialog = screen.getByRole("dialog", { name: "Custom canvas" });
    expect(dialog.textContent).toMatch(/8192 px per side, 40 megapixels/);
    fireEvent.change(within(dialog).getByRole("spinbutton", { name: "Width" }), { target: { value: "8000" } });
    fireEvent.change(within(dialog).getByRole("spinbutton", { name: "Height" }), { target: { value: "8000" } });
    expect(within(dialog).getByRole("alert").textContent).toMatch(/at most 40 megapixels/);
    const create = within(dialog).getByRole("button", { name: "Create" });
    expect(create.getAttribute("aria-disabled")).toBe("true");
  });

  it("opens an image, offering Scale down to fit when it is over the limits", async () => {
    const onOpen = vi.fn();
    h.pickWith.mockResolvedValue(["C:/photos/big.png"]);
    h.imageSize.mockResolvedValue({ w: 12000, h: 6000 });
    render(<Harness onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: /Open image/ }));
    const dialog = await screen.findByRole("dialog", { name: /bigger than a canvas/ });
    expect(dialog.textContent).toMatch(/12000 × 6000/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Scale down to fit" }));
    await waitFor(() => expect(h.paint.CreateFromImage).toHaveBeenCalledWith("C:/photos/big.png", "big", true));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith("p-img"));
  });

  it("does not open an over-limit image when cancelled, and opens a normal one directly", async () => {
    h.pickWith.mockResolvedValue(["C:/photos/big.png"]);
    h.imageSize.mockResolvedValue({ w: 12000, h: 6000 });
    const { unmount } = render(<Harness onOpen={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: /Open image/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(h.paint.CreateFromImage).not.toHaveBeenCalled();
    unmount();

    h.pickWith.mockResolvedValue(["C:/photos/small.jpg"]);
    h.imageSize.mockResolvedValue({ w: 800, h: 600 });
    render(<Harness onOpen={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: /Open image/ }));
    await waitFor(() => expect(h.paint.CreateFromImage).toHaveBeenCalledWith("C:/photos/small.jpg", "small", false));
  });

  it("imports an .ora file as a project", async () => {
    h.pickWith.mockResolvedValue(["C:/art/piece.ora"]);
    const onOpen = vi.fn();
    render(<Harness onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: /Open image/ }));
    await waitFor(() => expect(h.paint.ImportORA).toHaveBeenCalledWith("C:/art/piece.ora"));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith("p-ora"));
  });

  it("shows project cards and renames, duplicates and deletes them", async () => {
    h.paint.Projects.mockResolvedValue([project]);
    const onOpen = vi.fn();
    render(<Harness onOpen={onOpen} />);
    const card = await screen.findByTestId("project-p1");
    expect(card.textContent).toMatch(/Sunset/);
    expect(card.textContent).toMatch(/3 layers/);
    fireEvent.click(within(card).getByRole("button", { name: "Open Sunset" }));
    expect(onOpen).toHaveBeenCalledWith("p1");

    // Rename
    fireEvent.click(within(card).getByRole("button", { name: "More for Sunset" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename…" }));
    const input = await screen.findByRole("textbox", { name: "New name" });
    fireEvent.change(input, { target: { value: "Dusk" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(h.paint.Rename).toHaveBeenCalledWith("p1", "Dusk"));

    // Duplicate
    fireEvent.click(within(card).getByRole("button", { name: "More for Sunset" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Duplicate" }));
    await waitFor(() => expect(h.paint.Duplicate).toHaveBeenCalledWith("p1"));

    // Delete asks first
    fireEvent.click(within(card).getByRole("button", { name: "More for Sunset" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete…" }));
    expect(h.paint.Delete).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(h.paint.Delete).toHaveBeenCalledWith("p1"));
  });
});

import { within } from "@testing-library/react";
