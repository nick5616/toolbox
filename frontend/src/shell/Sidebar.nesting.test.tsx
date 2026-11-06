import { render, renderHook, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { Category, ModuleStatus, type Descriptor } from "@/lib/api";
import { useDeps } from "@/state/deps";
import { useModules } from "@/state/modules";
import { useUI } from "@/state/ui";
import { useNavGroups } from "./nav";
import { Sidebar } from "./Sidebar";

function mod(id: string, name: string, order: number, extra: Partial<Descriptor> = {}): Descriptor {
  return {
    id, name, tagline: "", description: "", icon: "box", category: Category.$zero, status: ModuleStatus.StatusReady,
    accepts: { extensions: null, urls: false, any: false }, requires: null, recommends: null, outputSubdir: "", order, hidden: false, jobLess: false, maxInputs: 0, base: "", parts: null,
    ...extra,
  };
}

const labels = () =>
  screen
    .getAllByRole("button")
    .map((b) => b.textContent ?? "")
    .filter((t) => /Editor|Studio|Transcribe|Subtitles|Other/.test(t));

describe("Sidebar composition", () => {
  beforeEach(() => {
    useDeps.getState().setAll([]);
    useUI.setState({ view: "library", sidebarCollapsed: false, comingSoonOpen: false });
  });

  it("lists a variant right under its base even when order differs", () => {
    useModules.getState().setAll([
      mod("editor", "Video Editor", 1),
      mod("other", "Other", 2),
      mod("studio", "Edit Studio", 9, { base: "editor" }),
    ]);
    render(<Sidebar />);
    expect(labels()).toEqual(["Video Editor", "Edit Studio", "Other"]);
    const { result } = renderHook(() => useNavGroups());
    expect(result.current.ordered.map((i) => i.id)).toEqual(["editor", "studio", "other"]);
    expect(result.current.tools.find((t) => t.id === "studio")?.variantOf).toBe("editor");
  });

  it("is a normal row when the base is hidden or not ready", () => {
    useModules.getState().setAll([
      mod("editor", "Video Editor", 1, { hidden: true }),
      mod("studio", "Edit Studio", 2, { base: "editor" }),
      mod("transcribe", "Transcribe", 3, { status: ModuleStatus.StatusComingSoon }),
      mod("subs", "Subtitles", 4, { base: "transcribe" }),
    ]);
    const { result } = renderHook(() => useNavGroups());
    expect(result.current.tools.map((t) => [t.id, t.variantOf])).toEqual([
      ["studio", undefined],
      ["subs", undefined],
    ]);
  });

  it("shows corner badges in rail mode", () => {
    useModules.getState().setAll([mod("editor", "Video Editor", 1), mod("studio", "Edit Studio", 2, { base: "editor" })]);
    useUI.setState({ sidebarCollapsed: true });
    render(<Sidebar />);
    expect(screen.getAllByTestId("variant-badge")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Edit Studio" })).toBeTruthy();
  });
});
