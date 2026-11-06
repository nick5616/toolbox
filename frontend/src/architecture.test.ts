/**
 * The app's dependency rules (Phase 11, SPEC §3.4). Tools are building blocks
 * that compose through registries, parts, click-ins and hand-offs, never by
 * importing each other:
 *
 * 1. A tool (`tools/<a>/`) imports no other tool, except the file-tool kit
 *    (`tools/_kit`), the tool index's types (`@/tools`) and, for a variant, its
 *    base (Edit Studio → Video Editor, Subtitles → Transcribe).
 * 2. Shared code (`blocks/`, `components/`, `editor/`, `lib/`, `state/`,
 *    `viz/`, `workspace/`, `parts/` except its index) imports no tool. The
 *    editor may use the kit's DepsGate (`@/tools/_kit`, `@/tools/_kit/accepts`).
 * 3. Composition roots may import tools: `tools/index.ts`, `parts/index.ts`,
 *    `shell/`, `views/`, `pipelines/` (step options reuse tool option schemas),
 *    `App.tsx`, `main.tsx`.
 */
import { describe, expect, it } from "vitest";

const files = import.meta.glob("./**/*.{ts,tsx}", { eager: true, query: "?raw", import: "default" }) as Record<string, string>;

/** A variant may build on its base tool (folder names). */
const VARIANT_OF: Record<string, string> = { "edit-studio": "video-studio", subtitles: "transcribe" };

const EDITOR_ALLOWED = new Set(["@/tools/_kit", "@/tools/_kit/accepts"]);

const ROOTS = [/^tools\/index\.ts$/, /^parts\/index\.ts$/, /^shell\//, /^views\//, /^pipelines\//, /^App\.tsx$/, /^main\.tsx$/, /architecture\.test\.ts$/];

const SHARED = [/^blocks\//, /^components\//, /^editor\//, /^lib\//, /^state\//, /^viz\//, /^workspace\//, /^parts\//, /^paint\//];

const SPECIFIER = /(?:\bfrom|\bimport\(|\bvi\.mock\(|\bvi\.importActual(?:<[^>]*>)?\()\s*["']([^"']+)["']/g;

/** `a/b/../c` → `a/c`. */
function normalise(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." && out.length && out[out.length - 1] !== "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/** The src-relative target of a specifier ("tools/stems/options"), or null for packages. */
export function resolveSpec(file: string, spec: string): string | null {
  if (spec.startsWith("@/")) return spec.slice(2);
  if (!spec.startsWith(".")) return null;
  const dir = file.split("/").slice(0, -1).join("/");
  return normalise(`${dir}/${spec}`);
}

/** The tool folder a src-relative path is in ("tools/stems/x" → "stems"; "tools" or "tools/index" → "" ). */
function toolOf(path: string): string | null {
  if (path === "tools" || path === "tools/index" || path === "tools/index.ts") return "";
  const m = /^tools\/([^/]+)/.exec(path);
  return m ? (m[1] as string) : null;
}

export function violations(file: string, source: string): string[] {
  if (ROOTS.some((r) => r.test(file))) return [];
  const bad: string[] = [];
  const own = toolOf(file);
  const shared = SHARED.some((r) => r.test(file));
  for (const m of source.matchAll(SPECIFIER)) {
    const spec = m[1] as string;
    const target = resolveSpec(file, spec);
    if (target === null) continue;
    const tool = toolOf(target);
    if (tool === null || tool === "") continue; // not a tool, or the index (types)
    if (own !== null) {
      if (tool === own || tool === "_kit" || VARIANT_OF[own] === tool) continue;
      bad.push(`${file} imports ${spec} (tool ${own} → tool ${tool})`);
    } else if (shared) {
      if (file.startsWith("editor/") && EDITOR_ALLOWED.has(spec)) continue;
      bad.push(`${file} imports ${spec} (shared code → tool ${tool})`);
    }
  }
  return bad;
}

describe("app architecture", () => {
  const entries = Object.entries(files).map(([k, v]) => [k.replace(/^\.\//, ""), v] as const);

  it("scans the sources", () => {
    expect(entries.length).toBeGreaterThan(500);
  });

  it("keeps tools and shared code from importing tools", () => {
    const bad = entries.flatMap(([file, src]) => violations(file, src));
    expect(bad).toEqual([]);
  });

  it("checks relative paths, aliases and mocks", () => {
    expect(violations("tools/lyricvideo/X.tsx", `import { a } from "../visualizer/designer/model";`)).toHaveLength(1);
    expect(violations("tools/lyricvideo/X.tsx", `import { a } from "@/tools/_kit";`)).toEqual([]);
    expect(violations("tools/lyricvideo/X.tsx", `import type { ToolViewProps } from "@/tools";`)).toEqual([]);
    expect(violations("tools/subtitles/X.tsx", `import { a } from "@/tools/transcribe/options";`)).toEqual([]);
    expect(violations("components/X.tsx", `vi.mock("@/tools/stems/StemsView", () => ({}))`)).toHaveLength(1);
    expect(violations("shell/Shell.tsx", `import { toolViews } from "@/tools";`)).toEqual([]);
    expect(violations("editor/X.tsx", `import { DepsGate } from "@/tools/_kit";`)).toEqual([]);
  });
});
