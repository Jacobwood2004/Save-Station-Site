/**
 * Save Station — Drive token broker
 * =================================
 * The one job a browser can't do: hold a Google **refresh token**.
 *
 * Google won't issue refresh tokens to browser apps, and rightly so — they're
 * good for months, and in JavaScript any XSS would walk off with one. They're
 * only issued through the authorization-code flow, to something holding a client
 * secret. That's this Worker.
 *
 * Flow
 *   1. Browser (signed into Save Station) POSTs its Firebase ID token to
 *      /link/start. We verify it, mint a one-time `state`, and hand back the
 *      Google consent URL.
 *   2. Google bounces the user to /callback with a code. We swap it for an
 *      access token + refresh token, and file the refresh token under that
 *      user's Firebase uid.
 *   3. From then on the browser POSTs to /token whenever it needs Drive access.
 *      We mint a fresh access token from the stored refresh token.
 *
 * What stops one user pulling another's token: every call carries a Firebase ID
 * token, we verify its RSA signature against Google's published keys, and the
 * `sub` claim — not anything the caller can assert — is the storage key.
 *
 * Stored per user: a Google refresh token. Never a save file, never anything
 * else in their Drive. The token only covers `drive.file`, so it reaches the
 * files this app created and nothing more.
 */

const JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE = "https://oauth2.googleapis.com/revoke";
const SCOPE = "https://www.googleapis.com/auth/drive.file";

const STATE_TTL = 600;        // seconds a pending link is valid
const REFRESH_KEY = (uid) => `rt:${uid}`;
const STATE_KEY = (s) => `st:${s}`;

/* ------------------------------------------------------------------ utils */

function b64urlToBytes(s) {
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToString(s) {
  return new TextDecoder().decode(b64urlToBytes(s));
}

function randomToken(bytes) {
  const a = new Uint8Array(bytes || 32);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.SITE_ORIGIN || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(body, status, env) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { "Content-Type": "application/json", ...corsHeaders(env) },
  });
}

/* -------------------------------------------------- Firebase ID token check */

let jwksCache = { at: 0, keys: null };

async function getJwks() {
  // Google rotates these; an hour is well inside the rotation window.
  if (jwksCache.keys && Date.now() - jwksCache.at < 3600e3) return jwksCache.keys;
  const r = await fetch(JWKS_URL);
  if (!r.ok) throw new Error("could not fetch Google signing keys");
  const data = await r.json();
  jwksCache = { at: Date.now(), keys: data.keys || [] };
  return jwksCache.keys;
}

/**
 * Verify a Firebase ID token and return its uid. Throws on anything suspect —
 * a bad signature, the wrong project, or an expired token.
 */
async function verifyFirebaseToken(token, projectId) {
  if (!token || token.split(".").length !== 3) throw new Error("malformed token");
  const [rawHeader, rawPayload, rawSig] = token.split(".");

  let header, payload;
  try {
    header = JSON.parse(b64urlToString(rawHeader));
    payload = JSON.parse(b64urlToString(rawPayload));
  } catch (e) {
    throw new Error("unreadable token");
  }

  // Claim checks first — cheap, and they catch the obvious forgeries.
  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== projectId) throw new Error("token is for a different project");
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) throw new Error("bad issuer");
  if (!payload.sub) throw new Error("token has no subject");
  if (typeof payload.exp !== "number" || payload.exp <= now) throw new Error("token expired");
  if (typeof payload.iat === "number" && payload.iat > now + 300) throw new Error("token from the future");
  if (header.alg !== "RS256") throw new Error("unexpected signing algorithm");

  // Then the signature, which is what actually makes it trustworthy.
  const keys = await getJwks();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("unknown signing key");

  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.n ? "RSA" : jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(rawSig),
    new TextEncoder().encode(`${rawHeader}.${rawPayload}`)
  );
  if (!ok) throw new Error("signature does not verify");

  return payload.sub;
}

async function requireUid(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) throw new Error("missing Authorization header");
  return await verifyFirebaseToken(m[1].trim(), env.FIREBASE_PROJECT_ID);
}

/* ----------------------------------------------------------------- routes */

// 1. Begin linking: hand back the Google consent URL for this user.
async function handleLinkStart(request, env) {
  const uid = await requireUid(request, env);
  const state = randomToken(24);
  await env.TOKENS.put(STATE_KEY(state), uid, { expirationTtl: STATE_TTL });

  const url = new URL(GOOGLE_AUTH);
  url.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", `${env.WORKER_ORIGIN}/callback`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("state", state);
  // offline + consent is what actually produces a refresh token. Without the
  // explicit consent prompt Google skips it for a user who has approved before,
  // and we'd be right back to hourly re-linking.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  return json({ url: url.toString() }, 200, env);
}

// 2. Google sends the user back here with a code.
async function handleCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const err = url.searchParams.get("error");
  const back = (hash) => Response.redirect(`${env.SITE_URL}#${hash}`, 302);

  if (err) return back(`drive=denied`);
  if (!code || !state) return back("drive=bad_request");

  const uid = await env.TOKENS.get(STATE_KEY(state));
  if (!uid) return back("drive=expired");        // replayed or stale
  await env.TOKENS.delete(STATE_KEY(state));     // strictly one use

  const body = new URLSearchParams({
    code,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: `${env.WORKER_ORIGIN}/callback`,
    grant_type: "authorization_code",
  });
  const r = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) return back("drive=exchange_failed");
  const tok = await r.json();
  if (!tok.refresh_token) return back("drive=no_refresh_token");

  await env.TOKENS.put(REFRESH_KEY(uid), tok.refresh_token);
  return back("drive=ok");
}

// 3. Mint an access token from the stored refresh token.
async function handleToken(request, env) {
  const uid = await requireUid(request, env);
  const refresh = await env.TOKENS.get(REFRESH_KEY(uid));
  if (!refresh) return json({ error: "not_linked" }, 404, env);

  const r = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refresh,
      grant_type: "refresh_token",
    }),
  });
  if (!r.ok) {
    // A refresh token dies if the user revokes access in their Google account,
    // or if it goes unused for six months. Drop it so the app re-links cleanly
    // instead of retrying something that will never work again.
    const detail = await r.text();
    if (/invalid_grant/.test(detail)) {
      await env.TOKENS.delete(REFRESH_KEY(uid));
      return json({ error: "not_linked" }, 404, env);
    }
    return json({ error: "refresh_failed" }, 502, env);
  }
  const tok = await r.json();
  return json({ access_token: tok.access_token, expires_in: tok.expires_in || 3600 }, 200, env);
}

// 4. Deliberately give up access.
async function handleUnlink(request, env) {
  const uid = await requireUid(request, env);
  const refresh = await env.TOKENS.get(REFRESH_KEY(uid));
  if (refresh) {
    try {
      await fetch(GOOGLE_REVOKE, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: refresh }),
      });
    } catch (e) { /* revoking is best-effort; dropping our copy is what counts */ }
    await env.TOKENS.delete(REFRESH_KEY(uid));
  }
  return json({ ok: true }, 200, env);
}

/* ------------------------------------------------------------------ entry */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    try {
      if (url.pathname === "/callback" && request.method === "GET") {
        return await handleCallback(request, env);
      }
      if (url.pathname === "/link/start" && request.method === "POST") {
        return await handleLinkStart(request, env);
      }
      if (url.pathname === "/token" && request.method === "POST") {
        return await handleToken(request, env);
      }
      if (url.pathname === "/unlink" && request.method === "POST") {
        return await handleUnlink(request, env);
      }
      if (url.pathname === "/health") {
        return json({ ok: true, linked: "n/a" }, 200, env);
      }
      return json({ error: "not_found" }, 404, env);
    } catch (e) {
      // Anything thrown by requireUid is an auth failure; don't leak details
      // beyond the reason, and never echo the token back.
      const msg = String((e && e.message) || e);
      const auth = /token|Authorization|signature|issuer|project|expired/i.test(msg);
      return json({ error: auth ? "unauthorized" : "server_error", detail: msg },
                  auth ? 401 : 500, env);
    }
  },
};

// Exported for the local test harness.
export const _internals = { verifyFirebaseToken, b64urlToBytes, b64urlToString };
