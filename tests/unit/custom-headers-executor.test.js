import { describe, it, expect, vi, beforeEach } from "vitest";

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

const loadHeaders = () => import("../../open-sse/config/customHeaders.js");
const loadExecutor = () => import("../../open-sse/executors/default.js");

describe("custom headers reach the upstream request", () => {
  beforeEach(() => { calls.length = 0; });

  it("sends a static custom header", async () => {
    const { __setRulesForTest } = await loadHeaders();
    __setRulesForTest({ openai: [{ name: "X-Client", mode: "static", value: "9router" }] });
    const { DefaultExecutor } = await loadExecutor();

    const ex = new DefaultExecutor("openai");
    try {
      await ex.execute({
        model: "gpt-4",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: false,
        credentials: { apiKey: "k", provider: "openai" },
        log: null,
      });
    } catch { /* stub response may not parse; the request is what matters */ }

    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].opts.headers["X-Client"]).toBe("9router");
  });

  it("sends a random header of the configured length", async () => {
    const { __setRulesForTest } = await loadHeaders();
    __setRulesForTest({ openai: [{ name: "X-Session", mode: "random", length: 20 }] });
    const { DefaultExecutor } = await loadExecutor();

    const ex = new DefaultExecutor("openai");
    try {
      await ex.execute({
        model: "gpt-4",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: false,
        credentials: { apiKey: "k", provider: "openai" },
        log: null,
      });
    } catch { /* see above */ }

    expect(calls[0].opts.headers["X-Session"]).toMatch(/^[a-z0-9]{20}$/);
  });

  it("replaces the built-in Authorization without duplicating it", async () => {
    const { __setRulesForTest } = await loadHeaders();
    __setRulesForTest({
      openai: [{ name: "authorization", mode: "static", value: "Bearer custom" }],
    });
    const { DefaultExecutor } = await loadExecutor();

    const ex = new DefaultExecutor("openai");
    try {
      await ex.execute({
        model: "gpt-4",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: false,
        credentials: { apiKey: "real-key", provider: "openai" },
        log: null,
      });
    } catch { /* see above */ }

    const headers = calls[0].opts.headers;
    const authKeys = Object.keys(headers).filter((k) => k.toLowerCase() === "authorization");
    expect(authKeys).toHaveLength(1);
    expect(headers[authKeys[0]]).toBe("Bearer custom");
  });

  it("applies rules to an executor that overrides buildHeaders without calling super", async () => {
    // Regression guard: the hook lives in base.execute() after the
    // this.buildHeaders() call, precisely because subclasses override
    // buildHeaders and never call super. A hook at the end of the base
    // buildHeaders would silently miss every one of them.
    const { __setRulesForTest } = await loadHeaders();
    const { BaseExecutor } = await import("../../open-sse/executors/base.js");

    class OverridingExecutor extends BaseExecutor {
      constructor() {
        // config is required: getBaseUrls() reads this.config.baseUrls.
        super("openai", { baseUrl: "https://example.test/v1/chat/completions" });
      }
      buildHeaders() {
        // Deliberately does NOT call super.
        return { Authorization: "Bearer own", "X-Own": "1" };
      }
    }

    __setRulesForTest({ openai: [{ name: "X-Client", mode: "static", value: "9router" }] });
    const ex = new OverridingExecutor();
    try {
      await ex.execute({
        model: "gpt-4",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: false,
        credentials: { apiKey: "k", provider: "openai" },
        log: null,
      });
    } catch { /* stub response may not parse */ }

    expect(calls.length).toBeGreaterThan(0);
    const headers = calls[0].opts.headers;
    expect(headers["X-Client"]).toBe("9router");
    // The subclass's own headers survive.
    expect(headers["X-Own"]).toBe("1");
    expect(headers.Authorization).toBe("Bearer own");
  });

  it("applies no custom headers for a provider without rules", async () => {
    const { __setRulesForTest } = await loadHeaders();
    __setRulesForTest({ openai: [{ name: "X-Client", mode: "static", value: "v" }] });
    const { DefaultExecutor } = await loadExecutor();

    const ex = new DefaultExecutor("agnes");
    try {
      await ex.execute({
        model: "agnes-3.0-flash",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: false,
        credentials: { accessToken: "t", provider: "agnes" },
        log: null,
      });
    } catch { /* see above */ }

    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].opts.headers["X-Client"]).toBeUndefined();
    expect(calls[0].opts.headers.Authorization).toBe("Bearer t");
  });
});
