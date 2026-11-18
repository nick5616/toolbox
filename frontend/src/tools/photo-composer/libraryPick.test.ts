import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  pickLib: vi.fn(async (_o: unknown): Promise<string[]> => []),
  pickWith: vi.fn(async (..._a: unknown[]): Promise<string[]> => []),
}));

vi.mock("@/blocks/library-picker", async (orig) => {
  const actual = await orig<typeof import("@/blocks/library-picker")>();
  return { ...actual, pickFromLibrary: (o: unknown) => h.pickLib(o) };
});

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    FilesService: { PickWith: (...a: unknown[]) => h.pickWith(...a), Stat: async () => [{ exists: true }] },
    SettingsService: { ModuleState: async () => "", SetModuleState: async () => undefined },
  };
});

vi.mock("@/composer/loadImages", () => {
  const bmp = { width: 400, height: 300, close() {} } as unknown as ImageBitmap;
  return {
    EDIT_DIM: 2048,
    loadImage: async () => bmp,
    loadImages: async (paths: string[]) => ({ images: new Map(paths.map((p) => [p, bmp])), failed: new Map() }),
  };
});

import { layerList, newComposition } from "@/composer/model";
import { useComposer } from "./store";

beforeEach(() => {
  h.pickLib.mockReset().mockResolvedValue([]);
  h.pickWith.mockReset().mockResolvedValue([]);
  useComposer.getState().close();
  useComposer.getState().open({ id: "p1", name: "M", doc: newComposition("4:5"), postSlide: null });
});

const photos = () => layerList(useComposer.getState().history!.present).filter((l) => l.kind === "image");

describe("Photo Composer: From Library", () => {
  it("adds the chosen files as layers, like the native Add photos", async () => {
    h.pickLib.mockResolvedValue(["C:/lib/a.png", "C:/lib/b.jpg"]);
    await useComposer.getState().pickPhotosFromLibrary();
    expect(photos().map((l) => l.image?.ref.path)).toEqual(["C:/lib/a.png", "C:/lib/b.jpg"]);
    expect(h.pickWith).not.toHaveBeenCalled();
    expect(h.pickLib.mock.calls[0]?.[0]).toMatchObject({ multiple: true });
    expect((h.pickLib.mock.calls[0]?.[0] as { exts: string[] }).exts).toContain(".jpg");
  });

  it("changes nothing when the Library pick is cancelled", async () => {
    await useComposer.getState().pickPhotosFromLibrary();
    expect(photos()).toHaveLength(0);
  });

  it("sets the background photo from the Library", async () => {
    h.pickLib.mockResolvedValue(["C:/lib/bg.png"]);
    await useComposer.getState().chooseBackgroundFromLibrary();
    const bg = useComposer.getState().history!.present.background;
    expect(bg.kind).toBe("image");
    expect(bg.image?.path).toBe("C:/lib/bg.png");
    expect(h.pickLib.mock.calls[0]?.[0]).toMatchObject({ multiple: false });
  });
});
