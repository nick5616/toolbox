import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return { ...actual, LanShareService: { State: vi.fn(), Devices: vi.fn(), Messages: vi.fn(), Activity: vi.fn() } };
});

import type { LanDevice } from "@/lib/api";
import { EMPTY_LAN_STATE, useLanShare } from "@/state/lanshare";
import { BUILTIN_VARS } from "../vars";
import { DEFAULT_LANSHARE_STEP, lanShareNote, lanShareSteps, parseLanShareStep } from "./lanshare";
import { stepUI, type StepUI } from "./registry";

const VARS = BUILTIN_VARS.map((v) => ({ ...v }));

const dev = (o: Partial<LanDevice>): LanDevice => ({
  fingerprint: "f",
  alias: "Dev",
  deviceType: "desktop",
  deviceModel: "",
  toolbox: true,
  paired: false,
  autoAccept: false,
  address: "",
  port: 0,
  protocol: "https",
  lastSeen: 0,
  online: false,
  stored: true,
  ...o,
});

function mount(json: string) {
  const ui = stepUI("lan-share") as StepUI<unknown>;
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
  useLanShare.setState({ loaded: true, state: EMPTY_LAN_STATE, devices: [] });
});
afterEach(cleanup);

describe("lan-share step", () => {
  it("registers with its parameter overrides and parses over the defaults", () => {
    expect(lanShareSteps[0]?.type).toBe("lan-share");
    expect(lanShareSteps[0]?.params?.["/device"]?.primary).toBe(true);
    expect(parseLanShareStep("")).toEqual(DEFAULT_LANSHARE_STEP);
    expect(parseLanShareStep('{"device":"ab","waitMinutes":5000,"text":"hi {name}"}')).toEqual({ device: "ab", waitMinutes: 1440, text: "hi {name}" });
    expect(parseLanShareStep('{"waitMinutes":"x"}').waitMinutes).toBe(30);
  });

  it("lists only stored devices and picks one", async () => {
    useLanShare.setState({
      devices: [dev({ fingerprint: "p", alias: "Studio Mac", paired: true }), dev({ fingerprint: "s", alias: "Pixel", toolbox: false }), dev({ fingerprint: "x", alias: "Passing by", stored: false })],
    });
    const last = mount("{}");
    const select = screen.getByRole("combobox");
    expect(screen.getByRole("option", { name: "Studio Mac (paired)" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Pixel" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Passing by" })).toBeNull();
    await userEvent.selectOptions(select, "p");
    expect((last.value as { device: string }).device).toBe("p");
    expect(screen.getByText(/Accept without asking/)).toBeTruthy();
    await userEvent.selectOptions(select, "s");
    expect(screen.getByText("That device will ask its owner before it accepts the files.")).toBeTruthy();
  });

  it("says LocalSend devices ask, with nothing chosen", () => {
    mount("{}");
    expect(screen.getByText(/LocalSend devices will ask their owner/)).toBeTruthy();
    expect(lanShareNote(false, false)).toContain("will ask");
  });

  it("edits the message and the wait", async () => {
    const last = mount('{"device":"p"}');
    const msg = screen.getByRole("textbox");
    await userEvent.type(msg, "ready");
    expect((last.value as { text: string }).text).toBe("ready");
    const wait = screen.getByLabelText("Wait for it (minutes)");
    await userEvent.clear(wait);
    await userEvent.type(wait, "10");
    await userEvent.tab();
    expect((last.value as { waitMinutes: number }).waitMinutes).toBe(10);
  });
});
