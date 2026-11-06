import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { isReady, useModules } from "@/state/modules";
import { useNavGroups } from "@/shell/nav";
import { CHECK_TYPE } from "@/tools/pipelines/editorModel";
import { storeContents } from "@/tools/pipelines/toolStoreModel";
import { GO_MODULES, GO_STEP_TYPES } from "./catalogFixture";
import { registeredStepTypes, stepUI } from "./steps";
import { paramsOf } from "./params";

// The frontend half of "every tool is a pipeline step" (SPEC Phase 14 §1.A).
// The Go half is TestEveryToolIsAPipelineStep. There is deliberately no
// exemption list: a tool that cannot be a step fails here.

// The sidebar's own list: `useModules` through `useNavGroups` (hidden modules left out, Pipelines is its own item).
useModules.getState().setAll(GO_MODULES);
const sidebarTools = renderHook(() => useNavGroups()).result.current.tools;

describe("every tool in the sidebar is a pipeline step", () => {
  it("the fixture lists the tools the sidebar shows", () => {
    expect(sidebarTools.length).toBeGreaterThanOrEqual(28);
    // Hidden modules and the Pipelines tool itself are not in the sidebar.
    const ids = sidebarTools.map((t) => t.id);
    expect(ids).not.toContain("video-editor");
    expect(ids).not.toContain("clipboard-copy");
    expect(ids).not.toContain("pipelines");
  });

  it.each(sidebarTools.map((t) => [t.id, t.label]))("%s (%s) has a step editor and is in the palette", (id) => {
    expect(stepUI(id), `no StepUI registered for ${id}`).toBeDefined();
    expect(GO_STEP_TYPES.some((t) => t.id === id), `${id} is not in the step catalogue`).toBe(true);
    const { groups } = storeContents(GO_STEP_TYPES, GO_MODULES, "");
    expect(groups.flatMap((g) => g.tools.map((t) => t.id))).toContain(id);
  });

  it("no ready, visible tool is left in the palette's 'can't be a step' list", () => {
    const { unavailable } = storeContents(GO_STEP_TYPES, GO_MODULES, "");
    expect(unavailable).toEqual([]);
  });

  it("every ready, visible module the sidebar would show is covered (not only the fixture's nav)", () => {
    const visible = GO_MODULES.filter((m) => isReady(m) && !m.hidden && m.id !== "pipelines");
    expect(sidebarTools.map((t) => t.id).sort()).toEqual(visible.map((m) => m.id).sort());
  });

  it("every step type of the catalogue has an editor, including the built-ins and Check", () => {
    for (const t of GO_STEP_TYPES) expect(stepUI(t.id), `no StepUI for catalogue entry ${t.id}`).toBeDefined();
    expect(stepUI(CHECK_TYPE)).toBeDefined();
  });

  // Tools whose defaults have no scalar option, so there is nothing to wire.
  const NO_SCALAR_OPTIONS: Record<string, string> = {
    "bpm-key": "analyses the file; it has no options",
  };

  it.each(sidebarTools.map((t) => [t.id, t.label]))("%s (%s) has at least one parameter", (id) => {
    const type = GO_STEP_TYPES.find((t) => t.id === id);
    const params = type ? paramsOf(id, type.defaultsJson) : [];
    if (id in NO_SCALAR_OPTIONS) expect(params, NO_SCALAR_OPTIONS[id]).toEqual([]);
    else expect(params.length, `${id} exposes no parameter`).toBeGreaterThanOrEqual(1);
  });

  it("keeps the old Local Chat id editable", () => {
    expect(registeredStepTypes()).toContain("pipelines.chat");
    expect(registeredStepTypes()).toContain("llm-chat");
  });
});
