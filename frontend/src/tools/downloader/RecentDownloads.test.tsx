import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { OutputKind } from "@/lib/api";
import { useLibrary } from "@/state/library";
import { RecentDownloads } from "./RecentDownloads";

describe("RecentDownloads", () => {
  beforeEach(() => {
    useLibrary.getState().setPage(
      [{ id: "o1", jobId: "j", moduleId: "downloader", path: "/lib/a.mp3", name: "a.mp3", kind: OutputKind.KindAudio, sizeBytes: 1, createdAt: Date.now(), missing: false, tags: [] }] as never,
      "",
    );
  });

  it("offers Send to on each finished file", () => {
    render(<RecentDownloads />);
    expect(screen.getByText("a.mp3").getAttribute("data-tip")).toBe("/lib/a.mp3");
    expect(screen.getByRole("button", { name: "Send to…" })).toBeTruthy();
  });
});
