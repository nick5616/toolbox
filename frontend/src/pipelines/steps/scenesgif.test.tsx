import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentType } from "react";

import { gifSteps } from "./gif";
import { scenesSteps } from "./scenes";
import { registeredStepTypes, stepUI, type StepEditorProps } from "./registry";

afterEach(cleanup);

function mount(type: string, value: unknown) {
  const ui = stepUI(type);
  if (!ui) throw new Error(`no editor for ${type}`);
  const Editor = ui.Editor as ComponentType<StepEditorProps<unknown>>;
  const onChange = vi.fn();
  render(<Editor value={value} onChange={onChange} check={undefined} vars={[]} />);
  return { ui, onChange };
}

function last(onChange: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = onChange.mock.calls.at(-1);
  if (!call) throw new Error("onChange was not called");
  return call[0] as Record<string, unknown>;
}

describe("scenes and gif step editors", () => {
  it("export one step each and register it", () => {
    expect(scenesSteps.map((s) => (s as { type: string }).type)).toEqual(["scenes"]);
    expect(gifSteps.map((s) => (s as { type: string }).type)).toEqual(["gif"]);
    expect(registeredStepTypes()).toEqual(expect.arrayContaining(["scenes", "gif"]));
  });

  it.each(["scenes", "gif"])("%s: parse never throws, fills defaults and is idempotent", (type) => {
    const ui = stepUI(type);
    for (const bad of ["", "not json", "null", "[1]", '{"mode":42,"output":{},"fps":"x","threshold":99,"columns":50}']) {
      expect(() => ui?.parse(bad)).not.toThrow();
    }
    const once = ui?.parse("{}");
    expect(ui?.parse(JSON.stringify(once))).toEqual(once);
    mount(type, once);
  });

  it("scenes: stills by default; out-of-range values fall back; unknown fields survive", () => {
    const ui = stepUI("scenes");
    expect(ui?.parse("")).toMatchObject({ output: "stills", keep: "all", threshold: 0.3, keepN: 10 });
    expect(ui?.parse('{"threshold":2,"keepN":0,"output":"gif","extra":1}')).toMatchObject({ threshold: 0.3, keepN: 10, output: "stills", extra: 1 });
  });

  it("scenes: choosing a keep rule shows the count and reports edits", async () => {
    const value = stepUI("scenes")?.parse("{}");
    const { onChange } = mount("scenes", value);
    expect(screen.queryByLabelText("How many")).toBeNull();
    await userEvent.click(screen.getByRole("radio", { name: "Both" }));
    expect(last(onChange).output).toBe("both");
    cleanup();
    mount("scenes", { ...(value as object), keep: "active" });
    expect(screen.getByLabelText("How many")).toBeTruthy();
  });

  it("gif: the mode switches the fields and the grid stays within 100 frames", async () => {
    const ui = stepUI("gif");
    expect(ui?.parse('{"columns":10,"rows":10}')).toMatchObject({ columns: 10, rows: 10 });
    expect(ui?.parse('{"columns":9,"rows":10}')).toMatchObject({ columns: 9, rows: 10 }); // 90 ≤ 100
    const { onChange } = mount("gif", ui?.parse("{}"));
    expect(screen.getByLabelText("Length")).toBeTruthy();
    await userEvent.click(screen.getByRole("radio", { name: "Contact sheet" }));
    expect(last(onChange).mode).toBe("sheet");
    cleanup();
    mount("gif", { ...(ui?.parse("{}") as object), mode: "sheet" });
    expect(screen.getByLabelText("Columns")).toBeTruthy();
    expect(screen.queryByLabelText("Length")).toBeNull();
  });
});
