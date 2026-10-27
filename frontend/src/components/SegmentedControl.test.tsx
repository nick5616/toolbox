import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { SegmentedControl } from "./SegmentedControl";

type V = "a" | "b" | "c";
const options = [
  { value: "a" as V, label: "A" },
  { value: "b" as V, label: "B", disabled: true },
  { value: "c" as V, label: "C" },
];

function Harness({ onChange }: { onChange: (v: V) => void }) {
  const [v, setV] = useState<V>("a");
  return (
    <SegmentedControl<V>
      aria-label="Test"
      value={v}
      options={options}
      onChange={(next) => {
        setV(next);
        onChange(next);
      }}
    />
  );
}

describe("SegmentedControl", () => {
  it("exposes a radiogroup with the selected option checked", () => {
    render(<Harness onChange={() => {}} />);
    expect(screen.getByRole("radiogroup", { name: "Test" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "A" }).getAttribute("aria-checked")).toBe("true");
  });

  it("arrow keys move selection, skipping disabled options, and fire onChange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    screen.getByRole("radio", { name: "A" }).focus();

    await user.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith("c");
    expect(screen.getByRole("radio", { name: "C" }).getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "C" }));

    await user.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith("a");

    await user.keyboard("{ArrowLeft}");
    expect(onChange).toHaveBeenLastCalledWith("c");
  });

  it("clicking selects", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.click(screen.getByRole("radio", { name: "C" }));
    expect(onChange).toHaveBeenCalledWith("c");
  });
});
