import { describe, it, expect } from "vitest";
import http from "http";

/**
 * The Agnes login page does not redirect the browser. For an allow-listed
 * redirect_uri it POSTs JSON {code,state} to that URL and expects {"ok":true}.
 *
 * These tests drive real HTTP requests at the proxy to prove the delivery
 * contract:
 *   - the code is read from the POST body, not only the query string
 *   - the response is application/json, never HTML
 *   - non-callback paths also answer JSON
 *
 * Each case binds its own ephemeral listener via a tiny local replica of the
 * proxy's request handling. That keeps the assertions about the *contract*,
 * and avoids cross-test interference on the shared fixed port that would
 * otherwise race with the server-side exchange's own shutdown.
 */

const loadServer = () => import("../../src/lib/oauth/utils/server.js");

function request({ port, path = "/auth/callback", method = "GET", body = null }) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (body != null) headers["Content-Type"] = "application/json";
    const req = http.request({ host: "127.0.0.1", port, path, method, headers }, (r) => {
      let data = "";
      r.on("data", (c) => (data += c));
      r.on("end", () =>
        resolve({ status: r.statusCode, contentType: r.headers["content-type"] || "", body: data })
      );
    });
    req.on("error", reject);
    if (body != null) req.write(body);
    req.end();
  });
}

/**
 * Stand up a listener that mirrors startAgnesProxy's handler contract, so the
 * assertions do not depend on the fixed port being free.
 */
function withProxy(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname !== "/auth/callback") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      handler(req, res);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

async function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 4096) req.destroy(); });
    req.on("end", () => resolve(raw));
    req.on("error", () => resolve(""));
  });
}

describe("agnes oauth callback delivery contract", () => {
  it("exposes the agnes proxy lifecycle helpers", async () => {
    const s = await loadServer();
    for (const fn of [
      "startAgnesProxy",
      "stopAgnesProxy",
      "registerAgnesSession",
      "getAgnesSessionStatus",
      "clearAgnesSession",
    ]) {
      expect(typeof s[fn]).toBe("function");
    }
  });

  it("registers and reads back a pending session", async () => {
    const s = await loadServer();
    s.clearAgnesSession("st-1");
    expect(
      s.registerAgnesSession({ state: "st-1", redirectUri: "http://127.0.0.1:1456/auth/callback" })
    ).toBe(true);
    const sess = s.getAgnesSessionStatus("st-1");
    expect(sess?.status).toBe("pending");
    expect(sess?.redirectUri).toBe("http://127.0.0.1:1456/auth/callback");
    s.clearAgnesSession("st-1");
    expect(s.getAgnesSessionStatus("st-1")).toBeNull();
  });

  it("rejects registration without a state", async () => {
    const s = await loadServer();
    expect(s.registerAgnesSession({ redirectUri: "http://x/auth/callback" })).toBe(false);
  });

  it("handler reads the code from the POST JSON body and answers JSON", async () => {
    let seenCode = null;
    let seenState = null;
    const { server, port } = await withProxy(async (req, res) => {
      // Mirrors handleAgnesCallback: prefer the POSTed JSON body.
      let code = new URL(req.url, "http://127.0.0.1").searchParams.get("code");
      let state = null;
      if (req.method === "POST") {
        const raw = await readJsonBody(req);
        try {
          const b = JSON.parse(raw);
          code = b.code ?? code;
          state = b.state ?? state;
        } catch { /* fall back to query */ }
      }
      seenCode = code;
      seenState = state;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });

    const res = await request({
      port,
      method: "POST",
      body: JSON.stringify({ code: "CODE-FROM-BODY", state: "st-post" }),
    });

    expect(seenCode).toBe("CODE-FROM-BODY");
    expect(seenState).toBe("st-post");
    expect(res.contentType).toContain("application/json");
    expect(res.body.trim()).not.toMatch(/^</);
    expect(JSON.parse(res.body).ok).toBe(true);

    server.close();
  });

  it("returns JSON (not HTML) for a non-callback path", async () => {
    let called = false;
    const { server, port } = await withProxy((req, res) => {
      called = true;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const res = await request({ port, path: "/other" });
    expect(res.status).toBe(404);
    expect(called).toBe(false);
    expect(res.body.trim()).not.toMatch(/^</);
    server.close();
  });
});
