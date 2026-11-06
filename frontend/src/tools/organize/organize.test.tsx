import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueue = vi.hoisted(() => vi.fn());
const preview = vi.hoisted(() => vi.fn());
const expand = vi.hoisted(() => vi.fn());
const picked = vi.hoisted(() => ({ paths: ["/photos/a.jpg"] as string[] }));
const revealPath = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    OrganizeService: {
      Defaults: async () => ({}),
      Enqueue: (...a: unknown[]) => enqueue(...a),
      Preview: (...a: unknown[]) => preview(...a),
      Expand: (...a: unknown[]) => expand(...a),
    },
    FilesService: {
      Pick: async () => picked.paths,
      PickFolder: async () => "/dump",
      Stat: async (p: string[]) => p.map((path) => ({ path, name: path, sizeBytes: 10, exists: true, isDir: false, kind: "image" })),
      ImageThumb: async () => "data:image/jpeg;base64,AAAA",
    },
    SettingsService: { ModuleState: async () => "", SetModuleState: async () => undefined },
    LibraryService: { Reveal: async () => undefined, Open: async () => undefined, RevealPath: (...a: unknown[]) => revealPath(...a) },
  };
});

import { JobStatus, ModuleStatus, OrganizeDupMode, OrganizeGroupBy, type Descriptor } from "@/lib/api";
import { useJobs } from "@/state/jobs";
import { useModules } from "@/state/modules";
import { useUI } from "@/state/ui";
import OrganizeView from "./OrganizeView";
import { DEFAULT_ORGANIZE_OPTIONS, buildTree, describeOptions, parseSummary, patternProblem, sanitizeOrganizeOptions } from "./options";

const mod = { id: "organize", name: "Organizer", icon: "box", status: ModuleStatus.StatusReady, accepts: { extensions: [], urls: false, any: true } } as unknown as Descriptor;

describe("organize options", () => {
  it("sanitizes saved options", () => {
    expect(sanitizeOrganizeOptions({ groupBy: "camera", duplicates: "similar", similarity: 80, dupAction: "skip" }, DEFAULT_ORGANIZE_OPTIONS)).toEqual({
      ...DEFAULT_ORGANIZE_OPTIONS,
      groupBy: "camera",
      duplicates: "similar",
      similarity: 80,
      dupAction: "skip",
    });
    expect(sanitizeOrganizeOptions({ groupBy: "x", duplicates: 3, similarity: 5, dupAction: "no" }, DEFAULT_ORGANIZE_OPTIONS)).toEqual(DEFAULT_ORGANIZE_OPTIONS);
    expect(sanitizeOrganizeOptions("nope", DEFAULT_ORGANIZE_OPTIONS)).toEqual(DEFAULT_ORGANIZE_OPTIONS);
  });

  it("checks patterns like the backend", () => {
    expect(patternProblem("{yyyy}/{mm}/{type}")).toBe("");
    expect(patternProblem("{camera}\\{ext}")).toBe("");
    expect(patternProblem("")).not.toBe("");
    expect(patternProblem("{year}")).toContain("{year}");
    expect(patternProblem("{yyyy")).toContain("Unmatched");
    expect(patternProblem("/abs")).not.toBe("");
    expect(patternProblem("{yyyy}/../x")).not.toBe("");
    expect(patternProblem("a/b/c/d/e/f/g")).toContain("at most");
  });

  it("builds an indented tree with counts that include sub-folders", () => {
    const rows = buildTree([
      { path: "2021/2021-03", count: 2 },
      { path: "2021/2021-04", count: 1 },
      { path: "Duplicates", count: 3 },
    ]);
    expect(rows.map((r) => [r.path, r.depth, r.count])).toEqual([
      ["2021", 1, 3],
      ["2021/2021-03", 2, 2],
      ["2021/2021-04", 2, 1],
      ["Duplicates", 1, 3],
    ]);
    expect(buildTree([{ path: "", count: 4 }])).toEqual([{ path: "", name: "Result folder", depth: 0, count: 4 }]);
    expect(buildTree([])).toEqual([]);
  });

  it("reads job summaries and describes options", () => {
    expect(parseSummary("")).toBeNull();
    expect(parseSummary("not json")).toBeNull();
    expect(parseSummary('{"root":"/o/x","report":"/o/x/report.csv","copied":3,"duplicates":1,"skipped":0,"failed":0,"folders":2}')).toMatchObject({ root: "/o/x", copied: 3, duplicates: 1 });
    expect(describeOptions(DEFAULT_ORGANIZE_OPTIONS)).toBe("By date taken · exact duplicates set aside");
    expect(describeOptions({ ...DEFAULT_ORGANIZE_OPTIONS, groupBy: OrganizeGroupBy.GroupPattern, duplicates: OrganizeDupMode.DupOff })).toBe("Pattern {yyyy}/{mm}/{type} · duplicates not checked");
  });
});

describe("OrganizeView", () => {
  beforeEach(() => {
    enqueue.mockReset();
    preview.mockReset();
    expand.mockReset();
    revealPath.mockReset().mockResolvedValue(undefined);
    picked.paths = ["/photos/a.jpg"];
    useJobs.setState({ byId: {} });
    useUI.setState({ handoff: null });
    useModules.getState().setAll([mod]);
  });

  it("starts empty with the group-by control and a disabled run button", () => {
    render(<OrganizeView moduleId="organize" />);
    expect(screen.getByText("Drop files here")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Date taken" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Nothing organized yet.")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Organize/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /Preview/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("enqueues the files with the chosen grouping", async () => {
    enqueue.mockResolvedValue([{ id: "j1" }]);
    const user = userEvent.setup();
    render(<OrganizeView moduleId="organize" />);
    await user.click(screen.getByRole("button", { name: "Add files…" }));
    await user.click(await screen.findByRole("radio", { name: "Camera" }));
    const run = await screen.findByRole("button", { name: /Organize 1 file/ });
    await waitFor(() => expect((run as HTMLButtonElement).disabled).toBe(false));
    await user.click(run);
    await waitFor(() => expect(enqueue).toHaveBeenCalledWith(["/photos/a.jpg"], expect.objectContaining({ groupBy: "camera", duplicates: "exact", dupAction: "folder" })));
  });

  it("expands a folder into its files", async () => {
    expand.mockResolvedValue(["/dump/1.jpg", "/dump/sub/2.jpg"]);
    const user = userEvent.setup();
    render(<OrganizeView moduleId="organize" />);
    await user.click(screen.getByRole("button", { name: "Add a folder…" }));
    expect(await screen.findByRole("button", { name: /Organize 2 files/ })).toBeTruthy();
    expect(expand).toHaveBeenCalledWith(["/dump"]);
    expect(screen.getByText("2.jpg")).toBeTruthy();
  });

  it("shows only the advanced settings that apply, with a summary", async () => {
    const user = userEvent.setup();
    render(<OrganizeView moduleId="organize" />);
    const adv = screen.getByRole("button", { name: /Advanced/ });
    expect(adv.textContent).toContain("exact duplicates set aside");
    await user.click(adv);
    expect(await screen.findByLabelText("Folder pattern")).toBeTruthy();
    expect((screen.getByLabelText("Folder pattern") as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByLabelText("Similarity")).toBeNull();
    await user.click(screen.getByRole("radio", { name: "Look-alike" }));
    expect(screen.getByLabelText("Similarity")).toBeTruthy();
    await user.click(screen.getByRole("radio", { name: "Off" }));
    expect(screen.queryByText("Duplicates go")).toBeNull();
  });

  it("blocks running with a bad pattern and says why", async () => {
    const user = userEvent.setup();
    render(<OrganizeView moduleId="organize" />);
    await user.click(screen.getByRole("button", { name: "Add files…" }));
    await user.click(await screen.findByRole("radio", { name: "Pattern" }));
    await user.click(screen.getByRole("button", { name: /Advanced/ }));
    const field = await screen.findByLabelText("Folder pattern");
    await user.clear(field);
    await user.type(field, "{{bogus}");
    expect((await screen.findAllByText(/isn't something the pattern can use/)).length).toBeGreaterThan(0);
    expect((screen.getByRole("button", { name: /Organize 1 file/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("previews the folders and the duplicate groups", async () => {
    preview.mockResolvedValue({
      total: 3,
      duplicates: 1,
      skipped: 0,
      dateSource: "exif",
      moreGroups: 0,
      folders: [
        { path: "2021/2021-03", count: 1 },
        { path: "Duplicates", count: 1 },
      ],
      groups: [
        {
          match: "exact",
          keep: { path: "/photos/a.jpg", name: "a.jpg", sizeBytes: 2048, width: 400, height: 300 },
          others: [{ path: "/photos/copy.jpg", name: "copy.jpg", sizeBytes: 2048, width: 400, height: 300 }],
        },
      ],
    });
    const user = userEvent.setup();
    render(<OrganizeView moduleId="organize" />);
    await user.click(screen.getByRole("button", { name: "Add files…" }));
    const launcher = await screen.findByRole("button", { name: /Preview/ });
    await waitFor(() => expect((launcher as HTMLButtonElement).disabled).toBe(false));
    await user.click(launcher);
    expect(await screen.findByText(/would be copied into 2 folders/)).toBeTruthy();
    expect(preview).toHaveBeenCalledWith(["/photos/a.jpg"], expect.objectContaining({ groupBy: "date" }));
    const folders = screen.getByRole("region", { name: "Folders" });
    expect(within(folders).getByText("2021")).toBeTruthy();
    expect(within(folders).getByText("2021-03")).toBeTruthy();
    expect(within(folders).getByText("Duplicates")).toBeTruthy();
    const group = screen.getByRole("listitem", { name: "Duplicates of a.jpg" });
    expect(within(group).getByText("Keeps")).toBeTruthy();
    expect(within(group).getByText("copy.jpg")).toBeTruthy();
    expect((await within(group).findAllByRole("img")).length).toBe(2);
  });

  it("shows a preview error", async () => {
    preview.mockRejectedValue({ code: "validation", message: "The destination can't be inside the files" });
    const user = userEvent.setup();
    render(<OrganizeView moduleId="organize" />);
    await user.click(screen.getByRole("button", { name: "Add files…" }));
    const launcher = await screen.findByRole("button", { name: /Preview/ });
    await waitFor(() => expect((launcher as HTMLButtonElement).disabled).toBe(false));
    await user.click(launcher);
    expect(await screen.findByRole("alert")).toBeTruthy();
  });

  it("lists finished runs with the folder and report", async () => {
    const user = userEvent.setup();
    useJobs.setState({
      byId: {
        j1: {
          id: "j1",
          moduleId: "organize",
          title: "trip",
          status: JobStatus.JobDone,
          inputs: [],
          outputs: [{ id: "o1", path: "/lib/Organized/trip/report.csv", name: "report.csv" }],
          createdAt: Date.now(),
          finishedAt: Date.now(),
          resultJson: '{"root":"/lib/Organized/trip","report":"/lib/Organized/trip/report.csv","copied":4,"duplicates":2,"skipped":0,"failed":0,"folders":2}',
        } as never,
      },
    });
    render(<OrganizeView moduleId="organize" />);
    expect(await screen.findByText("trip")).toBeTruthy();
    expect(screen.getByText(/4 organized · 2 duplicates/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open report" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Open folder" }));
    expect(revealPath).toHaveBeenCalledWith("/lib/Organized/trip");
  });
});
