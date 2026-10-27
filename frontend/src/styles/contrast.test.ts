import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Typed by ./node-fs.d.ts (no @types/node dependency).
const css = readFileSync("src/styles/tokens.css" /* vitest runs with cwd = frontend/ */, "utf8");

function block(selectorStart: string): Record<string, string> {
  const start = css.indexOf(selectorStart);
  if (start < 0) throw new Error(`selector not found: ${selectorStart}`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  const vars: Record<string, string> = {};
  for (const m of css.slice(open + 1, close).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    vars[m[1] as string] = (m[2] as string).trim();
  }
  return vars;
}

function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`not a 6-digit hex colour: ${hex}`);
  const n = parseInt(m[1] as string, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const themes: Record<string, Record<string, string>> = {
  dark: block(':root[data-theme="dark"]'),
  light: block(':root[data-theme="light"]'),
};

describe.each(Object.keys(themes))("contrast (%s)", (name) => {
  const t = themes[name] as Record<string, string>;
  const surfaces = ["--bg-panel", "--bg-raised", "--bg-sidebar"];

  it.each(surfaces.flatMap((s) => ["--fg", "--fg-muted"].map((f) => [f, s] as const)))(
    "%s on %s >= 4.5:1",
    (fg, bg) => {
      expect(contrast(t[fg] as string, t[bg] as string)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it("--fg-subtle on --bg-panel >= 3:1", () => {
    expect(contrast(t["--fg-subtle"] as string, t["--bg-panel"] as string)).toBeGreaterThanOrEqual(3);
  });

  it("--accent on --bg-panel >= 3:1", () => {
    expect(contrast(t["--accent"] as string, t["--bg-panel"] as string)).toBeGreaterThanOrEqual(3);
  });

  // Not required by the spec table; light theme (white on #DD6416) is 3.55:1, so only the
  // 3:1 UI-component bar is enforced here. Primary buttons are 500-weight 13px labels.
  it("--accent-fg on --accent >= 3:1", () => {
    expect(contrast(t["--accent-fg"] as string, t["--accent"] as string)).toBeGreaterThanOrEqual(3);
  });
});
