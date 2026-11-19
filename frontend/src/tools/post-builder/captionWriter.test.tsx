import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { ClickInHost } from "@/components";
import { ModuleStatus, type Descriptor } from "@/lib/api";
import { useEmbed } from "@/lib/embed";
import { newHistory } from "@/lib/history";
import { registerToolViews } from "@/lib/toolActions";
import { useModules } from "@/state/modules";
import { CaptionWriterClickIn, captionText, parseWritten } from "./CaptionWriterClickIn";
import { blankSlide, type PostDoc } from "./logic";
import { usePostBuilder } from "./postStore";

const desc = (id: string, name: string): Descriptor => ({ id, name, icon: "box", status: ModuleStatus.StatusReady, accepts: { extensions: [], urls: false, any: false } }) as unknown as Descriptor;

const slide = (id: string, extra: Partial<PostDoc["slides"][number]> = {}) => ({ ...blankSlide("photo", { path: `C:/p/${id}.jpg` }), id, ...extra });

/** Stands in for Caption Writer: shows what it was given and returns text through the embed contract. */
function FakeCaptions() {
  const e = useEmbed();
  const payload = `captions:${JSON.stringify({ input: "C:/p/b.jpg", caption: "Golden hour", hashtags: ["#lisbon", "#tram"], alt: "A tram on a hill" })}`;
  return (
    <div>
      <p>writer sees: {e?.handoff.inputs.join(",")} / {e?.handoff.action}</p>
      <button type="button" onClick={() => e?.onUse?.([payload])}>
        {e?.useLabel}
      </button>
    </div>
  );
}

function openPost(slides: PostDoc["slides"]) {
  const d = { version: 1, format: "carousel", aspect: "4:5", slides, caption: "old", keepLocation: false, folder: "", subfolders: false, extra: [], hidden: [] } as unknown as PostDoc;
  usePostBuilder.setState({ ready: true, postId: "p1", loadedId: "p1", name: "Trip", history: newHistory(d), selectedId: "a", saveState: "saved", dirty: false });
}

beforeEach(() => {
  usePostBuilder.getState().reset();
  registerToolViews({ captions: FakeCaptions });
  useModules.getState().setAll([desc("captions", "Caption Writer"), desc("post-builder", "Post Builder")]);
});

describe("Write with Caption Writer (Post Builder)", () => {
  it("formats the returned text and ignores anything else", () => {
    expect(captionText({ caption: " Hi ", hashtags: ["#a", "#b"] })).toBe("Hi\n\n#a #b");
    expect(captionText({ caption: "", hashtags: [] })).toBe("");
    expect(parseWritten(["C:/x.png"])).toBeNull();
    expect(parseWritten(["captions:{oops"])).toBeNull();
  });

  it("opens Caption Writer with the post's photos and clips for posting", async () => {
    openPost([slide("a"), slide("b", { kind: "clip" }), slide("c", { kind: "composition", path: "", projectId: "x" })]);
    render(
      <ClickInHost>
        <CaptionWriterClickIn />
      </ClickInHost>,
    );
    await userEvent.click(screen.getByRole("button", { name: /Write with Caption Writer/ }));
    expect(await screen.findByText("writer sees: C:/p/a.jpg,C:/p/b.jpg / posting")).toBeTruthy();
  });

  it("Use puts the caption and hashtags into the caption box and the alt text on its slide", async () => {
    openPost([slide("a"), slide("b")]);
    render(
      <ClickInHost>
        <CaptionWriterClickIn />
      </ClickInHost>,
    );
    await userEvent.click(screen.getByRole("button", { name: /Write with Caption Writer/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Use caption" }));
    const present = () => usePostBuilder.getState().history?.present;
    await waitFor(() => expect(present()?.caption).toBe("Golden hour\n\n#lisbon #tram"));
    expect(present()?.slides.find((s) => s.id === "b")?.altText).toBe("A tram on a hill");
    expect(present()?.slides.find((s) => s.id === "a")?.altText).toBe("");
  });

  it("doesn't overwrite alt text the user already wrote", async () => {
    openPost([slide("a"), slide("b", { altText: "My own words" })]);
    render(
      <ClickInHost>
        <CaptionWriterClickIn />
      </ClickInHost>,
    );
    await userEvent.click(screen.getByRole("button", { name: /Write with Caption Writer/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Use caption" }));
    await waitFor(() => expect(usePostBuilder.getState().history?.present.caption).toContain("Golden hour"));
    expect(usePostBuilder.getState().history?.present.slides.find((s) => s.id === "b")?.altText).toBe("My own words");
  });

  it("can't open without a photo or clip, and says why", () => {
    openPost([slide("c", { kind: "composition", path: "", projectId: "x" })]);
    render(
      <ClickInHost>
        <CaptionWriterClickIn />
      </ClickInHost>,
    );
    const btn = screen.getByRole("button", { name: /Write with Caption Writer/ });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });
});
