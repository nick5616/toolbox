import { describe, expect, it } from "vitest";
import type { EditMod, EditParam } from "@/viz/edit/types";
import { isKeyed, keyIndexAt, neighbourKey, paramBase, paramKeys, removeKeyAt, setEaseAt, setKeyAt, withBase, withMods, writeValue } from "./paramOps";

const mod: EditMod = { signal: "marker.kick", amount: 1, shape: "exp" };

describe("paramOps", () => {
  it("keeps plain numbers plain", () => {
    expect(withBase(1, 2)).toBe(2);
    expect(withBase({ base: 1, mods: [mod] }, 3)).toEqual({ base: 3, mods: [mod] });
    expect(withMods(0.5, [])).toBe(0.5);
    expect(withMods(0.5, [mod])).toEqual({ base: 0.5, mods: [mod] });
    expect(withMods({ base: 1, mods: [mod] }, [])).toBe(1);
  });

  it("limits reactions to 4", () => {
    expect((withMods(0, [mod, mod, mod, mod, mod]) as { mods: EditMod[] }).mods).toHaveLength(4);
  });

  it("adds, sorts and replaces keys", () => {
    let p: EditParam = 1;
    p = setKeyAt(p, 500, 1.2);
    p = setKeyAt(p, 100, 1);
    expect(paramKeys(p).map((k) => k.t)).toEqual([100, 500]);
    p = setKeyAt(p, 503, 1.5); // within tolerance: same key
    expect(paramKeys(p)).toHaveLength(2);
    expect(paramKeys(p)[1]).toEqual({ t: 500, v: 1.5, ease: "ease" });
    expect(isKeyed(p)).toBe(true);
  });

  it("caps the key count", () => {
    let p: EditParam = 0;
    for (let i = 0; i < 70; i++) p = setKeyAt(p, i * 100, i);
    expect(paramKeys(p)).toHaveLength(64);
  });

  it("removing the last key bakes its value into the base", () => {
    let p = setKeyAt(0, 200, 3);
    p = removeKeyAt(p, 200);
    expect(p).toBe(3);
    const q = removeKeyAt(setKeyAt(setKeyAt(1, 0, 1), 400, 2), 0);
    expect(paramKeys(q)).toHaveLength(1);
    expect(removeKeyAt(q, 900)).toBe(q);
  });

  it("changes the ease of a key only where there is one", () => {
    const p = setKeyAt(1, 300, 2);
    expect(paramKeys(setEaseAt(p, 300, "hold"))[0]?.ease).toBe("hold");
    expect(setEaseAt(p, 900, "hold")).toBe(p);
  });

  it("finds neighbouring keys", () => {
    const keys = paramKeys(setKeyAt(setKeyAt(setKeyAt(0, 100, 1), 300, 2), 700, 3));
    expect(neighbourKey(keys, 300, -1)?.t).toBe(100);
    expect(neighbourKey(keys, 300, 1)?.t).toBe(700);
    expect(neighbourKey(keys, 100, -1)).toBeNull();
    expect(neighbourKey(keys, 700, 1)).toBeNull();
    expect(keyIndexAt(keys, 296)).toBe(1);
    expect(keyIndexAt(keys, 400)).toBe(-1);
  });

  it("writes a key when keyed and the base otherwise, clamped", () => {
    expect(writeValue(1, 9, 0.05, 8.0, 100)).toBe(8);
    expect(writeValue({ base: 1, mods: [mod] }, 2, 0, 8, 100)).toEqual({ base: 2, mods: [mod] });
    const keyed = setKeyAt(1, 0, 1);
    const next = writeValue(keyed, 2, 0, 8, 400);
    expect(paramKeys(next).map((k) => [k.t, k.v])).toEqual([
      [0, 1],
      [400, 2],
    ]);
    expect(paramBase(next)).toBe(1);
  });
});
