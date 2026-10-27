import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Category, ModuleStatus, type Descriptor } from "@/lib/api";
import { useModules } from "@/state/modules";
import { ComingSoonView } from "./ComingSoonView";

describe("ComingSoonView", () => {
  it("renders name and accepts chips", () => {
    useModules.getState().setAll([
      {
        id: "conv",
        name: "Converter",
        tagline: "Convert things",
        description: "",
        icon: "repeat",
        category: Category.CategoryMedia,
        status: ModuleStatus.StatusComingSoon,
        accepts: { extensions: [".mp3", ".wav"], urls: true },
      } as unknown as Descriptor,
    ]);
    render(<ComingSoonView moduleId="conv" />);
    expect(screen.getByText("Converter")).toBeTruthy();
    expect(screen.getByText(".mp3")).toBeTruthy();
    expect(screen.getByText(".wav")).toBeTruthy();
    expect(screen.getByText("Links")).toBeTruthy();
  });

  it("handles unknown ids", () => {
    render(<ComingSoonView moduleId="nope" />);
    expect(screen.getByText("Unknown tool")).toBeTruthy();
  });
});
