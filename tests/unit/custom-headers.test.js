import { describe, it, expect } from "vitest";

const load = () => import("../../open-sse/config/customHeaders.js");

describe("randomAlphaNum", () => {
  it("produces a string of the requested length", async () => {
    const { randomAlphaNum } = await load();
    expect(randomAlphaNum(16)).toHaveLength(16);
    expect(randomAlphaNum(1)).toHaveLength(1);
  });

  it("only uses a-z0-9", async () => {
    const { randomAlphaNum } = await load();
    for (let i = 0; i < 20; i++) {
      expect(randomAlphaNum(32)).toMatch(/^[a-z0-9]+$/);
    }
  });

  it("differs between calls (per-request regeneration)", async () => {
    const { randomAlphaNum } = await load();
    const values = new Set(Array.from({ length: 50 }, () => randomAlphaNum(16)));
    expect(values.size).toBeGreaterThan(1);
  });
});

describe("setHeaderCaseInsensitive", () => {
  it("replaces an existing header of the same name", async () => {
    const { setHeaderCaseInsensitive } = await load();
    const headers = { Authorization: "Bearer real", "Content-Type": "application/json" };
    setHeaderCaseInsensitive(headers, "Authorization", "custom");
    expect(headers.Authorization).toBe("custom");
    expect(Object.keys(headers)).toHaveLength(2);
  });

  it("replaces regardless of case and leaves exactly one entry", async () => {
    const { setHeaderCaseInsensitive } = await load();
    const headers = { "X-Trace": "old" };
    setHeaderCaseInsensitive(headers, "x-trace", "new");
    expect(Object.keys(headers)).toHaveLength(1);
    expect(Object.keys(headers)[0]).toBe("x-trace"); // configured casing kept
    expect(Object.values(headers)[0]).toBe("new");
  });

  it("adds the header when it is not present", async () => {
    const { setHeaderCaseInsensitive } = await load();
    const headers = {};
    setHeaderCaseInsensitive(headers, "X-New", "v");
    expect(headers["X-New"]).toBe("v");
  });
});

describe("normalizeRules", () => {
  it("keeps valid static and random rules", async () => {
    const { normalizeRules } = await load();
    const rules = normalizeRules({
      openai: [
        { name: "X-Client", mode: "static", value: "9router" },
        { name: "X-Session", mode: "random", length: 16 },
      ],
    });
    expect(rules.openai).toHaveLength(2);
  });

  // Providers whose rules are all invalid get no entry at all, so applyCustomHeaders
  // can skip them without allocating. Assert on `?? []`.
  it("drops rules with an unknown mode", async () => {
    const { normalizeRules } = await load();
    const rules = normalizeRules({ p: [{ name: "X", mode: "nope" }] });
    expect(rules.p ?? []).toHaveLength(0);
  });

  it("drops static rules without a value and random rules without a length", async () => {
    const { normalizeRules } = await load();
    const rules = normalizeRules({
      p: [
        { name: "A", mode: "static" },
        { name: "B", mode: "random" },
      ],
    });
    expect(rules.p ?? []).toHaveLength(0);
  });

  it("drops rules with an empty name", async () => {
    const { normalizeRules } = await load();
    const rules = normalizeRules({ p: [{ name: "  ", mode: "static", value: "v" }] });
    expect(rules.p ?? []).toHaveLength(0);
  });

  it("clamps a random length to 1..256", async () => {
    const { normalizeRules } = await load();
    const rules = normalizeRules({ p: [{ name: "X", mode: "random", length: 9999 }] });
    expect(rules.p[0].length).toBe(256);
  });

  it("returns an empty map for non-object input", async () => {
    const { normalizeRules } = await load();
    expect(normalizeRules(null)).toEqual({});
    expect(normalizeRules("x")).toEqual({});
  });
});

describe("SENSITIVE_HEADER_NAMES", () => {
  it("includes the auth and content headers", async () => {
    const { SENSITIVE_HEADER_NAMES } = await load();
    for (const n of ["authorization", "content-type", "accept", "x-api-key"]) {
      expect(SENSITIVE_HEADER_NAMES).toContain(n);
    }
  });

  it("is lowercase so comparisons can be lowercase-first", async () => {
    const { SENSITIVE_HEADER_NAMES } = await load();
    for (const n of SENSITIVE_HEADER_NAMES) expect(n).toBe(n.toLowerCase());
  });
});
