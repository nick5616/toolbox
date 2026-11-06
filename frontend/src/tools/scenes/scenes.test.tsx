import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueue = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    ScenesService: { Enqueue: (...a: unknown[]) => enqueue(...a) },
    FilesService: {
      Pick: async () => ["/a.mp4"],
      ImageThumb: async () => "data:image/jpeg;base64,AAAA",
      Stat: async (p: string[]) => p.map((path) => ({ path, name: path, sizeBytes: 10, exists: true, isDir: false, kind: "video" })),
    },
    SettingsService: { ModuleState: async () => "", SetModuleState: async () => undefined },
    LibraryService: { Reveal: async () => undefined, Open: async () => undefined, RevealPath: async () => undefined },
  };
});

import { ErrorCode, JobStatus, SceneKeep, SceneOutput } from "@/lib/api";
import { useJobs } from "@/state/jobs";
import ScenesView from "./ScenesView";
import { DEFAULT_SCENES_OPTIONS, sanitizeScenesOptions, sceneCountText, toScenesResult } from "./options";

function job(over: Record<string, unknown> = {}) {
  return {
    id: "j1",
    moduleId: "scenes",
    title: "a.mp4",
    status: JobStatus.JobDone,
    progress: 1,
    message: "",
    inputs: ["/a.mp4"],
    optionsJson: "{}",
    errorCode: ErrorCode.$zero,
    error: "",
    errorHint: "",
    pipelineRunId: "",
    pipelineStepId: "",
    attempt: 1,
    cancelRequested: false,
    createdAt: 1,
    startedAt: 1,
    finishedAt: 2,
    outputs: [
      { id: "o1", path: "/o/a (scene 001).mp4", missing: false },
      { id: "o2", path: "/o/a (scene 001).jpg", missing: false },
      { id: "o3", path: "/o/a (scene 003).mp4", missing: false },
      { id: "o4", path: "/o/a (scene 003).jpg", missing: false },
    ] as never,
    resultJson: JSON.stringify({
      durationMs: 20000,
      found: 4,
      reencoded: 1,
      scenes: [
        { n: 1, startMs: 0, endMs: 5000, motion: 0.1, clip: "/o/a (scene 001).mp4", still: "/o/a (scene 001).jpg" },
        { n: 3, startMs: 9000, endMs: 20000, motion: 0.2, clip: "/o/a (scene 003).mp4", still: "/o/a (scene 003).jpg" },
      ],
      outputs: [],
    }),
    ...over,
  };
}

describe("scenes options", () => {
  it("sanitizes saved options", () => {
    expect(sanitizeScenesOptions({ threshold: 0.5, output: "stills", keep: "longest", keepN: 3 }, DEFAULT_SCENES_OPTIONS)).toEqual({
      ...DEFAULT_SCENES_OPTIONS,
      threshold: 0.5,
      output: "stills",
      keep: "longest",
      keepN: 3,
    });
    expect(sanitizeScenesOptions({ threshold: 5, minSceneSecs: -1, output: "gif", keep: 4, keepN: 9000 }, DEFAULT_SCENES_OPTIONS)).toEqual({
      ...DEFAULT_SCENES_OPTIONS,
      threshold: 0.9,
      minSceneSecs: 0.2,
      keepN: 200,
    });
    expect(sanitizeScenesOptions("junk", DEFAULT_SCENES_OPTIONS)).toEqual(DEFAULT_SCENES_OPTIONS);
  });

  it("reads a result and words the count", () => {
    const item = toScenesResult({ ...job(), inputs: ["/in/a.mp4"] } as never);
    expect(item?.title).toBe("a.mp4");
    expect(item?.scenes.map((s) => s.n)).toEqual([1, 3]);
    expect(item && sceneCountText(item)).toBe("2 of 4 scenes");
    expect(toScenesResult({ ...job(), resultJson: "" } as never)).toBeNull();
  });
});

describe("ScenesView", () => {
  beforeEach(() => {
    enqueue.mockReset();
    useJobs.setState({ byId: {} });
  });

  it("enqueues the chosen output and keep options", async () => {
    enqueue.mockResolvedValue([{}]);
    const user = userEvent.setup();
    render(<ScenesView moduleId="scenes" />);
    await user.click(await screen.findByRole("radio", { name: "Stills" }));
    await user.selectOptions(screen.getByLabelText("Keep"), SceneKeep.KeepLongest);
    expect(screen.getByLabelText("Number of scenes to keep")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Add files…" }));
    const run = await screen.findByRole("button", { name: /Split/ });
    await waitFor(() => expect((run as HTMLButtonElement).disabled).toBe(false));
    await user.click(run);
    await waitFor(() =>
      expect(enqueue).toHaveBeenCalledWith(["/a.mp4"], expect.objectContaining({ output: SceneOutput.OutputStills, keep: SceneKeep.KeepLongest, keepN: 10 })),
    );
  });

  it("shows the scene strip and the clip rows of a finished job", async () => {
    useJobs.getState().upsert(job() as never);
    render(<ScenesView moduleId="scenes" />);
    expect(await screen.findByText("2 of 4 scenes · 1 re-encoded to cut exactly")).toBeTruthy();
    expect(screen.getByLabelText("Scene 1, 0:00–0:05")).toBeTruthy();
    expect(screen.getByLabelText("Scene 3, 0:09–0:20")).toBeTruthy();
    expect(screen.getByText("a (scene 003).mp4")).toBeTruthy();
  });
});
