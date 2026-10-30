import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ value: "" }));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    SettingsService: {
      ModuleState: async () => store.value,
      SetModuleState: async (_id: string, json: string) => {
        store.value = json;
      },
    },
  };
});

import { PRESETS, showFromPreset } from "@/viz/presets";
import { useMyPresets } from "./designer/myPresets";

beforeEach(() => {
  store.value = JSON.stringify({ analysisKeys: { "a.mp3": "k" } });
  useMyPresets.setState({ items: [], loaded: false });
});

describe("my presets", () => {
  it("saves {id, name, show} under myPresets and keeps the other keys", async () => {
    const show = showFromPreset(PRESETS[0]!);
    show.name = "Mine";
    expect(await useMyPresets.getState().add(show)).toBeNull();
    const saved = JSON.parse(store.value) as { analysisKeys: unknown; myPresets: Array<{ id: string; name: string; show: { name: string } }> };
    expect(saved.analysisKeys).toEqual({ "a.mp3": "k" });
    expect(saved.myPresets).toHaveLength(1);
    expect(saved.myPresets[0]).toMatchObject({ name: "Mine" });
    expect(typeof saved.myPresets[0]!.id).toBe("string");

    // reload, rename, delete
    useMyPresets.setState({ items: [], loaded: false });
    await useMyPresets.getState().load();
    const id = useMyPresets.getState().items[0]!.id;
    await useMyPresets.getState().rename(id, "Renamed");
    expect((JSON.parse(store.value) as { myPresets: Array<{ name: string }> }).myPresets[0]!.name).toBe("Renamed");
    await useMyPresets.getState().remove(id);
    expect((JSON.parse(store.value) as { myPresets: unknown[] }).myPresets).toEqual([]);
  });

  it("refuses a design that doesn't fit in the 64 KB module state", async () => {
    const show = showFromPreset(PRESETS[0]!);
    show.name = "x".repeat(70 * 1024);
    const msg = await useMyPresets.getState().add(show);
    expect(msg).toMatch(/room/);
    expect(useMyPresets.getState().items).toHaveLength(0);
  });
});
