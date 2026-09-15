import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Forward-path coverage for Agnes: what an actual model call sends upstream.
 *
 * Earlier tests only proved the negative (a bad token is rejected). These pin
 * the positive: a stored connection produces a request to Agnes' OpenAI
 * endpoint carrying the Bearer credential.
 *
 * proxyFetch captures globalThis.fetch at import time, so mocking the global
 * after import has no effect — mock the module instead.
 */

const calls = [];

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
      json: async () => ({ choices: [{ message: { content: "ok" } }] }),
      body: null,
    };
  },
}));

const loadProviders = () => import("../../open-sse/providers/index.js");
const loadExecutor = () => import("../../open-sse/executors/default.js");

describe("agnes request path", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("resolves the DefaultExecutor (no custom executor needed)", async () => {
    const { getExecutor } = await import("../../open-sse/executors/index.js");
    const ex = getExecutor("agnes");
    expect(ex).toBeTruthy();
    // OpenAI-compatible upstreams are handled by DefaultExecutor.
    expect(ex.constructor.name).toBe("DefaultExecutor");
  });

  it("sends the request to Agnes with a Bearer token", async () => {
    const { PROVIDERS } = await loadProviders();
    const { DefaultExecutor } = await loadExecutor();

    expect(PROVIDERS.agnes.baseUrl).toBe(
      "https://api-agnes-code.agnes-ai.com/v1/chat/completions"
    );

    const ex = new DefaultExecutor("agnes", PROVIDERS.agnes);
    const credentials = { accessToken: "TOKEN-123", authType: "oauth", provider: "agnes" };

    try {
      await ex.execute({
        model: "agnes-3.0-flash",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: false,
        credentials,
        log: null,
      });
    } catch {
      // The stub response is minimal; parsing may still throw. We assert on the
      // outgoing request, which is what this test is about.
    }

    expect(calls.length).toBeGreaterThan(0);
    const { url, opts } = calls[0];
    expect(url).toContain("api-agnes-code.agnes-ai.com");
    const headers = opts?.headers || {};
    const auth = headers.Authorization || headers.authorization;
    expect(auth).toBe("Bearer TOKEN-123");
  });

  it("formats the upstream payload as OpenAI chat completions", async () => {
    const { PROVIDERS } = await loadProviders();
    const { DefaultExecutor } = await loadExecutor();

    const ex = new DefaultExecutor("agnes", PROVIDERS.agnes);
    try {
      await ex.execute({
        model: "agnes-3.0-flash",
        body: { messages: [{ role: "user", content: "hello" }] },
        stream: false,
        credentials: { accessToken: "T", provider: "agnes" },
        log: null,
      });
    } catch { /* see above */ }

    expect(calls.length).toBeGreaterThan(0);
    const sent = typeof calls[0].opts.body === "string"
      ? JSON.parse(calls[0].opts.body)
      : calls[0].opts.body;
    // OpenAI shape: model + messages, not a provider-specific envelope.
    expect(sent).toHaveProperty("messages");
    expect(Array.isArray(sent.messages)).toBe(true);
  });
});
