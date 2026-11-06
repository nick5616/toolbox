import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("src/styles/tokens.css", "utf8");

/** The custom properties with hex colours in the block that starts at `start`. */
function block(start: string): Record<string, string> {
  const i = css.indexOf(start);
  const body = css.slice(i, css.indexOf("}", i));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1] as string, m[2] as string]));
}

function lum(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (c[0] ?? 0) + 0.7152 * (c[1] ?? 0) + 0.0722 * (c[2] ?? 0);
}

const ratio = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

describe("text contrast", () => {
  const themes: Array<[string, Record<string, string>]> = [
    ["dark", block(':root[data-theme="dark"] {')],
    ["light", block(':root[data-theme="light"] {')],
  ];
  for (const [name, t] of themes) {
    for (const fg of ["--fg-muted", "--fg-subtle"]) {
      for (const bg of ["--bg-app", "--bg-sidebar", "--bg-panel", "--bg-raised", "--bg-hover", "--bg-active", "--bg-inset"]) {
        it(`${name}: ${fg} on ${bg} is at least 4.5:1`, () => {
          expect(t[fg] && t[bg]).toBeTruthy();
          expect(ratio(t[fg] as string, t[bg] as string)).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
  }
});
