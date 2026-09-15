import { describe, it, expect } from "vitest";

describe("agnes registry entry", () => {
  it("registers agnes with an accessOnly oauth block", async () => {
    const { PROVIDER_OAUTH } = await import("../../open-sse/providers/index.js");
    expect(PROVIDER_OAUTH.agnes?.accessOnly).toBe(true);
  });

  it("exposes an openai-compatible transport baseUrl", async () => {
    const { PROVIDERS } = await import("../../open-sse/providers/index.js");
    expect(PROVIDERS.agnes?.baseUrl).toContain("api-agnes-code.agnes-ai.com");
    expect(PROVIDERS.agnes?.format).toBe("openai");
  });

  it("seeds at least 7 models", async () => {
    const { PROVIDER_MODELS } = await import("../../open-sse/providers/index.js");
    expect(PROVIDER_MODELS.agnes?.length).toBeGreaterThanOrEqual(7);
  });
});
