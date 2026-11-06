import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import type { LabParams, LabToolInfo } from "@/paint/lab/types";
import { back, canBack, canForward, current, forward, fromNorm, newHistory, pushRand, randomize, toNorm, type NumberParam } from "./deviceLogic";
import { Device } from "./ui/Device";
import "./ui/tokens.css";

const info: LabToolInfo = {
  id: "t",
  label: "Test tool",
  description: "d",
  kind: "algorithmic",
  predictability: "seeded",
  origin: { kind: "algorithm", text: "x" },
  icon: "flow",
  params: [
    { id: "a", label: "A", type: "number", min: 0, max: 100, default: 50, tip: "a", unit: "px" },
    { id: "b", label: "B", type: "number", min: 0, max: 1, step: 0.01, default: 0.5, tip: "b", rand: false },
    { id: "c", label: "C", type: "number", min: 1, max: 100, default: 10, tip: "c", curve: "exp" },
    { id: "d", label: "D", type: "choice", choices: [{ value: "x", label: "X" }, { value: "y", label: "Y" }], default: "x", tip: "d" },
    { id: "e", label: "E", type: "toggle", default: false, tip: "e" },
  ],
};
const start: LabParams = { a: 50, b: 0.5, c: 10, d: "x", e: false };

describe("Rand", () => {
  it("is deterministic for a rand seed and differs between seeds", () => {
    expect(randomize(info, start, new Set(), 7)).toEqual(randomize(info, start, new Set(), 7));
    expect(randomize(info, start, new Set(), 7)).not.toEqual(randomize(info, start, new Set(), 8));
  });

  it("keeps locked params and rand:false params, and never moves the others' draws", () => {
    const free = randomize(info, start, new Set(), 3);
    const locked = randomize(info, start, new Set(["a"]), 3);
    expect(locked.a).toBe(50);
    expect(locked.b).toBe(0.5);
    expect(free.b).toBe(0.5);
    expect(locked.c).toBe(free.c);
    expect(locked.d).toBe(free.d);
  });

  it("stays inside each range", () => {
    for (let s = 1; s < 40; s++) {
      const r = randomize(info, start, new Set(), s);
      expect(r.a as number).toBeGreaterThanOrEqual(0);
      expect(r.a as number).toBeLessThanOrEqual(100);
      expect(r.c as number).toBeGreaterThanOrEqual(1);
      expect(["x", "y"]).toContain(r.d);
    }
  });

  it("goes back and forward through its states", () => {
    let h = newHistory(start);
    expect(canBack(h)).toBe(false);
    h = pushRand(h, { ...start, a: 1 });
    h = pushRand(h, { ...start, a: 2 });
    expect(current(h).a).toBe(2);
    h = back(h);
    expect(current(h).a).toBe(1);
    expect(canForward(h)).toBe(true);
    h = back(h);
    expect(current(h)).toEqual(start);
    h = forward(h);
    expect(current(h).a).toBe(1);
    h = pushRand(h, { ...start, a: 9 }); // drops the forward state
    expect(canForward(h)).toBe(false);
  });

  it("exp curves give small values more room", () => {
    const p = info.params[2] as NumberParam;
    expect(fromNorm(p, 0.5)).toBeLessThan(p.min + (p.max - p.min) * 0.5);
    expect(Math.abs(toNorm(p, fromNorm(p, 0.7)) - 0.7)).toBeLessThan(0.05);
  });
});

function Harness({ log }: { log: LabParams[] }) {
  const [params, setParams] = useState<LabParams>(start);
  const [seed, setSeed] = useState({ seed: 5, locked: false });
  return (
    <Device
      info={info}
      params={params}
      onParam={(id, v) => setParams((p) => ({ ...p, [id]: v }))}
      onParams={(p) => {
        log.push(p);
        setParams(p);
      }}
      seed={seed}
      onToggleSeedLock={() => setSeed((s) => ({ ...s, locked: !s.locked }))}
      onReroll={() => setSeed((s) => ({ ...s, seed: s.seed + 1 }))}
      enabled
      onToggleEnabled={() => undefined}
      origins={[]}
    />
  );
}

describe("Device", () => {
  it("a knob answers the keyboard and double-click resets it", () => {
    render(<div data-design="paint"><Harness log={[]} /></div>);
    const knob = screen.getByRole("slider", { name: "A" });
    expect(knob.getAttribute("aria-valuetext")).toBe("50 px");
    fireEvent.keyDown(knob, { key: "ArrowUp" });
    expect(screen.getByRole("slider", { name: "A" }).getAttribute("aria-valuetext")).toBe("52 px");
    fireEvent.keyDown(knob, { key: "End" });
    expect(screen.getByRole("slider", { name: "A" }).getAttribute("aria-valuetext")).toBe("100 px");
    fireEvent.doubleClick(knob);
    expect(screen.getByRole("slider", { name: "A" }).getAttribute("aria-valuetext")).toBe("50 px");
    fireEvent.keyDown(knob, { key: "Home" });
    fireEvent.keyDown(knob, { key: "Enter" });
    expect(screen.getByRole("slider", { name: "A" }).getAttribute("aria-valuetext")).toBe("50 px");
  });

  it("Rand, back and forward drive the params; every control has a tooltip", () => {
    const log: LabParams[] = [];
    const { container } = render(<div data-design="paint"><Harness log={log} /></div>);
    fireEvent.click(screen.getByRole("button", { name: /^Rand$/ }));
    expect(log).toHaveLength(1);
    expect(log[0]?.b).toBe(0.5);
    fireEvent.click(screen.getByRole("button", { name: "Previous Rand" }));
    expect(log[1]).toEqual(start);
    fireEvent.click(screen.getByRole("button", { name: "Next Rand" }));
    expect(log[2]).toEqual(log[0]);
    for (const el of container.querySelectorAll("button, [role=slider], [role=switch]")) {
      expect(el.getAttribute("data-tip") || el.getAttribute("aria-label")).toBeTruthy();
    }
  });

  it("shows the lock pip after Lock from Rand", () => {
    render(<div data-design="paint"><Harness log={[]} /></div>);
    fireEvent.contextMenu(screen.getByRole("slider", { name: "A" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Lock from Rand" }));
    expect(screen.getAllByLabelText("Locked from Rand")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /^Rand$/ }));
    expect(screen.getByRole("slider", { name: "A" }).getAttribute("aria-valuetext")).toBe("50 px");
  });
});
