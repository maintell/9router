import { describe, it, expect } from "vitest";

const load = () => import("../../src/lib/oauth/providers/agnes.js");

describe("agnes login adapter", () => {
  it("is registered as an authorization_code flow", async () => {
    const agnes = (await load()).default;
    expect(agnes.flowType).toBe("authorization_code");
  });

  it("reads its config from the registry (accessOnly set)", async () => {
    const agnes = (await load()).default;
    expect(agnes.config.accessOnly).toBe(true);
    expect(agnes.config.clientId).toBe("agnes-code");
  });

  it("builds a login URL with client, redirect_uri and state", async () => {
    const agnes = (await load()).default;
    const url = agnes.buildAuthUrl(
      agnes.config,
      "http://127.0.0.1:1455/auth/callback",
      "STATE123"
    );
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://app.agnes-ai.com/login");
    expect(parsed.searchParams.get("client")).toBe("agnes-code");
    expect(parsed.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:1455/auth/callback"
    );
    expect(parsed.searchParams.get("state")).toBe("STATE123");
  });

  it("exchanges a code over JSON and returns the access token", async () => {
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ code: "000000", data: { access_token: "tok", expires_in: 86400 } }),
    });
    const agnes = (await load()).default;
    const out = await agnes.exchangeToken(
      agnes.config,
      "CODE",
      "http://127.0.0.1:1455/auth/callback",
      null,
      "STATE123"
    );
    expect(out.accessToken).toBe("tok");
    expect(out.expiresIn).toBe(86400);
  });

  it("throws with the server message when the code is rejected", async () => {
    global.fetch = async () => ({
      ok: false,
      status: 401,
      json: async () => ({ code: "010006", message: "Authorization code is invalid" }),
    });
    const agnes = (await load()).default;
    await expect(
      agnes.exchangeToken(agnes.config, "BAD", "http://x/auth/callback", null, "S")
    ).rejects.toThrow(/Authorization code is invalid/);
  });
});
