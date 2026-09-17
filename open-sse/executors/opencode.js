import crypto from "crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { getThinkingLevels } from "../providers/thinkingLevels.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import { resolveSessionId } from "../utils/sessionManager.js";
import { isMuseSparkModel } from "../providers/models/helpers.js";

// Extracted from the OpenCode desktop bundle (app.asar): the client sends
// `opencode/${InstallationVersion}` with the version baked into the build.
// A bare "opencode" does not match what the real client sends, so requests that
// only differ by this header are trivially distinguishable from real ones.
// Bump alongside upstream releases; a stale version is still a valid shape.
const OPENCODE_VERSION = "1.18.31";
const OPENCODE_UA = `opencode/${OPENCODE_VERSION}`;
// Sentinel used by the public/free endpoint when no credential is configured.
const PUBLIC_TOKEN = "public";
// Models served by /zen/v1/responses; every other model stays on /chat/completions.
const RESPONSES_MODELS = new Set([
  "muse-spark-1.2-contributor-free",
  "muse-spark-1.3-contributor-free",
]);

function generateRequestId() {
  return `msg_${crypto.randomUUID().replace(/-/g, "")}`;
}

function generateSessionId() {
  return `ses_${crypto.randomUUID().replace(/-/g, "")}`;
}

// Strip the thinking suffix "model(level)" so registry lookups hit the base id.
function baseModelId(model) {
  return String(model || "").replace(/\([^()]+\)\s*$/, "").trim();
}

function isResponsesModel(model) {
  const base = baseModelId(model);
  return RESPONSES_MODELS.has(base) || isMuseSparkModel(base);
}

function resolveOpencodeSession(body, credentials) {
  const headers = credentials?.rawHeaders || {};
  return resolveSessionId({
    headers,
    body,
    connectionId: credentials?.connectionId,
    scope: "opencode",
    generate: generateSessionId,
  });
}

function normalizeOpencodeReasoning(model, body) {
  const current = body.reasoning;
  const currentReasoning = current && typeof current === "object" && !Array.isArray(current)
    ? current
    : null;
  const requestedEffort = typeof body.reasoning_effort === "string"
    ? body.reasoning_effort
    : currentReasoning?.effort;
  if (typeof requestedEffort !== "string") return;

  const cleanModel = baseModelId(model || body.model);
  const supportedLevels = getThinkingLevels("opencode", cleanModel);
  let effort = requestedEffort.toLowerCase().trim();
  if ((effort === "max" || effort === "ultra") && supportedLevels?.length && !supportedLevels.includes(effort)) {
    if (effort === "ultra" && supportedLevels.includes("max")) effort = "max";
    else if (supportedLevels.includes("xhigh")) effort = "xhigh";
  }

  body.reasoning = { ...currentReasoning, effort };
  if (!body.reasoning.summary) body.reasoning.summary = "auto";
  delete body.reasoning_effort;
}

export class OpenCodeExecutor extends BaseExecutor {
  constructor() {
    super("opencode", PROVIDERS.opencode);
    this._currentSessionId = null;
  }

  transformRequest(model, body, stream, credentials) {
    this._currentSessionId = resolveOpencodeSession(body, credentials);
    if (isResponsesModel(model)) {
      // Responses API names the output cap max_output_tokens and takes thinking
      // as reasoning:{effort,summary} — normalize the Chat fields at this boundary.
      if (body.max_output_tokens === undefined) {
        if (body.max_completion_tokens !== undefined) body.max_output_tokens = body.max_completion_tokens;
        else if (body.max_tokens !== undefined) body.max_output_tokens = body.max_tokens;
      }
      delete body.max_tokens;
      delete body.max_completion_tokens;
      normalizeOpencodeReasoning(model, body);
    }
    return injectReasoningContent({ provider: this.provider, model, body });
  }

  buildUrl(model) {
    const base = this.config.baseUrl;
    return isResponsesModel(model)
      ? `${base}/zen/v1/responses`
      : `${base}/zen/v1/chat/completions`;
  }

  /**
   * "public" is a sentinel, not a credential: the upstream short-circuits any
   * request carrying it with HTTP 403 / type "FreeTierError" before it ever
   * reaches authentication. Verified across every free model, every
   * x-opencode-client value, the real User-Agent and two egress IPs — all 403.
   *
   * A real key changes the outcome: any key-shaped token returns 401
   * "Invalid API key" instead, i.e. it *is* authenticated. So the actionable
   * advice is "configure a real OpenCode Zen/Go API key", not "give up".
   *
   * Without this the base handler echoes the raw upstream JSON, which reads like
   * a crash rather than a next step.
   */
  parseError(response, bodyText) {
    const base = super.parseError(response, bodyText);
    if (!bodyText || typeof bodyText !== "string") return base;

    try {
      const parsed = JSON.parse(bodyText);
      const inner = parsed?.error;
      const type = inner?.type || parsed?.type;
      if (type !== "FreeTierError") return base;

      base.message =
        "OpenCode rejected this request because no API key is configured (the " +
        "free endpoint returns \"free tier can only be used from within OpenCode\" " +
        "when it sees the public/no-key sentinel). Add an OpenCode Zen or Go API " +
        "key to this provider's connection — with a real key the same model is " +
        "authenticated normally. Otherwise use another free-tier provider.";
    } catch {
      /* not JSON — keep the base message */
    }
    return base;
  }

  buildHeaders(credentials, stream = true) {
    const raw = credentials?.rawHeaders || {};
    const lower = {};
    for (const [k, v] of Object.entries(raw)) lower[k.toLowerCase()] = v;

    const downstreamUa = lower["user-agent"] || "";
    const isOpencodeDownstream = downstreamUa.toLowerCase().includes("opencode");

    // A real key (OpenCode Zen / Go subscription) takes precedence; without one
    // fall back to the public sentinel so unauthenticated use still works.
    const token = credentials?.apiKey || credentials?.accessToken || PUBLIC_TOKEN;

    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "User-Agent": isOpencodeDownstream ? downstreamUa : OPENCODE_UA,
      "x-opencode-client": lower["x-opencode-client"] || "desktop",
      "x-opencode-session": lower["x-opencode-session"] || this._currentSessionId || generateSessionId(),
      "x-opencode-request": lower["x-opencode-request"] || generateRequestId(),
      "x-opencode-project": lower["x-opencode-project"] || "global",
      "Accept": stream ? "text/event-stream" : "*/*",
    };
  }
}
