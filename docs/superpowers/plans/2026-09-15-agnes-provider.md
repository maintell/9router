# Agnes Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Agnes as a 9router provider, reachable through `/v1/*`, by teaching the OAuth layer to support credentials that have no `refresh_token` and renew by presenting the `access_token`.

**Architecture:** Introduce a single `oauth.accessOnly` registry flag plus an `isAccessOnly(provider)` helper. Relax the five existing `if (!refreshToken)` guards for such providers so both refresh paths (background scheduler and on-request 401 retry) work. Agnes itself needs no custom executor — it speaks OpenAI-compatible JSON, so `DefaultExecutor` handles transport.

**Tech Stack:** Plain JavaScript (ESM), Next.js 16, vitest 4 (`tests/` is an independent package).

## Global Constraints

- Plain JavaScript ESM — **no TypeScript**. `@/*` aliases to `src/*`.
- Config-driven and DRY: never hardcode URLs, models, or role/block strings outside `config/` + `registry/`.
- `open-sse/providers/registry/index.js` is **auto-generated**. Regenerate with `scripts/migrate-registry.mjs`; never hand-edit.
- Tests live in `tests/` (vitest). Run from `tests/`: `npx vitest run <path>`. The suite is **not** expected to be all-green on a plain checkout — judge regressions against `tests/__baseline__/known-fails.txt`.
- Commit style: Conventional Commits (`feat(...)`, `fix(...)`).
- After every task: push to the fork and run `/opt/9router/deploy.sh` on uat-ubuntu; all 11 checks must pass.

### Agnes OAuth contract (verified — do not re-derive)

| Item | Value |
|---|---|
| Login page | `https://app.agnes-ai.com/login?client=agnes-code&redirect_uri={URI}&state={STATE}` |
| `client_id` | `agnes-code` |
| Exchange | `POST https://api-agnes-code.agnes-ai.com/api/v1/code/auth/exchange-code`, JSON `{code, redirect_uri, state, client_id}` |
| Refresh | `POST https://api-agnes-code.agnes-ai.com/api/v1/user/refresh-token`, header `Authorization: Bearer <access_token>` |
| Chat | `https://api-agnes-code.agnes-ai.com/v1/chat/completions` (OpenAI-compatible) |
| Success code | `000000`; `000501` = login expired; `010006` = bad/used code |
| Token lifetime | 24h; **no `refresh_token` exists anywhere in the client bundle** |

**Security boundary (do not cross):** the locally installed AgnesCode desktop session
(`%APPDATA%\AgnesCode\code-auth-session.v1`) is app-bound-encrypted. Do **not** attempt to
decrypt it — the client deletes the file on decryption failure, which would log the user out.
This plan never reads that file.

---

## File Structure

| File | Responsibility |
|---|---|
| `open-sse/services/tokenRefresh.js` | **Modify.** Add `isAccessOnly()`, export it, relax 3 guards, register the `agnes` handler. |
| `open-sse/services/tokenRefresh/providers/agnesToken.js` | **Create.** `refreshAgnesToken()` — the HTTP call. |
| `open-sse/executors/default.js` | **Modify.** Relax 1 guard, add the `agnes` refresher branch. |
| `src/sse/services/backgroundTokenRefresh.js` | **Modify.** Relax 1 guard. |
| `open-sse/providers/registry/agnes.js` | **Create.** Registry entry: transport + oauth + models. |
| `src/lib/oauth/providers/agnes.js` | **Create.** Login-flow adapter (`buildAuthUrl`, `exchangeToken`). |
| `tests/unit/agnes-token-refresh.test.js` | **Create.** Unit tests for the refresh path. |
| `tests/unit/agnes-provider-registry.test.js` | **Create.** Unit tests for the registry entry. |

---

### Task 1: `isAccessOnly()` helper + relax the scheduler guard

**Files:**
- Modify: `open-sse/services/tokenRefresh.js:1` (imports), `~130` (new export)
- Modify: `src/sse/services/backgroundTokenRefresh.js:57`

**Interfaces:**
- Produces: `isAccessOnly(provider) -> boolean`, imported by Tasks 1–3.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/agnes-token-refresh.test.js`:

```js
import { describe, it, expect } from "vitest";

const load = () => import("../../open-sse/services/tokenRefresh.js");

describe("isAccessOnly", () => {
  it("is true only for providers flagged accessOnly", async () => {
    const { isAccessOnly } = await load();
    expect(isAccessOnly("agnes")).toBe(true);
  });

  it("is false for existing oauth providers", async () => {
    const { isAccessOnly } = await load();
    for (const p of ["claude", "codex", "iflow", "kiro", "gemini-cli"]) {
      expect(isAccessOnly(p)).toBe(false);
    }
  });

  it("is false for unknown providers", async () => {
    const { isAccessOnly } = await load();
    expect(isAccessOnly("totally-unknown")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd tests && npx vitest run unit/agnes-token-refresh.test.js -v`
Expected: FAIL — `isAccessOnly is not a function`.

- [ ] **Step 3: Add the helper to `open-sse/services/tokenRefresh.js`**

Change the import on line 1 from:
```js
import { PROVIDERS } from "../config/providers.js";
```
to:
```js
import { PROVIDERS, PROVIDER_OAUTH } from "../config/providers.js";
```

(`config/providers.js` is a barrel that re-exports `PROVIDER_OAUTH` from `providers/index.js`,
where line 40 does `PROVIDER_OAUTH[entry.id] = entry.oauth` — so the whole oauth block is
available without touching the build step.)

Add before `const REFRESH_HANDLERS = {`:

```js
// Credentials that carry only an access_token and renew by presenting it
// (Agnes). Existing providers always have a refreshToken, so this is false
// for every current entry and no behaviour changes for them.
export function isAccessOnly(provider) {
  return PROVIDER_OAUTH[provider]?.accessOnly === true;
}
```

- [ ] **Step 4: Relax the scheduler guard in `src/sse/services/backgroundTokenRefresh.js:57`**

Change:
```js
    if (!conn.refreshToken) continue;
```
to:
```js
    // accessOnly providers (Agnes) have no refreshToken but still need keep-alive.
    if (!conn.refreshToken && !isAccessOnly(conn.provider)) continue;
```

Add the import at the top of the file (next to the other `open-sse` imports):
```js
import { isAccessOnly } from "open-sse/services/tokenRefresh.js";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd tests && npx vitest run unit/agnes-token-refresh.test.js -v`
Expected: the 3 `isAccessOnly` tests PASS (the registry entry does not exist yet, so
`isAccessOnly("agnes")` is currently `false` — **expect this test to fail here and start
passing in Task 5**; if it fails, that is correct at this stage, proceed).

- [ ] **Step 6: Verify no regression in the existing dispatch tests**

Run: `cd tests && npx vitest run unit/token-refresh-dispatch.test.js unit/background-token-refresh.test.js`
Expected: same results as the pre-change baseline (3 passed for dispatch). Record any diff.

- [ ] **Step 7: Commit**

```bash
git add open-sse/services/tokenRefresh.js src/sse/services/backgroundTokenRefresh.js tests/unit/agnes-token-refresh.test.js
git commit -m "feat(oauth): add isAccessOnly() and include access-only connections in background refresh"
```

---

### Task 2: `refreshAgnesToken()` — the HTTP refresh call

**Files:**
- Create: `open-sse/services/tokenRefresh/providers/agnesToken.js`
- Modify: `open-sse/services/tokenRefresh.js` (import + `REFRESH_HANDLERS` + 2 guards)

**Interfaces:**
- Consumes: `dedupRefresh(provider, oldToken, fn, log)` from `./dedup.js`
- Produces: `refreshAgnesToken(accessToken, log) -> { accessToken, refreshToken, expiresIn }`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/agnes-token-refresh.test.js`:

```js
describe("refreshAgnesToken", () => {
  it("returns the new access token on code 000000", async () => {
    const fetchStub = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ code: "000000", data: { access_token: "new-token", expires_in: 86400 } }),
    });
    global.fetch = fetchStub;
    const { refreshAgnesToken } = await import(
      "../../open-sse/services/tokenRefresh/providers/agnesToken.js"
    );
    const out = await refreshAgnesToken("old-token", null);
    expect(out.accessToken).toBe("new-token");
    expect(out.expiresIn).toBe(86400);
  });

  it("throws when the server reports login expired (000501)", async () => {
    global.fetch = async () => ({
      ok: false,
      status: 401,
      json: async () => ({ code: "000501", message: "Login expired" }),
    });
    const { refreshAgnesToken } = await import(
      "../../open-sse/services/tokenRefresh/providers/agnesToken.js"
    );
    await expect(refreshAgnesToken("old-token", null)).rejects.toThrow(/Login expired/);
  });

  it("returns null when there is no token to refresh", async () => {
    const { refreshAgnesToken } = await import(
      "../../open-sse/services/tokenRefresh/providers/agnesToken.js"
    );
    expect(await refreshAgnesToken(null, null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd tests && npx vitest run unit/agnes-token-refresh.test.js -v`
Expected: FAIL — cannot resolve `agnesToken.js`.

- [ ] **Step 3: Create `open-sse/services/tokenRefresh/providers/agnesToken.js`**

```js
import { dedupRefresh } from "./dedup.js";

const AGNES_REFRESH_URL =
  "https://api-agnes-code.agnes-ai.com/api/v1/user/refresh-token";

const DEFAULT_EXPIRES_IN = 86400;

/**
 * Agnes has no refresh_token: renewal means presenting the current access_token
 * and receiving a new one. Returns the shape other refreshers return so the
 * shared write-back path works unchanged.
 */
export async function refreshAgnesToken(accessToken, log) {
  if (!accessToken) return null;
  return dedupRefresh("agnes", accessToken, async () => {
    const response = await fetch(AGNES_REFRESH_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const body = await response.json().catch(() => ({}));
    const next = body?.data?.access_token;
    if (!response.ok || body?.code !== "000000" || !next) {
      throw new Error(body?.message || `Agnes refresh failed (${response.status})`);
    }
    // refreshToken is set to the old token purely so the DB column stays
    // non-null for downstream code; Agnes never issues one.
    return {
      accessToken: next,
      refreshToken: accessToken,
      expiresIn: body?.data?.expires_in ?? DEFAULT_EXPIRES_IN,
    };
  });
}
```

- [ ] **Step 4: Register the handler and relax the two `tokenRefresh.js` guards**

In `open-sse/services/tokenRefresh.js`, add to the import block from `./tokenRefresh/providers.js`:
```js
  refreshAgnesToken,
```

Add to `REFRESH_HANDLERS`:
```js
  agnes: (c, log) => refreshAgnesToken(c.accessToken, log),
```

Relax `refreshTokenByProvider` (line 183):
```js
  if (!credentials.refreshToken && !isAccessOnly(provider)) return null;
```

Relax `getAccessToken` (line 163) from:
```js
  if (!credentials || !credentials.refreshToken || typeof credentials.refreshToken !== "string") {
```
to:
```js
  const hasRt = credentials?.refreshToken && typeof credentials.refreshToken === "string";
  if (!credentials || (!hasRt && !isAccessOnly(provider))) {
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd tests && npx vitest run unit/agnes-token-refresh.test.js -v`
Expected: all PASS.

- [ ] **Step 6: Verify no regression**

Run: `cd tests && npx vitest run unit/token-refresh-dispatch.test.js unit/background-token-refresh.test.js unit/codex-refresh-token.test.js`
Expected: identical to the Task 1 baseline.

- [ ] **Step 7: Commit**

```bash
git add open-sse/services/tokenRefresh/providers/agnesToken.js open-sse/services/tokenRefresh.js tests/unit/agnes-token-refresh.test.js
git commit -m "feat(oauth): add refreshAgnesToken and wire it into REFRESH_HANDLERS"
```

---

### Task 3: Relax the on-request 401 retry path in `DefaultExecutor`

**Files:**
- Modify: `open-sse/executors/default.js:220`

**Interfaces:**
- Consumes: `isAccessOnly(provider)` (Task 1), `refreshAgnesToken` (Task 2)
- Produces: `refreshCredentials()` returning `{accessToken}` for Agnes

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/agnes-token-refresh.test.js`:

```js
describe("DefaultExecutor.refreshCredentials for agnes", () => {
  it("returns an accessToken even with no refreshToken present", async () => {
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ code: "000000", data: { access_token: "rotated", expires_in: 86400 } }),
    });
    const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
    const ex = new DefaultExecutor("agnes", {});
    const out = await ex.refreshCredentials({ accessToken: "old" }, null);
    expect(out && out.accessToken).toBe("rotated");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd tests && npx vitest run unit/agnes-token-refresh.test.js -v`
Expected: FAIL — `refreshCredentials` currently returns `null` without a `refreshToken`.

- [ ] **Step 3: Modify `open-sse/executors/default.js`**

`default.js` already imports `PROVIDER_OAUTH` on line 2
(`import { PROVIDERS, PROVIDER_OAUTH } from "../config/providers.js";`), so reuse it rather
than importing `isAccessOnly` across module boundaries — define the check locally to keep the
executor independent of the refresh service:

```js
const isAccessOnly = (provider) => PROVIDER_OAUTH[provider]?.accessOnly === true;
```

Place that next to `const BEARER = …` near the top of the file.

Add one import for the refresher:
```js
import { refreshAgnesToken } from "../services/tokenRefresh/providers/agnesToken.js";
```

Change line 220 from:
```js
    if (!credentials.refreshToken) return null;
```
to:
```js
    // accessOnly providers (Agnes) carry no refreshToken; refresh on the
    // access token instead. Everyone else keeps the existing behaviour.
    if (!credentials.refreshToken && !isAccessOnly(this.provider)) return null;
```

Add to the `refreshers` map:
```js
      agnes: () => refreshAgnesToken(credentials.accessToken, log),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd tests && npx vitest run unit/agnes-token-refresh.test.js -v`
Expected: all PASS.

- [ ] **Step 5: Verify no regression across the executor tests**

Run: `cd tests && npx vitest run` 2>&1 | tail -30 — compare against the pre-change baseline.
Expected: no new failures beyond `tests/__baseline__/known-fails.txt`.

- [ ] **Step 6: Commit**

```bash
git add open-sse/executors/default.js tests/unit/agnes-token-refresh.test.js
git commit -m "feat(executor): allow DefaultExecutor to refresh access-only providers on 401"
```

---

### Task 4: Registry entry `open-sse/providers/registry/agnes.js`

**Files:**
- Create: `open-sse/providers/registry/agnes.js`
- Regenerate: `open-sse/providers/registry/index.js`
- Create: `tests/unit/agnes-provider-registry.test.js`

**Interfaces:**
- Produces: `PROVIDERS.agnes`, `PROVIDER_OAUTH.agnes`, `PROVIDER_MODELS.agnes`
- Consumed by: Task 1–3 (`isAccessOnly` reads `PROVIDER_OAUTH.agnes.accessOnly`)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/agnes-provider-registry.test.js`:

```js
import { describe, it, expect } from "vitest";

describe("agnes registry entry", () => {
  it("registers agnes with an accessOnly oauth block", async () => {
    const { PROVIDER_OAUTH } = await import("../../open-sse/providers/index.js");
    expect(PROVIDER_OAUTH.agnes?.accessOnly).toBe(true);
  });

  it("exposes an openai-compatible transport baseUrl", async () => {
    const { PROVIDERS } = await import("../../open-sse/providers/index.js");
    expect(PROVIDERS.agnes?.baseUrl).toContain("api-agnes-code.agnes-ai.com");
    expect(PROVIDERS.agnes?.format).toBe("openai");
  });

  it("seeds at least 7 models", async () => {
    const { PROVIDER_MODELS } = await import("../../open-sse/providers/index.js");
    expect(PROVIDER_MODELS.agnes?.length).toBeGreaterThanOrEqual(7);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd tests && npx vitest run unit/agnes-provider-registry.test.js -v`
Expected: FAIL — `PROVIDER_OAUTH.agnes` undefined.

- [ ] **Step 3: Create `open-sse/providers/registry/agnes.js`**

```js
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
```

- [ ] **Step 4: Add the entry to `open-sse/providers/registry/index.js`**

`index.js` is labelled auto-generated but is actually maintained as generated-plus-hand-tuned
(it contains manually commented-out entries such as `// p114, // devin-cli — hidden`). There is
no working regeneration script — `scripts/migrate-registry.mjs` is a schema migration tool and
would rewrite every registry file. Edit it by hand, matching the existing style.

1. Add an import in alphabetical position among the `import pN from "./….js";` lines:
```js
import p123 from "./agnes.js";
```
   Use the next free `pN` (the file currently ends at `p122`; pick `p123` and confirm no
   collision: `grep -c "p123" open-sse/providers/registry/index.js` must return 0).

2. Add `p123,` to the exported array (the `];`-terminated list at the end of the file).

Verify: `grep -n "agnes" open-sse/providers/registry/index.js` must show both lines.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd tests && npx vitest run unit/agnes-provider-registry.test.js -v`
Expected: all PASS.

- [ ] **Step 6: Re-run the Task 1–3 tests (they now exercise the real registry)**

Run: `cd tests && npx vitest run unit/agnes-token-refresh.test.js unit/agnes-provider-registry.test.js -v`
Expected: all PASS, including `isAccessOnly("agnes") === true`.

- [ ] **Step 7: Commit**

```bash
git add open-sse/providers/registry/agnes.js open-sse/providers/registry/index.js tests/unit/agnes-provider-registry.test.js
git commit -m "feat(provider): register agnes with accessOnly oauth and seeded models"
```

---

### Task 5: Login-flow adapter `src/lib/oauth/providers/agnes.js`

**Files:**
- Create: `src/lib/oauth/providers/agnes.js`
- Modify: `src/lib/oauth/providers/index.js`

**Interfaces:**
- Consumes: `AGNES_CONFIG` constants
- Produces: `agnes` adapter with `buildAuthUrl`, `exchangeToken`

- [ ] **Step 1: Add the Agnes constants to `src/lib/oauth/constants/oauth.js`**

Append:
```js
export const AGNES_CONFIG = {
  clientId: "agnes-code",
  authorizeUrl: "https://app.agnes-ai.com/login",
  exchangeUrl: "https://api-agnes-code.agnes-ai.com/api/v1/code/auth/exchange-code",
  refreshUrl: "https://api-agnes-code.agnes-ai.com/api/v1/user/refresh-token",
  callbackPath: "/auth/callback",
};
```

- [ ] **Step 2: Create `src/lib/oauth/providers/agnes.js`**

```js
import { AGNES_CONFIG } from "../constants/oauth.js";

// Agnes runs a private authorization-code variant: the login page takes
// `client` + `redirect_uri` + `state`, and the code is exchanged over a JSON
// POST (not a form-encoded token endpoint). The redirect_uri is not validated
// server-side, so a localhost callback works.
const agnes = {
  config: AGNES_CONFIG,
  flowType: "authorization_code",

  buildAuthUrl: (config, redirectUri, state) => {
    const params = new URLSearchParams({
      client: config.clientId,
      redirect_uri: redirectUri,
      state,
    });
    return `${config.authorizeUrl}?${params.toString()}`;
  },

  exchangeToken: async (config, code, redirectUri, _codeVerifier, state) => {
    const response = await fetch(config.exchangeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        code,
        redirect_uri: redirectUri,
        state,
        client_id: config.clientId,
      }),
    });
    const body = await response.json().catch(() => ({}));
    const accessToken = body?.data?.access_token;
    if (!response.ok || body?.code !== "000000" || !accessToken) {
      throw new Error(body?.message || `Agnes login failed (${response.status})`);
    }
    return {
      accessToken,
      // No refresh token exists; store the access token so the column stays
      // non-null and isAccessOnly() drives renewal.
      refreshToken: accessToken,
      expiresIn: body?.data?.expires_in ?? 86400,
    };
  },
};

export default agnes;
```

- [ ] **Step 3: Register it in `src/lib/oauth/providers/index.js`**

Add next to the other provider imports:
```js
import agnes from "./agnes.js";
```
and add `agnes,` to the `PROVIDERS` object (the one containing `iflow,`).

- [ ] **Step 4: Verify the module graph loads**

Run: `cd tests && npx vitest run unit/agnes-provider-registry.test.js unit/agnes-token-refresh.test.js -v`
Expected: all PASS (no import cycle / syntax error).

- [ ] **Step 5: Commit**

```bash
git add src/lib/oauth/constants/oauth.js src/lib/oauth/providers/agnes.js src/lib/oauth/providers/index.js
git commit -m "feat(oauth): add agnes login-flow adapter"
```

---

### Task 6: Self-check, deploy, verify

**Files:** none (verification only)

- [ ] **Step 1: Lint**

Run: `npx eslint open-sse/services/tokenRefresh.js open-sse/services/tokenRefresh/providers/agnesToken.js open-sse/executors/default.js open-sse/providers/registry/agnes.js src/lib/oauth/providers/agnes.js src/sse/services/backgroundTokenRefresh.js`
Expected: no errors.

- [ ] **Step 2: Full regression check**

Run: `cd tests && npx vitest run 2>&1 | tail -40`
Compare the failure list against `tests/__baseline__/known-fails.txt`. Expected: no new failures.
If a new failure appears, fix it before deploying.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: compiles successfully.

- [ ] **Step 4: Commit any remaining changes and push**

```bash
git add -A
git commit -m "chore: agnes provider integration"
git push origin master
```

- [ ] **Step 5: Deploy and verify on uat-ubuntu**

Run on uat-ubuntu: `cd /opt/9router && ./deploy.sh`
Expected: `全部通过` with 11/11 checks.

- [ ] **Step 6: Confirm agnes is visible in the deployed instance**

On uat-ubuntu:
```bash
cd /tmp && rm -f ck.txt
curl -s -c ck.txt -X POST http://127.0.0.1:20128/api/auth/login \
  -H 'Content-Type: application/json' -d '{"password":"Uat@9router#2026"}' -o /dev/null
curl -s -b ck.txt http://127.0.0.1:20128/api/providers | grep -o '"agnes"' | head -1
rm -f ck.txt
```
Expected: `"agnes"` appears in the provider list.

- [ ] **Step 7: Report**

Report the deploy result, the regression delta, and the two open items from the design doc
(token rotation, `expires_in`) as still-unverified pending a live login.
