import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setCurrentPresenter } from "@/lib/pathRewrite";
import { tipFor, TooltipLayer } from "./TooltipLayer";

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("tipFor", () => {
  it("prefers data-tip, moves title to data-tip, and falls back to aria-label only without visible text", () => {
    document.body.innerHTML = `
      <div data-tip="Outer"><button id="a">Go</button></div>
      <span id="b" title="From title">x</span>
      <button id="c" aria-label="Zoom in"><svg></svg></button>
      <button id="d" aria-label="Export">Export</button>
      <div data-tip-off><button id="e" data-tip="no">x</button></div>
      <span data-tip="How strong each hit is"><input id="f" type="range" aria-label="Strength"></span>
      <div data-tip="Section"><button id="g" aria-label="One"></button><button aria-label="Two"></button><button aria-label="Three"></button></div>`;
    const $ = (id: string) => document.getElementById(id);
    expect(tipFor($("a"))?.text).toBe("Outer");
    expect(tipFor($("b"))?.text).toBe("From title");
    expect($("b")?.getAttribute("title")).toBeNull();
    expect(tipFor($("c"))?.text).toBe("Zoom in");
    expect(tipFor($("d"))).toBeNull();
    expect(tipFor($("e"))?.text).toBe("no");
    expect(tipFor($("f"))?.text).toBe("How strong each hit is");
    expect(tipFor($("g"))?.text).toBe("One");
  });
});

describe("TooltipLayer", () => {
  it("shows the tip after hovering and hides on pointerdown", () => {
    vi.useFakeTimers();
    render(
      <>
        <TooltipLayer />
        <button data-tip="Cuts on every kick" data-tip-kbd="K">
          Cut
        </button>
      </>,
    );
    const btn = screen.getByText("Cut");
    act(() => {
      btn.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    });
    expect(screen.queryByRole("tooltip")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByRole("tooltip").textContent).toContain("Cuts on every kick");
    act(() => {
      btn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});

describe("TooltipLayer and Hide personal details", () => {
  afterEach(() => setCurrentPresenter(null));

  it("rewrites folder paths in the tip text", () => {
    vi.useFakeTimers();
    const win = (...p: string[]) => p.join(String.fromCharCode(92));
    setCurrentPresenter({ on: true, root: win("C:", "Users", "me", "Demo"), name: "Demo", home: win("C:", "Users", "me") });
    render(
      <>
        <TooltipLayer />
        <span data-tip={win("C:", "Users", "me", "Demo", "Library", "Captions", "a.jpg")}>a.jpg</span>
      </>,
    );
    act(() => {
      screen.getByText("a.jpg").dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByRole("tooltip").textContent).toBe("Demo/Library/Captions/a.jpg");
    act(() => {
      screen.getByText("a.jpg").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
  });
});
