import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueue = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => []));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    DownloaderService: {
      Defaults: async () => ({
        mode: "audio", audioFormat: "mp3", audioQuality: "best", maxResolution: "best",
        trimEnabled: false, trimStart: "", trimEnd: "", embedMetadata: true, embedThumbnail: true, playlist: false,
      }),
      Enqueue: enqueue,
    },
    SettingsService: { ModuleState: async () => "", SetModuleState: async () => undefined },
    LibraryService: { OpenLibraryFolder: async () => undefined },
  };
});

import DownloaderView from "./DownloaderView";

describe("DownloaderView", () => {
  beforeEach(() => enqueue.mockClear());

  it("counts valid links and enqueues them", async () => {
    const user = userEvent.setup();
    render(<DownloaderView moduleId="downloader" />);
    await screen.findByRole("radiogroup", { name: "Mode" });

    await user.click(screen.getByLabelText("Links"));
    await user.paste("https://a.com/x https://b.com/y");
    const btn = await screen.findByRole("button", { name: /Download 2/ });
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    await user.click(btn);

    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    const [urls, opts] = enqueue.mock.calls[0] as unknown as [string[], Record<string, unknown>];
    expect(urls).toEqual(["https://a.com/x", "https://b.com/y"]);
    expect(opts).toMatchObject({ mode: "audio", audioFormat: "mp3" });
    await waitFor(() => expect((screen.getByLabelText("Links") as HTMLTextAreaElement).value).toBe(""));
  });
});
