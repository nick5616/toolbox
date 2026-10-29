import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

// findBy*/waitFor default to 1 s; lazy-loaded views can take longer under a full parallel run.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  cleanup();
});
