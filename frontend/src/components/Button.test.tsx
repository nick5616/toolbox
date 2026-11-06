import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./Button";
import { IconButton } from "./IconButton";
import { MenuButton } from "./MenuButton";
import { tipFor } from "./TooltipLayer";

describe("disabled buttons", () => {
  it("use aria-disabled, stay focusable and swallow clicks", () => {
    const onClick = vi.fn();
    render(
      <Button disabled data-tip="Pick a file first" onClick={onClick}>
        Go
      </Button>,
    );
    const b = screen.getByRole("button", { name: "Go" }) as HTMLButtonElement;
    expect(b.getAttribute("aria-disabled")).toBe("true");
    expect(b.hasAttribute("disabled")).toBe(false);
    b.focus();
    expect(document.activeElement).toBe(b);
    fireEvent.click(b);
    expect(onClick).not.toHaveBeenCalled();
    expect(tipFor(b)?.text).toBe("Pick a file first");
  });

  it("do not submit forms, enabled ones do", () => {
    const onSubmit = vi.fn((e: { preventDefault(): void }) => e.preventDefault());
    const { rerender } = render(
      <form onSubmit={onSubmit}>
        <Button type="submit" disabled>
          Save
        </Button>
      </form>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit).not.toHaveBeenCalled();
    rerender(
      <form onSubmit={onSubmit}>
        <Button type="submit">Save</Button>
      </form>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("loading buttons are aria-disabled and busy", () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Run
      </Button>,
    );
    const b = screen.getByRole("button", { name: /Run/ });
    expect(b.getAttribute("aria-disabled")).toBe("true");
    expect(b.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(b);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("icon buttons guard clicks too", () => {
    const onClick = vi.fn();
    render(<IconButton icon="x" label="Close" disabled onClick={onClick} />);
    const b = screen.getByRole("button", { name: "Close" });
    expect(b.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(b);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("disabled menu items keep their tip and do not select", async () => {
    const onSelect = vi.fn();
    render(<MenuButton label="Menu" items={() => [{ id: "a", label: "Item", disabled: true, tip: "Why not", onSelect }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    const item = await screen.findByRole("menuitem", { name: "Item" });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(tipFor(item)?.text).toBe("Why not");
    fireEvent.click(item);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("a collapsible primary button keeps its label; a secondary one collapses", () => {
    render(
      <div>
        <Button variant="primary" icon="send" collapsible>
          Export
        </Button>
        <Button icon="send" collapsible>
          Share
        </Button>
      </div>,
    );
    // The collapse rule is a CSS-module class: only the secondary button carries it.
    const cls = (n: string) => screen.getByRole("button", { name: n }).className;
    expect(cls("Export")).not.toMatch(/collapsible/);
    expect(cls("Share")).toMatch(/collapsible/);
  });
});
