import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { stepUI } from "./index";

const VARS = [{ name: "name", label: "File name" }];

function mount<T>(type: string, json: string, onChange: (v: T) => void = () => {}) {
  const ui = stepUI(type);
  if (!ui) throw new Error(`no editor for ${type}`);
  const value = ui.parse(json) as T;
  const Editor = ui.Editor as unknown as (p: {
    value: T;
    onChange: (v: T) => void;
    check: undefined;
    vars: typeof VARS;
  }) => React.JSX.Element;
  render(<Editor value={value} onChange={onChange} check={undefined} vars={VARS} />);
  return value;
}

describe("docs step registry", () => {
  it("registers the five editors", () => {
    for (const t of ["pdf", "vault", "bg-remover", "upscaler", "exif"]) expect(stepUI(t)).toBeDefined();
  });

  it("parse never throws and falls back to defaults", () => {
    for (const t of ["pdf", "vault", "bg-remover", "upscaler", "exif"]) {
      const ui = stepUI(t);
      expect(() => ui?.parse("not json")).not.toThrow();
      expect(ui?.parse("[]")).toEqual(ui?.parse("{}"));
    }
  });
});

describe("pdf step", () => {
  it("sanitises over the defaults", () => {
    const ui = stepUI("pdf");
    expect(ui?.parse("{}")).toEqual({ action: "merge", every: 1, level: "balanced", pageSize: "a4", margin: "small", imageFormat: "png", dpi: 150 });
    expect(ui?.parse('{"action":"organize","every":0,"dpi":99,"level":"high"}')).toMatchObject({ action: "merge", every: 1, dpi: 150, level: "high" });
  });

  it("offers only the seven step actions and notes passwords", async () => {
    const onChange = vi.fn();
    mount("pdf", '{"action":"protect"}', onChange);
    const select = screen.getByLabelText("What to do") as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["merge", "split", "compress", "images-to-pdf", "pdf-to-images", "protect", "unlock"]);
    expect(screen.queryByText(/asked when the run starts/i)).not.toBeNull();
    await userEvent.selectOptions(select, "split");
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ action: "split" }));
  });

  it("shows the fields of the chosen action", () => {
    mount("pdf", '{"action":"pdf-to-images","imageFormat":"jpg","dpi":300}');
    expect((screen.getByRole("radio", { name: "JPG" }) as HTMLInputElement).getAttribute("aria-checked")).toBe("true");
    expect((screen.getByRole("radio", { name: "300 dpi" }) as HTMLInputElement).getAttribute("aria-checked")).toBe("true");
  });
});

describe("vault step", () => {
  it("round-trips the folder template", async () => {
    const onChange = vi.fn();
    mount("vault", '{"folder":"Scans/{name}"}', onChange);
    const input = screen.getByLabelText("Folder in the Vault") as HTMLInputElement;
    expect(input.value).toBe("Scans/{name}");
    await userEvent.type(input, "x");
    expect(onChange).toHaveBeenCalledWith({ folder: "Scans/{name}x" });
  });
});

describe("bg-remover step", () => {
  it("renders the defaults and changes the output", async () => {
    const onChange = vi.fn();
    const v = mount<{ output: string; model: string }>("bg-remover", "{}", onChange);
    expect(v).toMatchObject({ model: "balanced", output: "transparent" });
    expect((screen.getByRole("radio", { name: "Balanced" }) as HTMLInputElement).getAttribute("aria-checked")).toBe("true");
    await userEvent.click(screen.getByRole("radio", { name: "Mask only" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ output: "mask" }));
  });
});

describe("upscaler step", () => {
  it("renders the defaults and changes the scale", async () => {
    const onChange = vi.fn();
    mount("upscaler", '{"scale":9}', onChange);
    expect((screen.getByRole("radio", { name: "4×" }) as HTMLInputElement).getAttribute("aria-checked")).toBe("true");
    await userEvent.click(screen.getByRole("radio", { name: "2×" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ scale: 2 }));
  });
});

describe("exif step", () => {
  it("defaults to strip location and drops unknown fields", () => {
    const ui = stepUI("exif");
    expect(ui?.parse("{}")).toEqual({ action: "strip-location", keepOrientation: true, fields: {} });
    expect(ui?.parse('{"action":"edit","fields":{"Title":"a","Bogus":"b","Artist":3}}')).toEqual({
      action: "edit",
      keepOrientation: true,
      fields: { Title: "a" },
    });
  });

  it("edits fields with templates", async () => {
    const onChange = vi.fn();
    mount("exif", '{"action":"edit","fields":{"Title":"Hi"}}', onChange);
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Hi");
    expect(screen.queryByLabelText("Artist")).toBeNull();
    await userEvent.click(screen.getByRole("switch", { name: /set artist/i }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ fields: { Title: "Hi", Artist: "" } }));
    await userEvent.type(screen.getByLabelText("Title"), "!");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ fields: { Title: "Hi!" } }));
  });

  it("strip all offers keep orientation", async () => {
    const onChange = vi.fn();
    mount("exif", '{"action":"strip-all"}', onChange);
    await userEvent.click(screen.getByRole("switch", { name: /keep orientation/i }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ keepOrientation: false }));
  });
});
