import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const desktop = vi.hoisted(() => ({
  PastePermission: vi.fn(),
  RequestPastePermission: vi.fn(),
  PasteAfterCopy: vi.fn(),
  HidePopup: vi.fn(),
  ShowMain: vi.fn(),
}));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return { ...actual, DesktopService: desktop };
});

import { AutoPasteSetting } from "./AutoPasteSetting";

describe("AutoPasteSetting", () => {
  beforeEach(() => {
    Object.values(desktop).forEach((f) => f.mockReset());
    desktop.RequestPastePermission.mockResolvedValue(undefined);
  });

  it("is disabled on unsupported platforms", async () => {
    desktop.PastePermission.mockResolvedValue("unsupported");
    render(<AutoPasteSetting checked={false} onChange={() => undefined} />);
    expect(await screen.findByText("Not supported on this platform yet")).toBeTruthy();
    expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows Allowed when granted", async () => {
    desktop.PastePermission.mockResolvedValue("granted");
    render(<AutoPasteSetting checked onChange={() => undefined} />);
    expect(await screen.findByText("Allowed")).toBeTruthy();
  });

  it("requests permission when denied and enabled", async () => {
    desktop.PastePermission.mockResolvedValue("denied");
    const onChange = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<AutoPasteSetting checked={false} onChange={onChange} />);
    await waitFor(() => expect(desktop.PastePermission).toHaveBeenCalled());
    await user.click(screen.getByRole("switch"));
    expect(onChange).toHaveBeenCalledWith(true);
    await waitFor(() => expect(desktop.RequestPastePermission).toHaveBeenCalledTimes(1));
    rerender(<AutoPasteSetting checked onChange={onChange} />);
    expect(await screen.findByText(/Needs Accessibility permission/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Request permission" }));
    await waitFor(() => expect(desktop.RequestPastePermission).toHaveBeenCalledTimes(2));
  });
});
