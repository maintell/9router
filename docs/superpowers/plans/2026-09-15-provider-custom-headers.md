# Provider Custom Request Headers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users configure extra upstream HTTP headers per provider, with static or per-request random values, replacing any existing header of the same name without ever emitting duplicates.

**Architecture:** Rules live in a new `customHeaders` field on the settings row, shaped `{ [providerId]: HeaderRule[] }`. A small module exposes a synchronous, TTL-cached read so header assembly stays synchronous. `BaseExecutor.buildHeaders()` applies the rules last, so configured values replace the built-in ones, via a case-insensitive setter that guarantees a single header.

**Tech Stack:** Plain JavaScript (ESM), Next.js 16, vitest 4 (`tests/` is an independent package).

## Global Constraints

- Plain JavaScript ESM — **no TypeScript**. `@/*` aliases to `src/*`.
- Config-driven and DRY: constants live in config modules, not inline.
- Tests in `tests/`; run from `tests/`: `npx vitest run <path>`. The suite is **not** all-green on a plain checkout — compare against the baseline, do not chase pre-existing failures.
- Commit style: Conventional Commits.
- After every task: push and run `/opt/9router/deploy.sh` on uat-ubuntu; all 13 checks must pass.
- **Never block a request because of a bad rule** — every failure mode is fail-open.

### Verified facts this plan relies on

- `open-sse/executors/base.js:46` `buildHeaders()` is the shared entry point.
  Specialised executors override it and delegate via `super.buildHeaders(...)`
  (`codex.js:213`, `grok-cli.js:363`, `iflow.js:43`, `kiro.js:235`), so editing
  the base covers them all.
- `base.js:130` calls `buildHeaders()` **inside** the retry/fallback loop, so a
  random value is regenerated per attempt — this is what makes "per request"
  true.
- Executors are module-level singletons created by `getExecutor(provider)` with
  no config argument (`open-sse/executors/index.js:67-71`), so `this.config` is
  `undefined` on the request path. Rules cannot ride on `this.config`.
- JavaScript object keys are **case-sensitive**: assigning `x-trace` when
  `X-Trace` exists yields two keys, i.e. two headers on the wire. HTTP header
  names are case-insensitive, so that is a real duplicate. Deduplication must
  therefore be case-insensitive.
- `/api/settings` GET returns the whole settings row (minus `password` and
  `oidcClientSecret`), and PATCH accepts partial updates — `customHeaders` needs
  no new endpoint.
- `saveProviderStrategy` in `src/app/(dashboard)/dashboard/providers/[id]/page.js:374`
  is the existing pattern for per-provider settings: GET, merge under
  `providerId`, PATCH. Follow it.

---

## File Structure

| File | Responsibility |
|---|---|
| `open-sse/config/customHeaders.js` | **Create.** Constants (chars, TTL, sensitive names), rule normalisation, random generation, case-insensitive set, TTL cache. |
| `open-sse/executors/base.js` | **Modify.** Apply the rules at the end of `buildHeaders()`. |
| `src/lib/db/repos/settingsRepo.js` | **Modify.** Add `customHeaders: {}` to `DEFAULT_SETTINGS`. |
| `src/app/(dashboard)/dashboard/providers/[id]/CustomHeadersSection.js` | **Create.** UI for managing this provider's rules. |
| `src/app/(dashboard)/dashboard/providers/[id]/page.js` | **Modify.** Render the section. |
| `tests/unit/custom-headers.test.js` | **Create.** Unit tests for the module. |
| `tests/unit/custom-headers-executor.test.js` | **Create.** Unit tests for executor integration. |

---

### Task 1: Rules module — normalisation, generation, dedup

**Files:**
- Create: `open-sse/config/customHeaders.js`
- Test: `tests/unit/custom-headers.test.js`

**Interfaces:**
- Produces: `SENSITIVE_HEADER_NAMES`, `RANDOM_CHARS`, `randomAlphaNum(length)`,
  `setHeaderCaseInsensitive(headers, name, value)`, `normalizeRules(raw)`.
  (`applyCustomHeaders` arrives in Task 2.)

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/custom-headers.test.js`:

```js
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

  it("drops rules with an unknown mode", async () => {
    const { normalizeRules } = await load();
    expect(normalizeRules({ p: [{ name: "X", mode: "nope" }] }).p).toHaveLength(0);
  });

  it("drops static rules without a value and random rules without a length", async () => {
    const { normalizeRules } = await load();
    const rules = normalizeRules({
      p: [
        { name: "A", mode: "static" },
        { name: "B", mode: "random" },
      ],
    });
    expect(rules.p).toHaveLength(0);
  });

  it("drops rules with an empty name", async () => {
    const { normalizeRules } = await load();
    expect(normalizeRules({ p: [{ name: "  ", mode: "static", value: "v" }] }).p).toHaveLength(0);
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd tests && npx vitest run unit/custom-headers.test.js -v`
Expected: FAIL — cannot resolve `open-sse/config/customHeaders.js`.

- [ ] **Step 3: Create `open-sse/config/customHeaders.js`**

```js
/**
 * Per-provider custom request headers.
 *
 * Rules are stored on the settings row as:
 *   customHeaders: { [providerId]: [{ name, mode, value?, length? }] }
 *
 * Two modes:
 *   static — value is sent verbatim
 *   random — a fresh alphanumeric string of `length` chars per request
 *
 * Any rule failure is fail-open: the rule is skipped and the request is still
 * sent. Header names are matched case-insensitively, because HTTP treats them
 * that way while JavaScript object keys do not.
 */

export const RANDOM_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
export const MIN_RANDOM_LENGTH = 1;
export const MAX_RANDOM_LENGTH = 256;
export const CACHE_TTL_MS = 5000;

// Overriding these replaces a value 9router would otherwise set, so the UI
// warns. Nothing is blocked — the user's value is still sent.
export const SENSITIVE_HEADER_NAMES = [
  "authorization",
  "content-type",
  "accept",
  "anthropic-version",
  "x-api-key",
  "api-key",
];

export function randomAlphaNum(length) {
  const n = Math.max(MIN_RANDOM_LENGTH, Math.min(MAX_RANDOM_LENGTH, Math.floor(length) || MIN_RANDOM_LENGTH));
  let out = "";
  for (let i = 0; i < n; i++) {
    out += RANDOM_CHARS[Math.floor(Math.random() * RANDOM_CHARS.length)];
  }
  return out;
}

/**
 * Write `name` onto `headers`, removing any existing key that differs only in
 * case so the request never carries two equivalent headers.
 */
export function setHeaderCaseInsensitive(headers, name, value) {
  const target = String(name).toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) delete headers[key];
  }
  headers[name] = value;
}

export function normalizeRules(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;

  for (const [providerId, list] of Object.entries(raw)) {
    if (!Array.isArray(list)) continue;
    const rules = [];

    for (const rule of list) {
      if (!rule || typeof rule !== "object") continue;
      const name = typeof rule.name === "string" ? rule.name.trim() : "";
      if (!name) continue;

      if (rule.mode === "static") {
        if (typeof rule.value === "string") rules.push({ name, mode: "static", value: rule.value });
      } else if (rule.mode === "random") {
        const length = Number(rule.length);
        if (Number.isFinite(length)) {
          rules.push({
            name,
            mode: "random",
            length: Math.max(MIN_RANDOM_LENGTH, Math.min(MAX_RANDOM_LENGTH, Math.floor(length))),
          });
        }
      }
    }

    if (rules.length) out[providerId] = rules;
  }
  return out;
}

// NOTE: no isSensitiveHeaderName() helper — the UI compares against
// SENSITIVE_HEADER_NAMES directly, and an export with no consumer is dead code.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd tests && npx vitest run unit/custom-headers.test.js -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add open-sse/config/customHeaders.js tests/unit/custom-headers.test.js
git commit -m "feat(headers): add custom header rules module (normalize, random, dedup)"
```

---

### Task 2: TTL cache — synchronous read of the settings

**Files:**
- Modify: `open-sse/config/customHeaders.js` (append cache + `applyCustomHeaders`)
- Modify: `src/lib/db/repos/settingsRepo.js:7` (`DEFAULT_SETTINGS`)
- Test: `tests/unit/custom-headers.test.js` (append)

**Interfaces:**
- Consumes: `getSettings()` from `src/lib/db/repos/settingsRepo.js`, lazily imported.
- Produces: `applyCustomHeaders(headers, provider)` — synchronous, mutates `headers`.

- [ ] **Step 1: Add `customHeaders` to the default settings**

In `src/lib/db/repos/settingsRepo.js`, add to `DEFAULT_SETTINGS` (next to
`providerStrategies: {},` on line 15):

```js
  customHeaders: {},
```

- [ ] **Step 2: Write the failing test**

Append to `tests/unit/custom-headers.test.js`:

```js
describe("applyCustomHeaders", () => {
  it("applies a static rule", async () => {
    const { applyCustomHeaders, __setRulesForTest } = await load();
    __setRulesForTest({ openai: [{ name: "X-Client", mode: "static", value: "9router" }] });
    const headers = {};
    applyCustomHeaders(headers, "openai");
    expect(headers["X-Client"]).toBe("9router");
  });

  it("applies a random rule of the configured length", async () => {
    const { applyCustomHeaders, __setRulesForTest } = await load();
    __setRulesForTest({ openai: [{ name: "X-Session", mode: "random", length: 12 }] });
    const headers = {};
    applyCustomHeaders(headers, "openai");
    expect(headers["X-Session"]).toMatch(/^[a-z0-9]{12}$/);
  });

  it("generates a new random value on each call", async () => {
    const { applyCustomHeaders, __setRulesForTest } = await load();
    __setRulesForTest({ p: [{ name: "X", mode: "random", length: 24 }] });
    const a = {}, b = {};
    applyCustomHeaders(a, "p");
    applyCustomHeaders(b, "p");
    expect(a.X).not.toBe(b.X);
  });

  it("ignores rules belonging to another provider", async () => {
    const { applyCustomHeaders, __setRulesForTest } = await load();
    __setRulesForTest({ openai: [{ name: "X-Client", mode: "static", value: "v" }] });
    const headers = {};
    applyCustomHeaders(headers, "agnes");
    expect(headers["X-Client"]).toBeUndefined();
  });

  it("leaves headers untouched when there are no rules", async () => {
    const { applyCustomHeaders, __setRulesForTest } = await load();
    __setRulesForTest({});
    const headers = { Authorization: "Bearer real" };
    applyCustomHeaders(headers, "openai");
    expect(headers).toEqual({ Authorization: "Bearer real" });
  });

  it("replaces an existing header without duplicating it", async () => {
    const { applyCustomHeaders, __setRulesForTest } = await load();
    __setRulesForTest({ p: [{ name: "x-trace", mode: "static", value: "new" }] });
    const headers = { "X-Trace": "old" };
    applyCustomHeaders(headers, "p");
    expect(Object.keys(headers)).toHaveLength(1);
    expect(headers["x-trace"]).toBe("new");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd tests && npx vitest run unit/custom-headers.test.js -v`
Expected: FAIL — `applyCustomHeaders` and `__setRulesForTest` are not functions.

- [ ] **Step 4: Append the cache and `applyCustomHeaders` to `open-sse/config/customHeaders.js`**

```js
// ───────────────────────────────────────────────────────────────────────────
// Settings-backed cache.
//
// buildHeaders() is synchronous but getSettings() is async, and executors are
// singletons created without a config argument, so rules cannot be threaded
// through this.config. Mirror getObservabilityConfig() in
// src/lib/db/repos/settingsRepo.js: a synchronous read over a short-lived
// cache, refreshed in the background.
// ───────────────────────────────────────────────────────────────────────────

let cache = { rules: {}, ts: 0 };
let refreshing = false;

function refreshCache() {
  if (refreshing) return;
  refreshing = true;
  // Lazy import keeps open-sse free of a load-time dependency on src/.
  import("../../src/lib/db/repos/settingsRepo.js")
    .then(({ getSettings }) => getSettings())
    .then((settings) => {
      cache = { rules: normalizeRules(settings?.customHeaders), ts: Date.now() };
    })
    .catch(() => {
      /* keep serving the previous value on failure */
    })
    .finally(() => {
      refreshing = false;
    });
}

export function applyCustomHeaders(headers, provider) {
  if (!headers || !provider) return headers;
  try {
    if (Date.now() - cache.ts > CACHE_TTL_MS) refreshCache();
    const rules = cache.rules[provider];
    if (!rules || !rules.length) return headers;

    for (const rule of rules) {
      if (rule.mode === "static") {
        setHeaderCaseInsensitive(headers, rule.name, rule.value);
      } else if (rule.mode === "random") {
        setHeaderCaseInsensitive(headers, rule.name, randomAlphaNum(rule.length));
      }
    }
  } catch {
    /* never break a request because of a header rule */
  }
  return headers;
}

// Test seam: inject rules directly instead of going through the settings store.
export function __setRulesForTest(rules) {
  cache = { rules: normalizeRules(rules), ts: Date.now() };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd tests && npx vitest run unit/custom-headers.test.js -v`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add open-sse/config/customHeaders.js src/lib/db/repos/settingsRepo.js tests/unit/custom-headers.test.js
git commit -m "feat(headers): read custom header rules from settings via a TTL cache"
```

---

### Task 3: Wire into `BaseExecutor.buildHeaders`

**Files:**
- Modify: `open-sse/executors/base.js:46-76`
- Test: `tests/unit/custom-headers-executor.test.js`

**Interfaces:**
- Consumes: `applyCustomHeaders(headers, provider)` (Task 2).
- Produces: nothing new; changes the headers every executor sends.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/custom-headers-executor.test.js`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd tests && npx vitest run unit/custom-headers-executor.test.js -v`
Expected: FAIL — `X-Client` is undefined (rules not yet applied).

- [ ] **Step 3: Modify `open-sse/executors/base.js`**

Add the import next to the other `open-sse/config` imports at the top:

```js
import { applyCustomHeaders } from "../config/customHeaders.js";
```

Then change the end of `buildHeaders()` from:

```js
    if (stream) {
      headers["Accept"] = "text/event-stream";
    }

    return headers;
```

to:

```js
    if (stream) {
      headers["Accept"] = "text/event-stream";
    }

    // Applied last so a configured rule replaces anything set above (including
    // Authorization). Specialised executors call super.buildHeaders(), so this
    // covers them too.
    applyCustomHeaders(headers, this.provider);

    return headers;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd tests && npx vitest run unit/custom-headers-executor.test.js -v`
Expected: all PASS.

- [ ] **Step 5: Verify no regression in the existing executor tests**

Run: `cd tests && npx vitest run unit/executor-const-guard.test.js unit/openai-to-claude.test.js unit/claude-header-forwarding.test.js`
Expected: identical to the pre-change results.

- [ ] **Step 6: Commit**

```bash
git add open-sse/executors/base.js tests/unit/custom-headers-executor.test.js
git commit -m "feat(headers): apply per-provider custom headers in BaseExecutor"
```

---

### Task 4: Provider settings UI

**Files:**
- Create: `src/app/(dashboard)/dashboard/providers/[id]/CustomHeadersSection.js`
- Modify: `src/app/(dashboard)/dashboard/providers/[id]/page.js`

**Interfaces:**
- Consumes: `SENSITIVE_HEADER_NAMES` from `open-sse/config/customHeaders.js`
  (Task 1), the `/api/settings` GET + PATCH pair.
- Produces: nothing consumed by other tasks.

- [ ] **Step 1: Create `CustomHeadersSection.js`**

```jsx
"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { Card, Button, Input, Select } from "@/shared/components";
import { SENSITIVE_HEADER_NAMES } from "open-sse/config/customHeaders.js";

const MODE_OPTIONS = [
  { value: "static", label: "Fixed value" },
  { value: "random", label: "Random string" },
];

/**
 * Manage this provider's custom request headers.
 *
 * Rules replace any header of the same name (case-insensitive), so a rule
 * targeting Authorization or Content-Type overrides what 9router would send —
 * hence the warning on sensitive names.
 */
export default function CustomHeadersSection({ providerId, settings, onChange }) {
  const all = settings?.customHeaders || {};
  const rules = all[providerId] || [];
  const [name, setName] = useState("");
  const [mode, setMode] = useState("static");
  const [value, setValue] = useState("");
  const [length, setLength] = useState("16");
  const [error, setError] = useState("");

  const persist = async (next) => {
    const updated = { ...all };
    if (next.length) updated[providerId] = next;
    else delete updated[providerId];
    await onChange({ customHeaders: updated });
  };

  const add = async () => {
    const trimmed = name.trim();
    if (!trimmed) return setError("Header name is required");
    if (rules.some((r) => r.name.toLowerCase() === trimmed.toLowerCase())) {
      return setError("A rule with this name already exists");
    }

    let rule;
    if (mode === "static") {
      if (!value) return setError("Value is required");
      rule = { name: trimmed, mode: "static", value };
    } else {
      const n = Number(length);
      if (!Number.isFinite(n) || n < 1 || n > 256) {
        return setError("Length must be between 1 and 256");
      }
      rule = { name: trimmed, mode: "random", length: Math.floor(n) };
    }

    setError("");
    await persist([...rules, rule]);
    setName("");
    setValue("");
  };

  const remove = async (index) => {
    await persist(rules.filter((_, i) => i !== index));
  };

  return (
    <Card>
      <div className="mb-4">
        <h2 className="text-lg font-semibold">Custom Request Headers</h2>
        <p className="text-sm text-text-muted">
          Extra headers sent to this provider. A rule replaces any existing
          header with the same name. Random values are regenerated per request.
        </p>
      </div>

      {rules.length > 0 && (
        <ul className="mb-4 space-y-2">
          {rules.map((rule, index) => {
            const sensitive = SENSITIVE_HEADER_NAMES.includes(rule.name.toLowerCase());
            return (
              <li key={`${rule.name}-${index}`} className="rounded-lg border border-border p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <span className="font-mono text-sm">{rule.name}</span>
                    <span className="ml-2 text-xs text-text-muted">
                      {rule.mode === "static" ? `fixed: ${rule.value}` : `random: ${rule.length} chars`}
                    </span>
                  </div>
                  <Button size="sm" variant="ghost" icon="delete" onClick={() => remove(index)}>
                    Remove
                  </Button>
                </div>
                {sensitive && (
                  <p className="mt-2 text-xs text-yellow-700 dark:text-yellow-300">
                    This replaces the value 9router normally sends. A wrong value
                    will cause upstream 401 errors.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="X-Session-Id"
          className="font-mono text-xs"
        />
        <Select
          value={mode}
          onChange={(e) => setMode(e.target.value)}
          options={MODE_OPTIONS}
        />
        {mode === "static" ? (
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="value"
            className="font-mono text-xs"
          />
        ) : (
          <Input
            value={length}
            onChange={(e) => setLength(e.target.value)}
            placeholder="length"
            type="number"
            min="1"
            max="256"
            className="font-mono text-xs"
          />
        )}
        <Button icon="add" onClick={add} className="w-full">
          Add
        </Button>
      </div>

      {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}

      <p className="mt-2 text-xs text-text-muted">
        Overriding Authorization, Content-Type, Accept, X-Api-Key or
        Anthropic-Version replaces the value 9router sets — use with care.
      </p>
    </Card>
  );
}

CustomHeadersSection.propTypes = {
  providerId: PropTypes.string.isRequired,
  settings: PropTypes.object,
  onChange: PropTypes.func.isRequired,
};
```

- [ ] **Step 2: Render the section in the provider page**

In `src/app/(dashboard)/dashboard/providers/[id]/page.js`:

1. Import it next to the other section imports (around line 18):

```js
import CustomHeadersSection from "./CustomHeadersSection";
```

2. Render it inside the page body, after the provider details card and before
   the models section (near line 1770):

```jsx
        <CustomHeadersSection
          providerId={providerId}
          settings={settings}
          onChange={handleSettingsChange}
        />
```

3. Ensure `handleSettingsChange` exists and PATCHes `/api/settings`. If the page
   has no such helper, add one following the `saveProviderStrategy` pattern
   (lines 374-402):

```js
  const handleSettingsChange = async (patch) => {
    await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    // Refresh local state so the list re-renders.
    const res = await fetch("/api/settings", { cache: "no-store" });
    if (res.ok) setSettings(await res.json());
  };
```

- [ ] **Step 3: Typecheck the build**

Run: `npm run build` (or let the UAT deploy build it — the local build OOMs on
this machine; see the note in the deploy section).

- [ ] **Step 4: Commit**

```bash
git add "src/app/(dashboard)/dashboard/providers/[id]/CustomHeadersSection.js" "src/app/(dashboard)/dashboard/providers/[id]/page.js"
git commit -m "feat(headers): add per-provider custom headers UI with sensitive-name warning"
```

---

### Task 5: Verify end-to-end on uat-ubuntu

**Files:** none (verification only)

- [ ] **Step 1: Full regression check**

Run: `cd tests && npx vitest run` and confirm the failing-file count matches the
pre-change baseline (34 files). No new failures.

- [ ] **Step 2: Syntax check the touched files**

Run, from the repo root:

```bash
node --check open-sse/config/customHeaders.js
node --check open-sse/executors/base.js
node --check src/lib/db/repos/settingsRepo.js
```

Expected: no output (all OK).

- [ ] **Step 3: Push and deploy**

```bash
git push origin master
```

Then on uat-ubuntu: `cd /opt/9router && ./deploy.sh`
Expected: `全部通过` with 13/13 checks.

- [ ] **Step 4: Configure a rule through the API and confirm it is stored**

On uat-ubuntu (replace `<PASS>` with the UAT password):

```bash
cd /tmp && rm -f ck.txt
curl -s -c ck.txt -X POST http://127.0.0.1:20128/api/auth/login \
  -H 'Content-Type: application/json' -d '{"password":"<PASS>"}' -o /dev/null
curl -s -b ck.txt -X PATCH http://127.0.0.1:20128/api/settings \
  -H 'Content-Type: application/json' \
  -d '{"customHeaders":{"openai":[{"name":"X-Client","mode":"static","value":"9router"},{"name":"X-Session","mode":"random","length":16}]}}'
curl -s -b ck.txt http://127.0.0.1:20128/api/settings | head -c 400
echo
```

Expected: the PATCH succeeds and the GET echoes back `customHeaders` with the
two rules.

- [ ] **Step 5: Confirm the headers are actually sent**

The request-details view records outbound headers. Send a request through
`/v1/chat/completions` for a provider that has a real credential configured; if
none is available, this step is skipped and noted as unverified.

```bash
curl -s -b ck.txt http://127.0.0.1:20128/api/usage/request-details | head -c 600
echo
rm -f ck.txt
```

- [ ] **Step 6: Clean up the test rule**

Repeat the PATCH with `"customHeaders":{}` so the UAT instance is left without
the test configuration.

- [ ] **Step 7: Report**

Report the regression delta, the deploy result, and whether step 5 could be
verified.
