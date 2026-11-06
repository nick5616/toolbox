import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  save: vi.fn(),
  fromTemplate: vi.fn(),
}));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    PipelinesService: {
      Save: (...a: unknown[]) => h.save(...a),
      FromTemplate: (...a: unknown[]) => h.fromTemplate(...a),
      List: async () => [],
      Runs: async () => [],
      Catalog: async () => [],
      Templates: async () => [],
    },
  };
});

import { PackState, type Pipeline, type PipelineTemplate } from "@/lib/api";
import { usePacks } from "@/state/packs";
import { usePipelines } from "@/state/pipelines";
import { PipelineList } from "./PipelineList";
import { groupTemplates } from "./TemplateGallery";
import { useNewPipeline } from "./useNewPipeline";
import { CATALOG, check, entry, pipeline, step, stepCheck } from "./testFixtures";

function template(id: string, name: string, steps: NonNullable<Pipeline["steps"]>, packs: string[] = [], group = "Practical"): PipelineTemplate {
  return { id, group, blurb: `${name} blurb`, icon: "workflow", packs, pipeline: pipeline("", steps, { name, templateId: id }) };
}

const TEMPLATES = [
  template("social-clip", "Clip for social", [step("aaaaaaaa", "downloader")], [], "Just cool"),
  template("podcast", "Podcast", [step("aaaaaaaa", "stems")], ["music"]),
  template("sampling", "Sampling", [step("aaaaaaaa", "stems")], [], "Just cool"),
  template("product-photos", "Product photos", [step("aaaaaaaa", "object-eraser")]),
  template("music-video", "Music video", [step("aaaaaaaa", "visualizer", { optionsJson: '{"presetId":"golden-hour","showJson":""}' })], [], "Just cool"),
];

function Gallery() {
  const n = useNewPipeline();
  return (
    <>
      <button onClick={n.open}>open gallery</button>
      {n.dialog}
    </>
  );
}

beforeEach(() => {
  h.save.mockImplementation(async (p: Pipeline) => entry({ ...p, id: "new1" }));
  usePipelines.setState({ entries: [], catalog: CATALOG, templates: TEMPLATES, runs: {}, loaded: true, selectedPipelineId: null, runSheet: null });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PipelineList", () => {
  it("shows the empty state with four template cards and All templates", async () => {
    const onNew = vi.fn();
    render(<PipelineList onNew={onNew} />);
    expect(screen.getByText("No pipelines yet")).toBeTruthy();
    for (const n of ["Clip for social", "Podcast", "Sampling", "Product photos"]) expect(screen.getByText(n)).toBeTruthy();
    expect(screen.queryByText("Music video")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New pipeline" }));
    fireEvent.click(screen.getByRole("button", { name: "All templates…" }));
    expect(onNew).toHaveBeenCalledTimes(2);

    h.fromTemplate.mockResolvedValue(TEMPLATES[1]!.pipeline);
    fireEvent.click(screen.getByText("Podcast"));
    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(usePipelines.getState().selectedPipelineId).toBe("new1"));
    expect(h.fromTemplate).toHaveBeenCalledWith("podcast");
  });

  it("makes every card a Wails drop target with the pipeline-drop id", () => {
    usePipelines.setState({ entries: [entry(pipeline("p1", [step("aaaaaaaa", "downloader")])), entry(pipeline("p2", [step("aaaaaaaa", "stems")]))] });
    render(<PipelineList onNew={() => undefined} />);
    for (const id of ["p1", "p2"]) {
      const el = document.getElementById(`pipeline-drop:${id}`);
      expect(el).toBeTruthy();
      expect(el?.hasAttribute("data-file-drop-target")).toBe(true);
    }
  });

  it("cards of pipelines that take no files are not drop targets and the hint says so", () => {
    const p1 = pipeline("p1", [step("aaaaaaaa", "stems")]);
    const p2 = pipeline("p2", [step("aaaaaaaa", "focus")]);
    usePipelines.setState({ entries: [entry(p1), entry(p2, check([stepCheck("aaaaaaaa")], { takesFiles: false }))] });
    const { unmount } = render(<PipelineList onNew={() => undefined} />);
    expect(document.getElementById("pipeline-drop:p1")?.hasAttribute("data-file-drop-target")).toBe(true);
    const card2 = document.getElementById("pipeline-drop:p2")!;
    expect(card2.hasAttribute("data-file-drop-target")).toBe(false);
    expect(card2.querySelector("button")?.getAttribute("data-tip")).not.toMatch(/Drop files/);
    expect(screen.getByText(/Drop files on a card/)).toBeTruthy();
    unmount();
    usePipelines.setState({ entries: [entry(p2, check([stepCheck("aaaaaaaa")], { takesFiles: false }))] });
    render(<PipelineList onNew={() => undefined} />);
    expect(screen.queryByText(/Drop files/)).toBeNull();
  });

  it("shows name, step icons, takes, watch and status; selects and runs", () => {
    const p1 = pipeline("p1", [step("aaaaaaaa", "downloader"), step("bbbbbbbb", "stems")], { name: "Clips", watch: { enabled: true, folder: "C:\\w" } });
    const p2 = pipeline("p2", [step("aaaaaaaa", "stems")], { name: "Broken" });
    usePipelines.setState({
      entries: [
        entry(p1, check([stepCheck("aaaaaaaa"), stepCheck("bbbbbbbb")]), { watch: { active: true, message: "" } }),
        entry(p2, check([stepCheck("aaaaaaaa")], { ready: false, missing: ["audio-engine"] })),
      ],
      selectedPipelineId: "p1",
    });
    render(<PipelineList onNew={() => undefined} />);
    const card1 = document.getElementById("pipeline-drop:p1")!;
    expect(within(card1).getByText("Clips")).toBeTruthy();
    expect(within(card1).getByText("Takes: links")).toBeTruthy();
    expect(within(card1).getByText("watching")).toBeTruthy();
    expect(within(card1).getByRole("img", { name: "Ready" })).toBeTruthy();
    expect(card1.querySelectorAll("svg").length).toBeGreaterThanOrEqual(3);
    const card2 = document.getElementById("pipeline-drop:p2")!;
    expect(within(card2).getByRole("img", { name: "Tools missing" })).toBeTruthy();
    expect((within(card2).getByRole("button", { name: "Run Broken" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(within(card2).getByRole("button", { name: "Broken" }));
    expect(usePipelines.getState().selectedPipelineId).toBe("p2");
    fireEvent.click(within(card1).getByRole("button", { name: "Run Clips" }));
    expect(usePipelines.getState().runSheet).toEqual({ pipelineId: "p1", inputs: [] });
  });

  it("selects the first pipeline when none is selected", async () => {
    usePipelines.setState({ entries: [entry(pipeline("p1", [step("aaaaaaaa", "downloader")]))], selectedPipelineId: null });
    render(<PipelineList onNew={() => undefined} />);
    await waitFor(() => expect(usePipelines.getState().selectedPipelineId).toBe("p1"));
  });
});

describe("template gallery", () => {
  it("lists a blank card and every template with its steps and pack chip", () => {
    usePacks.getState().setAll([
      { id: "music", name: "Music", icon: "music", description: "", state: PackState.PackMissing, unsupportedReason: "", components: [], unlocks: [], jobId: "" },
    ]);
    render(<Gallery />);
    fireEvent.click(screen.getByText("open gallery"));
    const dialog = screen.getByRole("dialog", { name: "New pipeline" });
    expect(within(dialog).getByText("Blank pipeline")).toBeTruthy();
    for (const t of TEMPLATES) expect(within(dialog).getByText(t.pipeline.name)).toBeTruthy();
    expect(within(dialog).getByText("Needs: Music pack")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Install" })).toBeTruthy();
  });

  it("shows the templates in a Practical and a Just cool section, keeping their order", () => {
    render(<Gallery />);
    fireEvent.click(screen.getByText("open gallery"));
    const dialog = screen.getByRole("dialog", { name: "New pipeline" });
    const names = (section: string) =>
      within(within(dialog).getByRole("region", { name: section }))
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label"))
        .filter((n) => n !== null);
    expect(names("Practical")).toEqual(["Podcast", "Product photos"]);
    expect(names("Just cool")).toEqual(["Clip for social", "Sampling", "Music video"]);
    const headings = within(dialog).getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(["Practical", "Just cool"]);
  });

  it("groupTemplates puts a template without a known group under Practical and drops empty sections", () => {
    const odd = template("x", "Odd", [step("aaaaaaaa", "stems")], [], "");
    expect(groupTemplates([odd]).map((g) => [g.group, g.templates.length])).toEqual([["Practical", 1]]);
    expect(groupTemplates([])).toEqual([]);
  });

  it("fills the visualizer design before the first Save, selects the pipeline and closes", async () => {
    h.fromTemplate.mockResolvedValue(TEMPLATES[4]!.pipeline);
    render(<Gallery />);
    fireEvent.click(screen.getByText("open gallery"));
    fireEvent.click(screen.getByRole("button", { name: "Music video" }));
    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
    const saved = h.save.mock.calls[0]![0] as Pipeline;
    const o = JSON.parse((saved.steps ?? [])[0]!.optionsJson) as { showJson: string; designName: string };
    expect(o.showJson.length).toBeGreaterThan(10);
    expect(JSON.parse(o.showJson)).toBeTruthy();
    expect(o.designName).toBe("Golden Hour");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(usePipelines.getState().selectedPipelineId).toBe("new1");
  });

  it("creates a blank pipeline with one Downloader step reading the input", async () => {
    usePipelines.setState({ entries: [entry(pipeline("p1", [step("aaaaaaaa", "downloader")], { name: "New pipeline" }))] });
    render(<Gallery />);
    fireEvent.click(screen.getByText("open gallery"));
    fireEvent.click(screen.getByRole("button", { name: /Blank pipeline/ }));
    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
    const saved = h.save.mock.calls[0]![0] as Pipeline;
    expect(saved.name).toBe("New pipeline 2");
    expect(saved.steps).toHaveLength(1);
    expect((saved.steps ?? [])[0]).toMatchObject({ type: "downloader", from: "input", keep: true });
    expect(h.fromTemplate).not.toHaveBeenCalled();
  });

  it("keeps the dialog open and toasts when creating fails", async () => {
    h.fromTemplate.mockRejectedValue(new Error("not implemented"));
    render(<Gallery />);
    fireEvent.click(screen.getByText("open gallery"));
    fireEvent.click(screen.getByRole("button", { name: "Podcast" }));
    await waitFor(() => expect(h.fromTemplate).toHaveBeenCalled());
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(h.save).not.toHaveBeenCalled();
  });

  it("closes with Escape", () => {
    render(<Gallery />);
    fireEvent.click(screen.getByText("open gallery"));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
