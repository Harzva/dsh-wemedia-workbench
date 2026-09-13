import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("quality fixtures", () => {
  it("are sanitized and contain no machine-private paths or credential assignments", async () => {
    const directory = resolve(import.meta.dirname, "quality");
    const contents = await Promise.all(["clean-content.json", "clean-content.md"].map((name) => readFile(resolve(directory, name), "utf8")));
    for (const content of contents) {
      expect(content).not.toMatch(/(?:\/Users\/|\/Volumes\/|[A-Za-z]:\\Users\\)/u);
      expect(content).not.toMatch(/\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+/iu);
    }
  });
});
