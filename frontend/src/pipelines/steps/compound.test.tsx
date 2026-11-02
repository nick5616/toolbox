import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    TranscribeService: {
      Languages: async () => [
        { code: "en", name: "English" },
        { code: "es", name: "Spanish" },
      ],
    },
    SubtitlesService: {
      TranslationLanguages: async () => [
        { code: "de", name: "German" },
        { code: "en", name: "English" },
      ],
    },
    LyricVideoService: { Fonts: async () => ["Arial", "Georgia"] },
    VisualizerService: {
      Designs: async () => [{ id: "d1", name: "My neon", showJson: '{"mine":true}', updatedMs: 1 }],
    },
    FilesService: { PickWith: async () => [] },
  };
});

import type { StepVar } from "@/lib/api";
import { PRESETS, showFromPreset } from "@/viz/presets";
import { stepUI } from "./registry";
import "./compound";
import { DEFAULT_LYRIC_VIDEO, DEFAULT_SUBTITLES, DEFAULT_VISUALIZER, parseLyricVideo, parseSubtitles, parseVisualizer } from "./compound";

const VARS: StepVar[] = [
  { name: "item", label: "Item" },
  { name: "title", label: "Title" },
];

/** Mounts a registered editor with state, reporting every change. */
function mount<T>(type: string, initial: string, onValue: (v: T) => void) {
  const ui = stepUI(type);
  if (!ui) throw new Error(`no editor for ${type}`);
  const Editor = ui.Editor;
  function Harness() {
    const [value, setValue] = useState(() => ui!.parse(initial) as T);
    return (
      <Editor
        value={value as never}
        check={undefined}
        vars={VARS}
        onChange={(next) => {
          setValue(next as T);
          onValue(next as T);
        }}
      />
    );
  }
  return render(<Harness />);
}

describe("registration", () => {
  it("registers the three compound step types", () => {
    for (const t of ["subtitles", "lyric-video", "visualizer"]) expect(stepUI(t)).toBeTruthy();
  });
});

describe("parse sanitises over the defaults and never throws", () => {
  it.each([["subtitles"], ["lyric-video"], ["visualizer"]])("%s survives garbage", (type) => {
    const ui = stepUI(type)!;
    for (const junk of ["", "not json", "[]", "null", "42", '{"model":5,"look":7,"save":"x","mode":{},"height":"tall"}']) {
      expect(() => ui.parse(junk)).not.toThrow();
    }
  });

  it("empty options give the defaults", () => {
    expect(parseSubtitles("{}")).toEqual(DEFAULT_SUBTITLES);
    expect(parseLyricVideo("{}")).toEqual(DEFAULT_LYRIC_VIDEO);
    expect(parseVisualizer("{}")).toEqual(DEFAULT_VISUALIZER);
  });

  it("subtitles clamps and filters", () => {
    const p = parseSubtitles(
      JSON.stringify({ model: "huge", maxLineChars: 500, maxLines: 3, save: ["vtt", "srt", "ass", "srt"], video: "gif", maxSizeMB: -4, canvasHeight: 480, backgroundColor: "red" }),
    );
    expect(p.model).toBe("small");
    expect(p.maxLineChars).toBe(60);
    expect(p.maxLines).toBe(2);
    expect(p.save).toEqual(["srt", "vtt"]);
    expect(p.video).toBe("burn");
    expect(p.maxSizeMB).toBe(0);
    expect(p.canvasHeight).toBe(1080);
    expect(p.backgroundColor).toBe(DEFAULT_SUBTITLES.backgroundColor);
  });

  it("subtitles keeps an explicit empty save list", () => {
    expect(parseSubtitles('{"save":[],"video":"embed"}').save).toEqual([]);
  });

  it("lyric video keeps its title templates and fixes bad values", () => {
    const p = parseLyricVideo(JSON.stringify({ look: { title: "{title} ({name})", artist: "{item}", background: "nope", textColor: "zzz" }, aspect: "4:3", height: 480 }));
    expect(p.look.title).toBe("{title} ({name})");
    expect(p.look.artist).toBe("{item}");
    expect(p.look.background).toBe("blur-cover");
    expect(p.look.textColor).toBe(DEFAULT_LYRIC_VIDEO.look.textColor);
    expect(p.aspect).toBe("16:9");
    expect(p.height).toBe(1080);
  });

  it("visualizer needs stems for the instrumental and the saved stems", () => {
    const p = parseVisualizer(JSON.stringify({ stems: false, audio: "instrumental", saveStems: true }));
    expect(p.audio).toBe("original");
    expect(p.saveStems).toBe(false);
  });
});

describe("Subtitles editor", () => {
  it("renders the defaults and round-trips changes", async () => {
    const user = userEvent.setup();
    const seen: Array<ReturnType<typeof parseSubtitles>> = [];
    mount("subtitles", "{}", (v: ReturnType<typeof parseSubtitles>) => seen.push(v));
    expect(within(screen.getByRole("radiogroup", { name: "Model" })).getByRole("radio", { name: "Small" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Burn in" }).getAttribute("aria-checked")).toBe("true");

    await user.click(screen.getByRole("radio", { name: "Boxed" }));
    await user.click(screen.getByRole("radio", { name: "Top" }));
    expect(seen.at(-1)).toMatchObject({ style: "boxed", position: "top", save: ["srt"], video: "burn" });

    await user.click(screen.getByLabelText("VTT"));
    expect(seen.at(-1)?.save).toEqual(["srt", "vtt"]);

    await user.click(screen.getByRole("radio", { name: "No video" }));
    expect(seen.at(-1)?.video).toBe("none");
    expect(screen.queryByText("Burned-in look")).toBeNull();

    await user.click(screen.getByRole("radio", { name: "Add as a track" }));
    expect(screen.getByLabelText("Track language")).toBeTruthy();
  });

  it("offers translation targets from the service", async () => {
    mount("subtitles", "{}", () => undefined);
    await waitFor(() => expect(screen.getByRole("option", { name: "German" })).toBeTruthy());
  });
});

describe("Lyric Video editor", () => {
  it("renders the defaults, shows the title templates and round-trips", async () => {
    const user = userEvent.setup();
    const seen: Array<ReturnType<typeof parseLyricVideo>> = [];
    mount("lyric-video", "{}", (v: ReturnType<typeof parseLyricVideo>) => seen.push(v));
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("{item}");
    expect(screen.getByRole("radio", { name: "Original" }).getAttribute("aria-checked")).toBe("true");

    await user.click(screen.getByRole("radio", { name: "Instrumental" }));
    await user.click(screen.getByRole("radio", { name: "9:16" }));
    expect(seen.at(-1)).toMatchObject({ audio: "instrumental", aspect: "9:16" });

    const artist = screen.getByLabelText("Artist");
    await user.type(artist, "by {{title}");
    expect(seen.at(-1)?.look.artist).toBe("by {title}");
  });
});

describe("Visualizer editor", () => {
  it("asks for a design, stores a preset's show and round-trips", async () => {
    const user = userEvent.setup();
    const seen: Array<ReturnType<typeof parseVisualizer>> = [];
    mount("visualizer", "{}", (v: ReturnType<typeof parseVisualizer>) => seen.push(v));
    expect(screen.getByTestId("chosen-design").textContent).toBe("No design picked yet");

    const preset = PRESETS[0]!;
    await user.click(screen.getByRole("radio", { name: new RegExp(`^${preset.name}`) }));
    const last = seen.at(-1)!;
    expect(last.presetId).toBe(preset.id);
    expect(last.designName).toBe(preset.name);
    expect(JSON.parse(last.showJson)).toEqual(JSON.parse(JSON.stringify(showFromPreset(preset))));
    expect(screen.getByTestId("chosen-design").textContent).toBe(`Design: ${preset.name}`);

    await user.click(screen.getByRole("radio", { name: "Over the video" }));
    expect(seen.at(-1)?.mode).toBe("overlay");
    expect(screen.queryByRole("radiogroup", { name: "Aspect" })).toBeNull();
  });

  it("lists saved designs and stores theirs", async () => {
    const user = userEvent.setup();
    const seen: Array<ReturnType<typeof parseVisualizer>> = [];
    mount("visualizer", "{}", (v: ReturnType<typeof parseVisualizer>) => seen.push(v));
    const mine = await screen.findByRole("radio", { name: "My neon" });
    await user.click(mine);
    expect(seen.at(-1)).toMatchObject({ presetId: "", designName: "My neon", showJson: '{"mine":true}' });
  });

  it("turning stems off clears the instrumental and the saved stems", async () => {
    const user = userEvent.setup();
    const seen: Array<ReturnType<typeof parseVisualizer>> = [];
    mount("visualizer", JSON.stringify({ audio: "instrumental", saveStems: true }), (v: ReturnType<typeof parseVisualizer>) => seen.push(v));
    await user.click(screen.getByLabelText("Separate instruments"));
    expect(seen.at(-1)).toMatchObject({ stems: false, saveStems: false, audio: "original" });
  });
});
