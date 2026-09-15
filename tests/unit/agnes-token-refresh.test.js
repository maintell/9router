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

// dedupRefresh caches by old token for 10s, so each case must use a distinct
// token or it will reuse the previous case's cached result.
describe("refreshAgnesToken", () => {
  it("returns the new access token on code 000000", async () => {
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ code: "000000", data: { access_token: "new-token", expires_in: 86400 } }),
    });
    const { refreshAgnesToken } = await import(
      "../../open-sse/services/tokenRefresh/providers/agnesToken.js"
    );
    const out = await refreshAgnesToken("old-token-ok", null);
    expect(out.accessToken).toBe("new-token");
    expect(out.expiresIn).toBe(86400);
  });

  it("throws when the server reports login expired (000501)", async () => {
    global.fetch = async () => ({
      ok: false,
      status: 401,
      json: async () => ({ code: "000501", message: "Login expired" }),
    });
    const { refreshAgnesToken } = await import(
      "../../open-sse/services/tokenRefresh/providers/agnesToken.js"
    );
    await expect(refreshAgnesToken("old-token-expired", null)).rejects.toThrow(/Login expired/);
  });

  it("returns null when there is no token to refresh", async () => {
    const { refreshAgnesToken } = await import(
      "../../open-sse/services/tokenRefresh/providers/agnesToken.js"
    );
    expect(await refreshAgnesToken(null, null)).toBeNull();
  });
});

