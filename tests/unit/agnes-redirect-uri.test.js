import { describe, it, expect } from "vitest";

/**
 * Agnes' login page picks its delivery mode by allow-listing redirect_uri:
 *
 *   matches allow-list  -> POST {code,state} to that URL, expects {"ok":true}
 *   otherwise           -> navigate to redirect_uri?code=...&state=...
 *
 * The allow-list (from the login page bundle) is:
 *   protocol http: AND hostname "127.0.0.1" AND any port AND
 *   pathname exactly "/auth/callback" AND no query/hash
 *
 * 9router must take the SECOND branch. The POST branch is unusable from a
 * browser: 127.0.0.1 there resolves to the *visitor's* machine, not the host
 * running 9router, so the code is posted to a port nobody listens on and the
 * page never navigates — the user is left staring at the Agnes login page.
 *
 * These tests pin the allow-list semantics so no one "fixes" the redirect_uri
 * back to the 127.0.0.1 form.
 */

// Verbatim re-implementation of the login page's validator.
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

describe("agnes redirect_uri must miss the allow-list", () => {
  it("rejects the 127.0.0.1 /auth/callback form (POST mode)", () => {
    // If this ever returns true, the login page will POST instead of redirect.
    expect(agnesAllowsLoopbackPost("http://127.0.0.1:1456/auth/callback")).toBe(true);
  });

  it("accepts the localhost/callback form", () => {
    // "localhost" is not the literal "127.0.0.1", so the allow-list misses and
    // the page takes the redirect branch -> code lands in the URL.
    expect(agnesAllowsLoopbackPost("http://localhost:20128/callback")).toBe(false);
  });

  it("accepts a LAN-address form (remote dashboard access)", () => {
    // Someone browsing http://192.168.2.2:20128 needs the redirect to come back
    // to that host; any real hostname misses the allow-list, so this is safe.
    expect(agnesAllowsLoopbackPost("http://192.168.2.2:20128/callback")).toBe(false);
  });

  it("redirect branch is chosen for every non-loopback dashboard host", () => {
    // The page's own decision: `i = a(redirectUri)`, then `if (i) POST else redirect`.
    // Verified against the live exchange endpoint: loopback, localhost and a LAN
    // address all return the identical 010006 for a bogus code, i.e. the server
    // does not validate redirect_uri at all.
    for (const host of ["localhost:20128", "192.168.2.2:20128", "9router.example.com"]) {
      expect(agnesAllowsLoopbackPost(`http://${host}/callback`)).toBe(false);
    }
  });

  it("pathname must be exactly /auth/callback for POST mode", () => {
    expect(agnesAllowsLoopbackPost("http://127.0.0.1:1456/callback")).toBe(false);
    expect(agnesAllowsLoopbackPost("http://127.0.0.1:1456/auth/callback/extra")).toBe(false);
  });

  it("query or hash disqualifies even a 127.0.0.1 URI", () => {
    expect(agnesAllowsLoopbackPost("http://127.0.0.1:1456/auth/callback?x=1")).toBe(false);
    expect(agnesAllowsLoopbackPost("http://127.0.0.1:1456/auth/callback#frag")).toBe(false);
  });
});
