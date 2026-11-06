import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FocusWeaken, type FocusFriction } from "@/lib/api";
import { FrictionDialog, confirmBlocker } from "./FrictionDialog";
import { formatMmSs, phraseMatches } from "./model";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const PHRASE = "I'm choosing to stop early";

function friction(over: Partial<FocusFriction> = {}): FocusFriction {
  return { action: FocusWeaken.WeakenEnd, phrase: PHRASE, readyAt: 0, rule: null, ...over };
}

function confirmButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
}

describe("phrase check", () => {
  it("is exact on case and spacing", () => {
    expect(phraseMatches(PHRASE, PHRASE)).toBe(true);
    expect(phraseMatches("i'm choosing to stop early", PHRASE)).toBe(false);
    expect(phraseMatches("I'm choosing to  stop early", PHRASE)).toBe(false);
    expect(phraseMatches(PHRASE + " ", PHRASE)).toBe(false);
  });
  it("accepts curly and straight apostrophes either way", () => {
    expect(phraseMatches("I’m choosing to stop early", PHRASE)).toBe(true);
    expect(phraseMatches(PHRASE, "I’m choosing to stop early")).toBe(true);
    expect(phraseMatches("I‘m choosing to stop early", PHRASE)).toBe(true);
  });
  it("an empty phrase always matches", () => {
    expect(phraseMatches("", "")).toBe(true);
  });
  it("formats the countdown", () => {
    expect(formatMmSs(28)).toBe("0:28");
    expect(formatMmSs(299)).toBe("4:59");
  });
});

describe("confirmBlocker", () => {
  it("names what is missing", () => {
    expect(confirmBlocker(PHRASE, "", 30)).toMatch(/Type the phrase and wait 0:30/);
    expect(confirmBlocker(PHRASE, "", 0)).toMatch(/Type the phrase/);
    expect(confirmBlocker(PHRASE, PHRASE, 12)).toBe("Wait 0:12");
    expect(confirmBlocker(PHRASE, PHRASE, 0)).toBe("");
    expect(confirmBlocker("", "", 0)).toBe("");
  });
});

describe("FrictionDialog", () => {
  it("shows the phrase and keeps Confirm aria-disabled until typed", async () => {
    const onConfirm = vi.fn();
    render(<FrictionDialog friction={friction()} onConfirm={onConfirm} onCancel={() => undefined} onHide={() => undefined} />);
    expect(screen.getByTestId("friction-phrase").textContent).toBe(PHRASE);
    expect(confirmButton().getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(confirmButton());
    expect(onConfirm).not.toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText("Type the phrase"), "I’m choosing to stop early");
    expect(confirmButton().getAttribute("aria-disabled")).toBeNull();
    await userEvent.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledWith("I’m choosing to stop early");
  });

  it("accepts the straight apostrophe too", async () => {
    render(<FrictionDialog friction={friction()} onConfirm={() => undefined} onCancel={() => undefined} onHide={() => undefined} />);
    await userEvent.type(screen.getByLabelText("Type the phrase"), PHRASE);
    expect(confirmButton().getAttribute("aria-disabled")).toBeNull();
  });

  it("a wrong case keeps it disabled", async () => {
    render(<FrictionDialog friction={friction()} onConfirm={() => undefined} onCancel={() => undefined} onHide={() => undefined} />);
    await userEvent.type(screen.getByLabelText("Type the phrase"), "i'm choosing to stop early");
    expect(confirmButton().getAttribute("aria-disabled")).toBe("true");
  });

  it("counts down from readyAt and enables Confirm when it reaches zero", async () => {
    vi.useFakeTimers();
    let clock = 1_000_000;
    const now = () => clock;
    render(<FrictionDialog friction={friction({ phrase: "", readyAt: clock + 30_000 })} now={now} onConfirm={() => undefined} onCancel={() => undefined} onHide={() => undefined} />);
    expect(screen.getByTestId("friction-countdown").textContent).toContain("0:30");
    expect(confirmButton().getAttribute("aria-disabled")).toBe("true");
    expect(confirmButton().getAttribute("data-tip")).toBe("Wait 0:30");

    await act(async () => {
      clock += 12_000;
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(screen.getByTestId("friction-countdown").textContent).toContain("0:18");

    await act(async () => {
      clock += 18_000;
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(screen.queryByTestId("friction-countdown")).toBeNull();
    expect(confirmButton().getAttribute("aria-disabled")).toBeNull();
  });

  it("needs both the phrase and the countdown", async () => {
    const now = () => 5_000;
    render(<FrictionDialog friction={friction({ readyAt: 5_000 + 20_000 })} now={now} onConfirm={() => undefined} onCancel={() => undefined} onHide={() => undefined} />);
    await userEvent.type(screen.getByLabelText("Type the phrase"), PHRASE);
    expect(confirmButton().getAttribute("aria-disabled")).toBe("true");
    expect(confirmButton().getAttribute("data-tip")).toBe("Wait 0:20");
  });

  it("soft friction has no phrase field and confirms at once", async () => {
    const onConfirm = vi.fn();
    render(<FrictionDialog friction={friction({ phrase: "" })} onConfirm={onConfirm} onCancel={() => undefined} onHide={() => undefined} />);
    expect(screen.queryByLabelText("Type the phrase")).toBeNull();
    await userEvent.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledWith("");
  });

  it("Escape and the backdrop only hide; Cancel cancels", async () => {
    const onCancel = vi.fn();
    const onHide = vi.fn();
    const { container } = render(<FrictionDialog friction={friction()} onConfirm={() => undefined} onCancel={onCancel} onHide={onHide} />);
    await userEvent.keyboard("{Escape}");
    await userEvent.pointer({ keys: "[MouseLeft]", target: container.firstElementChild as Element });
    expect(onHide).toHaveBeenCalledTimes(2);
    expect(onCancel).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
