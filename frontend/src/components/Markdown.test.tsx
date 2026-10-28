import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "./Markdown";

describe("Markdown", () => {
  it("never injects HTML", () => {
    const { container } = render(<Markdown text={'<script>alert(1)</script>\n\n<img src=x onerror="boom()"> **ok**'} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
    expect(container.querySelector("strong")?.textContent).toBe("ok");
  });

  it("renders headings, paragraphs, emphasis, inline code and quotes", () => {
    const { container } = render(
      <Markdown text={"# Title\n\n## Sub\n\nSome *italic* and **bold** with `code`.\n\n> quoted"} />,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Title" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Sub" })).toBeTruthy();
    expect(container.querySelector("em")?.textContent).toBe("italic");
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("p code")?.textContent).toBe("code");
    expect(container.querySelector("blockquote")?.textContent).toBe("quoted");
  });

  it("renders unordered, ordered and nested lists", () => {
    const { container } = render(<Markdown text={"- one\n- two\n  - nested\n- three\n\n1. a\n2. b"} />);
    const uls = container.querySelectorAll("ul");
    expect(uls).toHaveLength(2);
    expect(uls[0]!.querySelectorAll(":scope > li")).toHaveLength(3);
    expect(container.querySelectorAll("ol > li")).toHaveLength(2);
  });

  it("shows links as text with a copy action and never an anchor", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { container } = render(<Markdown text="See [the docs](https://example.com/x)." />);
    expect(container.querySelector("a")).toBeNull();
    expect(screen.getByText("the docs")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Copy link https:\/\/example.com\/x/ }));
    expect(writeText).toHaveBeenCalledWith("https://example.com/x");
  });

  describe("fenced code", () => {
    const writeText = vi.fn();
    beforeEach(() => {
      writeText.mockReset().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    });

    it("shows the language and copies the raw code", async () => {
      const user = userEvent.setup();
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      render(<Markdown text={"Intro\n\n```ts\nconst a = 1 < 2;\n- not a list\n```\n\nAfter"} />);
      expect(screen.getByText("ts")).toBeTruthy();
      await user.click(screen.getByRole("button", { name: /Copy/ }));
      expect(writeText).toHaveBeenCalledWith("const a = 1 < 2;\n- not a list");
      expect(screen.getByText("After")).toBeTruthy();
    });

    it("renders an unterminated fence while streaming", () => {
      const { container } = render(<Markdown text={"```py\nprint(1)"} />);
      expect(container.querySelector("pre")?.textContent).toBe("print(1)");
    });
  });
});
