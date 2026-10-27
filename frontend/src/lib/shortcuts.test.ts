import { describe, expect, it } from "vitest";
import { isEditableTarget, matches } from "./shortcuts";

function key(k: string, mods: Partial<KeyboardEventInit> = {}) {
  return new KeyboardEvent("keydown", { key: k, ...mods });
}

// jsdom's user agent isn't a Mac, so Mod = Ctrl here.
describe("matches", () => {
  it("matches Mod combos", () => {
    expect(matches(key("k", { ctrlKey: true }), "Mod+K")).toBe(true);
    expect(matches(key("k"), "Mod+K")).toBe(false);
    expect(matches(key("K", { ctrlKey: true, shiftKey: true }), "Mod+K")).toBe(false);
    expect(matches(key("R", { ctrlKey: true, shiftKey: true }), "Mod+Shift+R")).toBe(true);
    expect(matches(key("\\", { ctrlKey: true }), "Mod+Backslash")).toBe(true);
    expect(matches(key("1", { ctrlKey: true }), "Mod+1")).toBe(true);
  });

  it("matches bare keys", () => {
    expect(matches(key("Escape"), "Escape")).toBe(true);
    expect(matches(key("/"), "/")).toBe(true);
    expect(matches(key("/", { ctrlKey: true }), "/")).toBe(false);
  });
});

describe("isEditableTarget", () => {
  it("detects inputs", () => {
    expect(isEditableTarget(document.createElement("textarea"))).toBe(true);
    const cb = document.createElement("input");
    cb.type = "checkbox";
    expect(isEditableTarget(cb)).toBe(false);
    expect(isEditableTarget(document.createElement("div"))).toBe(false);
  });
});
