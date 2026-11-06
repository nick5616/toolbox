import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    ClipboardService: { CopyText: async () => undefined },
    DevUtilsService: { HashText: async () => [], Enqueue: async () => [] },
    FilesService: { Pick: async () => [], Stat: async () => [] },
    SettingsService: { ModuleState: async () => "", SetModuleState: async () => undefined },
  };
});

import { useUI } from "@/state/ui";
import DevUtilsView from "./DevUtilsView";
import { useDevUtilsNav } from "./registry";
import { useDevUtils } from "./store";

beforeEach(() => {
  useDevUtilsNav.setState({ selected: null, pendingFiles: [] });
  useDevUtils.setState({ values: {} });
  useUI.setState({ handoff: null });
});

describe("Dev Utilities text hand-off", () => {
  it("opens the matching utility with the text as its input", async () => {
    render(<DevUtilsView moduleId="dev-utils" />);
    await screen.findByLabelText("JSON input");
    act(() => {
      useUI.getState().handOff({ moduleId: "dev-utils", inputs: [], text: { title: "Copied text", body: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln" } });
    });
    const jwt = (await screen.findByLabelText("JWT")) as HTMLTextAreaElement;
    expect(jwt.value).toBe("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln");
    expect(useUI.getState().handoff).toBeNull();
  });

  it("falls back to Text for plain text", async () => {
    render(<DevUtilsView moduleId="dev-utils" />);
    await screen.findByLabelText("JSON input");
    act(() => {
      useUI.getState().handOff({ moduleId: "dev-utils", inputs: [], text: { title: "Copied text", body: "just words" } });
    });
    expect(useDevUtils.getState().values["text.text"]).toBe("just words");
    expect(useDevUtilsNav.getState().selected).toBe("text");
  });
});
