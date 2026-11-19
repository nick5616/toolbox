import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  Maps: vi.fn(),
  PrepareMaps: vi.fn(),
  Vibe: vi.fn(),
  CancelVibe: vi.fn(),
  Read: vi.fn(),
  Transfer: vi.fn(),
  Enqueue: vi.fn(),
  Looks: vi.fn(),
  SaveLook: vi.fn(),
  RenameLook: vi.fn(),
  DeleteLook: vi.fn(),
  SaveCube: vi.fn(),
  Sources: vi.fn(),
  Prepare: vi.fn(),
  URLFor: vi.fn(),
  Stat: vi.fn(),
  PickWith: vi.fn(),
  ImageThumb: vi.fn(),
  ModuleState: vi.fn(),
  SetModuleState: vi.fn(),
  Install: vi.fn(),
}));
const compiled = vi.hoisted(() => ({ calls: [] as Array<{ name: string; wild: number }> }));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    GradeService: { Maps: api.Maps, PrepareMaps: api.PrepareMaps, Vibe: api.Vibe, CancelVibe: api.CancelVibe, Read: api.Read, Transfer: api.Transfer, Enqueue: api.Enqueue, Looks: api.Looks, SaveLook: api.SaveLook, RenameLook: api.RenameLook, DeleteLook: api.DeleteLook, SaveCube: api.SaveCube },
    EditStudioService: { Sources: api.Sources, Prepare: api.Prepare },
    MediaService: { URLFor: api.URLFor },
    FilesService: { Stat: api.Stat, PickWith: api.PickWith, Pick: api.PickWith, ImageThumb: api.ImageThumb },
    SettingsService: { ModuleState: api.ModuleState, SetModuleState: api.SetModuleState },
    PacksService: { Install: api.Install, InstallFor: vi.fn() },
  };
});

// The engine isn't under test: the canvas shows the effects it was given.
vi.mock("@/viz/edit/EditCanvas", () => ({
  EditCanvas: ({ inputs }: { inputs: { project: { tracks: Array<{ clips: Array<{ effects: string; path: string }> }> } } | null }) => (
    <div data-testid="edit-canvas" data-effects={inputs?.project.tracks[0]?.clips[0]?.effects ?? ""} data-path={inputs?.project.tracks[0]?.clips[0]?.path ?? ""} />
  ),
}));
vi.mock("@/grade/compile", () => ({
  compileRecipe: (r: { name: string }, wild: number) => {
    compiled.calls.push({ name: r.name, wild });
    return [{ id: "fx", type: "grade", enabled: true, params: { wild, look: r.name } }];
  },
}));

import { DepState, type DepStatus, type EditSourceState } from "@/lib/api";
import { useDeps } from "@/state/deps";
import { useLibrary } from "@/state/library";
import { useModules } from "@/state/modules";
import { useUI } from "@/state/ui";
import { setCurrentWindowForTest } from "@/lib/windows";
import { ClickInHost } from "@/components";
import type { BuiltInLook, GradeOp, GradeRecipe } from "@/grade/types";
import { ExportPanel } from "./FilesExportPanels";
import { setBuiltInLooksForTest } from "./builtins";
import { disposeThumbs, setThumbDrawerForTest } from "./lookThumbs";
import { setLutBakerForTest } from "./seams";
import { resetGrade, useGrade } from "./store";
import GradeView from "./GradeView";

const op = (id: string, over: Partial<GradeOp> = {}): GradeOp => ({ id, kind: "balance", on: true, amount: 1, region: { kind: "all" }, params: {}, ...over });
const recipe = (name: string, tier: GradeRecipe["tier"], ops: GradeOp[] = [op("aaaaaa")]): GradeRecipe => ({ v: 1, name, tier, seed: 0, wildCurve: "linear", ops });
const LOOKS: BuiltInLook[] = [
  { id: "teal-orange", recipe: recipe("Teal & Orange", "film"), blurb: "Cinema teal shadows, orange skin" },
  { id: "neon-noir", recipe: recipe("Neon Noir", "bonkers", [op("bbbbbb", { region: { kind: "subject", feather: 0.2 } })]), blurb: "Subject in colour, the rest mono" },
];

const PIC = "C:/photos/rain.jpg";
const VIDEO = "C:/videos/dance.mp4";

function sourceState(path: string, kind: "image" | "video"): EditSourceState {
  return {
    path,
    info: { path, kind, durationMs: kind === "video" ? 5000 : 0, width: 400, height: 300, fps: kind === "video" ? 30 : 0, rotation: 0, hasAudio: false, takenAt: 0, error: "" },
    preview: kind === "video" ? { stream: "/c/s.h264", index: "/c/s.idx.json", width: 400, height: 300, fps: 30, frames: 150 } : null,
    image: kind === "image" ? "/c/p.jpg" : "",
    shots: [],
    preparing: false,
    error: "",
  } as unknown as EditSourceState;
}

const noMaps = {
  path: PIC,
  depth: { ready: false, preview: "", still: "", stream: "", missing: "" },
  subject: { ready: false, preview: "", still: "", stream: "", missing: "" },
  people: { ready: false, preview: "", still: "", stream: "", missing: "" },
  preparing: null,
};

function mount() {
  return render(
    <ClickInHost>
      <GradeView moduleId="grade" />
    </ClickInHost>,
  );
}

async function openPicture(path = PIC, kind: "image" | "video" = "image") {
  api.Sources.mockResolvedValue([sourceState(path, kind)]);
  mount();
  act(() => useGrade.getState().addInputs([path]));
  await screen.findByTestId("edit-canvas");
}

beforeEach(() => {
  Object.values(api).forEach((m) => m.mockReset());
  compiled.calls.length = 0;
  api.Maps.mockResolvedValue(noMaps);
  api.Looks.mockResolvedValue([]);
  api.ModuleState.mockResolvedValue("");
  api.SetModuleState.mockResolvedValue(undefined);
  api.URLFor.mockImplementation(async (p: string) => `/media/t${p}`);
  api.Stat.mockImplementation(async (paths: string[]) => paths.map((path) => ({ path, exists: true, isDir: false })));
  api.CancelVibe.mockResolvedValue(undefined);
  api.Enqueue.mockResolvedValue([{ id: "j1", moduleId: "grade", status: "queued", inputs: [PIC], outputs: null }]);
  resetGrade();
  setBuiltInLooksForTest(LOOKS);
  setThumbDrawerForTest(async () => "data:image/jpeg;base64,AAAA");
  useDeps.getState().setAll([]);
  useModules.setState({ byId: {} } as unknown as Parameters<typeof useModules.setState>[0]);
  useLibrary.setState({ items: [] });
});

afterEach(() => {
  setBuiltInLooksForTest(null);
  setThumbDrawerForTest(null);
  setLutBakerForTest(undefined);
  setCurrentWindowForTest(null);
  disposeThumbs();
  resetGrade();
});

const railButton = (name: RegExp) => {
  const hit = screen.getAllByRole("button", { name }).find((b) => b.closest("nav"));
  if (!hit) throw new Error(`no rail button ${String(name)}`);
  return hit;
};
/** A button inside an open panel (not the rail's launcher). */
const panelButton = (name: string | RegExp) => {
  const hit = screen.getAllByRole("button", { name }).find((b) => !b.closest("nav"));
  if (!hit) throw new Error(`no panel button ${String(name)}`);
  return hit;
};

describe("Color Grader", () => {
  it("opens a picture that arrives as a handoff and shows it with the look", async () => {
    api.Sources.mockResolvedValue([sourceState(PIC, "image")]);
    mount();
    act(() => useUI.getState().handOff({ moduleId: "grade", inputs: [PIC] }));
    const canvas = await screen.findByTestId("edit-canvas");
    expect(api.Stat).toHaveBeenCalledWith([PIC]);
    expect(canvas.getAttribute("data-path")).toBe(PIC);
    // The file's name is on screen and its full path is the tooltip.
    const title = screen.getAllByText("rain.jpg")[0] as HTMLElement;
    expect(title.getAttribute("data-tip")).toBe(PIC);
    expect(useGrade.getState().maps?.depth.ready).toBe(false);
  });

  it("applies a look when its gallery card is clicked, and shows live thumbnails of the picture", async () => {
    const user = userEvent.setup();
    const drawn: string[] = [];
    setThumbDrawerForTest(async (inputs) => {
      drawn.push(inputs.project.tracks?.[0]?.clips?.[0]?.effects ?? "");
      return "data:image/jpeg;base64,AAAA";
    });
    await openPicture();
    const card = await screen.findByRole("button", { name: /Teal & Orange/ });
    await waitFor(() => expect(card.querySelector("img")).toBeTruthy());
    expect(drawn.some((e) => e.includes("Teal & Orange"))).toBe(true);
    await user.click(card);
    expect(useGrade.getState().recipe.name).toBe("Teal & Orange");
    expect(useGrade.getState().lookId).toBe("teal-orange");
    await waitFor(() => expect(screen.getByTestId("edit-canvas").getAttribute("data-effects")).toContain("Teal & Orange"));

    await user.click(within(screen.getByRole("region", { name: "Look gallery" })).getByRole("radio", { name: "Bonkers" }));
    await user.click(await screen.findByRole("button", { name: /Neon Noir/ }));
    expect(useGrade.getState().recipe.name).toBe("Neon Noir");
  });

  it("recompiles the effects when Wildness changes", async () => {
    await openPicture();
    act(() => useGrade.getState().setRecipe(LOOKS[0]!.recipe, "teal-orange"));
    const slider = screen.getAllByRole("slider", { name: "Wildness" })[0] as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "0.9" } });
    await waitFor(() => expect(screen.getByTestId("edit-canvas").getAttribute("data-effects")).toContain('"wild":0.9'));
    expect(compiled.calls.some((c) => c.wild === 0.9)).toBe(true);
    await userEvent.setup().click(screen.getByRole("radio", { name: "Tasteful" }));
    expect(useGrade.getState().wild).toBe(0);
  });

  describe("Vibe", () => {
    const written = { v: 1, name: "Haunted Mall", tier: "ai", seed: 1, wildCurve: "linear", ops: [{ id: "cccccc", kind: "balance", on: true, amount: 1, region: { kind: "all" }, params: {} }] };

    async function openVibe() {
      const user = userEvent.setup();
      await openPicture();
      await user.click(railButton(/^Vibe/));
      const box = await screen.findByRole("textbox", { name: "Describe the look" });
      await user.type(box, "haunted vaporwave mall");
      return user;
    }

    it("writes a look and applies it", async () => {
      api.Vibe.mockResolvedValue([written]);
      const user = await openVibe();
      await user.click(screen.getByRole("button", { name: "Write a look" }));
      expect(api.Vibe).toHaveBeenCalledWith({ text: "haunted vaporwave mall", seed: 4821, n: 1 });
      await waitFor(() => expect(useGrade.getState().recipe.name).toBe("Haunted Mall"));
      expect(useGrade.getState().recipe.tier).toBe("ai");
      expect(useGrade.getState().vibe.phase).toBe("idle");
    });

    it("asks for 3 variations with the next seed", async () => {
      api.Vibe.mockResolvedValue([written, { ...written, name: "B" }, { ...written, name: "C" }]);
      const user = await openVibe();
      await user.click(screen.getByRole("button", { name: "More like this" }));
      expect(api.Vibe).toHaveBeenCalledWith({ text: "haunted vaporwave mall", seed: 4822, n: 3 });
      expect(await screen.findByText("C")).toBeTruthy();
    });

    it("shows the model's error and stays usable", async () => {
      api.Vibe.mockRejectedValue(new Error("The chat model couldn't write a look. Try again or rephrase."));
      const user = await openVibe();
      await user.click(screen.getByRole("button", { name: "Write a look" }));
      expect((await screen.findAllByText(/couldn't write a look/i)).length).toBeGreaterThan(0);
      expect(useGrade.getState().vibe.phase).toBe("error");
      expect(screen.getByRole("button", { name: "Write a look" })).toBeTruthy();
    });

    it("cancels, and a late answer is ignored", async () => {
      let resolve: (v: unknown) => void = () => undefined;
      api.Vibe.mockReturnValue(new Promise((r) => (resolve = r)));
      const user = await openVibe();
      await user.click(screen.getByRole("button", { name: "Write a look" }));
      await user.click(await screen.findByRole("button", { name: "Cancel" }));
      expect(api.CancelVibe).toHaveBeenCalled();
      expect(useGrade.getState().vibe.phase).toBe("idle");
      await act(async () => resolve([written]));
      expect(useGrade.getState().recipe.name).not.toBe("Haunted Mall");
    });

    it("names the missing chat model and blocks Write a look", async () => {
      useModules.setState({ byId: { "llm-chat": { id: "llm-chat", requires: ["llama-server"] } } } as unknown as Parameters<typeof useModules.setState>[0]);
      useDeps.getState().setAll([{ id: "llama-server", name: "Chat engine", state: DepState.DepMissing, requiredBy: ["llm-chat"] } as unknown as DepStatus]);
      const user = await openVibe();
      const write = screen.getByRole("button", { name: "Write a look" });
      expect(write.getAttribute("aria-disabled")).toBe("true");
      await user.click(write);
      expect(api.Vibe).not.toHaveBeenCalled();
    });
  });

  it("makes the same Chaos look from the same seed, even after other rolls", async () => {
    const user = userEvent.setup();
    await openPicture();
    await user.click(railButton(/^Chaos/));
    const seed = await screen.findByRole("textbox", { name: "Seed" });
    await user.clear(seed);
    await user.type(seed, "4821{Enter}");
    const first = useGrade.getState().recipe;
    expect(first.name).toBe("Chaos #4821");
    await user.click(screen.getByRole("button", { name: "Again" }));
    expect(useGrade.getState().recipe.name).toBe("Chaos #4822");
    await user.clear(screen.getByRole("textbox", { name: "Seed" }));
    await user.type(screen.getByRole("textbox", { name: "Seed" }), "4821{Enter}");
    expect(useGrade.getState().recipe).toEqual(first);
  });

  it("keeps a locked op across rerolls", async () => {
    await openPicture();
    act(() => useGrade.getState().surprise(1));
    const keep = useGrade.getState().recipe.ops[1] as GradeOp;
    act(() => useGrade.getState().toggleLock(keep.id));
    for (let i = 0; i < 5; i++) act(() => useGrade.getState().again());
    expect(useGrade.getState().recipe.ops.some((o) => o.id === keep.id && o.kind === keep.kind)).toBe(true);
  });

  it("shows the region maps and the install button of a missing model", async () => {
    const user = userEvent.setup();
    api.Maps.mockResolvedValue({
      ...noMaps,
      depth: { ready: false, preview: "", still: "", stream: "", missing: "color" },
      subject: { ready: true, preview: "C:/cache/subject.png", still: "C:/cache/subject.png", stream: "", missing: "" },
    });
    api.Install.mockResolvedValue({ jobs: [], restart: false });
    api.ImageThumb.mockResolvedValue("data:image/png;base64,AAAA");
    await openPicture();
    await user.click(railButton(/^Regions/));
    const depth = await screen.findByTestId("map-depth");
    await user.click(within(depth).getByRole("button", { name: /Install color/ }));
    expect(api.Install).toHaveBeenCalledWith(["color"], "");
    const subject = screen.getByTestId("map-subject");
    await user.click(within(subject).getByRole("button", { name: "View this map" }));
    expect(useGrade.getState().mapView).toBe("subject");
    // People isn't made yet and nothing is missing: it can be made here.
    await user.click(within(screen.getByTestId("map-people")).getByRole("button", { name: /Make the people map/ }));
    expect(api.PrepareMaps).toHaveBeenCalledWith(PIC, ["people"]);
  });

  it("says how long a video's depth map takes", async () => {
    const user = userEvent.setup();
    await openPicture(VIDEO, "video");
    await user.click(railButton(/^Regions/));
    const depth = await screen.findByTestId("map-depth");
    expect(within(depth).getByText(/takes about/)).toBeTruthy();
  });

  it("exports every file with the look, Wildness, format and beat settings", async () => {
    const user = userEvent.setup();
    await openPicture();
    act(() => {
      useGrade.getState().setRecipe(LOOKS[0]!.recipe, "teal-orange");
      useGrade.getState().setWild(0.8);
      useGrade.getState().setFormat("webp");
      useGrade.getState().addInputs(["C:/photos/two.jpg"]);
    });
    await user.click(screen.getByTestId("grade-export"));
    await waitFor(() => expect(api.Enqueue).toHaveBeenCalled());
    const [paths, opts] = api.Enqueue.mock.calls[0] as [string[], { recipe: { name: string; tier: string; ops: Array<{ id: string }> }; wild: number; format: string; beat: unknown }];
    expect(paths).toEqual([PIC, "C:/photos/two.jpg"]);
    expect(opts.recipe.name).toBe("Teal & Orange");
    expect(opts.recipe.ops[0]?.id).toBe("aaaaaa");
    expect([opts.wild, opts.format, opts.beat]).toEqual([0.8, "webp", { on: false, song: "" }]);
  });

  it("won't export without a file, and says why", async () => {
    mount();
    const btn = screen.getByTestId("grade-export");
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    expect(btn.getAttribute("data-tip")).toMatch(/Add a picture or a video/);
    await userEvent.setup().click(btn);
    expect(api.Enqueue).not.toHaveBeenCalled();
  });

  it("works on its own: results, where they went, and getting to them", async () => {
    const user = userEvent.setup();
    useLibrary.setState({
      items: [{ id: "o1", moduleId: "grade", path: "C:/lib/Graded/rain (Teal & Orange).jpg", name: "rain (Teal & Orange).jpg", sizeBytes: 1000, createdAt: Date.now(), kind: "image", missing: false, tags: [] }],
    } as unknown as Parameters<typeof useLibrary.setState>[0]);
    await openPicture();
    await user.click(railButton(/^Export/));
    expect(await screen.findByText(/Graded/, { selector: "strong" })).toBeTruthy();
    expect(screen.getByText("rain (Teal & Orange).jpg")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show all in Library" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save look" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Export .cube" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Show in Explorer|Reveal in Finder/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: /Save a copy/i }).length).toBeGreaterThan(0);
  });

  it("writes a .cube only when the baker exists, and lists what a LUT can't hold", async () => {
    const user = userEvent.setup();
    api.SaveCube.mockResolvedValue("C:/lib/Graded/LUTs/Teal.cube");
    await openPicture();
    act(() => useGrade.getState().setRecipe(recipe("Teal", "film", [op("aaaaaa"), op("bbbbbb", { region: { kind: "subject", feather: 0.1 } })]), ""));
    await user.click(railButton(/^Export/));
    const cube = await screen.findByRole("button", { name: "Export .cube" });
    expect(cube.getAttribute("aria-disabled")).toBe("true");
    setLutBakerForTest(async (_r, _w, size) => new Float32Array(size * size * size * 3));
    act(() => useGrade.getState().renameLook("Teal")); // a render, so the button re-reads the baker
    await user.click(await screen.findByRole("button", { name: "Export .cube" }));
    await waitFor(() => expect(api.SaveCube).toHaveBeenCalledWith("Teal", 33, expect.any(Array)));
    await user.click(screen.getByText("What a LUT can't hold"));
    expect(screen.getByText(/Balance: left out \(region\)|balance: left out \(region\)/i)).toBeTruthy();
  });

  it("never submits from a replica window", async () => {
    setCurrentWindowForTest({ kind: "part", key: "part:grade.panel@export", view: "", part: "grade.panel", params: new URLSearchParams() });
    act(() => useGrade.getState().addInputs([PIC]));
    render(
      <ClickInHost>
        <ExportPanel />
      </ClickInHost>,
    );
    const btn = screen.getByRole("button", { name: /Export 1 file/ });
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    await userEvent.setup().click(btn);
    expect(api.Enqueue).not.toHaveBeenCalled();
  });

  it("Steal a look adds a transfer op from the reference's statistics", async () => {
    const user = userEvent.setup();
    api.PickWith.mockResolvedValue(["C:/photos/dessert.jpg"]);
    api.Transfer.mockResolvedValue(Array.from({ length: 18 }, (_, i) => i));
    await openPicture();
    await user.click(railButton(/^Steal/));
    await user.click(await screen.findByRole("button", { name: "Choose a picture…" }));
    await waitFor(() => expect(useGrade.getState().recipe.ops.some((o) => o.kind === "transfer")).toBe(true));
    const t = useGrade.getState().recipe.ops.find((o) => o.kind === "transfer") as GradeOp;
    expect((t.params.stats as number[]).length).toBe(18);
  });

  it("Read the picture shows 6 suggestions with their reasons in the gallery", async () => {
    const user = userEvent.setup();
    api.Read.mockResolvedValue(
      Array.from({ length: 6 }, (_, i) => ({ name: `Wet Neon ${i}`, why: `push the rain highlights magenta ${i}`, recipe: { v: 1, name: `Wet Neon ${i}`, tier: "ai", seed: 0, wildCurve: "linear", ops: [] } })),
    );
    await openPicture();
    await user.click(railButton(/^Read/));
    await user.click(panelButton("Read the picture"));
    expect(await screen.findByText(/push the rain highlights magenta 3/)).toBeTruthy();
    expect(api.Read).toHaveBeenCalledWith(PIC, 0);
    expect(useGrade.getState().suggestions).toHaveLength(6);
    await waitFor(() => expect(screen.getByRole("radio", { name: /For this picture/ })).toBeTruthy());
  });
});
