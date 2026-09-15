# Provider Custom Request Headers

**Date:** 2026-09-15
**Status:** Draft — pending user review

---

## 1. Goal

Let the user define extra HTTP headers that 9router sends to upstream providers,
per provider. Two value modes are supported:

- **static** — a fixed string
- **random** — a fresh alphanumeric string of a configurable length, generated
  per request

Applied headers must never be duplicated: if a request already carries a header
with the same name, the configured value **replaces** it.

### Non-goals

- Global (all-provider) rules — configuration is per provider only.
- Per-connection rules — configuration is per provider, shared by its accounts.
- Modifying response headers, or headers on non-model requests (token refresh,
  model-list fetches).

---

## 2. Decisions (confirmed with the user)

| Question | Decision |
|---|---|
| Scope | Per provider only (no global defaults) |
| Duplicate handling | Configured value **replaces** the existing one |
| Random regeneration | Per request |
| Injection point | `BaseExecutor.buildHeaders` (covers every executor) |
| Storage | `customHeaders` field on the settings table |
| Character set | `a-z0-9` |

---

## 3. Data model

### 3.1 Storage

New field on the settings row (`src/lib/db/repos/settingsRepo.js`), added to
`DEFAULT_SETTINGS` so the existing merge logic picks it up:

```js
customHeaders: {},   // { [providerId]: HeaderRule[] }
```

Shape:

```js
customHeaders: {
  openai: [
    { name: "X-Session-Id", mode: "random", length: 16 },
    { name: "X-Client",     mode: "static", value: "9router" }
  ],
  agnes: [
    { name: "X-Trace-Id", mode: "random", length: 24 }
  ]
}
```

Rule contract:

| Field | Type | Applies to | Notes |
|---|---|---|---|
| `name` | string | both | Header name. Required, non-empty. |
| `mode` | `"static" \| "random"` | both | Required. |
| `value` | string | `static` only | Sent verbatim. |
| `length` | number | `random` only | Integer, 1–256. |

Unknown modes are ignored (fail-open) rather than throwing, so a bad rule never
breaks a request.

### 3.2 Why settings and not connections

Configuration is per provider and shared across that provider's accounts, which
matches how `providerStrategies` and `quotaVisibility` already work. Storing per
connection would duplicate the same rules on every account.

---

## 4. Injection

### 4.1 Location

`open-sse/executors/base.js`, `buildHeaders()` (lines 46–76) — the shared entry
point used by every executor, including the special-cased ones that override it
and call `super.buildHeaders(...)` (`codex.js:213`, `grok-cli.js:363`,
`iflow.js:43`, `kiro.js:235`, …). Rules are appended **after** the existing
logic so that "replace" semantics win over the built-in `Authorization` /
`Content-Type` values.

Because the overrides delegate to `super.buildHeaders()`, changing the base
implementation covers them too — no per-executor edits are needed.

One caveat discovered while verifying: `...this.config.headers` on line 49 is
effectively a no-op on the request path, because executors are singletons built
without a config argument (see 4.5). That existing line is left untouched; the
custom rules do not depend on it.

### 4.2 Ordering

```js
buildHeaders(credentials, stream = true) {
  const headers = { "Content-Type": "application/json", ...this.config.headers };

  // ... existing auth branch (anthropic-compatible vs standard bearer) ...

  if (stream) headers["Accept"] = "text/event-stream";

  // appended last so configured values replace anything set above
  applyCustomHeaders(headers, this.provider);
  return headers;
}
```

### 4.3 Deduplication is case-insensitive

Verified experimentally: JavaScript object keys are **case-sensitive**, so a
plain assignment is not enough.

```js
const h = {};
h["x-trace"] = "a";
h["X-Trace"] = "b";
Object.keys(h);   // ['x-trace', 'X-Trace']  <- two keys, two headers on the wire
```

HTTP header names are case-insensitive, so emitting both would be a genuine
duplicate and could confuse or break upstreams. `applyCustomHeaders` therefore
removes any existing key whose lowercase form matches, then writes the new one:

```js
function setHeader(headers, name, value) {
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) delete headers[key];
  }
  headers[name] = value;   // keep the user's original casing
}
```

The configured name's casing is preserved on output; only the matching is
case-insensitive.

### 4.4 Random generation

```js
const RANDOM_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

function randomAlphaNum(length) {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += RANDOM_CHARS[Math.floor(Math.random() * RANDOM_CHARS.length)];
  }
  return out;
}
```

Uses `Math.random` — sufficient for header obfuscation and trace ids, and
consistent with the existing helper in `executors/grok-web.js`. Not
cryptographically secure, and it does not need to be.

`buildHeaders()` is called inside the retry/fallback loop
(`base.js:130`), so a random value is regenerated for each attempt, which
satisfies "per request".

### 4.5 Settings lookup — resolved

Two constraints shape this:

1. `buildHeaders()` is synchronous, but reading settings is async.
2. Executors are module-level singletons created by `getExecutor(provider)` with
   **no config argument** (`open-sse/executors/index.js:67-71`), so `this.config`
   is `undefined` on the request path. Custom headers therefore cannot ride on
   `this.config` the way `transport.headers` nominally does.

Mechanism: a small module exposing a **synchronous** read backed by an
in-process cache with a short TTL, patterned on the existing
`getObservabilityConfig()` in `src/lib/db/repos/requestDetailsRepo.js`
(`CONFIG_CACHE_TTL_MS = 5000`):

```js
// open-sse/config/customHeaders.js
let cache = { rules: {}, ts: 0, loading: false };
const TTL_MS = 5000;

export function getCustomHeadersSync(provider) {
  if (Date.now() - cache.ts > TTL_MS) refresh();   // fire-and-forget
  return cache.rules[provider] || EMPTY;
}

async function refresh() {
  if (cache.loading) return;
  cache.loading = true;
  try {
    const { getSettings } = await import("../../src/lib/db/repos/settingsRepo.js");
    const settings = await getSettings();
    cache = { rules: normalize(settings?.customHeaders), ts: Date.now(), loading: false };
  } catch {
    cache.loading = false;   // keep serving the previous value
  }
}
```

Properties:

- Header assembly stays synchronous — no per-request DB round trip.
- A settings change takes effect within one TTL window (5s).
- If the read fails, the previous value keeps being served; if nothing was ever
  loaded, no custom headers are added (fail-open).
- The first request after a cold start may not yet see the rules; this is the
  same trade-off `getObservabilityConfig()` already makes.

Note the import direction: `open-sse/` reaching into `src/lib/db/` is
pre-existing (see `requestDetailsRepo.js`'s lazy import) and is done lazily here
to avoid a module cycle at import time.

---

## 5. Configuration surface

Reachable from each provider's page (`/dashboard/providers/[id]`), alongside the
existing settings for that provider. Minimum viable UI:

- List of rules for this provider
- Add rule: name, mode, and (per mode) value or length
- Remove rule
- Validation: name required; `static` requires a value; `random` requires a
  length between 1 and 256

Served by the existing `/api/settings` route with the new `customHeaders` field
included in its response.

---

## 6. Error handling

| Case | Behaviour |
|---|---|
| Unknown `mode` | Skip the rule; log at debug level |
| `random` with missing/invalid length | Skip the rule |
| `static` with missing value | Skip the rule |
| Rule for an unknown provider | Never matches; harmless |
| Settings read fails | Fail-open: send the request with no custom headers |
| Header name empty | Skip the rule |

No configuration error may prevent a request from being sent — the feature is
additive and must never break existing traffic.

---

## 7. Overriding security-sensitive headers

Because the rule is "configured value replaces the existing one", a user can
configure `Authorization` or `Content-Type` and thereby replace the real
credential, producing upstream 401s that look like a provider outage.

**Decision: allow it, but warn in the UI.** The setting is explicit and the user
may have a legitimate reason — for example a provider that expects a
non-standard auth header, or a proxy that injects its own credentials.

Implementation:

- A shared list of sensitive names, matched case-insensitively:
  `authorization`, `content-type`, `accept`, `anthropic-version`,
  `x-api-key`, `api-key`.
- The settings API returns the list (or the UI imports the same constant) so the
  warning is not duplicated in two places.
- When a rule targets one of them, the provider page renders a warning next to
  that rule: that it replaces the value 9router would otherwise send, and that a
  wrong value causes upstream 401s.
- Nothing is blocked — the request is still sent with the user's value.

Alternatives considered and rejected:

- Block those names outright — safer, but silently ignores explicit intent.
- Allow with no warning — simplest, but the failure mode is confusing.

---

## 8. Testing

Unit (`tests/unit/`, vitest):

1. A static rule sets the header.
2. A static rule replaces an existing header of the same name.
3. Replacement is case-insensitive (`x-trace` replaces `X-Trace`) and leaves
   exactly one header.
4. A random rule produces a value of the configured length, matching
   `/^[a-z0-9]+$/`.
5. Two calls produce different random values (per-request regeneration).
6. Rules for other providers are not applied.
7. Unknown mode / missing value / missing length → rule skipped, request still
   built.
8. Settings read failure → no custom headers, request still built.

Manual:

- Configure a static and a random header for a provider, send a request through
  `/v1/chat/completions`, and confirm both appear once in the outgoing request
  (observable via the provider's request-details view or upstream logs).
- Confirm no duplicate `X-…` entries are present when the provider already sets
  that header.
