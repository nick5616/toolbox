import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_TEXT_STYLE } from "@/viz/edit/schema";
import { TextStyleEditor } from "./TextStyleEditor";

describe("TextStyleEditor", () => {
  it("picks a preset and moves subtitle presets to the bottom", () => {
    const onChange = vi.fn();
    render(<TextStyleEditor value={DEFAULT_TEXT_STYLE} onChange={onChange} fonts={["Arial", "Impact"]} />);
    fireEvent.click(screen.getByRole("radio", { name: /Boxed/ }));
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_TEXT_STYLE, preset: "subtitle-boxed", position: "lower" });
  });

  it("toggles capital letters and renders extras", () => {
    const onChange = vi.fn();
    render(
      <TextStyleEditor value={DEFAULT_TEXT_STYLE} onChange={onChange} fonts={[]}>
        <span>extra</span>
      </TextStyleEditor>,
    );
    fireEvent.click(screen.getByRole("switch", { name: "Capital letters" }));
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_TEXT_STYLE, uppercase: false });
    expect(screen.getByText("extra")).toBeTruthy();
  });

  it("hides the mood options unless allowed", () => {
    const { rerender } = render(<TextStyleEditor value={DEFAULT_TEXT_STYLE} onChange={() => undefined} fonts={[]} allowMood={false} />);
    expect(screen.queryByText("From the mood")).toBeNull();
    rerender(<TextStyleEditor value={DEFAULT_TEXT_STYLE} onChange={() => undefined} fonts={[]} allowMood />);
    expect(screen.getByText("From the mood")).toBeTruthy();
  });
});
