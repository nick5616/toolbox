import { beforeEach, describe, expect, it, vi } from "vitest";

interface Stored {
  id: string;
  name: string;
  showJson: string;
  updatedMs: number;
}
const store = vi.hoisted(() => ({ list: [] as Stored[], n: 0 }));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    VisualizerService: {
      Designs: async () => store.list,
      SaveDesign: async (d: Stored) => {
        const saved = { ...d, id: d.id || `d${++store.n}` };
        store.list = [saved, ...store.list.filter((x) => x.id !== saved.id)];
        return saved;
      },
      RenameDesign: async (id: string, name: string) => {
        store.list = store.list.map((x) => (x.id === id ? { ...x, name } : x));
      },
      DeleteDesign: async (id: string) => {
        store.list = store.list.filter((x) => x.id !== id);
      },
    },
  };
});

import { PRESETS, showFromPreset } from "@/viz/presets";
import { MAX_MY_PRESETS, useMyPresets } from "./designer/myPresets";

beforeEach(() => {
  store.list = [];
  store.n = 0;
  useMyPresets.setState({ items: [], loaded: false });
});

describe("my presets", () => {
  it("saves through the Visualizer service, reloads, renames and deletes", async () => {
    const show = showFromPreset(PRESETS[0]!);
    show.name = "Mine";
    expect(await useMyPresets.getState().add(show)).toBeNull();
    expect(store.list).toHaveLength(1);
    expect(store.list[0]).toMatchObject({ name: "Mine" });
    expect((JSON.parse(store.list[0]!.showJson) as { presetId: unknown }).presetId).toBeNull();

    useMyPresets.setState({ items: [], loaded: false });
    await useMyPresets.getState().load();
    const id = useMyPresets.getState().items[0]!.id;
    await useMyPresets.getState().rename(id, "Renamed");
    expect(store.list[0]!.name).toBe("Renamed");
    await useMyPresets.getState().remove(id);
    expect(store.list).toEqual([]);
  });

  it("skips saved designs that no longer validate", async () => {
    store.list = [{ id: "bad", name: "Broken", showJson: "{", updatedMs: 0 }];
    await useMyPresets.getState().load();
    expect(useMyPresets.getState().items).toHaveLength(0);
  });

  it("refuses more than the limit", async () => {
    const show = showFromPreset(PRESETS[0]!);
    useMyPresets.setState({ items: Array.from({ length: MAX_MY_PRESETS }, (_, i) => ({ id: `x${i}`, name: "x", show })), loaded: true });
    expect(await useMyPresets.getState().add(show)).toMatch(/50/);
  });
});
