import { describe, it, expect } from "vitest";

const loadConsts = () => import("../../open-sse/shared/qoder/constants.js");
const loadProviders = () => import("../../open-sse/providers/index.js");

/**
 * qoderclicn (China) uses a completely separate domain family from the
 * international qoder (.sh):
 *   gateway.qoder.com.cn  - inference (chat) + model list
 *   openapi.qoder.com.cn  - device flow + userinfo + quota + PAT exchange
 *
 * Verified live: PAT exchange, userinfo, quota and a real chat request all
 * return 200 on the CN hosts, and the shared COSY signing implementation works
 * unchanged against the CN gateway.
 */
describe("qoder-cn endpoints", () => {
  it("defines the CN gateway and openapi bases", async () => {
    const c = await loadConsts();
    expect(c.QODER_CN_GATEWAY_BASE).toBe("https://gateway.qoder.com.cn");
    expect(c.QODER_CN_OPENAPI_BASE).toBe("https://openapi.qoder.com.cn");
  });

  it("derives the CN exchange, userinfo, quota and model URLs", async () => {
    const c = await loadConsts();
    expect(c.QODER_CN_JOB_TOKEN_EXCHANGE_URL).toBe(
      "https://openapi.qoder.com.cn/api/v1/jobToken/exchange"
    );
    expect(c.QODER_CN_USERINFO_URL).toBe("https://openapi.qoder.com.cn/api/v1/userinfo");
    expect(c.QODER_CN_QUOTA_USAGE_URL).toBe(
      "https://openapi.qoder.com.cn/api/v2/quota/usage"
    );
    expect(c.QODER_CN_MODEL_LIST_URL).toBe(
      "https://gateway.qoder.com.cn/algo/api/v2/model/list"
    );
  });

  it("routes inference to the CN gateway for qoder-cn", async () => {
    const { qoderInferenceBase, isQoderCn } = await loadConsts();
    expect(isQoderCn({ provider: "qoder-cn" })).toBe(true);
    expect(isQoderCn({ provider: "qoder" })).toBe(false);
    expect(isQoderCn({})).toBe(false);
    expect(qoderInferenceBase({ provider: "qoder-cn" })).toBe(
      "https://gateway.qoder.com.cn"
    );
  });

  it("keeps the international default unchanged", async () => {
    const { qoderInferenceBase } = await loadConsts();
    expect(qoderInferenceBase({})).toBe("https://api3.qoder.sh");
    expect(qoderInferenceBase({ provider: "qoder" })).toBe("https://api3.qoder.sh");
    // Job tokens still route to the international alternate host.
    expect(qoderInferenceBase({ accessToken: "jt-abc" })).toBe("https://api2.qoder.sh");
  });

  it("registers the qoder-cn provider with CN transport and models", async () => {
    const { PROVIDERS, PROVIDER_OAUTH, PROVIDER_MODELS } = await loadProviders();
    expect(PROVIDERS["qoder-cn"]?.baseUrl).toContain("gateway.qoder.com.cn");
    expect(PROVIDER_OAUTH["qoder-cn"]?.openApiBaseUrl).toBe(
      "https://openapi.qoder.com.cn"
    );
    const ids = (PROVIDER_MODELS.qdc || []).map((m) => m.id);
    expect(ids).toContain("qfmodel");
  });

  it("resolves the qoder-cn executor", async () => {
    const { getExecutor } = await import("../../open-sse/executors/index.js");
    const ex = getExecutor("qoder-cn");
    expect(ex).toBeTruthy();
    expect(ex.provider).toBe("qoder-cn");
  });
});
