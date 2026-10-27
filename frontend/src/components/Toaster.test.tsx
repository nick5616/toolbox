import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Toaster } from "./Toaster";
import { dismissToast, toast, useToastStore } from "./toast";

afterEach(() => {
  vi.useRealTimers();
  act(() => useToastStore.setState({ toasts: [] }));
});

describe("Toaster", () => {
  it("shows a toast with title and description", () => {
    render(<Toaster />);
    act(() => {
      toast({ title: "Saved", description: "All good", tone: "success" });
    });
    expect(screen.getByText("Saved")).toBeTruthy();
    expect(screen.getByText("All good")).toBeTruthy();
  });

  it("runs the action and dismisses", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Toaster />);
    act(() => {
      toast({ title: "Done", action: { label: "Undo", onClick } });
    });
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(onClick).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByText("Done")).toBeNull());
  });

  it("dismissToast removes the toast", async () => {
    render(<Toaster />);
    let id = "";
    act(() => {
      id = toast({ title: "Bye" });
    });
    expect(screen.getByText("Bye")).toBeTruthy();
    act(() => dismissToast(id));
    await waitFor(() => expect(screen.queryByText("Bye")).toBeNull());
  });

  it("auto-dismisses after the duration", async () => {
    vi.useFakeTimers();
    render(<Toaster />);
    act(() => {
      toast({ title: "Soon gone", duration: 1000 });
    });
    expect(screen.getByText("Soon gone")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1000 + 300);
    });
    expect(screen.queryByText("Soon gone")).toBeNull();
  });

  it("keeps at most 4 toasts visible", async () => {
    render(<Toaster />);
    act(() => {
      for (let i = 1; i <= 6; i++) toast({ title: `T${i}`, duration: 0 });
    });
    await waitFor(() => expect(screen.getAllByRole("status").length).toBe(4));
    expect(screen.queryByText("T1")).toBeNull();
    expect(screen.getByText("T6")).toBeTruthy();
  });
});
