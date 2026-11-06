import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { organizeSteps, parseOrganizeStep } from "./organize";
import { registerSteps, stepUI } from "./registry";

function mount<T>(type: string, json: string, onChange: (v: T) => void = () => {}) {
  registerSteps(organizeSteps);
  const ui = stepUI(type);
  if (!ui) throw new Error(`no editor for ${type}`);
  const value = ui.parse(json) as T;
  const Editor = ui.Editor as unknown as (p: { value: T; onChange: (v: T) => void; check: undefined; vars: never[] }) => React.JSX.Element;
  render(<Editor value={value} onChange={onChange} check={undefined} vars={[]} />);
  return value;
}

describe("organize step", () => {
  it("is registered and parse never throws", () => {
    registerSteps(organizeSteps);
    const ui = stepUI("organize");
    expect(ui).toBeDefined();
    expect(() => ui?.parse("not json")).not.toThrow();
    expect(ui?.parse("[]")).toEqual(ui?.parse("{}"));
    expect(organizeSteps.map((s) => s.type)).toEqual(["organize"]);
  });

  it("sanitises over the defaults", () => {
    expect(parseOrganizeStep("{}")).toMatchObject({ groupBy: "date", duplicates: "exact", similarity: 90, dupAction: "folder", destination: "" });
    expect(parseOrganizeStep('{"groupBy":"nope","duplicates":"similar","similarity":80}')).toMatchObject({ groupBy: "date", duplicates: "similar", similarity: 80 });
  });

  it("edits grouping and duplicates", async () => {
    const onChange = vi.fn();
    mount("organize", "{}", onChange);
    expect(screen.queryByLabelText("Folder pattern")).toBeNull();
    await userEvent.click(screen.getByRole("radio", { name: "Type" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ groupBy: "type" }));
    await userEvent.click(screen.getByRole("radio", { name: "Look-alike" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ duplicates: "similar" }));
  });

  it("shows the pattern field with its problem", () => {
    mount("organize", '{"groupBy":"pattern","pattern":"{nope}"}');
    expect((screen.getByLabelText("Folder pattern") as HTMLInputElement).value).toBe("{nope}");
    expect(screen.getByText(/isn't something the pattern can use/)).toBeTruthy();
  });

  it("hides duplicate settings when off", () => {
    mount("organize", '{"duplicates":"off"}');
    expect(screen.queryByText("Duplicates go")).toBeNull();
    expect(screen.queryByLabelText("Similarity")).toBeNull();
  });
});
