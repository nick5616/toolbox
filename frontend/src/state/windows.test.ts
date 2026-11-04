import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { Descriptor } from "@/lib/api";
import { POP_OUT_FLUSH_MS, runBeforePopOut, useBeforePopOut } from "@/lib/popout";
import { useModules } from "./modules";
import { openToolWindow, toolFamily, useToolPoppedOut, useWindowOpen, useWindows } from "./windows";

function mod(id: string, base = ""): Descriptor {
  return { id, name: id, tagline: "", description: "", icon: "box", status: "ready", accepts: { extensions: [], urls: false }, requires: null, recommends: null, base, parts: [] } as unknown as Descriptor;
}

const catalog = [mod("video-studio"), mod("edit-studio", "video-studio"), mod("transcribe"), mod("subtitles", "transcribe"), mod("stems")];

describe("tool families", () => {
  const byId = Object.fromEntries(catalog.map((m) => [m.id, m])) as Record<string, { id: string; base: string }>;

  it("groups a base with its variants", () => {
    expect(toolFamily("edit-studio", byId).sort()).toEqual(["edit-studio", "video-studio"]);
    expect(toolFamily("video-studio", byId).sort()).toEqual(["edit-studio", "video-studio"]);
    expect(toolFamily("stems", byId)).toEqual(["stems"]);
  });

  it("finds the open window of any family member", () => {
    expect(openToolWindow("video-studio", ["tool:edit-studio"], byId)).toBe("tool:edit-studio");
    expect(openToolWindow("edit-studio", ["tool:video-studio"], byId)).toBe("tool:video-studio");
    expect(openToolWindow("subtitles", ["tool:transcribe"], byId)).toBe("tool:transcribe");
    expect(openToolWindow("stems", ["tool:edit-studio"], byId)).toBeNull();
    expect(openToolWindow("stems", ["tool:stems"], byId)).toBe("tool:stems");
  });
});

describe("window hooks", () => {
  it("follow the open list", () => {
    useModules.getState().setAll(catalog);
    useWindows.setState({ open: [] });
    const open = renderHook(() => useWindowOpen("part:a"));
    const out = renderHook(() => useToolPoppedOut("video-studio"));
    expect(open.result.current).toBe(false);
    expect(out.result.current).toBeNull();
    act(() => useWindows.getState().setOpen(["part:a", "tool:edit-studio"]));
    expect(open.result.current).toBe(true);
    expect(out.result.current).toBe("tool:edit-studio");
  });
});

describe("before pop out", () => {
  afterEach(() => vi.useRealTimers());

  it("awaits registered flushers and survives failures", async () => {
    const order: string[] = [];
    const { unmount } = renderHook(() => {
      useBeforePopOut("m", async () => {
        await Promise.resolve();
        order.push("a");
      });
      useBeforePopOut("m", () => {
        throw new Error("boom");
      });
    });
    await runBeforePopOut("m");
    expect(order).toEqual(["a"]);
    unmount();
    order.length = 0;
    await runBeforePopOut("m");
    expect(order).toEqual([]);
  });

  it("gives up after 3 s", async () => {
    vi.useFakeTimers();
    renderHook(() => useBeforePopOut("slow", () => new Promise<void>(() => undefined)));
    let done = false;
    void runBeforePopOut("slow").then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(POP_OUT_FLUSH_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(done).toBe(true);
  });
});
