import { describe, expect, it } from "vitest";
import { PROVIDER_MODELS, getModelSupportedFormats, getModelTargetFormat } from "../../open-sse/config/providerModels.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { resolveTransport } from "../../open-sse/services/provider.js";

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
    // Context/output limits live in capabilities PROVIDER_CAPABILITIES
    // (single source), not the registry.
    const { getCapabilitiesForModel } = await import("../../open-sse/providers/capabilities.js");
    expect(getCapabilitiesForModel("opencode-go", "qwen3.8-flash").contextWindow).toBe(1000000);
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

// Chat-only models (no /messages, no /responses support on opencode-go).
// New additions since the original list: kimi-k2.5, glm-5, mimo-v2-pro,
// mimo-v2-omni, hy3-preview (all verified openai-only by family or probe).
const CHAT_ONLY = ["glm-5.3", "glm-5.2", "glm-5.1", "glm-5", "kimi-k2.7-code", "kimi-k2.6", "kimi-k3",
  "kimi-k2.5", "deepseek-flash", "longcat-2.0", "mimo-v2.5", "mimo-v2.5-pro", "mimo-v2-pro",
  "mimo-v2-omni", "hy4-preview", "hy3", "hy3-preview"];
// Models that also expose the Anthropic /messages endpoint.
const CLAUDE_CAPABLE = ["minimax-m3", "minimax-m2.7", "minimax-m2.5",
  "qwen3.8-max", "qwen3.8-flash", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-plus", "qwen3.5-plus"];
// Models that also expose the OpenAI /responses endpoint.
const RESPONSES_CAPABLE = ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v4.1-flash"];
describe("OpenCode Go thinking-suffix model lookup", () => {
  it("preserves Responses routing for gpt-5.6-luna thinking variants", () => {
    expect(getModelSupportedFormats("opencode-go", "gpt-5.6-luna(high)")).toEqual(["openai-responses"]);
    expect(getModelTargetFormat("opencode-go", "gpt-5.6-luna(high)")).toBe("openai-responses");
  });

  it("preserves Responses routing for grok-4.6 thinking variants", () => {
    expect(getModelSupportedFormats("opencode-go", "grok-4.6(high)")).toEqual(["openai-responses"]);
    expect(getModelTargetFormat("opencode-go", "grok-4.6(high)")).toBe("openai-responses");
  });
});

describe("OpenCode Go per-model supportedFormats", () => {
  it("declares [openai, claude] for MiniMax + Qwen models", async () => {
    const { getModelSupportedFormats } = await import("../../open-sse/config/providerModels.js");
    for (const m of CLAUDE_CAPABLE) {
      expect(getModelSupportedFormats("opencode-go", m)).toEqual(["openai", "claude"]);
    }
  });

  it("declares [openai, claude, openai-responses] for DeepSeek models", async () => {
    const { getModelSupportedFormats } = await import("../../open-sse/config/providerModels.js");
    for (const m of RESPONSES_CAPABLE) {
      expect(getModelSupportedFormats("opencode-go", m)).toEqual(["openai", "claude", "openai-responses"]);
    }
  });

  it("declares [openai] only for chat-only models — guards /messages routing", async () => {
    const { getModelSupportedFormats } = await import("../../open-sse/config/providerModels.js");
    for (const m of CHAT_ONLY) {
      expect(getModelSupportedFormats("opencode-go", m)).toEqual(["openai"]);
    }
  });

  it("declares [openai, openai-responses] for grok-4.5 and omen-alpha", async () => {
    const { getModelSupportedFormats } = await import("../../open-sse/config/providerModels.js");
    for (const m of ["grok-4.5", "omen-alpha"]) {
      expect(getModelSupportedFormats("opencode-go", m)).toEqual(["openai", "openai-responses"]);
    }
  });
});

describe("OpenCode Go multi-endpoint transports", () => {
  it("declares openai / claude / openai-responses transports", async () => {
    const { PROVIDERS } = await load();
    const formats = (PROVIDERS["opencode-go"].transports || []).map((t) => t.format);
    expect(formats).toEqual(["openai", "claude", "openai-responses"]);
  });

  it("resolveTransport picks the endpoint matching the client sourceFormat", async () => {
    const { resolveTransport } = await import("../../open-sse/services/provider.js");
    expect(resolveTransport("opencode-go", "claude").baseUrl).toBe("https://opencode.ai/zen/go/v1/messages");
    expect(resolveTransport("opencode-go", "openai-responses").baseUrl).toBe("https://opencode.ai/zen/go/v1/responses");
    expect(resolveTransport("opencode-go", "openai").baseUrl).toBe("https://opencode.ai/zen/go/v1/chat/completions");
  });

  it("uses x-api-key + anthropicVersion on the claude transport", async () => {
    const { resolveTransport } = await import("../../open-sse/services/provider.js");
    const t = resolveTransport("opencode-go", "claude");
    expect(t.auth.header).toBe("x-api-key");
    expect(t.auth.anthropicVersion).toBe(true);
  });
});

describe("OpenCode Go per-model transport guard (chatCore logic)", () => {
  // Mirror of chatCore's per-model transport guard: use the sourceFormat-matched
  // transport only when the model declares support for that sourceFormat.
  async function pickTransport(provider, sourceFormat, alias, model) {
    const { getModelSupportedFormats } = await import("../../open-sse/config/providerModels.js");
    const { resolveTransport } = await import("../../open-sse/services/provider.js");
    const supported = getModelSupportedFormats(alias, model);
    const rt = resolveTransport(provider, sourceFormat);
    return supported?.includes(sourceFormat) ? rt : null;
  }

  it("routes Qwen + claude-format client to /messages", async () => {
    for (const m of CLAUDE_CAPABLE) {
      expect((await pickTransport("opencode-go", "claude", "opencode-go", m))?.baseUrl).toBe("https://opencode.ai/zen/go/v1/messages");
    }
  });

  it("does NOT route chat-only models to /messages on a claude-format request", async () => {
    for (const m of CHAT_ONLY) {
      expect(await pickTransport("opencode-go", "claude", "opencode-go", m)).toBeNull();
    }
  });

  it("routes DeepSeek + responses-format client to /responses", async () => {
    for (const m of RESPONSES_CAPABLE) {
      expect((await pickTransport("opencode-go", "openai-responses", "opencode-go", m))?.baseUrl).toBe("https://opencode.ai/zen/go/v1/responses");
    }
  });

  it("routes Muse Spark (responses-only) to /responses, never to /messages", async () => {
    for (const m of ["muse-spark-1.2-contributor", "muse-spark-1.3-contributor", "grok-4.6", "gpt-5.6-luna"]) {
      const { getModelSupportedFormats } = await import("../../open-sse/config/providerModels.js");
      expect(getModelSupportedFormats("opencode-go", m)).toEqual(["openai-responses"]);
      expect((await pickTransport("opencode-go", "openai-responses", "opencode-go", m))?.baseUrl).toBe("https://opencode.ai/zen/go/v1/responses");
      expect(await pickTransport("opencode-go", "claude", "opencode-go", m)).toBeNull();
      expect(await pickTransport("opencode-go", "openai", "opencode-go", m)).toBeNull();
    }
  });

  it("does NOT route Qwen (no responses support) to /responses", async () => {
    for (const m of CLAUDE_CAPABLE) {
      expect(await pickTransport("opencode-go", "openai-responses", "opencode-go", m)).toBeNull();
    }
  });
});
