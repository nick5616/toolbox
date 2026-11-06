import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClickInHost, ToolClickIn } from "@/components";
import { ModuleStatus, type Descriptor } from "@/lib/api";
import { useModules } from "@/state/modules";
import { useUI, type Handoff } from "@/state/ui";
import { EmbedContext, useEmbed, useToolHandoff, type EmbedContextValue } from "./embed";
import { registerToolViews } from "./toolActions";

const popOutTool = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock("./windows", async (orig) => {
  const real = await orig<typeof import("./windows")>();
  return { ...real, popOutTool: (...a: unknown[]) => popOutTool(...a), relayOn: () => () => undefined, relaySend: async () => undefined };
});

afterEach(() => {
  useUI.setState({ handoff: null });
  popOutTool.mockClear();
});

function embed(h: Handoff): EmbedContextValue {
  return { host: "photo-composer", hostName: "Photo Composer", placement: "drawer", handoff: h, useLabel: "Use as layer" };
}

describe("useToolHandoff", () => {
  it("takes the global handoff when standalone", () => {
    const got: Handoff[] = [];
    renderHook(() => useToolHandoff("stems", (h) => got.push(h)));
    act(() => useUI.getState().handOff({ moduleId: "stems", inputs: ["a.mp3"] }));
    expect(got.map((h) => h.inputs)).toEqual([["a.mp3"]]);
    expect(useUI.getState().handoff).toBeNull();
  });

  it("delivers the embed's handoff once per object and leaves the global one alone", () => {
    const got: Handoff[] = [];
    const h1: Handoff = { moduleId: "stems", inputs: ["song.mp3"] };
    let value = embed(h1);
    const wrapper = ({ children }: { children: ReactNode }) => <EmbedContext.Provider value={value}>{children}</EmbedContext.Provider>;
    const { rerender } = renderHook(() => useToolHandoff("stems", (h) => got.push(h)), { wrapper });
    act(() => useUI.getState().handOff({ moduleId: "stems", inputs: ["other.mp3"] }));
    rerender();
    expect(got.map((h) => h.inputs)).toEqual([["song.mp3"]]);
    expect(useUI.getState().handoff?.inputs).toEqual(["other.mp3"]);
    value = { ...value };
    rerender();
    expect(got).toHaveLength(1);
    value = embed({ moduleId: "stems", inputs: ["b.mp3"] });
    rerender();
    expect(got.map((h) => h.inputs)).toEqual([["song.mp3"], ["b.mp3"]]);
  });
});

function desc(id: string, status: ModuleStatus): Descriptor {
  return { id, name: id === "stems" ? "Stem Splitter" : "Photo Composer", icon: "box", status, accepts: { extensions: [], urls: false, any: false } } as unknown as Descriptor;
}

function FakeStems() {
  const e = useEmbed();
  const inputs = e?.handoff.inputs ?? [];
  return (
    <div>
      <p>stems view: {inputs.join(",")}</p>
      {e?.onUse && (
        <button type="button" onClick={() => e.onUse?.(["vocals.flac"])}>
          {e.useLabel}
        </button>
      )}
    </div>
  );
}

describe("ToolClickIn", () => {
  it("renders the constituent's view with the inputs and returns results through Use", async () => {
    registerToolViews({ stems: FakeStems });
    useModules.getState().setAll([desc("stems", ModuleStatus.StatusReady), desc("photo-composer", ModuleStatus.StatusReady)]);
    const used: string[][] = [];
    render(
      <ClickInHost>
        <ToolClickIn host="photo-composer" module="stems" inputs={["song.mp3"]} useLabel="Use as music" onUse={(p) => used.push(p)} />
      </ClickInHost>,
    );
    await userEvent.click(screen.getByRole("button", { name: /Stem Splitter/ }));
    expect(await screen.findByText("stems view: song.mp3")).toBeTruthy();
    await userEvent.click(screen.getByText("Use as music"));
    expect(used).toEqual([["vocals.flac"]]);
  });

  it("pops out with the handoff and an embed link", async () => {
    registerToolViews({ stems: FakeStems });
    useModules.getState().setAll([desc("stems", ModuleStatus.StatusReady), desc("photo-composer", ModuleStatus.StatusReady)]);
    render(
      <ClickInHost>
        <ToolClickIn host="photo-composer" module="stems" inputs={["song.mp3"]} onUse={() => undefined} />
      </ClickInHost>,
    );
    await userEvent.click(screen.getByRole("button", { name: /Stem Splitter/ }));
    await userEvent.click(screen.getByRole("button", { name: "Pop out" }));
    const [module, opts] = popOutTool.mock.calls[0] as [string, { handoff: Handoff }];
    expect(module).toBe("stems");
    expect(opts.handoff.inputs).toEqual(["song.mp3"]);
    expect(opts.handoff.embed).toMatchObject({ host: "photo-composer", hostName: "Photo Composer", useLabel: "Use in Photo Composer" });
  });

  it("hands the action to the view and keeps it on pop-out", async () => {
    function ActionView() {
      return <p>action: {useEmbed()?.handoff.action}</p>;
    }
    registerToolViews({ stems: ActionView });
    useModules.getState().setAll([desc("stems", ModuleStatus.StatusReady), desc("photo-composer", ModuleStatus.StatusReady)]);
    render(
      <ClickInHost>
        <ToolClickIn host="photo-composer" module="stems" inputs={["song.mp3"]} action="compress" onUse={() => undefined} />
      </ClickInHost>,
    );
    await userEvent.click(screen.getByRole("button", { name: /Stem Splitter/ }));
    expect(await screen.findByText("action: compress")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Pop out" }));
    const [, opts] = popOutTool.mock.calls[0] as [string, { handoff: Handoff }];
    expect(opts.handoff.action).toBe("compress");
  });

  it("is disabled when the constituent isn't ready", () => {
    registerToolViews({ stems: FakeStems });
    useModules.getState().setAll([desc("stems", ModuleStatus.StatusComingSoon), desc("photo-composer", ModuleStatus.StatusReady)]);
    render(<ToolClickIn host="photo-composer" module="stems" inputs={["song.mp3"]} />);
    expect((screen.getByRole("button", { name: /Stem Splitter/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
