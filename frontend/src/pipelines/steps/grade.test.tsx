import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ Looks: vi.fn() }));
vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return { ...actual, GradeService: { Looks: api.Looks } };
});

import type { BuiltInLook } from "@/grade/types";
import { setBuiltInLooksForTest } from "@/tools/grade/builtins";
import { stepUI } from "./index";
import { DEFAULT_GRADE_STEP, parseGradeStep, SAVED_PREFIX, type GradeStep } from "./grade";

const look = (id: string, name: string, tier: "film" | "bold" | "bonkers"): BuiltInLook => ({ id, blurb: "", recipe: { v: 1, name, tier, seed: 0, wildCurve: "linear", ops: [] } });
const savedRecipe = { v: 1, name: "My Fever", tier: "mine", seed: 3, wildCurve: "linear", ops: [] };

beforeEach(() => {
  api.Looks.mockResolvedValue([savedRecipe]);
  setBuiltInLooksForTest([look("teal-orange", "Teal & Orange", "film"), look("neon-noir", "Neon Noir", "bonkers")]);
});
afterEach(() => setBuiltInLooksForTest(null));

describe("grade step options", () => {
  it("parses over the defaults and clamps", () => {
    expect(parseGradeStep("")).toEqual(DEFAULT_GRADE_STEP);
    expect(parseGradeStep(JSON.stringify({ wild: 3, seed: -1, format: "gif", vibe: 4 }))).toEqual(DEFAULT_GRADE_STEP);
    expect(parseGradeStep(JSON.stringify({ look: "neon-noir", wild: 0.9, seed: 4821, vibe: "{name} as a fever dream", format: "png" }))).toEqual({
      look: "neon-noir",
      wild: 0.9,
      seed: 4821,
      vibe: "{name} as a fever dream",
      format: "png",
    });
  });

  it("keeps the resolved recipe, and the fields it doesn't know", () => {
    const p = parseGradeStep(JSON.stringify({ recipe: savedRecipe, extra: 1 })) as GradeStep & { extra: number };
    expect(p.recipe).toEqual(savedRecipe);
    expect(p.extra).toBe(1);
    expect(parseGradeStep(JSON.stringify({ recipe: "nope" })).recipe).toBeUndefined();
  });

  it("hides the recipe from the parameters", () => {
    expect(stepUI("grade")?.params?.["/recipe"]).toEqual({ hidden: true });
  });
});

describe("grade step editor", () => {
  function setup(initial: GradeStep = { ...DEFAULT_GRADE_STEP }) {
    const ui = stepUI("grade");
    if (!ui) throw new Error("no grade step editor");
    const Editor = ui.Editor as unknown as (p: { value: GradeStep; onChange: (v: GradeStep) => void; check: undefined; vars: [] }) => React.ReactElement;
    const onChange = vi.fn();
    render(<Editor value={initial} onChange={onChange} check={undefined} vars={[]} />);
    return onChange;
  }

  it("offers the built-in and saved looks, and stores the resolved recipe", async () => {
    const user = userEvent.setup();
    const onChange = setup();
    const select = screen.getByRole("combobox", { name: "Look" });
    await waitFor(() => expect(screen.getByRole("option", { name: "Mine · My Fever" })).toBeTruthy());
    expect(screen.getByRole("option", { name: "Film · Teal & Orange" })).toBeTruthy();
    await user.selectOptions(select, "neon-noir");
    const picked = onChange.mock.calls.at(-1)?.[0] as GradeStep;
    expect(picked.look).toBe("neon-noir");
    expect(picked.recipe?.name).toBe("Neon Noir");
    await user.selectOptions(select, `${SAVED_PREFIX}My Fever`);
    const saved = onChange.mock.calls.at(-1)?.[0] as GradeStep;
    expect(saved.look).toBe(`${SAVED_PREFIX}My Fever`);
    expect(saved.recipe?.name).toBe("My Fever");
  });

  it("changes Wildness, vibe and format", async () => {
    const user = userEvent.setup();
    const onChange = setup();
    await user.selectOptions(screen.getByRole("combobox", { name: "Picture format" }), "webp");
    expect((onChange.mock.calls.at(-1)?.[0] as GradeStep).format).toBe("webp");
    await user.type(screen.getByRole("textbox", { name: /Vibe/ }), "x");
    expect((onChange.mock.calls.at(-1)?.[0] as GradeStep).vibe).toBe("x");
  });

  it("keeps a look this build doesn't know selectable", () => {
    setup({ ...DEFAULT_GRADE_STEP, look: "from-the-future" });
    expect((screen.getByRole("combobox", { name: "Look" }) as HTMLSelectElement).value).toBe("from-the-future");
  });
});
