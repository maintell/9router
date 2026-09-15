export default {
  id: "agnes",
  alias: "agnes",
  category: "oauth",
  display: {
    name: "Agnes",
    icon: "auto_awesome",
    color: "#7C5CFF",
    textIcon: "AG",
    website: "https://agnes-ai.com",
    notice: { signupUrl: "https://agnes-ai.com" },
  },
  transport: {
    baseUrl: "https://api-agnes-code.agnes-ai.com/v1/chat/completions",
    format: "openai",
  },
  oauth: {
    // Agnes issues only an access_token (24h); it is renewed by presenting it.
    accessOnly: true,
    clientId: "agnes-code",
    authorizeUrl: "https://app.agnes-ai.com/login",
    exchangeUrl: "https://api-agnes-code.agnes-ai.com/api/v1/code/auth/exchange-code",
    refreshUrl: "https://api-agnes-code.agnes-ai.com/api/v1/user/refresh-token",
    callbackPath: "/auth/callback",
    refreshLeadMs: 3600000,
  },
  modelsFetcher: {
    url: "https://api-agnes-code.agnes-ai.com/v1/models",
    type: "openai",
  },
  models: [
    { id: "agnes-3.0-flash", name: "Agnes 3.0 Flash" },
    { id: "agnes-2.5-flash", name: "Agnes 2.5 Flash" },
    { id: "agnes-2.5-pro", name: "Agnes 2.5 Pro" },
    { id: "gpt-5.5", name: "GPT-5.5" },
    { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
    { id: "glm-5.2", name: "GLM 5.2" },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    { id: "gemini-3.5-flash", name: "Gemini 3.5 Flash" },
  ],
};
