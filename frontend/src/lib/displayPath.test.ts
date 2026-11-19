import { beforeEach, describe, expect, it } from "vitest";
import { useWorkspace } from "@/state/workspace";
import { displayPath, displayText, rewritePath, rewriteText, type Presenter } from "./displayPath";

const win: Presenter = { on: true, root: "C:\\Users\\nick\\repos\\toolbox\\workspaces\\demo", name: "Demo", home: "C:\\Users\\nick" };
const mac: Presenter = { on: true, root: "/Users/nick/ws/demo", name: "Demo", home: "/Users/nick" };

describe("rewritePath", () => {
  const cases: Array<[string, Presenter, string, string]> = [
    ["root file (windows)", win, "C:\\Users\\nick\\repos\\toolbox\\workspaces\\demo\\Library\\Stems\\song (vocals).flac", "Demo/Library/Stems/song (vocals).flac"],
    ["root itself", win, "C:\\Users\\nick\\repos\\toolbox\\workspaces\\demo", "Demo"],
    ["root with trailing slash", win, "C:\\Users\\nick\\repos\\toolbox\\workspaces\\demo\\", "Demo"],
    ["case-insensitive on windows", win, "c:\\users\\NICK\\Repos\\toolbox\\workspaces\\demo\\Library\\a.png", "Demo/Library/a.png"],
    ["forward slashes on windows", win, "C:/Users/nick/repos/toolbox/workspaces/demo/Library/a.png", "Demo/Library/a.png"],
    ["home file", win, "C:\\Users\\nick\\Documents\\a.txt", "~/Documents/a.txt"],
    ["home itself", win, "C:\\Users\\nick", "~"],
    ["sibling with the same prefix is not inside", win, "C:\\Users\\nick2\\a.txt", "C:\\Users\\nick2\\a.txt"],
    ["outside both", win, "D:\\Media\\a.mp4", "D:\\Media\\a.mp4"],
    ["mac root", mac, "/Users/nick/ws/demo/Library/x.png", "Demo/Library/x.png"],
    ["mac home", mac, "/Users/nick/Movies/x.mov", "~/Movies/x.mov"],
    ["mac is case-sensitive", mac, "/users/nick/Movies/x.mov", "/users/nick/Movies/x.mov"],
    ["mac outside", mac, "/Volumes/Disk/x.mov", "/Volumes/Disk/x.mov"],
    ["off leaves it alone", { ...win, on: false }, "C:\\Users\\nick\\a.txt", "C:\\Users\\nick\\a.txt"],
    ["empty path", win, "", ""],
  ];
  for (const [name, pr, input, want] of cases) {
    it(name, () => expect(rewritePath(input, pr)).toBe(want));
  }
});

describe("rewriteText", () => {
  const cases: Array<[string, Presenter, string, string]> = [
    ["a path in a message", win, "Can't write C:\\Users\\nick\\repos\\toolbox\\workspaces\\demo\\Library\\a.png: disk full", "Can't write Demo/Library/a.png: disk full"],
    ["quoted", win, 'open "C:\\Users\\nick\\Documents\\a.txt" failed', 'open "~/Documents/a.txt" failed'],
    ["two paths", mac, "copy /Users/nick/a.txt to /Users/nick/ws/demo/Library/a.txt", "copy ~/a.txt to Demo/Library/a.txt"],
    ["no path", win, "Nothing to see", "Nothing to see"],
    ["similar name left alone", win, "C:\\Users\\nickname\\a.txt", "C:\\Users\\nickname\\a.txt"],
    ["off", { ...win, on: false }, "C:\\Users\\nick\\a.txt", "C:\\Users\\nick\\a.txt"],
  ];
  for (const [name, pr, input, want] of cases) {
    it(name, () => expect(rewriteText(input, pr)).toBe(want));
  }
});

describe("displayPath / displayText use the store's presenter", () => {
  beforeEach(() => useWorkspace.setState({ presenter: null }));

  it("is unchanged before the presenter loads", () => {
    expect(displayPath("C:\\Users\\nick\\a.txt")).toBe("C:\\Users\\nick\\a.txt");
  });

  it("rewrites once it is on", () => {
    useWorkspace.setState({ presenter: win });
    expect(displayPath("C:\\Users\\nick\\a.txt")).toBe("~/a.txt");
    expect(displayText("see C:\\Users\\nick\\a.txt")).toBe("see ~/a.txt");
  });
});
