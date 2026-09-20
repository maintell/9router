import { describe, it, expect } from "vitest";

const load = () => import("../../open-sse/providers/index.js");

/**
 * opencode-go registry must track the upstream model list
 * (https://opencode.ai/zen/go/v1/models). New models are added only after the
 * endpoint serving them is verified — a wrong supportedFormats entry silently
 * misroutes requests instead of failing loudly.
 *
 * Verified 2026-09-20: 37 models upstream. grok-4.5 / omen-alpha formats were
 * probed per endpoint: both reach auth on openai + responses, while grok-4.5 is
 * explicitly rejected on the claude one ("not supported for format anthropic").
 */
describe("opencode-go model registry", () => {
  it("includes qwen3.8-flash with dual formats and a 1M context", async () => {
    const { PROVIDER_MODELS } = await load();
    const m = (PROVIDER_MODELS["opencode-go"] || []).find((x) => x.id === "qwen3.8-flash");
    expect(m).toBeTruthy();
    // Per https://help.aliyun.com/zh/model-studio/qwen3-8-flash: OpenAI +
    // Anthropic compatible, 1M context.
    expect(m.supportedFormats).toEqual(expect.arrayContaining(["openai", "claude"]));
    expect(m.contextLength).toBe(1000000);
  });

  it("includes the previously missing upstream models", async () => {
    const { PROVIDER_MODELS } = await load();
    const ids = new Set((PROVIDER_MODELS["opencode-go"] || []).map((m) => m.id));
    for (const id of [
      "kimi-k2.5",
      "glm-5",
      "deepseek-flash",
      "deepseek-v4.1-flash",
      "qwen3.5-plus",
      "mimo-v2-pro",
      "mimo-v2-omni",
      "hy3-preview",
      "grok-4.5",
      "omen-alpha",
    ]) {
      expect(ids.has(id), `missing model: ${id}`).toBe(true);
    }
  });

  it("gives grok-4.5 and omen-alpha only the verified formats", async () => {
    const { PROVIDER_MODELS } = await load();
    const byId = Object.fromEntries(
      (PROVIDER_MODELS["opencode-go"] || []).map((m) => [m.id, m])
    );
    expect(byId["grok-4.5"].supportedFormats).toEqual(["openai", "openai-responses"]);
    expect(byId["omen-alpha"].supportedFormats).toEqual(["openai", "openai-responses"]);
  });

  it("keeps both deepseek flash ids (they are distinct upstream models)", async () => {
    const { PROVIDER_MODELS } = await load();
    const ids = new Set((PROVIDER_MODELS["opencode-go"] || []).map((m) => m.id));
    expect(ids.has("deepseek-flash")).toBe(true);
    expect(ids.has("deepseek-v4.1-flash")).toBe(true);
  });
});
