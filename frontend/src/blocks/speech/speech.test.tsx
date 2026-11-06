import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TranscribeTask } from "@/lib/api";
import { SpeechOptions } from "./SpeechOptions";
import {
  isSpeechModel,
  isTranslate,
  languageName,
  languageOptions,
  modelLabel,
  speechSummary,
  taskOf,
} from "./options";
import { basename, parseTranscriptResult, previewPath, toggleFormat, wasAutoDetected } from "./transcript";

const LANGS = [
  { code: "en", name: "English" },
  { code: "de", name: "German" },
];

describe("speech options helpers", () => {
  it.each([
    [{ model: "small", language: "", translate: false }, "Small · Auto-detect"],
    [{ model: "turbo", language: "de", translate: false }, "Turbo · German"],
    [{ model: "base", language: "xx", translate: true }, "Base · XX · to English"],
    [{ model: "odd", language: "en", translate: false }, "odd · English"],
  ])("summarises %j as %s", (s, text) => {
    expect(speechSummary(s, LANGS)).toBe(text);
  });

  it("prefers an engine preset's label", () => {
    expect(modelLabel("small", [{ id: "small", label: "Small (464 MB)" }])).toBe("Small (464 MB)");
    expect(modelLabel("small")).toBe("Small");
  });

  it("builds language options with auto-detect first", () => {
    expect(languageOptions(LANGS)).toEqual([
      { value: "", label: "Auto-detect" },
      { value: "en", label: "English" },
      { value: "de", label: "German" },
    ]);
    expect(languageName("", LANGS)).toBe("Auto-detect");
    expect(languageName("fr", LANGS)).toBe("FR");
  });

  it("maps translate to the Go task and back", () => {
    expect(taskOf(true)).toBe(TranscribeTask.TaskTranslate);
    expect(taskOf(false)).toBe(TranscribeTask.TaskTranscribe);
    expect(isTranslate(TranscribeTask.TaskTranslate)).toBe(true);
    expect(isTranslate(TranscribeTask.TaskTranscribe)).toBe(false);
  });

  it("knows the speech models", () => {
    expect(isSpeechModel("turbo")).toBe(true);
    expect(isSpeechModel("huge")).toBe(false);
    expect(isSpeechModel(3)).toBe(false);
  });
});

describe("transcript helpers", () => {
  it("keeps at least one format", () => {
    expect(toggleFormat(["txt"], "txt")).toEqual(["txt"]);
    expect(toggleFormat(["srt"], "json")).toEqual(["srt", "json"]);
  });
  it("parses results defensively", () => {
    expect(parseTranscriptResult("")).toBeNull();
    expect(parseTranscriptResult("nope")).toBeNull();
    expect(parseTranscriptResult(JSON.stringify({ language: "en", outputs: ["a", 3] }))?.outputs).toEqual(["a"]);
  });
  it("finds the preview file, base names and auto-detect", () => {
    expect(previewPath(["/o/a.srt", "/o/a.txt"])).toBe("/o/a.txt");
    expect(basename("C:\\x\\y.srt")).toBe("y.srt");
    expect(wasAutoDetected(JSON.stringify({ language: "" }))).toBe(true);
    expect(wasAutoDetected("{")).toBe(false);
  });
});

describe("SpeechOptions", () => {
  it("reports each change as a patch", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<SpeechOptions value={{ model: "small", language: "", translate: false }} languages={LANGS} onChange={onChange} />);
    await user.selectOptions(screen.getByLabelText("Model"), "turbo");
    expect(onChange).toHaveBeenLastCalledWith({ model: "turbo" });
    await user.selectOptions(screen.getByLabelText("Spoken language"), "de");
    expect(onChange).toHaveBeenLastCalledWith({ language: "de" });
    await user.click(screen.getByRole("switch", { name: "Translate to English" }));
    expect(onChange).toHaveBeenLastCalledWith({ translate: true });
  });
});
