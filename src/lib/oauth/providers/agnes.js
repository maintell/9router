import { AGNES_CONFIG } from "../constants/oauth.js";

// Agnes runs a private authorization-code variant: the login page takes
// `client` + `redirect_uri` + `state`, and the code is exchanged over a JSON
// POST (not a form-encoded token endpoint). The redirect_uri is not validated
// server-side, so a localhost callback works.
//
// NOTE: for a http://127.0.0.1 redirect_uri the login page POSTs
// {code,state} to that URL and expects {"ok":true} — it does not navigate
// with ?code=. The callback route must accept POST. The code lives 60s.
const agnes = {
  config: AGNES_CONFIG,
  flowType: "authorization_code",

  buildAuthUrl: (config, redirectUri, state) => {
    const params = new URLSearchParams({
      client: config.clientId,
      redirect_uri: redirectUri,
      state,
    });
    return `${config.authorizeUrl}?${params.toString()}`;
  },

  exchangeToken: async (config, code, redirectUri, _codeVerifier, state) => {
    const response = await fetch(config.exchangeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        code,
        redirect_uri: redirectUri,
        state,
        client_id: config.clientId,
      }),
    });
    const body = await response.json().catch(() => ({}));
    const accessToken = body?.data?.access_token;
    if (!response.ok || body?.code !== "000000" || !accessToken) {
      throw new Error(body?.message || `Agnes login failed (${response.status})`);
    }
    return {
      accessToken,
      // No refresh token exists; store the access token so the column stays
      // non-null and isAccessOnly() drives renewal.
      refreshToken: accessToken,
      expiresIn: body?.data?.expires_in ?? 86400,
    };
  },
};

export default agnes;
