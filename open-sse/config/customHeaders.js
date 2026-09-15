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

    // A provider whose rules are all invalid gets no entry at all, so
    // applyCustomHeaders can skip it with a single lookup.
    if (rules.length) out[providerId] = rules;
  }
  return out;
}

// NOTE: no isSensitiveHeaderName() helper — the UI compares against
// SENSITIVE_HEADER_NAMES directly, and an export with no consumer is dead code.

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
