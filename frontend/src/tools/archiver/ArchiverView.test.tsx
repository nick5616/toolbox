import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueue = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => []));
const browser = vi.hoisted(() => ({ found: true, name: "Microsoft Edge" }));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    ArchiverService: {
      Defaults: async () => ({}),
      Browser: async () => ({ ...browser }),
      Enqueue: enqueue,
    },
    SettingsService: { ModuleState: async () => "", SetModuleState: async () => undefined },
  };
});

import { OutputKind } from "@/lib/api";
import { useLibrary } from "@/state/library";
import ArchiverView from "./ArchiverView";
import { parseLinks } from "./urls";

function seed(items: unknown[]) {
  useLibrary.getState().setPage(items as never, "");
}

const PAGE = {
  id: "o1", jobId: "j", moduleId: "archiver", path: "/lib/Web Archive/example.com/Example 2026-01-01.html",
  name: "Example 2026-01-01.html", kind: OutputKind.KindDocument, sizeBytes: 2048, createdAt: Date.now(), missing: false, tags: [],
};

describe("urls", () => {
  it("explains local, scheme and malformed links", () => {
    const p = parseLinks("http://localhost:3000 ftp://x.com/a nope https://192.168.1.4/x https://ok.com/", false);
    expect(p.map((x) => !!x.error)).toEqual([true, true, true, true, false]);
    expect(p[0]?.error).toMatch(/Allow local addresses/);
    expect(p[1]?.error).toMatch(/Only http and https/);
    expect(p[2]?.error).toMatch(/valid http or https/);
    expect(parseLinks("http://localhost:3000", true)[0]?.error).toBeUndefined();
  });
});

describe("ArchiverView", () => {
  beforeEach(() => {
    enqueue.mockClear();
    browser.found = true;
    seed([]);
  });

  it("shows the empty state and keeps Advanced in a click-in", async () => {
    render(<ArchiverView moduleId="archiver" />);
    expect(await screen.findByText("No saved pages yet.")).toBeTruthy();
    expect((screen.getByRole("button", { name: /^Save page/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: /Advanced/ }).textContent).toContain("Defaults");
  });

  it("shows why a line can't be saved and blocks saving", async () => {
    const user = userEvent.setup();
    render(<ArchiverView moduleId="archiver" />);
    await user.click(screen.getByLabelText("Links"));
    await user.paste("http://localhost:8080/x\nhttps://example.com/a");
    expect(await screen.findByText(/Local addresses are off/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /^Save page/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables the browser toggles when no browser is found", async () => {
    browser.found = false;
    render(<ArchiverView moduleId="archiver" />);
    await waitFor(() => {
      expect((screen.getByRole("switch", { name: "Render JavaScript" }) as HTMLButtonElement).disabled).toBe(true);
    });
    expect((screen.getByRole("switch", { name: "Also PDF" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("enqueues the valid links with the chosen options", async () => {
    const user = userEvent.setup();
    render(<ArchiverView moduleId="archiver" />);
    await waitFor(() => expect((screen.getByRole("switch", { name: "Also PDF" }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole("switch", { name: "Also PDF" }));
    await user.click(screen.getByLabelText("Links"));
    await user.paste("https://a.com/x\nhttps://b.com/y");
    const btn = screen.getByRole("button", { name: /^Save page/ });
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    await user.click(btn);
    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    const [urls, opts] = enqueue.mock.calls[0] as unknown as [string[], Record<string, unknown>];
    expect(urls).toEqual(["https://a.com/x", "https://b.com/y"]);
    expect(opts).toMatchObject({ alsoPdf: true, renderJs: false, timeoutSec: 60, allowLocal: false });
  });

  it("lists saved pages by name with the site, Send to and Convert", async () => {
    seed([PAGE]);
    render(<ArchiverView moduleId="archiver" />);
    const name = await screen.findByText("Example 2026-01-01.html");
    expect(name.textContent).not.toContain("/");
    expect(screen.getByText("example.com")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send to…" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Convert/ })).toBeTruthy();
  });
});
