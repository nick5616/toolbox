import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueue = vi.hoisted(() => vi.fn());
const read = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    ExifService: {
      Defaults: async () => ({}),
      EditableFields: async () => ["Title", "Description", "Artist", "Copyright", "Keywords", "DateTimeOriginal"],
      Read: (...a: unknown[]) => read(...a),
      Enqueue: (...a: unknown[]) => enqueue(...a),
    },
    FilesService: {
      Pick: async () => ["/a.jpg"],
      Stat: async (p: string[]) => p.map((path) => ({ path, name: path, sizeBytes: 100, exists: true, isDir: false, kind: "image" })),
      ImageDataURL: async () => "data:image/png;base64,AAAA",
    },
    SettingsService: { ModuleState: async () => "", SetModuleState: async () => undefined },
    LibraryService: { Reveal: async () => undefined, Open: async () => undefined, RevealPath: async () => undefined },
    DepsService: { UpdateExiftool: vi.fn() },
  };
});

import type { MetadataView } from "@/lib/api";
import { useToastStore } from "@/components/toast";
import ExifView from "./ExifView";
import { changedFields, formatCoordinates, validateField } from "./options";

function view(over: Partial<MetadataView> = {}): MetadataView {
  return {
    path: "/a.jpg",
    name: "a.jpg",
    sizeBytes: 2048,
    make: "Canon",
    model: "R5",
    dateTaken: "2024:05:01 10:00:00",
    groups: [
      { name: "EXIF", collapsed: false, fields: [{ tag: "IFD0:Make", label: "Make", value: "Canon" }, { tag: "ExifIFD:ISO", label: "ISO", value: "200" }] },
      { name: "MakerNotes", collapsed: true, fields: [{ tag: "MakerNotes:Lens", label: "Lens", value: "RF 24-70" }] },
    ],
    hasLocation: true,
    location: { lat: 48.8584, lon: 2.2945, altitude: 0, hasAltitude: false },
    editable: true,
    fields: { Title: "Old title", Artist: "Me" },
    ...over,
  };
}

describe("exif helpers", () => {
  it("validates dates and diffs fields", () => {
    expect(validateField("DateTimeOriginal", "2024:01:02 03:04:05")).toBe("");
    expect(validateField("DateTimeOriginal", "")).toBe("");
    expect(validateField("DateTimeOriginal", "2024-01-02")).not.toBe("");
    expect(changedFields({ Title: "x", Artist: "Me" }, { Artist: "Me" })).toEqual({ Title: "x" });
    expect(changedFields({ Title: "" }, { Title: "Old" })).toEqual({ Title: "" });
    expect(formatCoordinates(48.858400001, 2.2945)).toBe("48.8584, 2.2945");
  });
});

describe("ExifView", () => {
  beforeEach(() => {
    enqueue.mockReset();
    read.mockReset();
    read.mockResolvedValue(view());
    useToastStore.setState({ toasts: [] });
  });

  async function load() {
    const user = userEvent.setup();
    render(<ExifView moduleId="exif" />);
    await user.click(screen.getByRole("button", { name: "Add files…" }));
    await screen.findByRole("heading", { name: "a.jpg" });
    return user;
  }

  it("renders groups with initial collapsed state, filter and location card", async () => {
    const user = await load();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    expect(screen.getByText("Canon R5", { exact: false })).toBeTruthy();
    expect(screen.getByText("Contains location: 48.8584, 2.2945")).toBeTruthy();
    expect(screen.getByText("ISO")).toBeTruthy();
    expect(screen.queryByText("Lens")).toBeNull();
    expect(screen.getByRole("button", { name: /MakerNotes/ }).getAttribute("aria-expanded")).toBe("false");
    await user.click(screen.getByRole("button", { name: /MakerNotes/ }));
    expect(screen.getByText("Lens")).toBeTruthy();

    await user.type(screen.getByRole("textbox", { name: "Filter tags" }), "iso");
    expect(screen.queryByText("Lens")).toBeNull();
    expect(screen.getByText("ISO")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Copy coordinates" }));
    expect(writeText).toHaveBeenCalledWith("48.8584, 2.2945");
  });

  it("notes read-only RAW files and disables actions", async () => {
    read.mockResolvedValue(view({ editable: false, hasLocation: false, location: null }));
    await load();
    expect(screen.getAllByText(/RAW files are read-only here/).length).toBeGreaterThan(0);
    expect((screen.getByRole("button", { name: "Remove all metadata" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Edit…" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a read error", async () => {
    read.mockRejectedValue({ cause: JSON.stringify({ code: "dependency-missing", message: "ExifTool missing" }) });
    const user = userEvent.setup();
    render(<ExifView moduleId="exif" />);
    await user.click(screen.getByRole("button", { name: "Add files…" }));
    expect(await screen.findByText("ExifTool missing")).toBeTruthy();
  });

  it("enqueues remove location and remove all with options", async () => {
    enqueue.mockResolvedValue([{}]);
    const user = await load();
    await user.click(screen.getByRole("button", { name: "Remove location" }));
    await waitFor(() =>
      expect(enqueue).toHaveBeenCalledWith(["/a.jpg"], { action: "strip-location", keepOrientation: true, fields: {} }),
    );
    await waitFor(() => expect(screen.queryByRole("heading", { name: "a.jpg" })).toBeNull());

    enqueue.mockClear();
    await user.click(screen.getByRole("button", { name: "Add files…" }));
    await screen.findByRole("heading", { name: "a.jpg" });
    await user.click(screen.getByRole("switch", { name: "Keep orientation & colour profile" }));
    await user.click(screen.getByRole("button", { name: "Remove all metadata" }));
    await waitFor(() =>
      expect(enqueue).toHaveBeenCalledWith(["/a.jpg"], { action: "strip-all", keepOrientation: false, fields: {} }),
    );
  });

  it("edit dialog prefills, validates and sends only changed fields", async () => {
    enqueue.mockResolvedValue([{}]);
    const user = await load();
    await user.click(screen.getByRole("button", { name: "Edit…" }));
    const dialog = await screen.findByRole("dialog");
    const title = within(dialog).getByLabelText("Title") as HTMLInputElement;
    expect(title.value).toBe("Old title");

    // nothing changed
    await user.click(within(dialog).getByRole("button", { name: "Apply" }));
    expect(await within(dialog).findByText("Change at least one field.")).toBeTruthy();

    // invalid date
    await user.type(within(dialog).getByLabelText("Date taken"), "2024-01-01");
    await user.click(within(dialog).getByRole("button", { name: "Apply" }));
    expect(await within(dialog).findByText(/YYYY:MM:DD HH:MM:SS/, { selector: "p[role=alert]" })).toBeTruthy();
    expect(enqueue).not.toHaveBeenCalled();

    await user.clear(within(dialog).getByLabelText("Date taken"));
    await user.type(within(dialog).getByLabelText("Date taken"), "2024:01:02 03:04:05");
    await user.clear(title);
    await user.click(within(dialog).getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(enqueue).toHaveBeenCalledWith(["/a.jpg"], {
        action: "edit",
        keepOrientation: true,
        fields: { Title: "", DateTimeOriginal: "2024:01:02 03:04:05" },
      }),
    );
  });
});
