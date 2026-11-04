/**
 * Every literal icon name in the UI must be registered in Icon.tsx; unknown
 * names silently render the fallback box (found several in Phase 10 QA).
 */
import { describe, expect, it } from "vitest";
import { iconNames } from "./Icon";

const files = import.meta.glob(["../**/*.{ts,tsx}", "!../**/*.test.{ts,tsx}"], { eager: true, query: "?raw", import: "default" }) as Record<string, string>;
const PATTERN = /\bicon(?:=|:\s*)"([a-z0-9-]+)"/g;

describe("icon names", () => {
  it("are all registered", () => {
    const known = new Set<string>(iconNames);
    const missing: string[] = [];
    for (const [file, text] of Object.entries(files)) {
      for (const m of text.matchAll(PATTERN)) {
        const name = m[1] as string;
        if (!known.has(name)) missing.push(`${file}: ${name}`);
      }
    }
    expect(Object.keys(files).length).toBeGreaterThan(100);
    expect(missing).toEqual([]);
  });
});
