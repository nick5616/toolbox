import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { IntensityStops, stopFor } from "./IntensityStops";

describe("IntensityStops", () => {
  it("finds the stop a value sits on, or custom between stops", () => {
    expect(stopFor(0.5)).toBe("calm");
    expect(stopFor(1)).toBe("balanced");
    expect(stopFor(1.5)).toBe("wild");
    expect(stopFor(1.2)).toBe("custom");
  });

  it("sets 0.5 / 1 / 1.5 and marks the current stop", async () => {
    const onChange = vi.fn();
    render(<IntensityStops value={1} onChange={onChange} />);
    expect(screen.getByRole("radio", { name: "Balanced" }).getAttribute("aria-checked")).toBe("true");
    await userEvent.click(screen.getByRole("radio", { name: "Calm" }));
    expect(onChange).toHaveBeenLastCalledWith(0.5);
    await userEvent.click(screen.getByRole("radio", { name: "Wild" }));
    expect(onChange).toHaveBeenLastCalledWith(1.5);
  });
});
