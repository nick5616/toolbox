import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueue = vi.hoisted(() => vi.fn());
const imageSize = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    UpscaleService: {
      Models: async () => [
        { id: "photo", label: "Photo", hint: "Best for photos", cpuDownloadBytes: 67e6, cpuSecondsPerMPixel: 100 },
        { id: "fast", label: "Fast", hint: "Quickest, softer", cpuDownloadBytes: 2e6, cpuSecondsPerMPixel: 4 },
      ],
      Limits: async () => ({ maxOutputPixels: 100e6, maxCpuInputPixels: 2e6 }),
      Enqueue: (...a: unknown[]) => enqueue(...a),
    },
    FilesService: {
      Pick: async () => ["/big.png", "/small.png", "/p.heic"],
      Stat: async (p: string[]) =>
        p.map((path) => ({ path, name: path, sizeBytes: 10, exists: true, isDir: false, kind: "image" })),
      ImageSize: (p: string) => imageSize(p),
      ImageThumb: async () => "data:image/png;base64,AAAA",
    },
    SettingsService: { ModuleState: async () => "", SetModuleState: async () => undefined },
    LibraryService: { Reveal: async () => undefined, Open: async () => undefined, RevealPath: async () => undefined },
  };
});

import { UpscaleDevice } from "@/lib/api";
import { useToastStore } from "@/components/toast";
import { useJobs } from "@/state/jobs";
import UpscaleView from "./UpscaleView";
import { cpuEstimateSeconds, formatEstimate, rowVerdict } from "./options";

const limits = { maxOutputPixels: 100e6, maxCpuInputPixels: 2e6 };

describe("upscale helpers", () => {
  it("flags rows over the output cap", () => {
    expect(rowVerdict({ w: 4000, h: 3000 }, 2, UpscaleDevice.DeviceAuto, limits).kind).toBe("ok");
    expect(rowVerdict({ w: 6000, h: 5000 }, 4, UpscaleDevice.DeviceAuto, limits).kind).toBe("over");
    expect(rowVerdict("heic", 4, UpscaleDevice.DeviceAuto, limits).kind).toBe("heic");
    expect(rowVerdict(undefined, 4, UpscaleDevice.DeviceAuto, limits).kind).toBe("unknown");
  });
  it("applies the CPU input cap only for the CPU processor", () => {
    const d = { w: 2000, h: 2000 };
    expect(rowVerdict(d, 2, UpscaleDevice.DeviceCPU, limits).kind).toBe("over");
    expect(rowVerdict(d, 2, UpscaleDevice.DeviceGPU, limits).kind).toBe("ok");
  });
  it("estimates CPU time", () => {
    expect(cpuEstimateSeconds([{ w: 1000, h: 1000 }], 10)).toBe(10);
    expect(formatEstimate(0.2)).toBe("under a second");
    expect(formatEstimate(30)).toBe("about 30 s");
    expect(formatEstimate(300)).toBe("about 5 min");
  });
});

describe("UpscaleView", () => {
  beforeEach(() => {
    enqueue.mockReset();
    imageSize
      .mockReset()
      .mockImplementation(async (p: string) => (p === "/big.png" ? { w: 6000, h: 5000 } : { w: 640, h: 480 }));
    useJobs.setState({ byId: {} });
    useToastStore.setState({ toasts: [] });
  });

  it("shows sizes, warns over-cap rows and excludes them on start", async () => {
    enqueue.mockResolvedValue([{}]);
    const user = userEvent.setup();
    render(<UpscaleView moduleId="upscaler" />);
    await screen.findByRole("radio", { name: /Photo/ });
    await user.click(screen.getByRole("button", { name: "Add files…" }));
    expect(await screen.findByText("640×480 → 2560×1920")).toBeTruthy();
    expect(screen.getByText("HEIC")).toBeTruthy();
    expect((await screen.findAllByText(/Too large to upscale 4×/)).length).toBeGreaterThan(0);

    const run = await screen.findByRole("button", { name: /Upscale 2 images/ });
    await waitFor(() => expect((run as HTMLButtonElement).disabled).toBe(false));
    await user.click(run);
    await waitFor(() => expect(enqueue).toHaveBeenCalled());
    expect(enqueue.mock.calls[0]?.[0]).toEqual(["/small.png", "/p.heic"]);
    expect(useToastStore.getState().toasts.some((t) => /Skipped 1 image/.test(t.title))).toBe(true);
  });

  it("shows a CPU time estimate for the CPU processor", async () => {
    const user = userEvent.setup();
    render(<UpscaleView moduleId="upscaler" />);
    await screen.findByRole("radio", { name: /Photo/ });
    await user.selectOptions(screen.getByLabelText("Processor"), "cpu");
    expect(screen.getByText(/much slower than a GPU/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Add files…" }));
    // 640x480 = 0.3072 MP x 100 s/MP; the 30 MP file is over the CPU cap and not counted.
    expect(await screen.findByText(/Estimated time about 31 s/)).toBeTruthy();
  });
});
