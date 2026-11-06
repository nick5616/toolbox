import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const popOutTool = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/windows", async (orig) => {
  const actual = await orig<typeof import("@/lib/windows")>();
  return { ...actual, popOutTool: (...a: unknown[]) => popOutTool(...a) };
});

vi.mock("@/lib/api", async (orig) => {
  const { libraryApiMock } = await import("./testSvc");
  return libraryApiMock(orig as never);
});

import { ModuleStatus, type Descriptor } from "@/lib/api";
import { useModules } from "@/state/modules";
import { useLibrary } from "@/state/library";
import { useUI } from "@/state/ui";
import { LibraryView } from "./LibraryView";
import { out, resetMocks, svc } from "./testFixtures";

function mod(id: string, status = ModuleStatus.StatusReady): Descriptor {
  return { id, name: `Mod ${id}`, icon: "box", status, accepts: { extensions: [".mp3"], urls: false } } as unknown as Descriptor;
}

describe("Library Send to…", () => {
  beforeEach(async () => {
    resetMocks();
    popOutTool.mockClear();
    svc.Query.mockResolvedValue({ items: [out("a"), out("b", { missing: true })], nextCursor: "" });
    useModules.getState().setAll([mod("stems"), mod("soon", ModuleStatus.StatusComingSoon)]);
    useUI.setState({ handoff: null, view: "library" });
    useLibrary.setState({ view: "grid" });
    render(<LibraryView />);
    await screen.findByText("a.mp3");
  });

  it("lists ready tools that take the file and hands it off; missing files get no Send to", async () => {
    expect(screen.getAllByRole("button", { name: "Send to…" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Send to…" }));
    expect(screen.queryByRole("menuitem", { name: "Mod soon" })).toBeNull();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Mod stems" }));
    expect(useUI.getState().handoff).toEqual({ moduleId: "stems", inputs: ["/lib/a.mp3"] });
    expect(useUI.getState().view).toBe("stems");
  });

  it("also offers each tool in its own window", async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send to…" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Mod stems (new window)" }));
    await waitFor(() => expect(popOutTool).toHaveBeenCalled());
    expect(popOutTool.mock.calls[0]?.[0]).toBe("stems");
    expect(useUI.getState().handoff).toBeNull();
  });

  it("the detail panel offers it too, plus Open in the tool that made the file", async () => {
    useModules.getState().setAll([mod("stems"), mod("downloader")]);
    fireEvent.click(screen.getByRole("option", { name: "a.mp3" }));
    const panel = await screen.findByRole("complementary", { name: "Details" });
    fireEvent.click(within(panel).getByRole("button", { name: "Send to…" }));
    expect(await screen.findByRole("menuitem", { name: "Mod stems" })).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: "Open in Mod downloader" }));
    expect(useUI.getState().handoff).toEqual({ moduleId: "downloader", inputs: ["/lib/a.mp3"] });
  });
});
