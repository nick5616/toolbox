import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ open: vi.fn(async (p: string) => ({ url: `/media/t/${p.split("/").pop()}`, info: {} })) }));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    MediaService: { Open: (p: string) => h.open(p) },
    FilesService: { Stat: async (p: string[]) => p.map((path) => ({ path, exists: true, isDir: false, sizeBytes: 1 })), Pick: async () => [] },
    LibraryService: { Reveal: async () => undefined, RevealPath: async () => undefined, Open: async () => undefined },
  };
});

import { ResultRow } from "./ResultRow";
import { isInlineAudio } from "./InlinePlay";

const created: FakeAudio[] = [];
class FakeAudio {
  listeners: Record<string, (() => void)[]> = {};
  paused = true;
  constructor(public src: string) {
    created.push(this);
  }
  addEventListener(n: string, f: () => void) {
    (this.listeners[n] ??= []).push(f);
  }
  removeAttribute() {}
  emit(n: string) {
    for (const f of this.listeners[n] ?? []) f();
  }
  play() {
    this.paused = false;
    this.emit("play");
    return Promise.resolve();
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.emit("pause");
  }
}

beforeEach(() => {
  created.length = 0;
  h.open.mockClear();
  vi.stubGlobal("Audio", FakeAudio);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("inline audio in ResultRow", () => {
  it("recognises audio paths only", () => {
    expect(isInlineAudio("/a/b.MP3")).toBe(true);
    expect(isInlineAudio("/a/b.png")).toBe(false);
    expect(isInlineAudio("/a/noext")).toBe(false);
  });

  it("has no play button for other files", () => {
    render(<ResultRow path="/a/pic.png" />);
    expect(screen.queryByRole("button", { name: "Play" })).toBeNull();
  });

  it("plays and pauses an audio result through a media URL", async () => {
    const user = userEvent.setup();
    render(<ResultRow path="/a/voice.mp3" />);
    await user.click(screen.getByRole("button", { name: "Play" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy());
    expect(created[0]?.src).toBe("/media/t/voice.mp3");
    await user.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Play" })).toBeTruthy());
  });

  it("plays one result at a time", async () => {
    const user = userEvent.setup();
    render(
      <>
        <ResultRow path="/a/one.mp3" />
        <ResultRow path="/a/two.wav" />
      </>,
    );
    const [first, second] = screen.getAllByRole("button", { name: "Play" });
    await user.click(first!);
    await waitFor(() => expect(created.length).toBe(1));
    await user.click(second!);
    await waitFor(() => expect(created.length).toBe(2));
    expect(created[0]?.paused).toBe(true);
    expect(created[1]?.paused).toBe(false);
  });
});
