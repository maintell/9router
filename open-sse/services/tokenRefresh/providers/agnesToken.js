import { dedupRefresh } from "../dedup.js";

const AGNES_REFRESH_URL =
  "https://api-agnes-code.agnes-ai.com/api/v1/user/refresh-token";

const DEFAULT_EXPIRES_IN = 86400;

/**
 * Agnes has no refresh_token: renewal means presenting the current access_token
 * and receiving a new one. Returns the shape other refreshers return so the
 * shared write-back path works unchanged.
 */
export async function refreshAgnesToken(accessToken, log) {
  if (!accessToken) return null;
  return dedupRefresh("agnes", accessToken, async () => {
    const response = await fetch(AGNES_REFRESH_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const body = await response.json().catch(() => ({}));
    const next = body?.data?.access_token;
    if (!response.ok || body?.code !== "000000" || !next) {
      throw new Error(body?.message || `Agnes refresh failed (${response.status})`);
    }
    // refreshToken is set to the old token purely so the DB column stays
    // non-null for downstream code; Agnes never issues one.
    return {
      accessToken: next,
      refreshToken: accessToken,
      expiresIn: body?.data?.expires_in ?? DEFAULT_EXPIRES_IN,
    };
  });
}
