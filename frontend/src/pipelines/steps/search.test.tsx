import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SEARCH_FILTER, parseSearchFilter, searchFilterSummary, searchSteps, type SearchFilterOptions } from "./search";
import { registerSteps, stepUI } from "./registry";

function mount(json: string, onChange: (v: SearchFilterOptions) => void = () => {}) {
  registerSteps(searchSteps);
  const ui = stepUI("search-filter");
  if (!ui) throw new Error("no editor");
  const value = ui.parse(json) as SearchFilterOptions;
  const Editor = ui.Editor as unknown as (p: {
    value: SearchFilterOptions;
    onChange: (v: SearchFilterOptions) => void;
    check: undefined;
    vars: { name: string; label: string }[];
  }) => React.JSX.Element;
  render(<Editor value={value} onChange={onChange} check={undefined} vars={[{ name: "subject", label: "Subject" }]} />);
}

describe("search-filter step", () => {
  it("is registered and parse never throws", () => {
    registerSteps(searchSteps);
    expect(stepUI("search-filter")).toBeDefined();
    expect(() => stepUI("search-filter")?.parse("not json")).not.toThrow();
    expect(parseSearchFilter("[]")).toEqual(DEFAULT_SEARCH_FILTER);
  });

  it("sanitises over the defaults and keeps unknown keys", () => {
    expect(parseSearchFilter("{}")).toEqual(DEFAULT_SEARCH_FILTER);
    expect(parseSearchFilter('{"query":"dog","match":"sound","strength":"maybe","invert":"yes"}')).toEqual({
      query: "dog",
      match: "both",
      strength: "maybe",
      invert: false,
    });
    expect(parseSearchFilter('{"query":5,"invert":true,"match":"text"}')).toMatchObject({ query: "", invert: true, match: "text" });
  });

  it("summarises", () => {
    expect(searchFilterSummary(DEFAULT_SEARCH_FILTER)).toBe("Describe what to keep");
    expect(searchFilterSummary({ ...DEFAULT_SEARCH_FILTER, query: " a dog " })).toBe("Keeps files showing “a dog” · by picture or text · good matches");
    expect(searchFilterSummary({ query: "x", match: "text", strength: "maybe", invert: true })).toBe(
      "Keeps files not showing “x” · by text · including maybes",
    );
  });

  it("edits every option", async () => {
    const onChange = vi.fn();
    mount('{"query":"a dog"}', onChange);
    expect(screen.getByText(/Keeps files showing “a dog”/)).toBeTruthy();

    await userEvent.click(screen.getByRole("radio", { name: "Text" }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ match: "text", query: "a dog" }));
    await userEvent.click(screen.getByRole("radio", { name: "Strong" }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ strength: "strong" }));
    await userEvent.click(screen.getByRole("radio", { name: "Include maybes" }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ strength: "maybe" }));
    await userEvent.click(screen.getByRole("switch", { name: "Keep the ones that don't match" }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ invert: true }));

    const q = screen.getByLabelText("Keep files that show");
    await userEvent.type(q, "!");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ query: "a dog!" }));
  });

  it("asks for a description when empty", () => {
    mount("{}");
    expect(screen.getAllByText("Describe what to keep").length).toBeGreaterThan(0);
  });
});
