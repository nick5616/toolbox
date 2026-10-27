import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const match = vi.fn();

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    ModulesService: { Match: (p: string[]) => match(p) },
    LibraryService: {
      Recent: vi.fn().mockResolvedValue({ items: [], nextCursor: "" }),
      Reveal: vi.fn(),
      Open: vi.fn(),
      OpenLibraryFolder: vi.fn(),
    },
  };
});

import { ModuleStatus, OutputKind, type Descriptor, type Output } from "@/lib/api";
import { useLibrary } from "@/state/library";
import { useUI } from "@/state/ui";
import { LibraryView } from "./LibraryView";

function mod(id: string, status = ModuleStatus.StatusReady): Descriptor {
  return { id, name: `Mod ${id}`, icon: "box", status, accepts: { extensions: [], urls: false } } as unknown as Descriptor;
}

function out(id: string, missing = false): Output {
  return {
    id, jobId: "j", moduleId: "downloader", path: `/lib/${id}.mp3`, name: `${id}.mp3`,
    kind: OutputKind.KindAudio, sizeBytes: 1, createdAt: Date.now(), missing, tags: [],
  } as Output;
}

describe("Library Send to…", () => {
  beforeEach(() => {
    match.mockReset().mockResolvedValue({ matches: [{ module: mod("stems"), paths: ["/lib/a.mp3"] }, { module: mod("soon", ModuleStatus.StatusComingSoon), paths: ["/lib/a.mp3"] }], unmatched: null });
    useLibrary.setState({ refresh: vi.fn().mockResolvedValue(undefined) });
    useLibrary.getState().setPage([out("a"), out("b", true)], "");
    useUI.setState({ handoff: null, view: "library" });
  });

  it("lists ready matches and hands the file off; hidden for missing files", async () => {
    render(<LibraryView />);
    expect(screen.getAllByRole("button", { name: "Send to…" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Send to…" }));
    await waitFor(() => expect(match).toHaveBeenCalledWith(["/lib/a.mp3"]));
    expect(screen.queryByRole("menuitem", { name: "Mod soon" })).toBeNull();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Mod stems" }));
    expect(useUI.getState().handoff).toEqual({ moduleId: "stems", inputs: ["/lib/a.mp3"] });
    expect(useUI.getState().view).toBe("stems");
  });
});
