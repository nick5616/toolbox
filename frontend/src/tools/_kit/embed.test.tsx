import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ popOutTool: vi.fn(async (..._a: unknown[]) => undefined), addToPost: vi.fn(async (_p: string) => undefined) }));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    FilesService: { Stat: async (p: string[]) => p.map((path) => ({ path, exists: true, isDir: false, sizeBytes: 1 })), Pick: async () => [] },
    LibraryService: { Reveal: async () => undefined, RevealPath: async () => undefined, Open: async () => undefined },
    SettingsService: { ModuleState: vi.fn().mockResolvedValue(""), SetModuleState: vi.fn().mockResolvedValue(undefined) },
  };
});
vi.mock("@/lib/windows", async (orig) => {
  const real = await orig<typeof import("@/lib/windows")>();
  return { ...real, popOutTool: (...a: unknown[]) => h.popOutTool(...a) };
});

import { ModuleStatus, type Descriptor } from "@/lib/api";
import { EmbedContext, type EmbedContextValue } from "@/lib/embed";
import { registerToolActions } from "@/lib/toolActions";
import { useDeps } from "@/state/deps";
import { useJobs } from "@/state/jobs";
import { useModules } from "@/state/modules";
import { useUI } from "@/state/ui";
import { Toaster } from "@/components";
import { ClickInHost } from "@/components";
import { FileActions } from "./FileActions";
import { FileToolLayout } from "./FileToolLayout";
import { sessionFirst } from "./session";
import { sendToMenuItems } from "./sendTo";
import type { FileInputs } from "./useFileInputs";

function mod(id: string, name: string, exts: string[], extra: Partial<Descriptor> = {}): Descriptor {
  return { id, name, tagline: `${name} tagline`, description: "", icon: "box", status: ModuleStatus.StatusReady, accepts: { extensions: exts, urls: false, any: false }, requires: null, recommends: null, maxInputs: 0, hidden: false, order: 1, ...extra } as unknown as Descriptor;
}

const embedValue = (over: Partial<EmbedContextValue> = {}): EmbedContextValue => ({
  host: "photo-composer",
  hostName: "Photo Composer",
  placement: "drawer",
  handoff: { moduleId: "converter", inputs: ["/a.png"] },
  useLabel: "Use as layer",
  ...over,
});

const wrap = (v: EmbedContextValue | null, children: ReactNode) => <EmbedContext.Provider value={v}>{children}</EmbedContext.Provider>;

beforeEach(() => {
  h.popOutTool.mockClear();
  h.addToPost.mockClear();
  registerToolActions({ addToPost: h.addToPost });
  useModules.getState().setAll([
    mod("converter", "Converter", [".png", ".jpg"]),
    mod("bg-remover", "Background Remover", [".png", ".jpg"]),
    mod("stems", "Stem Splitter", [".mp3"]),
    mod("secret", "Secret", [".png"], { hidden: true }),
    mod("soon", "Soon", [".png"], { status: ModuleStatus.StatusComingSoon }),
    mod("post-builder", "Post Builder", [".png", ".jpg", ".mp4"]),
  ]);
  useDeps.getState().setAll([]);
  useJobs.getState().setAll([]);
});

describe("sendToMenuItems", () => {
  it("lists ready visible tools that accept the file, not the current one, with new-window variants and Add to post", () => {
    const items = sendToMenuItems("/x/a.png", "converter", useModules.getState().list);
    expect(items.map((i) => i.label)).toEqual(["Background Remover", "Background Remover (new window)", "Add to post…"]);
    items[1]!.onSelect();
    expect(h.popOutTool).toHaveBeenCalledWith("bg-remover", expect.objectContaining({ handoff: { moduleId: "bg-remover", inputs: ["/x/a.png"] } }));
    items[0]!.onSelect();
    expect(useUI.getState().handoff).toEqual({ moduleId: "bg-remover", inputs: ["/x/a.png"] });
    items[2]!.onSelect();
    expect(h.addToPost).toHaveBeenCalledWith("/x/a.png");
  });

  it("filters by extension", () => {
    const ids = sendToMenuItems("/x/a.mp3", "", useModules.getState().list).map((i) => i.id);
    expect(ids).toEqual(["send-stems", "send-stems-window"]);
  });
});

describe("FileActions", () => {
  it("shows Use only when embedded with onUse, and sends the path", async () => {
    const onUse = vi.fn();
    const { unmount } = render(wrap(null, <FileActions path="/a.png" moduleId="converter" />));
    expect(screen.queryByRole("button", { name: "Use as layer" })).toBeNull();
    unmount();
    render(wrap(embedValue({ onUse }), <><FileActions path="/a.png" moduleId="converter" /><Toaster /></>));
    await userEvent.click(screen.getByRole("button", { name: "Use as layer" }));
    expect(onUse).toHaveBeenCalledWith(["/a.png"]);
    expect(await screen.findByText("Sent to Photo Composer")).toBeTruthy();
  });

  it("has a Send to menu that excludes the current tool", async () => {
    render(wrap(null, <FileActions path="/a.png" moduleId="converter" />));
    await userEvent.click(screen.getByRole("button", { name: "Send to…" }));
    expect(await screen.findByRole("menuitem", { name: "Background Remover" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Converter" })).toBeNull();
    await userEvent.click(screen.getByRole("menuitem", { name: "Add to post…" }));
    expect(h.addToPost).toHaveBeenCalledWith("/a.png");
  });
});

describe("FileToolLayout embedded", () => {
  const files = [{ path: "/a.png", name: "a.png", sizeBytes: 10, exists: true, isDir: false }];
  const inputs = (list: typeof files): FileInputs => ({ files: list, add: async () => undefined, pick: async () => undefined, remove: () => undefined, clear: () => undefined }) as unknown as FileInputs;

  it("shows the tagline and drop zone standalone", () => {
    render(<FileToolLayout moduleId="converter" inputs={inputs([])} runLabel="Go" onRun={() => undefined} />);
    expect(screen.getByText("Converter tagline")).toBeTruthy();
    expect(screen.getByText("Drop files here")).toBeTruthy();
  });

  it("drops the tagline and the drop zone when files were handed over", () => {
    render(wrap(embedValue(), <FileToolLayout moduleId="converter" inputs={inputs(files)} runLabel="Go" onRun={() => undefined} />));
    expect(screen.queryByText("Converter tagline")).toBeNull();
    expect(screen.getByRole("list", { name: "Input files" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Add files/ })).toBeTruthy();
  });

  it("shows file names, with the full path as the tooltip", () => {
    const deep = [{ path: "/lots/of/folders/shot.png", name: "shot.png", sizeBytes: 10, exists: true, isDir: false }];
    render(wrap(embedValue(), <FileToolLayout moduleId="converter" inputs={inputs(deep)} runLabel="Go" onRun={() => undefined} />));
    const name = screen.getByText("shot.png");
    expect(name.getAttribute("data-tip")).toBe("/lots/of/folders/shot.png");
    expect(screen.queryByText("/lots/of/folders/shot.png")).toBeNull();
  });

  it("shows a compact add row when handed-over files were all removed", () => {
    render(wrap(embedValue(), <FileToolLayout moduleId="converter" inputs={inputs([])} runLabel="Go" onRun={() => undefined} />));
    expect(screen.queryByText("Drop files here")).toBeNull();
    expect(screen.getByText(/No files yet/)).toBeTruthy();
  });

  it("runs on Mod+Enter only with focus inside the embed", async () => {
    const onRun = vi.fn();
    render(
      <div>
        <button>outside</button>
        {wrap(embedValue(), <FileToolLayout moduleId="converter" inputs={inputs(files)} runLabel="Go" onRun={onRun} primary={<input aria-label="p" />} />)}
      </div>,
    );
    screen.getByText("outside").focus();
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    expect(onRun).not.toHaveBeenCalled();
    await act(async () => screen.getByLabelText("p").focus());
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it("keeps an Advanced click-in inline instead of a drawer", async () => {
    render(wrap(embedValue(), <ClickInHost mode="inline"><FileToolLayout moduleId="converter" inputs={inputs(files)} runLabel="Go" onRun={() => undefined} advanced={<input aria-label="Bitrate" />} /></ClickInHost>));
    await userEvent.click(screen.getByRole("button", { name: /Advanced/ }));
    expect(screen.getByLabelText("Bitrate")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("sessionFirst", () => {
  it("moves this session's jobs first and keeps order otherwise", () => {
    const jobs = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(sessionFirst(jobs, new Set(["c"])).map((j) => j.id)).toEqual(["c", "a", "b"]);
    expect(sessionFirst(jobs, null).map((j) => j.id)).toEqual(["a", "b", "c"]);
  });
});
