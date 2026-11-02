import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cancelSourceDrag, startSourceDrag, useSourceDrag, useSourceDropTarget, type SourceDropInfo } from "./sourceDrag";

function pointer(type: string, x: number, y: number, id = 1): void {
  const ev = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }) as MouseEvent & { pointerId: number };
  Object.defineProperty(ev, "pointerId", { value: id });
  act(() => {
    window.dispatchEvent(ev);
  });
}

function Target({ onDrop }: { onDrop: (i: SourceDropInfo) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useSourceDropTarget(ref, onDrop);
  return (
    <div ref={ref} data-testid="target">
      <span data-testid="inner" />
    </div>
  );
}

let hit: Element | null = null;

beforeEach(() => {
  hit = null;
  document.elementFromPoint = () => hit;
});

afterEach(() => {
  cancelSourceDrag();
  cleanup();
});

describe("sourceDrag", () => {
  it("does not start before the 4 px threshold, and a plain click is not a drag", () => {
    const drop = vi.fn();
    render(<Target onDrop={drop} />);
    startSourceDrag(["/a.jpg"], { clientX: 10, clientY: 10, pointerId: 1 });
    pointer("pointermove", 12, 12);
    expect(useSourceDrag.getState().paths).toEqual([]);
    expect(document.querySelector("[data-source-ghost]")).toBeNull();
    hit = document.querySelector('[data-testid="target"]');
    pointer("pointerup", 12, 12);
    expect(drop).not.toHaveBeenCalled();
  });

  it("shows a ghost with a count, marks the hovered target and drops on it", () => {
    const drop = vi.fn();
    const { getByTestId } = render(<Target onDrop={drop} />);
    startSourceDrag(["/a.jpg", "/b.jpg", "/c.mp4"], { clientX: 0, clientY: 0, pointerId: 1 });
    pointer("pointermove", 20, 20);
    expect(useSourceDrag.getState().paths).toHaveLength(3);
    expect(document.querySelector("[data-source-ghost]")?.textContent).toBe("3 sources");
    expect(getByTestId("target").hasAttribute("data-source-over")).toBe(false);

    hit = getByTestId("inner"); // hit-testing walks up to the registered ancestor
    pointer("pointermove", 30, 40);
    expect(getByTestId("target").hasAttribute("data-source-over")).toBe(true);

    hit = null;
    pointer("pointermove", 50, 50);
    expect(getByTestId("target").hasAttribute("data-source-over")).toBe(false);

    hit = getByTestId("inner");
    pointer("pointermove", 31, 41);
    pointer("pointerup", 31, 41);
    expect(drop).toHaveBeenCalledWith({ paths: ["/a.jpg", "/b.jpg", "/c.mp4"], x: 31, y: 41 });
    expect(document.querySelector("[data-source-ghost]")).toBeNull();
    expect(getByTestId("target").hasAttribute("data-source-over")).toBe(false);
    expect(useSourceDrag.getState().paths).toEqual([]);
  });

  it("a single source shows its file name", () => {
    render(<Target onDrop={() => undefined} />);
    startSourceDrag(["C:\\trip\\beach.jpg"], { clientX: 0, clientY: 0, pointerId: 1 });
    pointer("pointermove", 10, 10);
    expect(document.querySelector("[data-source-ghost]")?.textContent).toBe("beach.jpg");
  });

  it("Escape cancels without dropping", () => {
    const drop = vi.fn();
    const { getByTestId } = render(<Target onDrop={drop} />);
    startSourceDrag(["/a.jpg"], { clientX: 0, clientY: 0, pointerId: 1 });
    hit = getByTestId("target");
    pointer("pointermove", 20, 20);
    expect(getByTestId("target").hasAttribute("data-source-over")).toBe(true);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.querySelector("[data-source-ghost]")).toBeNull();
    expect(getByTestId("target").hasAttribute("data-source-over")).toBe(false);
    pointer("pointerup", 20, 20);
    expect(drop).not.toHaveBeenCalled();
    expect(useSourceDrag.getState().paths).toEqual([]);
  });

  it("releasing outside every target drops nowhere", () => {
    const drop = vi.fn();
    render(<Target onDrop={drop} />);
    startSourceDrag(["/a.jpg"], { clientX: 0, clientY: 0, pointerId: 1 });
    pointer("pointermove", 20, 20);
    pointer("pointerup", 20, 20);
    expect(drop).not.toHaveBeenCalled();
  });

  it("ignores other pointers", () => {
    const drop = vi.fn();
    const { getByTestId } = render(<Target onDrop={drop} />);
    startSourceDrag(["/a.jpg"], { clientX: 0, clientY: 0, pointerId: 1 });
    hit = getByTestId("target");
    pointer("pointermove", 20, 20, 2);
    expect(document.querySelector("[data-source-ghost]")).toBeNull();
    pointer("pointermove", 20, 20, 1);
    pointer("pointerup", 20, 20, 2);
    expect(drop).not.toHaveBeenCalled();
    pointer("pointerup", 20, 20, 1);
    expect(drop).toHaveBeenCalledTimes(1);
  });

  it("an unmounted target no longer receives drops", () => {
    const drop = vi.fn();
    const { getByTestId, unmount } = render(<Target onDrop={drop} />);
    const el = getByTestId("target");
    unmount();
    startSourceDrag(["/a.jpg"], { clientX: 0, clientY: 0, pointerId: 1 });
    hit = el;
    pointer("pointermove", 20, 20);
    pointer("pointerup", 20, 20);
    expect(drop).not.toHaveBeenCalled();
  });
});
