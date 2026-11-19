import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { CaptionField, CaptionLength, CaptionNamePattern, CaptionPreset, CaptionThen, CaptionTone, type CaptionOptions } from "@/lib/api";
import { BUILTIN_VARS } from "../vars";
import { CurrentPipelineContext } from "./context";
import { DEFAULT_CAPTION_STEP, parseCaptionStep } from "./captions";
import { stepUI, type StepUI } from "./index";

const VARS = BUILTIN_VARS.map((v) => ({ ...v }));

function mount(json: string) {
  const ui = stepUI("captions") as StepUI<CaptionOptions>;
  const last = { value: ui.parse(json) };
  function Harness(): ReactElement {
    const [value, setValue] = useState<CaptionOptions>(last.value);
    return (
      <CurrentPipelineContext.Provider value="">
        <ui.Editor
          value={value}
          vars={VARS}
          check={undefined}
          onChange={(next) => {
            last.value = next;
            setValue(next);
          }}
        />
      </CurrentPipelineContext.Provider>
    );
  }
  render(<Harness />);
  return last;
}

describe("Write captions step", () => {
  it("parses an empty or broken value to the defaults", () => {
    expect(parseCaptionStep("{}")).toEqual(DEFAULT_CAPTION_STEP);
    expect(parseCaptionStep("not json")).toEqual(DEFAULT_CAPTION_STEP);
  });

  it("sanitises every field it edits and keeps the ones it doesn't", () => {
    const o = parseCaptionStep(
      JSON.stringify({ preset: "poem", context: 3, tone: "poetic", length: "huge", language: "Klingon", hashtags: 40, namePattern: "n", then: "writeCopies", write: { alt: false, captionFrom: "name", keepLocation: "yes" }, model: "x" }),
    );
    expect(o).toMatchObject({
      preset: CaptionPreset.PresetPosting,
      context: "",
      tone: CaptionTone.TonePoetic,
      length: CaptionLength.LengthMedium,
      language: "",
      hashtags: 15,
      namePattern: CaptionNamePattern.NameOnly,
      then: CaptionThen.ThenWriteCopies,
      model: "x",
    });
    expect(o.write).toMatchObject({ alt: false, captionFrom: CaptionField.FieldCaption, keepLocation: false, title: true });
  });

  it("defaults match the Go defaults", () => {
    expect(DEFAULT_CAPTION_STEP).toMatchObject({ preset: "posting", tone: "warm", length: "medium", language: "", hashtags: 5, namePattern: "name", kebab: false, useHints: true, readText: true, then: "nothing", index: -1, keepEdited: true });
  });

  it("edits the preset, context and the rest", async () => {
    const user = userEvent.setup();
    const last = mount("{}");
    await user.click(screen.getByRole("radio", { name: "Rename" }));
    expect(last.value.preset).toBe(CaptionPreset.PresetRename);
    await user.click(screen.getByRole("radio", { name: "Everything" }));
    expect(last.value.preset).toBe(CaptionPreset.PresetEverything);
    await user.click(screen.getByRole("radio", { name: "Poetic" }));
    expect(last.value.tone).toBe(CaptionTone.TonePoetic);
    await user.click(screen.getByRole("radio", { name: "Long" }));
    expect(last.value.length).toBe(CaptionLength.LengthLong);
    await user.type(screen.getByRole("textbox", { name: /Context/ }), "Trip");
    expect(last.value.context).toBe("Trip");
  });

  it("shows the write options only for Write into copies", async () => {
    const user = userEvent.setup();
    const last = mount("{}");
    expect(screen.queryByRole("switch", { name: "Write alt text" })).toBeNull();
    await user.selectOptions(screen.getByLabelText("Then"), CaptionThen.ThenWriteCopies);
    expect(last.value.then).toBe(CaptionThen.ThenWriteCopies);
    await user.click(screen.getByRole("switch", { name: "Write alt text" }));
    expect(last.value.write.alt).toBe(false);
    await user.click(screen.getByRole("switch", { name: "Keep location data" }));
    expect(last.value.write.keepLocation).toBe(true);
  });
});
