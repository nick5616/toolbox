/** Test helpers: a viewport for matchMedia, and the PaintService fake. */
import { vi } from "vitest";

/** Makes `window.matchMedia` answer min/max-width/height queries for a window of w × h. */
export function setViewport(w: number, h: number): void {
  const test = (q: string): boolean => {
    const m = /\((min|max)-(width|height):\s*(\d+)px\)/.exec(q);
    if (!m) return false;
    const size = m[2] === "width" ? w : h;
    return m[1] === "min" ? size >= Number(m[3]) : size <= Number(m[3]);
  };
  window.matchMedia = ((q: string) => ({
    matches: test(q),
    media: q,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
    onchange: null,
  })) as unknown as typeof window.matchMedia;
}

/** A PaintDoc with `n` layers. */
export function sampleDoc(n = 2) {
  return {
    version: 1,
    width: 1920,
    height: 1080,
    background: "#ffffff",
    layers: Array.from({ length: n }, (_, i) => ({ id: `L${i + 1}`, name: `Layer ${i + 1}`, hidden: false, locked: false, alphaLock: false, clip: false, reference: false, opacity: 1, blend: "normal", tiles: [] as string[], rev: 0 })),
    active: `L${n}`,
    palette: [] as string[],
    guides: "",
    tileSize: 512,
    source: "",
  };
}

export function paintServiceMock() {
  return {
    Projects: vi.fn(async () => [] as unknown[]),
    Create: vi.fn(async () => "p-new"),
    CreateFromImage: vi.fn(async () => "p-img"),
    ImportORA: vi.fn(async () => "p-ora"),
    Load: vi.fn(async () => sampleDoc()),
    Tiles: vi.fn(async () => ({})),
    SaveTiles: vi.fn(async () => undefined),
    SaveDoc: vi.fn(async () => undefined),
    SaveThumb: vi.fn(async () => undefined),
    Rename: vi.fn(async () => undefined),
    Duplicate: vi.fn(async () => "p-dup"),
    Delete: vi.fn(async () => undefined),
    Export: vi.fn(async (_opts: Record<string, unknown>) => ({ id: "job1", status: "queued", outputs: [], error: "", moduleId: "paint" })),
    ExportAs: vi.fn(async () => ""),
    DefaultExport: vi.fn(async (_opts: Record<string, unknown>) => ({ projectId: "", format: "png", quality: 92, scale: 1, name: "", flattened: "" })),
    ImportLayer: vi.fn(async () => ({})),
    AIStatus: vi.fn(async () => [] as unknown[]),
    Origins: vi.fn(async () => [] as unknown[]),
    BrushSets: vi.fn(async () => [] as unknown[]),
    Brush: vi.fn(async () => "{}"),
    SaveBrush: vi.fn(async () => ({})),
    PickBrushFiles: vi.fn(async () => [] as string[]),
    ImportBrushes: vi.fn(async () => [] as unknown[]),
  };
}
