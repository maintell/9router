import { describe, it, expect } from "vitest";

const load = () => import("../../open-sse/executors/opencode.js");

/**
 * The free endpoint accepts credentials: a non-free model reports
 * 401 "Missing API key" while free models report 403 FreeTierError — i.e. the
 * tier check happens before auth. Sending a real key may not lift the free-tier
 * block, but the executor must still be able to carry one instead of hardcoding
 * "Bearer public", which makes any authenticated use impossible.
 */
describe("OpenCodeExecutor.buildHeaders credentials", () => {
  it("uses the configured apiKey when present", async () => {
    const { OpenCodeExecutor } = await load();
    const ex = new OpenCodeExecutor("opencode");
    const headers = ex.buildHeaders({ apiKey: "sk-real-key" }, false);
    expect(headers.Authorization).toBe("Bearer sk-real-key");
  });

  it("falls back to the public token when no key is configured", async () => {
    const { OpenCodeExecutor } = await load();
    const ex = new OpenCodeExecutor("opencode");
    expect(ex.buildHeaders({}, false).Authorization).toBe("Bearer public");
    expect(ex.buildHeaders(undefined, false).Authorization).toBe("Bearer public");
  });

  it("prefers an OAuth access token over the fallback", async () => {
    const { OpenCodeExecutor } = await load();
    const ex = new OpenCodeExecutor("opencode");
    const headers = ex.buildHeaders({ accessToken: "tok-123" }, false);
    expect(headers.Authorization).toBe("Bearer tok-123");
  });

  it("sends the official User-Agent and opencode identity headers", async () => {
    const { OpenCodeExecutor } = await load();
    const ex = new OpenCodeExecutor("opencode");
    const headers = ex.buildHeaders({ apiKey: "k" }, false);

    // Extracted from the OpenCode desktop bundle:
    //   USER_AGENT2 = `opencode/${InstallationVersion}`, version "1.18.31"
    expect(headers["User-Agent"]).toBe("opencode/1.18.31");
    expect(headers["x-opencode-client"]).toBeTruthy();
    expect(headers["x-opencode-session"]).toBeTruthy();
    expect(headers["x-opencode-request"]).toBeTruthy();
  });

  it("forwards a downstream x-opencode-session when present", async () => {
    const { OpenCodeExecutor } = await load();
    const ex = new OpenCodeExecutor("opencode");
    const headers = ex.buildHeaders(
      { apiKey: "k", rawHeaders: { "x-opencode-session": "ses_downstream" } },
      false
    );
    expect(headers["x-opencode-session"]).toBe("ses_downstream");
  });

  it("keeps Accept in sync with the stream flag", async () => {
    const { OpenCodeExecutor } = await load();
    const ex = new OpenCodeExecutor("opencode");
    expect(ex.buildHeaders({ apiKey: "k" }, true).Accept).toBe("text/event-stream");
    expect(ex.buildHeaders({ apiKey: "k" }, false).Accept).toBe("*/*");
  });
});
