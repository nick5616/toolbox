import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  masks: vi.fn(),
  composer: vi.fn(),
  edits: vi.fn(),
  recipes: vi.fn(),
}));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    EraserService: { SavedMasks: () => h.masks() },
    ComposerService: { List: () => h.composer() },
    EditStudioService: { List: () => h.edits(), BeatRecipes: () => h.recipes() },
  };
});

import { usePipelines } from "@/state/pipelines";
import { BUILTIN_VARS } from "../vars";
import { CurrentPipelineContext } from "./context";
import { stepUI, type StepUI } from "./index";

const VARS = BUILTIN_VARS.map((v) => ({ ...v }));

/** Renders a type's editor with real state; `last.value` is the latest value. */
function mount(type: string, json: string, pipelineId = "") {
  const ui = stepUI(type) as StepUI<unknown>;
  if (!ui) throw new Error(`no editor for ${type}`);
  const last: { value: unknown; calls: number } = { value: ui.parse(json), calls: 0 };
  function Harness(): ReactElement {
    const [value, setValue] = useState<unknown>(last.value);
    return (
      <CurrentPipelineContext.Provider value={pipelineId}>
        <ui.Editor
          value={value}
          vars={VARS}
          check={undefined}
          onChange={(next) => {
            last.value = next;
            last.calls++;
            setValue(next);
          }}
        />
      </CurrentPipelineContext.Provider>
    );
  }
  render(<Harness />);
  return last;
}

const proj = (id: string, name: string) => ({ id, name, kind: "composition", thumb: "", items: 1, missing: 0, updatedAt: 1, flags: [] });

beforeEach(() => {
  h.masks.mockReset().mockResolvedValue([]);
  h.composer.mockReset().mockResolvedValue([]);
  h.edits.mockReset().mockResolvedValue([]);
  h.recipes.mockReset().mockResolvedValue(["downbeat", "kick"]);
  usePipelines.setState({ entries: [] });
});
afterEach(() => usePipelines.setState({ entries: [] }));

const NEW_TYPES = ["dev-utils", "post-builder", "clipboard", "llm-chat", "object-eraser", "pipelines", "photo-composer", "video-studio", "edit-studio"];

describe("Phase 14 step editors", () => {
  it("are all registered; parse never throws, ignores non-objects and keeps unknown fields", () => {
    for (const t of NEW_TYPES) {
      const ui = stepUI(t);
      expect(ui, t).toBeDefined();
      expect(() => ui?.parse("not json")).not.toThrow();
      expect(ui?.parse("[]")).toEqual(ui?.parse("{}"));
    }
    for (const t of NEW_TYPES.filter((x) => x !== "llm-chat")) {
      expect(stepUI(t)?.parse('{"futureField":{"a":1}}'), t).toMatchObject({ futureField: { a: 1 } });
    }
  });

  it("llm-chat shares the chat editor with the old pipelines.chat id", () => {
    const a = stepUI("llm-chat");
    const b = stepUI("pipelines.chat");
    expect(a?.Editor).toBe(b?.Editor);
    expect(a?.parse("{}")).toEqual(b?.parse("{}"));
  });

  describe("dev-utils", () => {
    it("defaults to three checksums and edits algorithms, format and name", async () => {
      const last = mount("dev-utils", "{}");
      expect(last.value).toMatchObject({ action: "checksums", format: "sidecar", algorithms: ["sha256", "sha1", "md5"], encoding: "base64" });
      await userEvent.click(screen.getByRole("switch", { name: "SHA-1" }));
      expect((last.value as { algorithms: string[] }).algorithms).toEqual(["sha256", "md5"]);
      await userEvent.click(screen.getByRole("switch", { name: "CRC-32" }));
      expect((last.value as { algorithms: string[] }).algorithms).toEqual(["sha256", "md5", "crc32"]);
      await userEvent.click(screen.getByRole("radio", { name: "One CSV" }));
      expect(last.value).toMatchObject({ format: "csv" });
      await userEvent.type(screen.getByLabelText("File name (optional)"), "{{item}");
      expect((last.value as { name: string }).name).toBe("{item}");
    });

    it("switches to encode and keeps the checksum settings it doesn't show", async () => {
      const last = mount("dev-utils", '{"future":1}');
      await userEvent.click(screen.getByRole("radio", { name: "Encode" }));
      expect(screen.queryByRole("switch", { name: "SHA-256" })).toBeNull();
      await userEvent.click(screen.getByRole("radio", { name: "Hex" }));
      expect(last.value).toMatchObject({ action: "encode", encoding: "hex", future: 1, algorithms: ["sha256", "sha1", "md5"] });
    });

    it("sanitises unknown values", () => {
      expect(stepUI("dev-utils")?.parse('{"action":"x","algorithms":["md5","nope","md5"],"encoding":3}')).toMatchObject({
        action: "checksums",
        algorithms: ["md5"],
        encoding: "base64",
      });
    });
  });

  describe("post-builder", () => {
    it("defaults, shows the carousel shape only for carousels, and edits the caption", async () => {
      const last = mount("post-builder", "{}");
      expect(last.value).toMatchObject({ format: "auto", aspect: "4:5", name: "{item}", caption: "", keepLocation: false });
      await userEvent.click(screen.getByRole("radio", { name: "1:1" }));
      expect(last.value).toMatchObject({ aspect: "1:1" });
      await userEvent.selectOptions(screen.getByLabelText("Make a"), "reel");
      expect(screen.queryByRole("radio", { name: "1:1" })).toBeNull();
      await userEvent.click(screen.getByRole("switch", { name: "Keep location and metadata" }));
      expect(last.value).toMatchObject({ format: "reel", keepLocation: true });
      await userEvent.type(screen.getByLabelText("Caption"), "Hi");
      expect((last.value as { caption: string }).caption).toBe("Hi");
    });
  });

  describe("clipboard", () => {
    it("edits the text and explains the empty case", async () => {
      const last = mount("clipboard", '{"extra":true}');
      expect(screen.getByText(/first \.txt or \.md file/)).toBeTruthy();
      await userEvent.type(screen.getByLabelText("Text to copy"), "Done");
      expect(last.value).toEqual({ extra: true, text: "Done" });
      expect(screen.getByText(/Copies this text/)).toBeTruthy();
    });
  });

  describe("object-eraser", () => {
    it("picks a saved mask and the model", async () => {
      h.masks.mockResolvedValue([{ id: "m1", name: "Logo", width: 800, height: 600, createdAt: 1 }]);
      const last = mount("object-eraser", '{"model":"fast"}');
      await screen.findByRole("option", { name: "Logo (800×600)" });
      await userEvent.selectOptions(screen.getByLabelText("Saved mask"), "m1");
      expect(last.value).toMatchObject({ maskId: "m1", model: "fast" });
      await userEvent.click(screen.getByRole("radio", { name: "Best" }));
      expect(last.value).toMatchObject({ model: "best", maskId: "m1" });
    });

    it("points to the tool when no mask is saved, and shows a gone mask", async () => {
      mount("object-eraser", '{"maskId":"old"}');
      expect(await screen.findByText(/Save mask for pipelines/)).toBeTruthy();
      expect(screen.getByRole("option", { name: "(this mask is gone)" })).toBeTruthy();
    });

    it("survives a failing list", async () => {
      h.masks.mockRejectedValue(new Error("nope"));
      mount("object-eraser", "{}");
      await waitFor(() => expect(screen.getByLabelText("Saved mask")).toBeTruthy());
    });
  });

  describe("pipelines (run another pipeline)", () => {
    it("lists the other pipelines, not the one being edited", async () => {
      usePipelines.setState({
        entries: [
          { pipeline: { id: "me", name: "This one" } },
          { pipeline: { id: "p2", name: "Resize" } },
        ] as never,
      });
      const last = mount("pipelines", "{}", "me");
      const select = screen.getByLabelText("Pipeline");
      expect(screen.queryByRole("option", { name: "This one" })).toBeNull();
      await userEvent.selectOptions(select, "p2");
      expect(last.value).toEqual({ pipelineId: "p2" });
    });

    it("shows a deleted target", () => {
      mount("pipelines", '{"pipelineId":"gone"}', "me");
      expect(screen.getByRole("option", { name: "(this pipeline is gone)" })).toBeTruthy();
    });
  });

  describe("photo-composer (Fill a template)", () => {
    it("picks a composition, records its name and edits format, size and name", async () => {
      h.composer.mockResolvedValue([proj("c1", "Poster"), proj("c2", "Story")]);
      const last = mount("photo-composer", "{}");
      await screen.findByRole("option", { name: "Poster" });
      await userEvent.selectOptions(screen.getByLabelText("Template"), "c2");
      expect(last.value).toMatchObject({ templateId: "c2", templateName: "Story", scale: 1 });
      await userEvent.click(screen.getByRole("radio", { name: "PNG" }));
      expect(last.value).toMatchObject({ format: "png" });
      await userEvent.type(screen.getByLabelText("File name (optional)"), "x");
      expect(last.value).toMatchObject({ name: "x", templateId: "c2" });
    });

    it("shows a template that is gone with its name, and sanitises the scale", async () => {
      expect(stepUI("photo-composer")?.parse('{"scale":9}')).toMatchObject({ scale: 1 });
      mount("photo-composer", '{"templateId":"zz","templateName":"Old"}');
      expect(await screen.findByRole("option", { name: "Old (gone)" })).toBeTruthy();
    });
  });

  describe("video-studio (Assemble a video)", () => {
    it("defaults to the Go defaults and edits transition, title and music", async () => {
      const last = mount("video-studio", "{}");
      expect(last.value).toMatchObject({ transition: "cut", transitionMs: 500, titleMs: 3000, aspect: "9:16", fps: 30, height: 1080, stillMs: 3000, fit: "fill" });
      expect(screen.queryByLabelText("Crossfade lasts")).toBeNull();
      await userEvent.click(screen.getByRole("radio", { name: "Crossfade" }));
      expect(screen.getByLabelText("Crossfade lasts")).toBeTruthy();
      expect(screen.queryByLabelText("Title shows for")).toBeNull();
      await userEvent.type(screen.getByLabelText("Title (optional)"), "Hi");
      expect(screen.getByLabelText("Title shows for")).toBeTruthy();
      await userEvent.click(screen.getByRole("radio", { name: "16:9" }));
      await userEvent.click(screen.getByRole("radio", { name: "60 fps" }));
      await userEvent.click(screen.getByRole("radio", { name: "720p" }));
      expect(last.value).toMatchObject({ transition: "crossfade", title: "Hi", aspect: "16:9", fps: 60, height: 720 });
    });

    it("based on a saved edit hides the new-edit settings", async () => {
      h.edits.mockResolvedValue([proj("e1", "Template cut")]);
      const last = mount("video-studio", "{}");
      await screen.findByRole("option", { name: "Template cut" });
      expect(screen.getByRole("radio", { name: "9:16" })).toBeTruthy();
      await userEvent.selectOptions(screen.getByLabelText("Based on"), "e1");
      expect(last.value).toMatchObject({ templateId: "e1", templateName: "Template cut" });
      expect(screen.queryByRole("radio", { name: "9:16" })).toBeNull();
    });

    it("sanitises out-of-range numbers", () => {
      expect(stepUI("video-studio")?.parse('{"fps":24,"height":999,"transitionMs":5,"stillMs":1}')).toMatchObject({ fps: 30, height: 1080, transitionMs: 100, stillMs: 500 });
    });
  });

  describe("edit-studio (Cut to the beat)", () => {
    it("picks a recipe and edits the range, order and seed", async () => {
      const last = mount("edit-studio", "{}");
      expect(last.value).toMatchObject({ recipeId: "downbeat", seed: 1, order: "recipe", lengthMs: 30000, aspect: "9:16" });
      await userEvent.selectOptions(screen.getByLabelText("Cutting style"), "kick");
      await userEvent.selectOptions(screen.getByLabelText("Clips"), "shuffleNoRepeat");
      expect(last.value).toMatchObject({ recipeId: "kick", order: "shuffleNoRepeat" });
      const length = screen.getByLabelText("Length");
      await userEvent.clear(length);
      await userEvent.type(length, "45");
      await userEvent.tab();
      expect(last.value).toMatchObject({ lengthMs: 45000 });
    });

    it("keeps a recipe the list doesn't know", async () => {
      h.recipes.mockResolvedValue(["downbeat"]);
      mount("edit-studio", '{"recipeId":"future-recipe"}');
      expect(await screen.findByRole("option", { name: "future-recipe" })).toBeTruthy();
    });
  });
});
