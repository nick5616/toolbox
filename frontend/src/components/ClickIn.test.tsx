import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { definePart } from "@/parts/registry";
import { useWindows } from "@/state/windows";
import { ClickIn, ClickInHost, useClickIn } from "./ClickIn";

const popOutPart = vi.fn(() => Promise.resolve());
const focusWindow = vi.fn(() => Promise.resolve());

vi.mock("@/lib/windows", async (orig) => {
  const real = await orig<typeof import("@/lib/windows")>();
  return { ...real, popOutPart: (...a: unknown[]) => (popOutPart as (...x: unknown[]) => Promise<void>)(...a), focusWindow: (...a: unknown[]) => (focusWindow as (...x: unknown[]) => Promise<void>)(...a) };
});

definePart({ id: "t.fx", host: "t", title: "Effects", icon: "sparkles", tip: "", width: 500, height: 400, component: () => null });

function Fixture() {
  return (
    <ClickInHost>
      <button>outside</button>
      <ClickIn icon="sparkles" title="Effects" summary="2 on this clip" part="t.fx" params={{ project: "p1" }}>
        <input aria-label="amount" />
      </ClickIn>
      <ClickIn icon="gauge" title="Speed" variant="icon" badge={3}>
        <p>speed content</p>
      </ClickIn>
    </ClickInHost>
  );
}

describe("ClickIn", () => {
  beforeEach(() => {
    popOutPart.mockClear();
    focusWindow.mockClear();
    useWindows.setState({ open: [] });
  });

  it("renders a row launcher with its summary and no drawer when closed", () => {
    render(<Fixture />);
    expect(screen.getByRole("button", { name: /Effects/ }).textContent).toContain("2 on this clip");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("3")).toBeTruthy();
  });

  it("opens a drawer with the content and focuses it; Close and Esc close it", async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    const launcher = screen.getByRole("button", { name: /Effects/ });
    await user.click(launcher);
    const dlg = screen.getByRole("dialog", { name: "Effects" });
    expect(document.activeElement).toBe(dlg);
    expect(screen.getByLabelText("amount")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(launcher);

    await user.click(launcher);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps one drawer open per host and closes on an outside click", async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    await user.click(screen.getByRole("button", { name: /Effects/ }));
    await user.click(screen.getByRole("button", { name: "Speed" }));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe("Speed");
    fireEvent.pointerDown(screen.getByText("outside"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("pops a registered part out with its params, then closes", async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    await user.click(screen.getByRole("button", { name: /Effects/ }));
    await user.click(screen.getByRole("button", { name: "Pop out" }));
    expect(popOutPart).toHaveBeenCalledWith("t.fx", expect.objectContaining({ params: { project: "p1" }, width: 500, height: 400 }));
    await act(async () => {});
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers no Pop out without a registered part", async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    await user.click(screen.getByRole("button", { name: "Speed" }));
    expect(screen.queryByRole("button", { name: "Pop out" })).toBeNull();
  });

  it("focuses the part's window instead of opening while it is out", async () => {
    const user = userEvent.setup();
    useWindows.setState({ open: ["part:t.fx"] });
    render(<Fixture />);
    await user.click(screen.getByRole("button", { name: /Effects/ }));
    expect(focusWindow).toHaveBeenCalledWith("part:t.fx");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens programmatically with useClickIn", async () => {
    function Opener() {
      const { open, isOpen } = useClickIn();
      return <button onClick={() => open("Speed")}>{isOpen("Speed") ? "is open" : "go"}</button>;
    }
    const user = userEvent.setup();
    render(
      <ClickInHost>
        <Opener />
        <ClickIn icon="gauge" title="Speed">
          <p>speed content</p>
        </ClickIn>
      </ClickInHost>,
    );
    await user.click(screen.getByText("go"));
    expect(screen.getByText("speed content")).toBeTruthy();
    expect(screen.getByText("is open")).toBeTruthy();
  });
});
