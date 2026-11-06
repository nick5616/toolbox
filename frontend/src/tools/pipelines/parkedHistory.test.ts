import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const saved = vi.hoisted(() => new Map<string, string>());

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    PipelinesService: { Save: async () => undefined, Describe: async () => undefined },
    FilesService: { PickFolder: async () => "C:/Inbox" },
    SettingsService: {
      ModuleState: async (k: string) => saved.get(k) ?? "",
      SetModuleState: async (k: string, v: string) => {
        saved.set(k, v);
      },
    },
  };
});

import { parkForPopOut, resetParkedHistoryForTest } from "@/lib/parkedHistory";
import { useDraft } from "./draftStore";
import { entry, pipeline, step } from "./testFixtures";

const base = (id = "p1") => pipeline(id, [step("aaaaaaaa", "downloader")]);

beforeEach(() => {
  vi.useFakeTimers();
  saved.clear();
  resetParkedHistoryForTest();
});
afterEach(() => {
  useDraft.getState().close();
  vi.useRealTimers();
});

describe("Pipelines undo history across a pop-out", () => {
  it("round-trips through park and take", async () => {
    useDraft.getState().open(entry(base()));
    useDraft.getState().setName("One");
    useDraft.getState().setDescription("Two");
    expect(useDraft.getState().hist?.past).toHaveLength(2);
    const present = useDraft.getState().draft!;
    await parkForPopOut("pipelines");
    useDraft.getState().close();
    useDraft.getState().open(entry(present));
    await vi.waitFor(() => expect(useDraft.getState().hist?.past.length).toBe(2));
    expect(useDraft.getState().canUndo).toBe(true);
    useDraft.getState().undo();
    expect(useDraft.getState().draft?.description).toBe(base().description);
    expect(useDraft.getState().canRedo).toBe(true);
  });

  it("ignores a park for another pipeline", async () => {
    useDraft.getState().open(entry(base()));
    useDraft.getState().setName("One");
    await parkForPopOut("pipelines");
    useDraft.getState().close();
    useDraft.getState().open(entry(base("p2")));
    await vi.advanceTimersByTimeAsync(20);
    expect(useDraft.getState().hist?.past).toHaveLength(0);
    expect(useDraft.getState().canUndo).toBe(false);
  });
});
