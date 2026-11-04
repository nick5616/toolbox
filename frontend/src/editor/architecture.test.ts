/**
 * The dependency rule of Phase 10 (SPEC §5.1): `src/editor/` (the Video Editor)
 * never imports from `src/tools/`. The music layer (and every other tool)
 * reaches the editor only through an `EditorProfile`, never the other way.
 */
import { describe, expect, it } from "vitest";

const files = import.meta.glob("./**/*.{ts,tsx}", { eager: true, query: "?raw", import: "default" }) as Record<string, string>;

/**
 * Neutral shared utilities that happen to live under `src/tools/`. They know nothing
 * about Edit Studio and are slated to move to `src/lib/`; until then they are the only
 * allowed imports. The list may only shrink: an entry that is no longer imported fails
 * the test, so remove it.
 */
const SHARED_UTILITIES = [
  "@/tools/_kit", // DepsGate
  "@/tools/_kit/accepts",
];

const SPECIFIER = /(?:\bfrom|\bimport\(|\bvi\.mock\(|\bvi\.importActual(?:<[^>]*>)?\()\s*["']([^"']+)["']/g;

/** `a/b/../c` → `a/c`; leading `..` kept. */
function normalise(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." && out.length && out[out.length - 1] !== "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/** Specifiers in a file that point into src/tools. */
function toolImports(key: string, source: string): string[] {
  const dir = key.split("/").slice(0, -1).join("/");
  const found: string[] = [];
  for (const m of source.matchAll(SPECIFIER)) {
    const spec = m[1] as string;
    if (spec.startsWith("@/tools/") || spec === "@/tools") found.push(spec);
    else if (spec.startsWith(".")) {
      // this file lives in src/editor/<dir>; "../" past the editor folder lands in src/*
      const resolved = normalise(`editor/${dir}/${spec}`);
      if (resolved.startsWith("tools/")) found.push(spec);
    }
  }
  return found;
}

describe("editor architecture", () => {
  const entries = Object.entries(files).filter(([key]) => !key.endsWith("architecture.test.ts"));

  it("scans the editor sources", () => {
    expect(entries.length).toBeGreaterThan(50);
  });

  it("imports nothing from src/tools except the shared utilities", () => {
    const bad: string[] = [];
    for (const [key, source] of entries) {
      for (const spec of toolImports(key, source)) if (!SHARED_UTILITIES.includes(spec)) bad.push(`${key} imports ${spec}`);
    }
    expect(bad).toEqual([]);
  });

  it("never imports the music layer", () => {
    const bad: string[] = [];
    for (const [key, source] of entries) {
      for (const spec of toolImports(key, source)) if (spec.includes("edit-studio") || spec.includes("video-studio")) bad.push(`${key} imports ${spec}`);
    }
    expect(bad).toEqual([]);
  });

  it("keeps the shared-utility allowlist honest", () => {
    const used = new Set<string>();
    for (const [key, source] of entries) for (const spec of toolImports(key, source)) used.add(spec);
    expect(SHARED_UTILITIES.filter((s) => !used.has(s))).toEqual([]);
  });

  it("resolves relative paths that climb out of the editor", () => {
    expect(toolImports("./timeline/X.tsx", `import { a } from "../../tools/edit-studio/a";`)).toEqual(["../../tools/edit-studio/a"]);
    expect(toolImports("./timeline/X.tsx", `import { a } from "../store";`)).toEqual([]);
    expect(toolImports("./X.ts", `vi.mock("@/tools/edit-studio/lanes/exportMarkers", () => ({}))`)).toEqual(["@/tools/edit-studio/lanes/exportMarkers"]);
  });
});
