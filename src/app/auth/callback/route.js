import { NextResponse } from "next/server";
import { exchangeTokens } from "@/lib/oauth/providers";
import { registerAgnesSession, resolveAgnesSession } from "@/lib/oauth/agnesSessions";
import { createProviderConnection } from "@/models";

export const dynamic = "force-dynamic";

/**
 * POST /auth/callback — Agnes' CLI delivery endpoint.
 *
 * Agnes' login page only hands back an authorization code when the
 * redirect_uri passes its allow-list:
 *
 *   protocol http: AND hostname "127.0.0.1" AND any port AND
 *   pathname exactly "/auth/callback" AND no query/hash
 *
 * When it matches, the page POSTs JSON {code,state} here (from the visitor's
 * browser) and expects {"ok":true}. If the allow-list misses, the page just
 * navigates home and no code is ever delivered — so this exact path is not
 * cosmetic, it is what selects the delivery branch.
 *
 * Because the browser resolves 127.0.0.1 locally, this route is only reachable
 * when the dashboard itself is opened over a loopback address (browsing on the
 * server, or an SSH tunnel forwarding the dashboard port). That is an Agnes
 * constraint, not a 9router one — AgnesCode's own desktop app works the same
 * way, listening on the user's loopback interface.
 */
export async function POST(request) {
  let code = null;
  let state = null;

  try {
    const url = new URL(request.url);
    code = url.searchParams.get("code");
    state = url.searchParams.get("state");

    const raw = await request.text();
    if (raw) {
      try {
        const body = JSON.parse(raw);
        code = body.code ?? code;
        state = body.state ?? state;
      } catch {
        /* non-JSON body: fall back to the query string */
      }
    }
  } catch {
    /* ignore parse failures and fall through to validation */
  }

  if (!code || !state) {
    return NextResponse.json({ ok: false, error: "missing code or state" }, { status: 400 });
  }

  const session = resolveAgnesSession(state);
  if (!session) {
    return NextResponse.json({ ok: false, error: "unknown or expired state" }, { status: 400 });
  }

  try {
    const tokenData = await exchangeTokens("agnes", code, session.redirectUri, undefined, state);
    const connection = await createProviderConnection({
      provider: "agnes",
      authType: "oauth",
      ...tokenData,
      expiresAt: tokenData.expiresIn
        ? new Date(Date.now() + tokenData.expiresIn * 1000).toISOString()
        : null,
      testStatus: "active",
    });

    session.status = "done";
    session.connectionId = connection.id;
    session.email = connection.email;
    return NextResponse.json({ ok: true });
  } catch (err) {
    session.status = "error";
    session.error = err?.message || "exchange failed";
    return NextResponse.json({ ok: false, error: session.error }, { status: 502 });
  }
}

// Registering happens from the authorize route; keep the import used so the
// session module is not tree-shaken in builds that only import this file.
export const _registerAgnesSession = registerAgnesSession;
