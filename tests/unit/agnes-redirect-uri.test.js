import { describe, it, expect } from "vitest";

/**
 * Agnes' login page decides whether to deliver an authorization code at all by
 * allow-listing redirect_uri:
 *
 *   isDeepLinkMode = client && redirect_uri && state
 *                 && (client === "agnes-code" || client.startsWith("agnes-cli"))
 *                 && (redirect_uri === "agnes://auth/callback" || a(redirect_uri))
 *
 * On login success the page does:
 *   if (isDeepLinkMode) { deliver the code }   // generate code, then POST or redirect
 *   else { push("/") }                          // plain web login -> no code, ever
 *
 * So MISSING the allow-list is not a fallback path that redirects with ?code= —
 * it produces no code at all. An earlier iteration assumed otherwise and the
 * user just ended up on the Agnes home page. 9router must therefore MATCH the
 * allow-list.
 *
 * `a()` is reproduced verbatim from the login page bundle.
 */

function agnesAllowsLoopbackPost(u) {
  let x;
  try { x = new URL(u); } catch { return false; }
  return x.protocol === "http:"
    && (x.hostname === "127.0.0.1" || x.hostname === "[::1]")
    && !!x.port
    && x.pathname === "/auth/callback"
    && !x.username && !x.password
    && !x.search && !x.hash;
}

describe("agnes redirect_uri must MATCH the allow-list", () => {
  it("accepts the 127.0.0.1 /auth/callback form 9router uses", () => {
    expect(agnesAllowsLoopbackPost("http://127.0.0.1:20128/auth/callback")).toBe(true);
  });

  it("rejects localhost (only the literal 127.0.0.1 matches)", () => {
    // "localhost" resolves to a loopback address but is not the literal string
    // the allow-list compares against, so the code would never be delivered.
    expect(agnesAllowsLoopbackPost("http://localhost:20128/auth/callback")).toBe(false);
  });

  it("rejects a LAN address (remote dashboard access cannot work)", () => {
    expect(agnesAllowsLoopbackPost("http://192.168.2.2:20128/auth/callback")).toBe(false);
  });

  it("requires the pathname to be exactly /auth/callback", () => {
    expect(agnesAllowsLoopbackPost("http://127.0.0.1:20128/callback")).toBe(false);
    expect(agnesAllowsLoopbackPost("http://127.0.0.1:20128/auth/callback/extra")).toBe(false);
  });

  it("rejects a missing port", () => {
    expect(agnesAllowsLoopbackPost("http://127.0.0.1/auth/callback")).toBe(false);
  });

  it("rejects any query or hash", () => {
    expect(agnesAllowsLoopbackPost("http://127.0.0.1:20128/auth/callback?x=1")).toBe(false);
    expect(agnesAllowsLoopbackPost("http://127.0.0.1:20128/auth/callback#f")).toBe(false);
  });

  it("rejects https (allow-list only accepts http:)", () => {
    expect(agnesAllowsLoopbackPost("https://127.0.0.1:20128/auth/callback")).toBe(false);
  });
});
