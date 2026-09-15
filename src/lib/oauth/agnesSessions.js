/**
 * In-memory registry of in-flight Agnes OAuth attempts, keyed by state.
 *
 * Agnes delivers the code by POSTing to /auth/callback from the *browser*, so
 * the exchange cannot run inside the request that produced the login URL.
 * The authorize route registers the attempt here; the callback route resolves
 * it and records the outcome; the modal polls until it sees a terminal state.
 *
 * Entries are short-lived (one login attempt) and are capped so a burst of
 * abandoned attempts cannot grow without bound.
 */

const SESSION_TTL_MS = 5 * 60 * 1000;
const MAX_SESSIONS = 100;

const sessions = new Map();

export function registerAgnesSession({ state, redirectUri }) {
  if (!state) return false;
  pruneSessions();
  sessions.set(state, {
    redirectUri: redirectUri || "",
    status: "pending",
    createdAt: Date.now(),
  });
  return true;
}

export function resolveAgnesSession(state) {
  const session = sessions.get(state);
  if (!session) return null;
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(state);
    return null;
  }
  return session;
}

export function getAgnesSessionStatus(state) {
  return resolveAgnesSession(state);
}

export function clearAgnesSession(state) {
  sessions.delete(state);
}

function pruneSessions() {
  const now = Date.now();
  for (const [state, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL_MS) sessions.delete(state);
  }
  // Hard cap in case many attempts land inside the TTL window.
  if (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
    for (let i = 0; i < oldest.length - MAX_SESSIONS + 1; i++) sessions.delete(oldest[i][0]);
  }
}
