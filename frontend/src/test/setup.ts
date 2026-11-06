import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";
import { useFileInputsStore } from "../tools/_kit/fileInputsStore";

// findBy*/waitFor default to 1 s; lazy-loaded views can take longer under a full parallel run.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  cleanup();
  // File-tool input lists live in a module-level store; don't leak them between tests.
  useFileInputsStore.getState().reset();
});

// Disabled buttons use aria-disabled (so they stay hoverable and explain themselves); let
// `button.disabled` in tests report that state as well as the native attribute.
{
  const native = Object.getOwnPropertyDescriptor(HTMLButtonElement.prototype, "disabled");
  if (native?.get && native.set) {
    const get = native.get;
    Object.defineProperty(HTMLButtonElement.prototype, "disabled", {
      configurable: true,
      get(this: HTMLButtonElement) {
        return get.call(this) || this.getAttribute("aria-disabled") === "true";
      },
      set: native.set,
    });
  }
}
