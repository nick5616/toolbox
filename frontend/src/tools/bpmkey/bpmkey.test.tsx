import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueue = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    BpmKeyService: { Enqueue: (...a: unknown[]) => enqueue(...a) },
    FilesService: {
      Pick: async () => ["/a.mp3"],
      Stat: async (p: string[]) => p.map((path) => ({ path, name: path, sizeBytes: 10, exists: true, isDir: false, kind: "audio" })),
    },
    SettingsService: { ModuleState: async () => "", SetModuleState: async () => undefined },
  };
});

import { JobStatus, type Job } from "@/lib/api";
import { toCsv } from "@/tools/_kit";
import { useJobs } from "@/state/jobs";
import BpmKeyView from "./BpmKeyView";
import { bpmColumns } from "./columns";
import { parseBpmKeyResult, type BpmRow } from "./results";

const RESULT = '{"bpm":127.96,"bpmCandidates":[64,128,256],"key":"A minor","camelot":"8A","confidence":0.82,"alternatives":null,"durationSec":200,"truncated":false}';

function job(over: Partial<Job>): Job {
  return {
    id: "j1", moduleId: "bpm-key", title: "song.mp3", status: JobStatus.JobDone, progress: 1, message: "", inputs: ["/song.mp3"],
    optionsJson: "{}", errorCode: "", error: "", errorHint: "", attempt: 1, cancelRequested: false,
    createdAt: 1, startedAt: 1, finishedAt: Date.now(), outputs: null, resultJson: RESULT, ...over,
  } as Job;
}

describe("bpm-key results", () => {
  it("parses good JSON and ignores bad", () => {
    expect(parseBpmKeyResult(RESULT)?.bpm).toBeCloseTo(127.96);
    expect(parseBpmKeyResult("{oops")).toBeNull();
    expect(parseBpmKeyResult('{"bpm":"x"}')).toBeNull();
    expect(parseBpmKeyResult("")).toBeNull();
  });

  it("builds CSV rows", () => {
    const result = parseBpmKeyResult(RESULT);
    if (!result) throw new Error("no result");
    const rows: BpmRow[] = [{ id: "1", file: "a, b.mp3", at: 0, result }];
    const csv = toCsv(rows, bpmColumns().slice(0, 5));
    expect(csv).toBe('File,BPM,Key,Camelot,Confidence\r\n"a, b.mp3",128.0,A minor,8A,0.82');
  });
});

describe("BpmKeyView", () => {
  beforeEach(() => {
    enqueue.mockReset();
    useJobs.setState({ byId: {} });
  });

  it("lists done jobs and ignores unparseable ones", async () => {
    useJobs.getState().setAll([job({}), job({ id: "j2", title: "bad.mp3", resultJson: "nope" })]);
    render(<BpmKeyView moduleId="bpm-key" />);
    expect(await screen.findByText("song.mp3")).toBeTruthy();
    expect(screen.queryByText("bad.mp3")).toBeNull();
    expect(screen.getByText("128.0")).toBeTruthy();
    expect(screen.getByText("8A")).toBeTruthy();
  });

  it("enqueues paths and maps validation errors", async () => {
    enqueue.mockRejectedValue({ cause: JSON.stringify({ code: "validation", message: "bad", fields: { "inputs.0": "Unreadable" } }) });
    const user = userEvent.setup();
    render(<BpmKeyView moduleId="bpm-key" />);
    await user.click(screen.getByRole("button", { name: "Add files…" }));
    const btn = await screen.findByRole("button", { name: /Analyze 1 file/ });
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    await user.click(btn);
    await waitFor(() => expect(enqueue).toHaveBeenCalledWith(["/a.mp3"]));
    expect(await screen.findByText("Unreadable")).toBeTruthy();
  });
});
