import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ColorSwatchPicker, normalizeHex } from "./ColorSwatchPicker";
import { CompareSlider } from "./CompareSlider";

describe("CompareSlider", () => {
  const setup = () => render(<CompareSlider before="data:a" after="data:b" aria-label="Cmp" />);

  it("exposes slider semantics starting at 50", () => {
    setup();
    const s = screen.getByRole("slider", { name: "Cmp" });
    expect(s.getAttribute("aria-valuenow")).toBe("50");
    expect(s.getAttribute("aria-valuemin")).toBe("0");
    expect(s.getAttribute("aria-valuemax")).toBe("100");
  });

  it("moves 5% with arrows and jumps with Home/End, clamped", () => {
    setup();
    const s = screen.getByRole("slider", { name: "Cmp" });
    fireEvent.keyDown(s, { key: "ArrowRight" });
    expect(s.getAttribute("aria-valuenow")).toBe("55");
    fireEvent.keyDown(s, { key: "ArrowLeft" });
    fireEvent.keyDown(s, { key: "ArrowLeft" });
    expect(s.getAttribute("aria-valuenow")).toBe("45");
    fireEvent.keyDown(s, { key: "Home" });
    expect(s.getAttribute("aria-valuenow")).toBe("0");
    fireEvent.keyDown(s, { key: "ArrowLeft" });
    expect(s.getAttribute("aria-valuenow")).toBe("0");
    fireEvent.keyDown(s, { key: "End" });
    expect(s.getAttribute("aria-valuenow")).toBe("100");
  });

  it("follows pointer drags", () => {
    setup();
    const s = screen.getByRole("slider", { name: "Cmp" });
    s.getBoundingClientRect = () => ({
      left: 100,
      width: 200,
      top: 0,
      height: 100,
      right: 300,
      bottom: 100,
      x: 100,
      y: 0,
      toJSON: () => ({}),
    });
    fireEvent.pointerDown(s, { clientX: 150, pointerId: 1 });
    expect(s.getAttribute("aria-valuenow")).toBe("25");
    fireEvent.pointerMove(s, { clientX: 250, pointerId: 1 });
    expect(s.getAttribute("aria-valuenow")).toBe("75");
    fireEvent.pointerUp(s, { pointerId: 1 });
    fireEvent.pointerMove(s, { clientX: 110, pointerId: 1 });
    expect(s.getAttribute("aria-valuenow")).toBe("75");
  });
});

describe("ColorSwatchPicker", () => {
  it("normalizes hex values", () => {
    expect(normalizeHex("#FF0000")).toBe("#ff0000");
    expect(normalizeHex("00ff00")).toBe("#00ff00");
    expect(normalizeHex("#fff")).toBeNull();
    expect(normalizeHex("#gggggg")).toBeNull();
  });

  it("emits only valid colours and marks invalid input", () => {
    const onChange = vi.fn();
    render(<ColorSwatchPicker value="#ffffff" onChange={onChange} />);
    const field = screen.getByLabelText("Hex colour");
    fireEvent.change(field, { target: { value: "#12" } });
    expect(onChange).not.toHaveBeenCalled();
    expect(field.getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(field, { target: { value: "#12ABef" } });
    expect(onChange).toHaveBeenCalledWith("#12abef");
  });

  it("picks swatches; transparent only when allowed", () => {
    const onChange = vi.fn();
    const { rerender } = render(<ColorSwatchPicker value="#ffffff" onChange={onChange} />);
    expect(screen.queryByRole("button", { name: "Transparent" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Black" }));
    expect(onChange).toHaveBeenCalledWith("#000000");
    rerender(<ColorSwatchPicker value="#ffffff" onChange={onChange} allowTransparent />);
    fireEvent.click(screen.getByRole("button", { name: "Transparent" }));
    expect(onChange).toHaveBeenCalledWith("transparent");
  });
});
