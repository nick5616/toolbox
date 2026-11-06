import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { Category, ModuleStatus, type Descriptor } from "@/lib/api";
import { useDeps } from "@/state/deps";
import { EMPTY_FOCUS_STATE, useFocus } from "@/state/focus";
import { useModules } from "@/state/modules";
import { useUI } from "@/state/ui";
import { Sidebar } from "./Sidebar";

function mod(id: string, name: string): Descriptor {
  return {
    id, name, tagline: "", description: "", icon: "focus", category: Category.$zero, status: ModuleStatus.StatusReady,
    accepts: { extensions: null, urls: false, any: false }, requires: null, recommends: null, outputSubdir: "", order: 1, hidden: false, jobLess: true, maxInputs: 0, base: "", parts: null,
  };
}

describe("Sidebar focus dot", () => {
  beforeEach(() => {
    useModules.getState().setAll([mod("focus", "Focus"), mod("other", "Other")]);
    useDeps.getState().setAll([]);
    useUI.setState({ view: "library", sidebarCollapsed: false });
    useFocus.setState({ state: EMPTY_FOCUS_STATE });
  });

  it("shows a dot on the Focus entry only while a session is on", () => {
    render(<Sidebar />);
    expect(screen.queryByTestId("focus-indicator")).toBeNull();
    act(() =>
      useFocus.setState({
        state: {
          ...EMPTY_FOCUS_STATE,
          session: {
            id: "s", profile: { id: "p", name: "W", rules: [], createdAt: 0, updatedAt: 0 }, always: [], extra: [], launched: [],
            strength: "firm", onStart: "close", startedAt: 1, endsAt: 2, endedAt: 0, endReason: "", runId: "", stepId: "", dryRun: false, blocked: 0,
          } as never,
        },
      }),
    );
    const dots = screen.getAllByTestId("focus-indicator");
    expect(dots).toHaveLength(1);
    expect(dots[0]?.closest("button")?.textContent).toContain("Focus");
  });
});
