import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pickFolder = vi.hoisted(() => vi.fn<(title: string) => Promise<string>>());

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return { ...actual, FilesService: { PickFolder: (t: string) => pickFolder(t) } };
});

import { BUILTIN_VARS } from "../vars";
import {
  DEFAULT_CHAT,
  DEFAULT_COPY,
  DEFAULT_RENAME,
  DEFAULT_TABLE,
  DEFAULT_ZIP,
  MAX_COLUMNS,
  MAX_FIELDS,
  parseChat,
  parseCopy,
  parseRename,
  parseTable,
  parseZip,
} from "./builtin";
import { registeredStepTypes, stepUI, type StepUI } from "./registry";

const VARS = BUILTIN_VARS.map((v) => ({ ...v }));

/** Renders a type's editor with real state; `last` holds the latest value. */
function mount(type: string, json: string) {
  const ui = stepUI(type) as StepUI<unknown>;
  const last: { value: unknown } = { value: ui.parse(json) };
  function Harness(): ReactElement {
    const [value, setValue] = useState<unknown>(last.value);
    return (
      <ui.Editor
        value={value}
        vars={VARS}
        check={undefined}
        onChange={(next) => {
          last.value = next;
          setValue(next);
        }}
      />
    );
  }
  render(<Harness />);
  return last;
}

beforeEach(() => {
  pickFolder.mockReset();
});

describe("built-in step registry", () => {
  it("registers every built-in type", () => {
    for (const t of ["pipelines.rename", "pipelines.chat", "pipelines.table", "pipelines.zip", "pipelines.copy", "pipelines.check"]) {
      expect(registeredStepTypes(), t).toContain(t);
    }
  });
});

describe("parse", () => {
  it("never throws and falls back to the defaults", () => {
    for (const bad of ["", "{oops", "[]", "null", "42", '"x"']) {
      expect(parseRename(bad)).toEqual(DEFAULT_RENAME);
      expect(parseChat(bad)).toEqual(DEFAULT_CHAT);
      expect(parseTable(bad)).toEqual(DEFAULT_TABLE);
      expect(parseZip(bad)).toEqual(DEFAULT_ZIP);
      expect(parseCopy(bad)).toEqual(DEFAULT_COPY);
    }
  });

  it("matches the Go defaults for empty options", () => {
    expect(parseRename("{}")).toEqual({ template: "{name}" });
    expect(parseChat("{}")).toMatchObject({ mode: "write", outputName: "{item} (notes)", format: "md", temperature: 0.3, saveJson: false });
    expect(parseTable("{}").name).toBe("{pipeline} {date}");
    expect(parseZip("{}")).toEqual({ together: true, name: "{pipeline} {date}" });
    expect(parseZip('{"together":false}').name).toBe("{item}");
  });

  it("sanitises wrong types and ranges", () => {
    const c = parseChat(
      JSON.stringify({
        mode: "chat",
        format: "doc",
        temperature: 9,
        saveJson: "yes",
        fields: [{ name: 5, label: null, type: "blob" }, "junk", { name: "a", label: "A", type: "date" }],
      }),
    );
    expect(c.mode).toBe("write");
    expect(c.format).toBe("md");
    expect(c.temperature).toBe(1.5);
    expect(c.saveJson).toBe(false);
    expect(c.fields).toEqual([
      { name: "", label: "", type: "text" },
      { name: "", label: "", type: "text" },
      { name: "a", label: "A", type: "date" },
    ]);
    expect(parseChat('{"temperature":-3}').temperature).toBe(0);
  });

  it("caps fields and columns and keeps one column", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ name: `f${i}`, label: "L", type: "text" }));
    expect(parseChat(JSON.stringify({ fields: many })).fields).toHaveLength(MAX_FIELDS);
    const cols = Array.from({ length: 40 }, () => ({ header: "h", value: "v" }));
    expect(parseTable(JSON.stringify({ columns: cols })).columns).toHaveLength(MAX_COLUMNS);
    expect(parseTable('{"columns":[]}').columns).toHaveLength(1);
  });

  it("round-trips through JSON", () => {
    const chat = { ...DEFAULT_CHAT, mode: "extract", prompt: "p {text}", fields: [{ name: "total", label: "Total", type: "number" }], saveJson: true, temperature: 0.7 };
    expect(parseChat(JSON.stringify(chat))).toEqual(chat);
    const table = { name: "t", columns: [{ header: "A", value: "{a}" }, { header: "B", value: "{b}" }] };
    expect(parseTable(JSON.stringify(table))).toEqual(table);
    const copy = { folder: "D:\\Out", subfolder: "{pipeline}" };
    expect(parseCopy(JSON.stringify(copy))).toEqual(copy);
  });
});

describe("rename editor", () => {
  it("renders the template and edits it", async () => {
    const last = mount("pipelines.rename", '{"template":"{name}"}');
    const input = screen.getByLabelText("New name");
    expect((input as HTMLInputElement).value).toBe("{name}");
    await userEvent.clear(input);
    await userEvent.type(input, "x-");
    expect(last.value).toEqual({ template: "x-" });
  });

  it("flags an empty template", async () => {
    mount("pipelines.rename", '{"template":""}');
    expect(screen.getByText("Type the new name")).toBeTruthy();
  });
});

describe("chat editor", () => {
  it("renders write mode from defaults", () => {
    mount("pipelines.chat", "{}");
    expect(screen.getByRole("radio", { name: "Write text" }).getAttribute("aria-checked")).toBe("true");
    expect((screen.getByLabelText("File name") as HTMLInputElement).value).toBe("{item} (notes)");
    expect(screen.getByText("Write a prompt")).toBeTruthy();
    expect(screen.queryByText("Add field")).toBeNull();
  });

  it("edits the prompt and the output name", async () => {
    const last = mount("pipelines.chat", "{}");
    await userEvent.type(screen.getByLabelText("Prompt"), "Hi");
    await userEvent.clear(screen.getByLabelText("File name"));
    await userEvent.type(screen.getByLabelText("File name"), "N");
    expect(last.value).toMatchObject({ prompt: "Hi", outputName: "N" });
  });

  it("switches to extract mode and edits fields", async () => {
    const last = mount("pipelines.chat", "{}");
    await userEvent.click(screen.getByRole("radio", { name: "Pull out fields" }));
    expect(last.value).toMatchObject({ mode: "extract" });
    expect(screen.queryByLabelText("File name")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Add field" }));
    await userEvent.type(screen.getByLabelText("Field 1 name"), "total");
    await userEvent.type(screen.getByLabelText("Field 1 label"), "Total");
    await userEvent.selectOptions(screen.getByLabelText("Field 1 type"), "number");
    expect(last.value).toMatchObject({ fields: [{ name: "total", label: "Total", type: "number" }] });

    await userEvent.click(screen.getByRole("switch", { name: /JSON file/ }));
    expect(last.value).toMatchObject({ saveJson: true });

    await userEvent.click(screen.getByRole("button", { name: "Remove field 1" }));
    expect(last.value).toMatchObject({ fields: [] });
  });

  it("stops adding fields at the limit", () => {
    const fields = Array.from({ length: MAX_FIELDS }, (_, i) => ({ name: `f${i}`, label: "L", type: "text" }));
    mount("pipelines.chat", JSON.stringify({ mode: "extract", fields }));
    expect((screen.getByRole("button", { name: "Add field" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("marks a bad field name", () => {
    mount("pipelines.chat", JSON.stringify({ mode: "extract", fields: [{ name: "Total", label: "T", type: "text" }] }));
    expect(screen.getByLabelText("Field 1 name").getAttribute("aria-invalid")).toBe("true");
  });

  it("knows {file} in the prompt", () => {
    mount("pipelines.chat", JSON.stringify({ prompt: "Summarise {file}" }));
    expect(screen.queryByText(/Unknown/)).toBeNull();
  });

  it("changes the format", async () => {
    const last = mount("pipelines.chat", "{}");
    await userEvent.selectOptions(screen.getByLabelText("Save as"), "txt");
    expect(last.value).toMatchObject({ format: "txt" });
  });
});

describe("table editor", () => {
  it("renders the default column", () => {
    mount("pipelines.table", "{}");
    expect((screen.getByLabelText("Column 1 heading") as HTMLInputElement).value).toBe("File");
    expect((screen.getByLabelText("Column 1 value") as HTMLInputElement).value).toBe("{item}");
    expect((screen.getByRole("button", { name: "Remove column 1" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("adds, edits, reorders and removes columns", async () => {
    const last = mount("pipelines.table", "{}");
    await userEvent.click(screen.getByRole("button", { name: "Add column" }));
    await userEvent.type(screen.getByLabelText("Column 2 heading"), "BPM");
    await userEvent.type(screen.getByLabelText("Column 2 value"), "x");
    expect(last.value).toMatchObject({
      columns: [
        { header: "File", value: "{item}" },
        { header: "BPM", value: "x" },
      ],
    });

    await userEvent.click(screen.getByRole("button", { name: "Move column 2 up" }));
    expect(last.value).toMatchObject({ columns: [{ header: "BPM" }, { header: "File" }] });
    expect((screen.getByRole("button", { name: "Move column 1 up" }) as HTMLButtonElement).disabled).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "Remove column 1" }));
    expect(last.value).toMatchObject({ columns: [{ header: "File" }] });
  });

  it("edits the name", async () => {
    const last = mount("pipelines.table", "{}");
    await userEvent.clear(screen.getByLabelText("File name"));
    await userEvent.type(screen.getByLabelText("File name"), "Out");
    expect(last.value).toMatchObject({ name: "Out" });
  });
});

describe("zip editor", () => {
  it("toggles between one zip and one per item, swapping a default name", async () => {
    const last = mount("pipelines.zip", "{}");
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
    await userEvent.click(screen.getByRole("switch"));
    expect(last.value).toEqual({ together: false, name: "{item}" });
    await userEvent.click(screen.getByRole("switch"));
    expect(last.value).toEqual({ together: true, name: "{pipeline} {date}" });
  });

  it("keeps a custom name when toggling", async () => {
    const last = mount("pipelines.zip", '{"together":true,"name":"Mine"}');
    await userEvent.click(screen.getByRole("switch"));
    expect(last.value).toEqual({ together: false, name: "Mine" });
  });

  it("edits the name", async () => {
    const last = mount("pipelines.zip", "{}");
    await userEvent.clear(screen.getByLabelText("Zip name"));
    await userEvent.type(screen.getByLabelText("Zip name"), "Z");
    expect(last.value).toMatchObject({ name: "Z" });
  });
});

describe("copy editor", () => {
  it("asks for a folder with the picker", async () => {
    pickFolder.mockResolvedValue("D:\\Out");
    const last = mount("pipelines.copy", "{}");
    expect(screen.getByText("No folder chosen")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Choose…" }));
    expect(pickFolder).toHaveBeenCalledWith("Copy to folder");
    expect(await screen.findByTitle("D:\\Out")).toBeTruthy();
    expect(last.value).toEqual({ folder: "D:\\Out", subfolder: "" });
  });

  it("keeps the folder when the dialog is cancelled", async () => {
    pickFolder.mockResolvedValue("");
    const last = mount("pipelines.copy", '{"folder":"D:\\\\Out","subfolder":""}');
    await userEvent.click(screen.getByRole("button", { name: "Choose…" }));
    expect(last.value).toEqual({ folder: "D:\\Out", subfolder: "" });
  });

  it("edits the subfolder", async () => {
    const last = mount("pipelines.copy", "{}");
    await userEvent.type(screen.getByLabelText("Subfolder (optional)"), "a");
    expect(last.value).toMatchObject({ subfolder: "a" });
  });
});

describe("check editor", () => {
  it("explains what happens", () => {
    mount("pipelines.check", "{}");
    expect(screen.getByText(/pauses here/)).toBeTruthy();
  });
});
