import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const stat = vi.fn();

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    FilesService: { Stat: (p: string[]) => stat(p), Pick: vi.fn() },
    SettingsService: { ModuleState: vi.fn().mockResolvedValue(""), SetModuleState: vi.fn().mockResolvedValue(undefined) },
  };
});

import { ModuleStatus, type Descriptor, type FileInfo } from "@/lib/api";
import { EmbedContext, type EmbedContextValue } from "@/lib/embed";
import { useModules } from "@/state/modules";
import { useUI } from "@/state/ui";
import { MAX_EMBED_KEYS, useFileInputsStore } from "./fileInputsStore";
import { useFileInputs } from "./useFileInputs";

function mod(id: string): Descriptor {
  return {
    id,
    name: id,
    tagline: "t",
    description: "",
    icon: "box",
    status: ModuleStatus.StatusReady,
    accepts: { extensions: [".mp3"], urls: false },
    requires: null,
    recommends: null,
    maxInputs: 0,
  } as Descriptor;
}

function fi(path: string): FileInfo {
  return { path, name: path, sizeBytes: 10, exists: true, isDir: false, kind: "audio" } as FileInfo;
}

function embedValue(token: string): EmbedContextValue {
  return {
    host: "host-tool",
    hostName: "Host",
    placement: "window",
    handoff: { moduleId: "a", inputs: [], embed: { token, host: "host-tool", hostName: "Host", hostWindow: "main", useLabel: "" } },
    useLabel: "",
  } as EmbedContextValue;
}

function embedWrapper(token: string) {
  const value = embedValue(token);
  return ({ children }: { children: ReactNode }) => <EmbedContext.Provider value={value}>{children}</EmbedContext.Provider>;
}

beforeEach(() => {
  stat.mockReset().mockImplementation(async (ps: string[]) => ps.map((p) => fi(p)));
  useModules.getState().setAll([mod("a"), mod("b")]);
  useUI.setState({ handoff: null });
  useFileInputsStore.getState().reset();
});

describe("useFileInputs store", () => {
  it("keeps the list across unmount and remount", async () => {
    const first = renderHook(() => useFileInputs("a"));
    await act(() => first.result.current.add(["/x.mp3"]));
    first.unmount();
    const second = renderHook(() => useFileInputs("a"));
    expect(second.result.current.files.map((f) => f.path)).toEqual(["/x.mp3"]);
  });

  it("keeps modules independent", async () => {
    const a = renderHook(() => useFileInputs("a"));
    const b = renderHook(() => useFileInputs("b"));
    await act(() => a.result.current.add(["/x.mp3"]));
    expect(b.result.current.files).toEqual([]);
    expect(a.result.current.files).toHaveLength(1);
  });

  it("does not touch the standalone list from an embedded instance", async () => {
    const standalone = renderHook(() => useFileInputs("a"));
    await act(() => standalone.result.current.add(["/x.mp3"]));
    const embedded = renderHook(() => useFileInputs("a"), { wrapper: embedWrapper("t1") });
    expect(embedded.result.current.files).toEqual([]);
    await act(() => embedded.result.current.add(["/y.mp3"]));
    expect(embedded.result.current.files.map((f) => f.path)).toEqual(["/y.mp3"]);
    expect(standalone.result.current.files.map((f) => f.path)).toEqual(["/x.mp3"]);
    act(() => embedded.result.current.clear());
    expect(standalone.result.current.files).toHaveLength(1);
  });

  it("clears", async () => {
    const a = renderHook(() => useFileInputs("a"));
    await act(() => a.result.current.add(["/x.mp3"]));
    act(() => a.result.current.clear());
    expect(a.result.current.files).toEqual([]);
    const again = renderHook(() => useFileInputs("a"));
    expect(again.result.current.files).toEqual([]);
  });

  it("caps the number of kept embed lists, never dropping standalone ones", async () => {
    const standalone = renderHook(() => useFileInputs("a"));
    await act(() => standalone.result.current.add(["/x.mp3"]));
    for (let i = 0; i < MAX_EMBED_KEYS + 3; i++) {
      const e = renderHook(() => useFileInputs("a"), { wrapper: embedWrapper(`tok${i}`) });
      await act(() => e.result.current.add(["/e.mp3"]));
      e.unmount();
    }
    const lists = useFileInputsStore.getState().lists;
    expect(Object.keys(lists).filter((k) => k.startsWith("embed:"))).toHaveLength(MAX_EMBED_KEYS);
    expect(lists["a"]).toHaveLength(1);
    const oldest = renderHook(() => useFileInputs("a"), { wrapper: embedWrapper("tok0") });
    expect(oldest.result.current.files).toEqual([]);
  });
});
