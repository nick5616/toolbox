import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  save: vi.fn(async (_name: string, _text: string) => "C:/out/Notes.txt"),
  copy: vi.fn(async (_text: string) => undefined),
  saveCopy: vi.fn(async (_id: string, _path: string) => ""),
}));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    FilesService: { SaveText: (n: string, t: string) => h.save(n, t), Stat: async () => [] },
    ClipboardService: { CopyText: (t: string) => h.copy(t) },
    LibraryService: { Reveal: async () => undefined, RevealPath: async () => undefined, Open: async () => undefined, SaveCopy: (id: string, p: string) => h.saveCopy(id, p) },
  };
});

import { FileActions } from "./FileActions";
import { TextActions } from "./TextActions";

describe("standalone actions", () => {
  it("TextActions copies and saves the text with the suggested name", async () => {
    render(<TextActions text={() => "hello"} filename="Notes.txt" what="notes" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy notes" }));
    fireEvent.click(screen.getByRole("button", { name: "Save as…" }));
    await vi.waitFor(() => expect(h.save).toHaveBeenCalledWith("Notes.txt", "hello"));
    expect(h.copy).toHaveBeenCalledWith("hello");
  });

  it("FileActions always offers Reveal, Open and Save a copy, not only Send to", async () => {
    render(<FileActions outputId="o1" path="C:/lib/Erased/a.png" moduleId="object-eraser" />);
    expect(screen.getByRole("button", { name: /Show in|Reveal in/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save a copy…" }));
    await vi.waitFor(() => expect(h.saveCopy).toHaveBeenCalledWith("o1", "C:/lib/Erased/a.png"));
  });
});
