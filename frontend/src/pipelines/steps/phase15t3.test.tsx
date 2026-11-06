import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return { ...actual, ImageBatchService: { Fonts: async () => ["Arial", "Georgia"] } };
});

import { BUILTIN_VARS } from "../vars";
import { imagebatchSteps, parseImageBatchStep } from "./imagebatch";
import { silenceSteps, parseSilenceStep } from "./silence";
import { stepUI, type StepUI } from "./registry";

const VARS = BUILTIN_VARS.map((v) => ({ ...v }));

function mount(type: string, json: string) {
  const ui = stepUI(type) as StepUI<unknown>;
  if (!ui) throw new Error(`no editor for ${type}`);
  const last: { value: unknown } = { value: ui.parse(json) };
  function Harness(): ReactElement {
    const [value, setValue] = useState<unknown>(last.value);
    return (
      <ui.Editor
        value={value}
        vars={VARS}
        check={undefined}
        onChange={(next) => {
          last.value = next;
          setValue(next);
        }}
      />
    );
  }
  render(<Harness />);
  return last;
}

describe("silence step", () => {
  it("registers itself and fills defaults, keeping unknown fields", () => {
    expect(silenceSteps[0]?.type).toBe("silence");
    expect(stepUI("silence")).toBeDefined();
    expect(parseSilenceStep("")).toEqual({ thresholdDb: -35, minSilenceMs: 500, paddingMs: 150, crossfadeMs: 15, cutList: true });
    expect(parseSilenceStep('{"thresholdDb":-200,"extra":1,"cutList":false}')).toMatchObject({ thresholdDb: -80, extra: 1, cutList: false });
  });

  it("edits the numbers and the cut list", async () => {
    const user = userEvent.setup();
    const last = mount("silence", "{}");
    const input = screen.getByLabelText("Padding");
    await user.clear(input);
    await user.type(input, "300");
    await user.tab();
    expect((last.value as { paddingMs: number }).paddingMs).toBe(300);
    await user.click(screen.getByRole("switch", { name: /cut list/i }));
    expect((last.value as { cutList: boolean }).cutList).toBe(false);
  });
});

describe("image batch step", () => {
  it("registers itself and clamps what Go would reject", () => {
    expect(imagebatchSteps[0]?.type).toBe("imagebatch");
    expect(stepUI("imagebatch")).toBeDefined();
    const d = parseImageBatchStep("");
    expect(d).toMatchObject({ resize: "longSide", longSide: 2048, format: "jpg", quality: 85, strip: true, name: "{name}" });
    expect(parseImageBatchStep('{"quality":900,"format":"bmp","extra":true,"watermark":{"kind":"text","text":"© {project}"}}')).toMatchObject({
      quality: 100,
      format: "jpg",
      extra: true,
      watermark: { kind: "text", text: "© {project}" },
    });
  });

  it("switches size mode, format and watermark", async () => {
    const user = userEvent.setup();
    const last = mount("imagebatch", "{}");
    await user.click(screen.getByRole("radio", { name: "Exact size" }));
    expect((last.value as { resize: string }).resize).toBe("exact");
    expect(screen.getByLabelText("Width")).toBeTruthy();
    await user.click(screen.getByRole("radio", { name: "WebP" }));
    expect((last.value as { format: string }).format).toBe("webp");
    await user.click(screen.getByRole("radio", { name: "Text" }));
    expect((last.value as { watermark: { kind: string } }).watermark.kind).toBe("text");
    expect(screen.getByText("Watermark text")).toBeTruthy();
    await user.click(screen.getByRole("switch", { name: "Strip metadata" }));
    expect((last.value as { strip: boolean }).strip).toBe(false);
  });
});
