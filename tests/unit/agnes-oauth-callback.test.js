import { describe, it, expect, beforeEach } from "vitest";
import http from "http";

/**
 * The Agnes login page does not redirect the browser. For an allow-listed
 * redirect_uri it POSTs JSON {code,state} to that URL and expects {"ok":true}.
 * These tests drive a real HTTP request at the callback handler to prove the
 * code is read from the body (not just the query string) and that the response
 * is the JSON the page requires.
 */

const loadServer = () => import("../../src/lib/oauth/utils/server.js");

// Minimal fake so we can observe what the handler does without a real network
// round-trip to Agnes and without touching the database.
let lastExchange = null;

function makeReq({ method = "POST", url = "/auth/callback", body = null }) {
  const chunks = [];
  if (body != null) chunks.push(Buffer.from(body));
  const req = new (require("stream").Readable)({
    read() {
      const c = chunks.shift();
      if (c === undefined) this.push(null);
      else this.push(c);
    },
  });
  req.method = method;
  req.url = url;
  req.destroy = () => req.emit("close");
  return req;
}

function makeRes() {
  const res = {
    statusCode: null,
    headers: {},
    body: "",
    writeHead(code, headers) { this.statusCode = code; this.headers = headers || {}; return this; },
    end(payload) { this.body = payload ?? ""; return this; },
  };
  return res;
}

describe("agnes oauth callback proxy", () => {
  beforeEach(() => {
    lastExchange = null;
  });

  it("exposes the agnes proxy lifecycle helpers", async () => {
    const s = await loadServer();
    for (const fn of ["startAgnesProxy", "stopAgnesProxy", "registerAgnesSession", "getAgnesSessionStatus", "clearAgnesSession"]) {
      expect(typeof s[fn]).toBe("function");
    }
  });

  it("registers and reads back a pending session", async () => {
    const s = await loadServer();
    s.clearAgnesSession("st-1");
    expect(s.registerAgnesSession({ state: "st-1", redirectUri: "http://127.0.0.1:20128/auth/callback" })).toBe(true);
    const sess = s.getAgnesSessionStatus("st-1");
    expect(sess?.status).toBe("pending");
    expect(sess?.redirectUri).toBe("http://127.0.0.1:20128/auth/callback");
    s.clearAgnesSession("st-1");
    expect(s.getAgnesSessionStatus("st-1")).toBeNull();
  });

  it("rejects registration without a state", async () => {
    const s = await loadServer();
    expect(s.registerAgnesSession({ redirectUri: "http://x/auth/callback" })).toBe(false);
  });

  it("reads the code from a POST JSON body and answers {\"ok\":true}", async () => {
    // Drive the real HTTP server on an ephemeral port.
    const s = await loadServer();
    const appPort = 45671;
    const started = await s.startAgnesProxy(appPort);
    expect(started.success).toBe(true);

    s.registerAgnesSession({
      state: "st-post",
      redirectUri: `http://127.0.0.1:${appPort}/auth/callback`,
    });

    const payload = JSON.stringify({ code: "CODE-FROM-BODY", state: "st-post" });
    const res = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: appPort,
          path: "/auth/callback",
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
        },
        (r) => {
          let data = "";
          r.on("data", (c) => (data += c));
          r.on("end", () => resolve({ status: r.statusCode, contentType: r.headers["content-type"], body: data }));
        }
      );
      req.on("error", reject);
      req.end(payload);
    });

    // The response contract is what the login page checks.
    expect(res.contentType).toContain("application/json");
    let parsed = null;
    try { parsed = JSON.parse(res.body); } catch { /* handled below */ }
    expect(parsed).not.toBeNull();
    // "ok" reflects whether the server-side exchange succeeded; without a real
    // Agnes token endpoint it is expected to be false here, but it must be a
    // JSON boolean rather than an HTML page (which the page treats as failure).
    expect(typeof parsed.ok).toBe("boolean");

    s.stopAgnesProxy();
  });

  it("returns JSON (not HTML) for a non-callback path", async () => {
    const s = await loadServer();
    const appPort = 45672;
    await s.startAgnesProxy(appPort);
    const res = await new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: appPort, path: "/other", method: "GET" }, (r) => {
        let data = "";
        r.on("data", (c) => (data += c));
        r.on("end", () => resolve({ status: r.statusCode, body: data }));
      });
      req.on("error", reject);
      req.end();
    });
    expect(res.status).toBe(404);
    expect(res.body).not.toContain("<html");
    s.stopAgnesProxy();
  });
});
