export default {
  id: "opencode",
  priority: 40,
  hasFree: true,
  alias: "oc",
  uiAlias: "oc",
  display: {
    name: "OpenCode Free",
    icon: "terminal",
    color: "#E87040",
    textIcon: "OC",
    notice: {
      // Without a key the upstream sees the public sentinel and answers 403
      // "free tier can only be used from within OpenCode" before authenticating.
      // A real key is authenticated normally, so the fix is to configure one.
      text: "Configure an OpenCode Zen (or Go) API key — without one the free endpoint rejects requests with \"free tier can only be used from within OpenCode\". Get a key at opencode.ai/zen.",
      apiKeyUrl: "https://opencode.ai/zen",
    },
  },
  category: "free",
  noAuth: true,
  transport: {
    baseUrl: "https://opencode.ai",
    headers: {
      "x-opencode-client": "desktop",
    },
    noAuth: true,
  },
  models: [
    // Muse Spark models are served by /zen/v1/responses; the rest stay on
    // /chat/completions, so the format is declared per-model, not per-provider.
    { id: "muse-spark-1.2-contributor-free", name: "Muse Spark 1.2 Contributor Free", targetFormat: "openai-responses" },
    { id: "muse-spark-1.3-contributor-free", name: "Muse Spark 1.3 Contributor Free", targetFormat: "openai-responses" },
  ],
  modelsFetcher: { url: "https://opencode.ai/zen/v1/models", type: "opencode-free" },
  passthroughModels: true,
};
