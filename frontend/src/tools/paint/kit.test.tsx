import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { actionCombos, buildActions, nextSize } from "./actions";
import { harmonyColors, hexToHsv, hsvToHex, isHex } from "./color";
import { fitSize, sizeProblem } from "./limits";
import { fracFromSize, sizeFromFrac } from "./store";
import { FakeEngine } from "./testing/fakeEngine";
import { PaintIcon, hasPaintIcon, resolveIconName, VerticalSlider } from "./ui";
import { PERCEPTION_TOOLS } from "@/paint/ai/tools";
import { ALGORITHMIC_TOOLS } from "@/paint/lab";

// vitest hands stylesheets over empty, so the sources are read from disk (node types aren't installed: a minimal shape).
interface Fs {
  readFileSync(p: string, enc: string): string;
  readdirSync(p: string, o: { withFileTypes: true }): Array<{ name: string; isDirectory(): boolean }>;
}
const fs = (await import("node:fs")) as unknown as Fs;
const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd().split("\\").join("/");
function readCss(dir: string, prefix = "."): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) Object.assign(out, readCss(`${dir}/${e.name}`, `${prefix}/${e.name}`));
    else if (e.name.endsWith(".css")) out[`${prefix}/${e.name}`] = fs.readFileSync(`${dir}/${e.name}`, "utf8");
  }
  return out;
}
const css = readCss(`${cwd}/src/tools/paint`);

describe("design language", () => {
  it("no stylesheet but tokens.css contains a raw colour", () => {
    const raw = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;
    const bad = Object.entries(css)
      .filter(([f]) => !f.endsWith("tokens.css"))
      .filter(([, src]) => raw.test(src.replace(/\/\*[\s\S]*?\*\//g, "")))
      .map(([f]) => f);
    expect(bad).toEqual([]);
  });

  it("tokens.css defines every token in both themes", () => {
    const tokens = css["./ui/tokens.css"] ?? "";
    for (const name of ["--p-island", "--p-ink", "--p-accent", "--p-exact", "--p-seeded", "--p-wild", "--p-popover", "--p-canvas-bg"]) {
      expect(tokens.split(name + ":").length - 1, name).toBeGreaterThanOrEqual(3); // dark, light (media), light (data-theme)
    }
  });

  it("every Lab tool icon resolves to a drawn icon", () => {
    const missing = [...ALGORITHMIC_TOOLS, ...PERCEPTION_TOOLS].map((t) => t.icon).filter((i) => !hasPaintIcon(i));
    expect(missing).toEqual([]);
    expect(resolveIconName("fill-eraser")).toBe("fillEraser");
    const { container } = render(<PaintIcon name="no-such-icon" />);
    expect(container.querySelector("svg")?.getAttribute("data-icon")).toBe("flask");
  });
});

describe("pure helpers", () => {
  it("canvas limits", () => {
    expect(sizeProblem(1920, 1080)).toBe("");
    expect(sizeProblem(9000, 100)).toMatch(/8192/);
    expect(sizeProblem(8000, 8000)).toMatch(/megapixels/);
    expect(sizeProblem(0, 10)).not.toBe("");
    const f = fitSize(12000, 6000);
    expect(sizeProblem(f.w, f.h)).toBe("");
    expect(f.w / f.h).toBeCloseTo(2, 1);
    const g = fitSize(8000, 7000);
    expect(g.w * g.h).toBeLessThanOrEqual(40_000_000);
  });

  it("colour round trips", () => {
    expect(hsvToHex(hexToHsv("#3d6fd6"))).toBe("#3d6fd6");
    expect(isHex("#abcdef")).toBe(true);
    expect(isHex("abc")).toBe(false);
    expect(harmonyColors(hexToHsv("#ff0000"), "complementary")).toEqual(["#00ffff"]);
    expect(harmonyColors(hexToHsv("#ff0000"), "triadic")).toHaveLength(2);
  });

  it("the size slider is monotonic and round trips", () => {
    expect(sizeFromFrac(0)).toBe(1);
    expect(sizeFromFrac(1)).toBe(400);
    expect(sizeFromFrac(0.5)).toBeLessThan(200);
    for (const px of [1, 8, 24, 100, 400]) expect(Math.abs(sizeFromFrac(fracFromSize(px)) - px)).toBeLessThanOrEqual(1);
    expect(nextSize(24, 1)).toBeGreaterThan(24);
    expect(nextSize(1, -1)).toBe(1);
    expect(nextSize(400, 1)).toBe(400);
  });

  it("the shortcut table has no duplicate combos and covers SPEC 1.1 item 16", () => {
    const actions = buildActions({ engine: new FakeEngine(), openDialog: () => undefined, toggleStudio: () => undefined, toggleHide: () => undefined, togglePanel: () => undefined, flashHud: () => undefined });
    const combos = actionCombos(actions);
    expect(new Set(combos).size).toBe(combos.length);
    for (const c of ["B", "E", "S", "G", "V", "L", "M", "W", "I", "[", "]", "{", "}", "Mod+Z", "Mod+Shift+Z", "Mod+A", "Mod+D", "Mod+Shift+I", "Mod+J", "Mod+E", "Tab", "F"]) expect(combos).toContain(c);
  });
});

describe("VerticalSlider", () => {
  it("answers the keyboard and shows its value", () => {
    const seen: number[] = [];
    render(<VerticalSlider label="Opacity" value={0.5} onChange={(v) => seen.push(v)} />);
    const s = screen.getByRole("slider", { name: "Opacity" });
    expect(s.getAttribute("aria-valuetext")).toBe("50%");
    fireEvent.keyDown(s, { key: "ArrowUp" });
    fireEvent.keyDown(s, { key: "End" });
    fireEvent.keyDown(s, { key: "Home" });
    expect(seen[0]).toBeCloseTo(0.52, 5);
    expect(seen.slice(1)).toEqual([1, 0]);
  });
});
