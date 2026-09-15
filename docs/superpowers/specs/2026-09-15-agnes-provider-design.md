# Agnes Provider Integration (9router → Agnes 云端模型)

**Date:** 2026-09-15
**Status:** Draft — pending user review
**Approach:** A — extend the OAuth layer to support access-only self-refreshing tokens

---

## 1. Goal

Add Agnes (`app.agnes-ai.com` / `api-agnes-code.agnes-ai.com`) as a 9router provider so its
aggregated cloud models (`agnes-3.0-flash`, `gpt-5.5`, `claude-opus-4-8`, `glm-5.2`,
`deepseek-v4-pro`, `gemini-3.5-flash`, …) become reachable through 9router's unified
`/v1/*` endpoint — with usage tracking, combo fallback and account rotation.

### Non-goals

- **Reusing the locally installed AgnesCode desktop credentials.** Not possible: the session
  file `%APPDATA%\AgnesCode\code-auth-session.v1` is Electron `safeStorage`-encrypted with
  app-bound encryption (Electron 41). The AES key decrypts fine, but the payload fails GCM
  authentication — it is bound to `AgnesCode.exe`. Worse, `Yse.loadForOperation()` **deletes
  the file when decryption fails**, so attempting it would log the user out of AgnesCode.
  Out of scope by design.
- **Making AgnesCode talk to 9router** (the reverse direction). Separate feature.

---

## 2. How Agnes auth actually works

Reverse-engineered from `AgnesCode/resources/app.asar` (`.vite/build/main.js` +
`.vite/renderer/main_window/assets/renderer-main-*.js`) and confirmed by live read-only probes.

It **is** OAuth authorization-code — but a private variant, not RFC 6749.

| Item | Value |
|---|---|
| Login page | `https://app.agnes-ai.com/login?client=agnes-code&redirect_uri={URI}&state={STATE}` |
| `client_id` | `agnes-code` |
| `redirect_uri` | `agnes://auth/callback` (desktop) — **`http://127.0.0.1:{port}/auth/callback` is accepted** |
| Code exchange | `POST {BASE}/api/v1/code/auth/exchange-code`, JSON body `{code, redirect_uri, state, client_id}` |
| Refresh | `POST {BASE}/api/v1/user/refresh-token`, header `Authorization: Bearer <access_token>` |
| Chat | `{BASE}/v1/chat/completions` (OpenAI-compatible) |
| `BASE` | `https://api-agnes-code.agnes-ai.com` |
| Error codes | `000000` ok · `000501` login expired · `010006` bad/used code |

### 2.1 No refresh_token — this is the crux

The string `refresh_token` occurs **0 times across all 170 renderer chunks**. The client only
ever holds an `access_token` and renews it by presenting it:

```js
// renderer: refresh orchestrator
const o = await rde(e.accessToken);            // POST /api/v1/user/refresh-token, Bearer <old>
if (o.access_token === e.accessToken) return true;
await xd(o.access_token);                      // validate the new token
await jP(o.access_token, e.userInfo, t);       // persistAccountSession
```

Token lifetime is 24h (`Jse = 1440 * 60 * 1000`), and refresh is the only renewal path.
**If a refresh window is missed, the token dies and the user must re-login in the browser.**

### 2.2 The login page's localhost callback is a POST, not a redirect

```js
// app.agnes-ai.com login chunk (app/(auth)/login/page-*.js)
function a(t) {                       // redirect_uri allow-list
  return t.protocol === "http:"
    && (t.hostname === "127.0.0.1" || t.hostname === "[::1]")
    && !!t.port
    && t.pathname === "/auth/callback"
    && !t.username && !t.password && !t.search && !t.hash;
}
async function u() {
  let a = await n.a4({ redirect_uri: t, state: e, client_id: s, ttl_seconds: 60 });
  let o = a.data.code;
  if (i) {                            // i = localhost mode
    let s = await d(t, o, e);         // POST {code,state} to redirect_uri; expects {ok:true}
    return { success: s };
  }
  window.location.href = `${t}?code=${o}&state=${e}`;   // non-localhost path
}
```

Implications for the implementation:
- The 9router callback endpoint must accept **POST** with a JSON body and answer `{"ok":true}`.
- The authorization code lives only **60 seconds**.
- The redirect URL must be exactly `http://127.0.0.1:{port}/auth/callback` — no query, no hash.

---

## 3. Why the existing OAuth layer blocks Agnes

9router has **two independent refresh paths**, and each has a guard that assumes a
`refresh_token` exists:

| # | Path | Guard | Trigger |
|---|---|---|---|
| 1 | Background keep-alive | `backgroundTokenRefresh.js:57` `if (!conn.refreshToken) continue;` | scheduler tick |
| 2 | `refreshTokenByProvider` | `tokenRefresh.js:183` `if (!credentials.refreshToken) return null;` | called by #1 |
| 3 | `getAccessToken` | `tokenRefresh.js:163` same guard | token retrieval |
| 4 | **On-request 401 retry** | `default.js:220` `if (!credentials.refreshToken) return null;` | upstream 401/403 |

Guard #4 is the safety net: if the scheduler misses a window, the next request's 401 triggers
an immediate refresh. Agnes is OpenAI-compatible → `DefaultExecutor` → hits #4 directly.

**Good news found while tracing #4:** `chatCore.js:412-422` merges the refreshed credentials
unconditionally, so returning `{accessToken}` alone is enough — only the guard needs relaxing:

```js
if (result?.refreshToken && result.refreshToken !== credentials.refreshToken) { … }
if (newCredentials?.accessToken || …) Object.assign(credentials, newCredentials);
```

---

## 4. Design

### 4.1 New registry field: `oauth.accessOnly`

```js
oauth: {
  accessOnly: true,     // no refresh_token; renew by presenting the access_token
  …
}
```

A single helper reads it and is reused by all four guards:

```js
// open-sse/services/tokenRefresh.js
export function isAccessOnly(provider) {
  return PROVIDER_OAUTH[provider]?.accessOnly === true;
}
```

`PROVIDER_OAUTH[id]` already exposes the whole oauth block (`providers/index.js:40`), so new
fields are available without touching the build step.

### 4.2 Changes to existing code — 5 guards

All are additive conditionals. **No existing provider changes behaviour**, because
`isAccessOnly()` is false for every current entry.

| # | File:line | Change |
|---|---|---|
| 1 | `src/sse/services/backgroundTokenRefresh.js:57` | `if (!conn.refreshToken && !isAccessOnly(conn.provider)) continue;` |
| 2 | `open-sse/services/tokenRefresh.js:183` | relax guard in `refreshTokenByProvider` |
| 3 | `open-sse/services/tokenRefresh.js:163` | relax guard in `getAccessToken` |
| 4 | `open-sse/services/tokenRefresh.js:135` | register `agnes` in `REFRESH_HANDLERS` |
| 5 | `open-sse/executors/default.js:220` | relax guard + add `refreshers.agnes` |

### 4.3 New files — 3

1. **`open-sse/providers/registry/agnes.js`** — registry entry (~60 lines, modelled on `iflow.js`):

```js
export default {
  id: "agnes",
  category: "oauth",
  display: { name: "Agnes", icon: "auto_awesome", color: "#7C5CFF",
             website: "https://agnes-ai.com", notice: { signupUrl: "https://agnes-ai.com" } },
  transport: {
    baseUrl: "https://api-agnes-code.agnes-ai.com/v1/chat/completions",
    format: "openai",
  },
  oauth: {
    accessOnly: true,
    clientId: "agnes-code",
    authorizeUrl: "https://app.agnes-ai.com/login",
    exchangeUrl: "https://api-agnes-code.agnes-ai.com/api/v1/code/auth/exchange-code",
    refreshUrl:  "https://api-agnes-code.agnes-ai.com/api/v1/user/refresh-token",
    callbackPath: "/auth/callback",
    refreshLeadMs: 3600000,      // 1h lead against a 24h token
  },
  models: [ /* 7 seeded, see 4.4 */ ],
  modelsFetcher: { url: "https://api-agnes-code.agnes-ai.com/v1/models", type: "openai" },
};
```

No custom executor is needed — Agnes speaks OpenAI-compatible JSON, so `DefaultExecutor` handles it.

2. **`open-sse/services/tokenRefresh/providers/agnesToken.js`**

```js
export async function refreshAgnesToken(accessToken, log) {
  if (!accessToken) return null;
  return dedupRefresh("agnes", accessToken, async () => {
    const res = await fetch(REFRESH_URL, {
      method: "POST", headers: { Authorization: `Bearer ${accessToken}` },
    });
    const body = await res.json().catch(() => ({}));
    const next = body?.data?.access_token;
    if (!res.ok || body?.code !== "000000" || !next) {
      throw new Error(body?.message || `Agnes refresh failed (${res.status})`);
    }
    return { accessToken: next, refreshToken: accessToken, expiresIn: body?.data?.expires_in ?? 86400 };
  });
}
```

`refreshToken: accessToken` keeps the DB column non-null so downstream code keeps working.
Reusing `dedupRefresh` prevents concurrent refreshes from invalidating each other.

3. **`src/lib/oauth/providers/agnes.js`** — login-flow adapter (`buildAuthUrl`, `exchangeToken`,
   `postExchange`) registered in `src/lib/oauth/providers/index.js`, following the `iflow.js` shape.
   `exchangeToken` must POST JSON (not form-encoded) and read `data.access_token`.

Registry index (`open-sse/providers/registry/index.js`) is **auto-generated** — regenerate with
`scripts/migrate-registry.mjs`, never hand-edit.

### 4.4 Model list — seeded + fetched

Hard-code the 7 models found in the local `~/.agnes/config/config.yaml` under
`AGNES_MODEL_LIMITS`, and layer `modelsFetcher` on top so new upstream models appear
automatically. If the fetch fails (401/timeout), the seeded list remains — matching how other
9router providers use `modelsFetcher`.

Seeded: `agnes-3.0-flash`, `agnes-2.5-flash`, `agnes-2.5-pro`, `gpt-5.5`, `claude-opus-4-8`,
`glm-5.2`, `deepseek-v4-pro`, `gemini-3.5-flash`.

---

## 5. Error handling

| Case | Behaviour |
|---|---|
| Refresh returns `000501` | token is dead → mark the connection inactive, surface "re-authorize" in UI |
| Refresh network failure | fail-open: keep the old token, retry on next tick / next 401 |
| `/v1/models` fetch fails | fall back to the seeded list, log a warning |
| Code exchange returns `010006` | code expired/used (60s TTL) → ask the user to retry login |
| Concurrent refreshes | deduplicated via `dedupRefresh` |

---

## 6. Testing

Unit (`tests/unit/`, vitest — note the suite is not expected to be fully green on a checkout;
compare against `tests/__baseline__/known-fails.txt`):

1. `isAccessOnly()` returns true only for Agnes.
2. `refreshAgnesToken()` maps `000000` → new token; `000501` → throws.
3. `selectConnectionsNeedingRefresh()` includes an Agnes connection with no `refreshToken`.
4. `refreshCredentials()` on `DefaultExecutor` returns `{accessToken}` for Agnes.
5. Registry entry passes `schema.js` validation.

Manual:
- Add the Agnes connection via the dashboard → browser login → callback completes.
- Send a `/v1/chat/completions` request through 9router with an Agnes model.
- Force a 401 from upstream and confirm the on-request refresh path fires.

Deployment verification: push to the fork, then run `/opt/9router/deploy.sh` on uat-ubuntu
(11 checks) and confirm all pass.

---

## 7. Open items

1. **Unverified: does the server rotate the token on refresh?** Static code shows the client
   handles both cases (`if (o.access_token === e.accessToken) return true;`). The implementation
   writes back `newToken ?? oldToken`, so either behaviour works. To be confirmed during
   implementation with one live login.
2. **Unverified: whether `expires_in` is returned.** The client only reads `access_token`; the
   refresh handler defaults to 86400s when absent.
3. **`userInfo` shape** — only `userInfo.id` was observed being read. The connection display
   name may end up generic until the real payload is seen.
