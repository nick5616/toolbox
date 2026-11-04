import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLIP_POST_TYPES, LOOK_POST_TYPES } from "@/viz/edit/schema";
import type { EditPost } from "@/viz/edit/types";
import type { PostType } from "@/viz/types";
import { EFFECT_CATALOG } from "./effectCatalog";
import { buildEntries, EffectPicker, filterEntries, STACKS_GROUP } from "./EffectPicker";

const label = (t: PostType) => EFFECT_CATALOG[t].label;
const make = (t: PostType): EditPost => ({ id: `x-${t}`, type: t, enabled: true, params: {} });

afterEach(cleanup);

describe("picker entries", () => {
  it("lists the stacks first, then every allowed effect under its category", () => {
    const e = buildEntries(CLIP_POST_TYPES, true, label, make);
    expect(e[0]?.group).toBe(STACKS_GROUP);
    expect(e.filter((x) => x.id.startsWith("type:")).map((x) => x.id.slice(5)).sort()).toEqual([...CLIP_POST_TYPES].sort());
    expect(e.find((x) => x.label === "Anime hit")?.count).toBe(4);
  });

  it("offers no stacks for the Look but includes the output effects", () => {
    const e = buildEntries(LOOK_POST_TYPES, false, label, make);
    expect(e.some((x) => x.group === STACKS_GROUP)).toBe(false);
    expect(e.some((x) => x.label === "Bloom")).toBe(true);
  });

  it("filters on every word of the query across label, description and group", () => {
    const e = buildEntries(CLIP_POST_TYPES, true, label, make);
    expect(filterEntries(e, "").length).toBe(e.length);
    expect(filterEntries(e, "shockwave").map((x) => x.label)).toContain("Shockwave");
    expect(filterEntries(e, "SHOCK ring").some((x) => x.label === "Shockwave")).toBe(true);
    expect(filterEntries(e, "glitch").every((x) => /glitch/i.test(`${x.label} ${x.description} ${x.group}`))).toBe(true);
    expect(filterEntries(e, "zzzzqq")).toEqual([]);
  });
});

describe("EffectPicker", () => {
  const setup = (room = 8) => {
    const onAdd = vi.fn();
    render(<EffectPicker types={CLIP_POST_TYPES} stacks room={room} label={label} makeEffect={make} onAdd={onAdd} />);
    return onAdd;
  };

  it("types to filter and Enter adds the first match", async () => {
    const onAdd = setup();
    await userEvent.click(screen.getByRole("button", { name: "Add effect" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Search effects" }), "twirl");
    expect(screen.getAllByRole("menuitem")).toHaveLength(1);
    await userEvent.keyboard("{Enter}");
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd.mock.calls[0]?.[0]).toHaveLength(1);
    expect(onAdd.mock.calls[0]?.[0][0].type).toBe("twirl");
    expect(onAdd.mock.calls[0]?.[1]).toBe(0);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("arrows move the selection and Escape closes", async () => {
    const onAdd = setup();
    await userEvent.click(screen.getByRole("button", { name: "Add effect" }));
    await userEvent.keyboard("{ArrowDown}{Enter}");
    // the second entry of the Stacks group
    expect(onAdd.mock.calls[0]?.[0].map((p: EditPost) => p.type)).toEqual(["shockwave", "zoomblur", "flash"]);
    await userEvent.click(screen.getByRole("button", { name: "Add effect" }));
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search effects" }), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("adds only what fits and reports the rest", async () => {
    const onAdd = setup(2);
    await userEvent.click(screen.getByRole("button", { name: "Add effect" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Anime hit" }));
    expect(onAdd.mock.calls[0]?.[0]).toHaveLength(2);
    expect(onAdd.mock.calls[0]?.[1]).toBe(2);
  });

  it("disables everything when the stack is full", async () => {
    const onAdd = setup(0);
    await userEvent.click(screen.getByRole("button", { name: "Add effect" }));
    for (const item of screen.getAllByRole("menuitem")) expect((item as HTMLButtonElement).disabled).toBe(true);
    expect(onAdd).not.toHaveBeenCalled();
  });
});
