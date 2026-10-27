import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueue = vi.hoisted(() => vi.fn());
const setState = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => undefined));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    StemsService: {
      Defaults: async () => ({ preset: "four-fast", format: "wav" }),
      Presets: async () => [
        { id: "vocals-fast", label: "Vocals + instrumental · fast", group: "", kind: "audio", ext: "", acceptsKinds: null, downloadBytes: 67e6, stems: ["Vocals", "Instrumental"], speed: "fast" },
        { id: "four-fast", label: "4 stems · fast", group: "", kind: "audio", ext: "", acceptsKinds: null, downloadBytes: 84e6, stems: ["Vocals", "Drums", "Bass", "Other"], speed: "fast" },
      ],
      Enqueue: (...a: unknown[]) => enqueue(...a),
    },
    FilesService: {
      Pick: async () => ["/a.mp3"],
      Stat: async (p: string[]) => p.map((path) => ({ path, name: path, sizeBytes: 10, exists: true, isDir: false, kind: "audio" })),
    },
    SettingsService: { ModuleState: async () => "", SetModuleState: (...a: unknown[]) => setState(...a) },
    LibraryService: { Reveal: async () => undefined, Open: async () => undefined, RevealPath: async () => undefined },
  };
});

import { useToastStore } from "@/components/toast";
import StemsView from "./StemsView";
import { DEFAULT_STEMS_OPTIONS, dirname, parseStemsResult, sanitizeStemsOptions } from "./options";
import { mapInputErrors } from "@/tools/_kit/enqueue";

describe("stems options", () => {
  it("sanitize keeps only valid fields", () => {
    expect(sanitizeStemsOptions({ preset: "four-best", format: "flac" }, DEFAULT_STEMS_OPTIONS)).toEqual({ preset: "four-best", format: "flac" });
    expect(sanitizeStemsOptions({ preset: "nope", format: 3 }, DEFAULT_STEMS_OPTIONS)).toEqual(DEFAULT_STEMS_OPTIONS);
    expect(sanitizeStemsOptions(null, DEFAULT_STEMS_OPTIONS)).toEqual(DEFAULT_STEMS_OPTIONS);
    expect(sanitizeStemsOptions({ format: "mp3", extra: 1 }, DEFAULT_STEMS_OPTIONS)).toEqual({ preset: "four-fast", format: "mp3" });
  });

  it("parses results safely", () => {
    expect(parseStemsResult("not json")).toBeNull();
    expect(parseStemsResult("")).toBeNull();
    expect(parseStemsResult('{"preset":"x","stems":[{"name":"Vocals","path":"/o/t/v.wav"},{"name":1}]}')?.stems).toEqual([
      { name: "Vocals", path: "/o/t/v.wav" },
    ]);
    expect(dirname("C:\\o\\t\\v.wav")).toBe("C:\\o\\t");
    expect(dirname("/o/t/v.wav")).toBe("/o/t");
  });

  it("maps inputs.N errors", () => {
    expect(mapInputErrors({ "inputs.1": "bad", other: "x", "inputs.9": "y" }, ["/a", "/b"])).toEqual({ "/b": "bad" });
  });
});

describe("StemsView", () => {
  beforeEach(() => {
    enqueue.mockReset();
    setState.mockClear();
    useToastStore.setState({ toasts: [] });
  });

  async function addFile() {
    const user = userEvent.setup();
    render(<StemsView moduleId="stems" />);
    await screen.findByRole("radio", { name: /4 stems/ });
    await user.click(screen.getByRole("button", { name: "Add files…" }));
    return { user, btn: await screen.findByRole("button", { name: /Split 1 track/ }) };
  }

  it("persists option changes and enqueues with paths + options", async () => {
    enqueue.mockResolvedValue([{}]);
    const { user, btn } = await addFile();
    await user.click(screen.getByRole("radio", { name: /Vocals \+ instrumental/ }));
    await user.click(screen.getByRole("radio", { name: "flac" }));
    await waitFor(() => expect(setState).toHaveBeenCalled());
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    await user.click(btn);
    await waitFor(() => expect(enqueue).toHaveBeenCalledWith(["/a.mp3"], { preset: "vocals-fast", format: "flac" }));
    expect(JSON.parse(String(setState.mock.calls.at(-1)?.[1]))).toEqual({ preset: "vocals-fast", format: "flac" });
    await waitFor(() => expect(screen.queryByText("a.mp3")).toBeNull());
  });

  it("shows inputs.N validation errors on the file", async () => {
    enqueue.mockRejectedValue({ cause: JSON.stringify({ code: "validation", message: "bad", fields: { "inputs.0": "Not audio" } }) });
    const { user, btn } = await addFile();
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    await user.click(btn);
    expect(await screen.findByText("Not audio")).toBeTruthy();
  });
});
