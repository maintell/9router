import { describe, it, expect } from "vitest";

const load = () => import("../../open-sse/executors/opencode.js");

/**
 * OpenCode's free tier is gated server-side: the upstream rejects proxy calls
 * with HTTP 403 / type "FreeTierError" regardless of headers, network or model
 * (verified against every free model and two different egress IPs).
 *
 * We cannot make those models work, but we can stop showing the user a raw
 * upstream JSON blob and tell them what is actually going on.
 */

describe("OpenCodeExecutor.parseError", () => {
  it("translates the free-tier rejection into an actionable message", async () => {
    const { OpenCodeExecutor } = await load();
    const ex = new OpenCodeExecutor("opencode");
    const body = JSON.stringify({
      type: "error",
      error: {
        type: "FreeTierError",
        message: "Error from provider (Console): OpenCode's free tier can only be used from within OpenCode",
      },
    });

    const out = ex.parseError({ status: 403 }, body);
    expect(out.status).toBe(403);
    expect(out.message).toMatch(/OpenCode/i);
    // Must not just echo the upstream blob.
    expect(out.message).not.toBe(body);
    // Must be actionable rather than merely descriptive.
    expect(out.message).toMatch(/OpenCode Go|client|provid/i);
  });

  it("leaves unrelated errors to the base handling", async () => {
    const { OpenCodeExecutor } = await load();
    const ex = new OpenCodeExecutor("opencode");

    const plain = "upstream exploded";
    expect(ex.parseError({ status: 500 }, plain).message).toBe(plain);

    const json = JSON.stringify({ error: { message: "Model is unavailable" } });
    const out = ex.parseError({ status: 400 }, json);
    expect(out.status).toBe(400);
    expect(out.message).toMatch(/Model is unavailable/);
  });

  it("handles a missing or non-JSON body without throwing", async () => {
    const { OpenCodeExecutor } = await load();
    const ex = new OpenCodeExecutor("opencode");
    expect(() => ex.parseError({ status: 403 }, "")).not.toThrow();
    expect(() => ex.parseError({ status: 403 }, "<html>nope</html>")).not.toThrow();
    expect(ex.parseError({ status: 403 }, null).status).toBe(403);
  });
});
