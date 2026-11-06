import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { stepUI } from "./index";

function mount<T>(type: string, json: string, onChange: (v: T) => void = () => {}) {
  const ui = stepUI(type);
  if (!ui) throw new Error(`no editor for ${type}`);
  const value = ui.parse(json) as T;
  const Editor = ui.Editor as unknown as (p: { value: T; onChange: (v: T) => void; check: undefined; vars: never[] }) => React.JSX.Element;
  render(<Editor value={value} onChange={onChange} check={undefined} vars={[]} />);
  return value;
}

describe("documents and archiver steps", () => {
  it("are registered and parse never throws", () => {
    for (const t of ["documents", "archiver"]) {
      const ui = stepUI(t);
      expect(ui).toBeDefined();
      expect(() => ui?.parse("not json")).not.toThrow();
      expect(ui?.parse("[]")).toEqual(ui?.parse("{}"));
    }
  });

  it("documents sanitises over the defaults and keeps unseen fields", () => {
    const ui = stepUI("documents");
    expect(ui?.parse("{}")).toMatchObject({ to: "docx", pageSize: "a4", marginMm: 25, fontSizePt: 11, embedResources: true });
    expect(ui?.parse('{"to":"nope","marginMm":99,"mainFont":"Arial","fontSizePt":12}')).toMatchObject({
      to: "docx", marginMm: 25, mainFont: "Arial", fontSizePt: 12,
    });
  });

  it("documents edits the target format and shows the options that apply", async () => {
    const onChange = vi.fn();
    mount("documents", '{"to":"pdf"}', onChange);
    expect(screen.getByRole("radio", { name: "Letter" })).toBeTruthy();
    expect(screen.queryByText("Embed images and styles")).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText("Convert to"), "html");
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ to: "html" }));
    await userEvent.click(screen.getByRole("radio", { name: "Letter" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ pageSize: "letter" }));
  });

  it("documents shows HTML-only options for html", () => {
    mount("documents", '{"to":"html"}');
    expect(screen.queryByText("Embed images and styles")).not.toBeNull();
    expect(screen.queryByRole("radio", { name: "Letter" })).toBeNull();
  });

  it("archiver sanitises and edits", async () => {
    const ui = stepUI("archiver");
    expect(ui?.parse('{"timeoutSec":5,"renderJs":true}')).toMatchObject({ timeoutSec: 60, renderJs: true, urls: [] });
    const onChange = vi.fn();
    mount("archiver", "{}", onChange);
    await userEvent.click(screen.getByRole("switch", { name: "Also PDF" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ alsoPdf: true, urls: [] }));
    await userEvent.click(screen.getByRole("switch", { name: "No images" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ noImages: true }));
  });
});
