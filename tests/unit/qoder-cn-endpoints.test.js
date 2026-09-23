import { describe, it, expect } from "vitest";

const loadConsts = () => import("../../open-sse/shared/qoder/constants.js");
const loadProviders = () => import("../../open-sse/providers/index.js");

/**
 * qoderclicn (China) uses a completely separate domain family from the
 * international qoder (.sh):
 *   gateway.qoder.com.cn  - inference (chat) + model list + token refresh
 *   openapi.qoder.com.cn  - device flow + userinfo + quota + PAT exchange
 *
 * Verified live: PAT exchange, userinfo, quota and a real chat request all
 * return 200 on the CN hosts, and the shared COSY signing implementation works
 * unchanged against the CN gateway.
 *
 * Aligned with upstream v0.5.86: open-sse/shared/qoder/constants.js dropped the
 * flat QODER_CN_* exports for a per-region base table (QODER_REGION_BASES) plus
 * qoder*Url(region) helpers, and isQoderCn() became qoderRegionOf(providerId)
 * (see "refactor(open-sse): registry consolidation" + the region split in the
 * file header). Same intent as before, new shape.
 */
describe("qoder-cn endpoints", () => {
  it("defines the CN gateway and openapi bases", async () => {
    const { qoderRegionBases, QODER_REGION_CN, QODER_REGION_INTL } = await loadConsts();
    const cn = qoderRegionBases(QODER_REGION_CN);
    expect(cn.chat).toBe("https://gateway.qoder.com.cn");
    expect(cn.openApi).toBe("https://openapi.qoder.com.cn");
    // CN has no api2-style host split: chat / chatAlt / center are one gateway.
    expect(cn.chatAlt).toBe(cn.chat);
    expect(cn.center).toBe(cn.chat);
    expect(cn.website).toBe("https://qoder.com.cn");
    // Unknown regions must not leak CN hosts (falls back to intl).
    expect(qoderRegionBases("nope").chat).toBe(
      qoderRegionBases(QODER_REGION_INTL).chat
    );
  });

  it("derives the CN exchange, userinfo, quota and model URLs", async () => {
    const c = await loadConsts();
    const CN = c.QODER_REGION_CN;
    expect(c.qoderJobTokenExchangeUrl(CN)).toBe(
      "https://openapi.qoder.com.cn/api/v1/jobToken/exchange"
    );
    expect(c.qoderUserInfoUrl(CN)).toBe("https://openapi.qoder.com.cn/api/v1/userinfo");
    expect(c.qoderQuotaUsageUrl(CN)).toBe(
      "https://openapi.qoder.com.cn/api/v2/quota/usage"
    );
    expect(c.qoderDeviceTokenUrl(CN)).toBe(
      "https://openapi.qoder.com.cn/api/v1/deviceToken/poll"
    );
    expect(c.qoderModelListUrl(CN)).toBe(
      "https://gateway.qoder.com.cn/algo/api/v2/model/list"
    );
    expect(c.qoderRefreshTokenUrl(CN)).toBe(
      "https://gateway.qoder.com.cn/algo/api/v3/user/refresh_token"
    );
    // intl keeps working through the legacy named constants (backward compat).
    expect(c.QODER_JOB_TOKEN_EXCHANGE_URL).toBe(
      "https://openapi.qoder.sh/api/v1/jobToken/exchange"
    );
  });

  it("routes inference to the CN gateway for qoder-cn", async () => {
    const { qoderInferenceBase, qoderRegionOf, QODER_REGION_CN, QODER_REGION_INTL } =
      await loadConsts();
    // Region is derived from the provider id (was isQoderCn).
    expect(qoderRegionOf("qoder-cn")).toBe(QODER_REGION_CN);
    expect(qoderRegionOf("qoder")).toBe(QODER_REGION_INTL);
    expect(qoderRegionOf(undefined)).toBe(QODER_REGION_INTL);
    expect(qoderInferenceBase({}, qoderRegionOf("qoder-cn"))).toBe(
      "https://gateway.qoder.com.cn"
    );
    // CN serves every token kind from the single gateway host — no jt- detour.
    expect(qoderInferenceBase({ accessToken: "jt-abc" }, QODER_REGION_CN)).toBe(
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
    // Models now live in providers/registry/qoder-cn.js and PROVIDER_MODELS is
    // keyed by the registry alias ("qdcn"), see providers/index.js.
    const ids = (PROVIDER_MODELS.qdcn || []).map((m) => m.id);
    expect(ids).toContain("qfmodel");
    expect(ids).toContain("ultimate");
  });

  it("resolves the qoder-cn executor", async () => {
    const { getExecutor } = await import("../../open-sse/executors/index.js");
    const ex = getExecutor("qoder-cn");
    expect(ex).toBeTruthy();
    expect(ex.provider).toBe("qoder-cn");
  });
});
