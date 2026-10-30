import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { windowKind } from "@/App";
import { PopupShell } from "./PopupShell";

describe("window routing", () => {
  it("recognises popup windows", () => {
    expect(windowKind("?window=popup&view=clipboard")).toEqual({ popup: true, view: "clipboard", vizlab: false });
    expect(windowKind("?view=settings")).toEqual({ popup: false, view: "settings", vizlab: false });
    expect(windowKind("")).toEqual({ popup: false, view: "", vizlab: false });
  });

  it("renders a fallback for unknown popup views", () => {
    render(<PopupShell view="nope" />);
    expect(screen.getByText("Nothing to show here")).toBeTruthy();
  });
});
