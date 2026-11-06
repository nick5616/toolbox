/**
 * Every source drop target (the editor's media bin and timeline, Post Builder's
 * slide strip, Photo Composer's canvas) is made by `useSourceDropTarget`, which
 * also takes in-app file drags (`PATHS_MIME`, Phase 14) with the drop point.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PATHS_MIME, startPathsDrag } from "@/lib/fileDrag";
import { useSourceDropTarget, type SourceDropInfo } from "./sourceDrag";

afterEach(cleanup);

function Target({ onDrop }: { onDrop: (i: SourceDropInfo) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useSourceDropTarget(ref, onDrop);
  return (
    <div ref={ref} data-testid="target">
      <span data-testid="inner">inner</span>
      <div data-file-drop-target="" data-testid="routed">
        shell-routed
      </div>
    </div>
  );
}

/** jsdom has no DragEvent: a MouseEvent carries the pointer, `dataTransfer` is attached. */
function dropAt(el: Element, dataTransfer: unknown, init: MouseEventInit = {}) {
  const e = new MouseEvent("drop", { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(e, "dataTransfer", { value: dataTransfer });
  fireEvent(el, e);
}

const transfer = (paths: string[] | null) => {
  const data: Record<string, string> = paths ? { [PATHS_MIME]: JSON.stringify(paths) } : {};
  return { types: paths ? [PATHS_MIME] : ["Files"], getData: (k: string) => data[k] ?? "", dropEffect: "none" };
};

describe("useSourceDropTarget with in-app file drags", () => {
  it("hands the dropped paths, the pointer and Shift to the target", () => {
    const onDrop = vi.fn();
    render(<Target onDrop={onDrop} />);
    dropAt(screen.getByTestId("inner"), transfer(["/a.jpg", "/b.mp4"]), { clientX: 12, clientY: 34, shiftKey: true });
    expect(onDrop).toHaveBeenCalledWith({ paths: ["/a.jpg", "/b.mp4"], x: 12, y: 34, shiftKey: true });
  });

  it("accepts a drag made by startPathsDrag", () => {
    const onDrop = vi.fn();
    render(<Target onDrop={onDrop} />);
    const store: Record<string, string> = {};
    const dt = { setData: (k: string, v: string) => (store[k] = v), types: [] as string[], getData: (k: string) => store[k] ?? "" };
    startPathsDrag({ dataTransfer: dt } as never, ["C:\\x\\y.png"]);
    dt.types = Object.keys(store);
    fireEvent.drop(screen.getByTestId("target"), { dataTransfer: dt });
    expect(onDrop.mock.calls[0]?.[0].paths).toEqual(["C:\\x\\y.png"]);
  });

  it("marks the target while a file drag hovers and clears the mark on leave and drop", () => {
    render(<Target onDrop={() => undefined} />);
    const el = screen.getByTestId("target");
    fireEvent.dragOver(el, { dataTransfer: transfer(["/a.jpg"]) });
    expect(el.hasAttribute("data-source-over")).toBe(true);
    fireEvent.dragLeave(el, { relatedTarget: document.body });
    expect(el.hasAttribute("data-source-over")).toBe(false);
    fireEvent.dragOver(el, { dataTransfer: transfer(["/a.jpg"]) });
    fireEvent.drop(el, { dataTransfer: transfer(["/a.jpg"]) });
    expect(el.hasAttribute("data-source-over")).toBe(false);
  });

  it("ignores drags without in-app files, and drops the shell routes itself", () => {
    const onDrop = vi.fn();
    render(<Target onDrop={onDrop} />);
    fireEvent.drop(screen.getByTestId("target"), { dataTransfer: transfer(null) });
    fireEvent.drop(screen.getByTestId("routed"), { dataTransfer: transfer(["/a.jpg"]) });
    expect(onDrop).not.toHaveBeenCalled();
  });
});
