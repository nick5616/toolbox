import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Meter, type MeterStatus } from "./Meter";

describe("Meter", () => {
  it("renders determinate width and aria values", () => {
    render(<Meter value={0.425} />);
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("43");
    expect((bar.firstElementChild as HTMLElement).style.width).toBe("42.5%");
    expect(bar.className).not.toContain("indeterminate");
  });

  it("clamps above 1", () => {
    render(<Meter value={3} />);
    expect((screen.getByRole("progressbar").firstElementChild as HTMLElement).style.width).toBe("100%");
  });

  it("is indeterminate for value -1 while running", () => {
    render(<Meter value={-1} />);
    const bar = screen.getByRole("progressbar");
    expect(bar.className).toContain("indeterminate");
    expect(bar.hasAttribute("aria-valuenow")).toBe(false);
  });

  it.each<MeterStatus>(["queued", "running", "done", "failed", "cancelled"])("applies the %s status class", (status) => {
    render(<Meter value={0.5} status={status} />);
    expect(screen.getByRole("progressbar").className).toContain(status);
  });

  it("shows a full bar for done with no value", () => {
    render(<Meter value={-1} status="done" />);
    const bar = screen.getByRole("progressbar");
    expect(bar.className).not.toContain("indeterminate");
    expect((bar.firstElementChild as HTMLElement).style.width).toBe("100%");
  });
});
