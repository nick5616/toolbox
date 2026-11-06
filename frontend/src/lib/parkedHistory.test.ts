import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const saved = vi.hoisted(() => new Map<string, string>());

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    SettingsService: {
      ModuleState: async (k: string) => saved.get(k) ?? "",
      SetModuleState: async (k: string, v: string) => {
        saved.set(k, v);
      },
    },
  };
});

import { parseWindow, setCurrentWindowForTest } from "@/lib/windows";
import { adoptParkedHistory, capSteps, park, parkForPopOut, parkKey, PARK_MAX_AGE_MS, registerHistory, resetParkedHistoryForTest, type HistorySteps } from "./parkedHistory";

// A tiny fake tool: one document id and its steps.
const fake = { doc: "d1" as string | null, steps: { past: [] as unknown[], future: [] as unknown[] }, listeners: [] as (() => void)[] };
registerHistory("fake", ["fake-tool"], {
  docId: () => fake.doc,
  read: () => (fake.doc ? fake.steps : null),
  write: (s) => {
    fake.steps = { past: [...s.past], future: [...s.future] };
  },
  subscribe: (cb) => {
    fake.listeners.push(cb);
    return () => undefined;
  },
});

const asTool = () => setCurrentWindowForTest(parseWindow("?window=tool&key=tool:fake-tool&view=fake-tool"));

beforeEach(() => {
  saved.clear();
  resetParkedHistoryForTest();
  fake.doc = "d1";
  fake.steps = { past: ["a", "b"], future: ["z"] };
  setCurrentWindowForTest(parseWindow(""));
});
afterEach(() => {
  setCurrentWindowForTest(null);
  vi.useRealTimers();
});

const fresh = () => {
  fake.steps = { past: [], future: [] };
};

describe("parked history", () => {
  it("parks on pop-out and installs once for the same document", async () => {
    await parkForPopOut("fake-tool");
    expect(saved.get(parkKey("fake"))).toBeTruthy();
    fresh();
    expect(await adoptParkedHistory("fake", "d1")).toBe(true);
    expect(fake.steps).toEqual({ past: ["a", "b"], future: ["z"] });
    expect(saved.get(parkKey("fake"))).toBe(""); // taken once
    fresh();
    resetParkedHistoryForTest();
    expect(await adoptParkedHistory("fake", "d1")).toBe(false);
  });

  it("survives a second open on the same page (StrictMode) but not a later one", async () => {
    await park("fake", 1000);
    fresh();
    expect(await adoptParkedHistory("fake", "d1", 1010)).toBe(true);
    fresh(); // the second open reset the history again
    expect(await adoptParkedHistory("fake", "d1", 1020)).toBe(true);
    fresh();
    expect(await adoptParkedHistory("fake", "d1", 20_000)).toBe(false);
  });

  it("ignores and clears a stale park", async () => {
    await park("fake", 1000);
    fresh();
    expect(await adoptParkedHistory("fake", "d1", 1000 + PARK_MAX_AGE_MS + 1)).toBe(false);
    expect(saved.get(parkKey("fake"))).toBe("");
    expect(fake.steps.past).toEqual([]);
  });

  it("ignores and clears a park for a different document", async () => {
    await park("fake", 1000);
    fake.doc = "d2";
    fresh();
    expect(await adoptParkedHistory("fake", "d2", 1100)).toBe(false);
    expect(saved.get(parkKey("fake"))).toBe("");
    fake.doc = "d1";
    expect(await adoptParkedHistory("fake", "d1", 1200)).toBe(false); // cleared, not just skipped
  });

  it("never overwrites steps the user already made", async () => {
    await park("fake", 1000);
    fake.steps = { past: ["new"], future: [] };
    expect(await adoptParkedHistory("fake", "d1", 1100)).toBe(false);
    expect(fake.steps.past).toEqual(["new"]);
  });

  it("replicas never park or take", async () => {
    setCurrentWindowForTest(parseWindow("?window=part&key=part:x&part=x"));
    await park("fake");
    expect(saved.has(parkKey("fake"))).toBe(false);
    setCurrentWindowForTest(parseWindow(""));
    await park("fake", 1000);
    setCurrentWindowForTest(parseWindow("?window=part&key=part:x&part=x"));
    fresh();
    expect(await adoptParkedHistory("fake", "d1", 1100)).toBe(false);
    expect(saved.get(parkKey("fake"))).toBeTruthy(); // untouched
  });

  it("a tool window parks (debounced) after changes, so Bring back keeps them", async () => {
    vi.useFakeTimers();
    asTool();
    fake.listeners.forEach((l) => l());
    expect(saved.has(parkKey("fake"))).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(JSON.parse(saved.get(parkKey("fake")) ?? "{}")).toMatchObject({ docId: "d1", past: ["a", "b"], future: ["z"] });
  });

  it("parks nothing when there is no history", async () => {
    fake.steps = { past: [], future: [] };
    await park("fake");
    expect(saved.get(parkKey("fake"))).toBe("");
  });
});

describe("size cap", () => {
  const big = (n: number) => "x".repeat(n);

  it("drops the oldest past steps first", () => {
    const steps: HistorySteps = { past: [big(400), big(400), big(400), "last"], future: ["f"] };
    const out = capSteps(steps, 1000);
    expect(out?.past).toEqual([big(400), "last"].slice(0, out?.past.length));
    expect(out?.past.at(-1)).toBe("last");
    expect(out?.past.length).toBeLessThan(4);
    expect(out?.future).toEqual(["f"]);
  });

  it("keeps everything under the cap and drops redo steps last", () => {
    const small: HistorySteps = { past: ["a", "b"], future: [] };
    expect(capSteps(small)).toEqual(small);
    expect(capSteps({ past: [], future: [big(5000)] }, 1000)).toEqual({ past: [], future: [] });
    expect(capSteps({ past: [big(900)], future: ["f"] }, 1000)).toEqual({ past: [], future: ["f"] });
  });

  it("park writes JSON no larger than 4 MB", async () => {
    fake.steps = { past: Array.from({ length: 10 }, () => big(1_000_000)), future: [] };
    await park("fake", 1000);
    const json = saved.get(parkKey("fake")) ?? "";
    expect(json.length).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(JSON.parse(json).past.length).toBeLessThan(10);
    expect(JSON.parse(json).past.length).toBeGreaterThan(0);
  });
});
