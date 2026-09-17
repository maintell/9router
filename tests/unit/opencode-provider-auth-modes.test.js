import { describe, it, expect } from "vitest";

/**
 * OpenCode is a noAuth provider, and the provider page used to swap the whole
 * Connections card for a static "no auth needed" card whenever noAuth was set —
 * leaving no way to enter an API key even though the executor supports one.
 *
 * The page now keeps the Connections card when the provider also declares
 * "apikey" as an auth mode, so the registry must declare it. If someone drops
 * authModes (or the notice that tells users where to get a key), the field
 * silently disappears again — hence these assertions.
 */
describe("opencode provider auth modes", () => {
  it("declares apikey as a supported auth mode", async () => {
    const { FREE_PROVIDERS } = await import("../../src/shared/constants/providers.js");
    const entry = FREE_PROVIDERS.opencode;
    expect(entry).toBeTruthy();
    expect(entry.authModes).toContain("apikey");
  });

  it("is still marked noAuth so it works without credentials", async () => {
    const { FREE_PROVIDERS } = await import("../../src/shared/constants/providers.js");
    expect(FREE_PROVIDERS.opencode.noAuth).toBe(true);
  });

  it("points users at where to get a key", async () => {
    const registry = await import("../../open-sse/providers/registry/opencode.js");
    const notice = registry.default?.display?.notice;
    expect(notice?.apiKeyUrl).toMatch(/opencode\.ai/);
    // The notice must explain the symptom users actually hit.
    expect(notice?.text).toMatch(/free tier|API key/i);
  });
});
