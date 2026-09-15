import { describe, it, expect } from "vitest";

const load = () => import("../../open-sse/services/tokenRefresh.js");

describe("isAccessOnly", () => {
  it("is true only for providers flagged accessOnly", async () => {
    const { isAccessOnly } = await load();
    expect(isAccessOnly("agnes")).toBe(true);
  });

  it("is false for existing oauth providers", async () => {
    const { isAccessOnly } = await load();
    for (const p of ["claude", "codex", "iflow", "kiro", "gemini-cli"]) {
      expect(isAccessOnly(p)).toBe(false);
    }
  });

  it("is false for unknown providers", async () => {
    const { isAccessOnly } = await load();
    expect(isAccessOnly("totally-unknown")).toBe(false);
  });
});
