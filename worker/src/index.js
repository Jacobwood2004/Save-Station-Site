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
 *
 * It also pairs devices for QR sign-in (see "QR sign-in" below), which is the
 * one thing that needs the Firebase service-account key.
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

/* ------------------------------------------------------------ QR sign-in
 *
 * A phone scans a code on a signed-in computer and ends up signed into the
 * same Save Station account, with a Firebase session of its own. (It used to
 * borrow the computer's Drive token instead, which left it with Drive for an
 * hour and no account: password reset and the rest said it wasn't signed in.)
 *
 *   1. The computer POSTs /qr/start with its Firebase ID token. We file a
 *      random one-time code under its uid for QR_TTL seconds, and the code is
 *      all the QR carries.
 *   2. The phone POSTs /qr/claim with the code. We take it, once, and answer
 *      with a Firebase custom token for that uid, signed with the project's
 *      service-account key. The phone trades that for a normal session.
 *
 * Needs the secret FIREBASE_SERVICE_ACCOUNT: the JSON key from Firebase →
 * Project settings → Service accounts → Generate new private key. Without it
 * both routes answer 501 and the site falls back to lending the Drive token.
 */

const QR_TTL = 120;
const QR_KEY = (c) => `qr:${c}`;
const CUSTOM_TOKEN_AUD =
  "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit";

function serviceAccount(env) {
  if (!env.FIREBASE_SERVICE_ACCOUNT) return null;
  try {
    const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
    return sa && sa.client_email && sa.private_key ? sa : null;
  } catch (e) {
    return null;
  }
}

function bytesToB64url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

let signingKey = { pem: null, key: null };
async function importPrivateKey(pem) {
  if (signingKey.pem === pem) return signingKey.key;
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const key = await crypto.subtle.importKey(
    "pkcs8", b64urlToBytes(body), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  signingKey = { pem, key };
  return key;
}

// A Firebase custom token: a JWT the service account signs, saying "this is
// uid X". Firebase only takes it from someone holding the project's key.
async function mintCustomToken(uid, sa, now) {
  const iat = now || Math.floor(Date.now() / 1000);
  const enc = (o) => bytesToB64url(new TextEncoder().encode(JSON.stringify(o)));
  const input = enc({ alg: "RS256", typ: "JWT" }) + "." +
    enc({ iss: sa.client_email, sub: sa.client_email, aud: CUSTOM_TOKEN_AUD, iat, exp: iat + 3600, uid });
  const key = await importPrivateKey(sa.private_key);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input));
  return input + "." + bytesToB64url(new Uint8Array(sig));
}

async function handleQrStart(request, env) {
  if (!serviceAccount(env)) return json({ error: "qr_not_configured" }, 501, env);
  const uid = await requireUid(request, env);
  const code = randomToken(24);
  await env.TOKENS.put(QR_KEY(code), uid, { expirationTtl: QR_TTL });
  return json({ code, expires_in: QR_TTL }, 200, env);
}

async function handleQrClaim(request, env) {
  const sa = serviceAccount(env);
  if (!sa) return json({ error: "qr_not_configured" }, 501, env);
  let code = "";
  try { code = String((await request.json()).code || ""); } catch (e) { /* stays empty */ }
  if (!/^[0-9a-f]{48}$/.test(code)) return json({ error: "bad_code" }, 400, env);
  const uid = await env.TOKENS.get(QR_KEY(code));
  if (!uid) return json({ error: "expired" }, 410, env);
  await env.TOKENS.delete(QR_KEY(code));          // one phone per code
  let token;
  try {
    token = await mintCustomToken(uid, sa);
  } catch (e) {
    return json({ error: "qr_key_invalid" }, 500, env);
  }
  return json({ token }, 200, env);
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

/* ---------------------------------------------------------- covers (IGDB)
   Box art from IGDB, the database Backloggd and most game trackers use. Every
   cover there comes back from IGDB's own image server at fixed sizes, so a
   library of them lines up perfectly — and unlike libretro, it has Switch.

   IGDB's API needs a Twitch app's client secret, which can't live in a web
   page, and it won't answer a browser anyway. So the site and the desktop app
   ask here; this holds the secret and the app token, and hands back covers.

   Optional: with IGDB_CLIENT_ID / IGDB_CLIENT_SECRET unset, /covers/search
   says { configured: false } and both clients fall back to libretro. */

const TWITCH_TOKEN = "https://id.twitch.tv/oauth2/token";
const IGDB_GAMES = "https://api.igdb.com/v4/games";
const IGDB_TOKEN_KEY = "igdb:token";
const igdbImage = (size, id) => `https://images.igdb.com/igdb/image/upload/t_${size}/${id}.jpg`;

// Save Station's console ids -> IGDB platform ids.
const IGDB_PLATFORMS = {
  gb: [33], gbc: [22], gba: [24], nds: [20], "3ds": [37, 137],
  wii: [5], wiiu: [41], switch: [130], psp: [38], vita: [46],
};

let igdbToken = { value: null, exp: 0 };

function igdbConfigured(env) {
  return !!(env.IGDB_CLIENT_ID && env.IGDB_CLIENT_SECRET);
}

// A Twitch app token: kept in memory, and in KV so cold starts share it.
// They last about two months; this renews a day early.
async function igdbAccessToken(env) {
  if (igdbToken.value && Date.now() < igdbToken.exp) return igdbToken.value;
  const cached = await env.TOKENS.get(IGDB_TOKEN_KEY, "json");
  if (cached && cached.value && Date.now() < cached.exp) {
    igdbToken = cached;
    return cached.value;
  }
  const r = await fetch(TWITCH_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.IGDB_CLIENT_ID,
      client_secret: env.IGDB_CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });
  if (!r.ok) throw new Error("igdb_login_failed");
  const t = await r.json();
  const ttl = Math.max(3600, (t.expires_in || 86400) - 86400);
  igdbToken = { value: t.access_token, exp: Date.now() + ttl * 1000 };
  await env.TOKENS.put(IGDB_TOKEN_KEY, JSON.stringify(igdbToken), { expirationTtl: ttl });
  return igdbToken.value;
}

async function igdbGames(env, query, retried) {
  const r = await fetch(IGDB_GAMES, {
    method: "POST",
    headers: {
      "Client-ID": env.IGDB_CLIENT_ID,
      Authorization: "Bearer " + (await igdbAccessToken(env)),
      Accept: "application/json",
      "Content-Type": "text/plain",
    },
    body: query,
  });
  if (r.status === 401 && !retried) {
    // Revoked or rotated early: drop it and log in again, once.
    igdbToken = { value: null, exp: 0 };
    await env.TOKENS.delete(IGDB_TOKEN_KEY);
    return igdbGames(env, query, true);
  }
  if (!r.ok) throw new Error("igdb_failed_" + r.status);
  return r.json();
}

// IGDB's query language quotes the search term; keep it to plain text.
function igdbTerm(s) {
  return String(s || "").replace(/["\\;]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
}

async function handleCoverSearch(request, env) {
  await requireUid(request, env);
  if (!igdbConfigured(env)) return json({ configured: false, results: [] }, 200, env);
  let input = {};
  try { input = await request.json(); } catch (e) { /* treated as an empty search */ }
  const term = igdbTerm(input.name);
  if (!term) return json({ configured: true, results: [] }, 200, env);

  const platforms = IGDB_PLATFORMS[input.console] || null;
  const base = `search "${term}"; fields name,first_release_date,cover.image_id; where cover != null`;
  let games = await igdbGames(env, base + (platforms ? ` & platforms = (${platforms.join(",")})` : "") + "; limit 12;");
  // Nothing listed for that console — a hack filed under its base game, say —
  // so look across every platform rather than come back empty.
  let anyPlatform = false;
  if (!games.length && platforms) {
    games = await igdbGames(env, base + "; limit 12;");
    anyPlatform = true;
  }
  const results = games
    .filter((g) => g.cover && g.cover.image_id)
    .map((g) => ({
      id: g.cover.image_id,
      title: g.name,
      year: g.first_release_date ? new Date(g.first_release_date * 1000).getUTCFullYear() : null,
      thumb: igdbImage("cover_big", g.cover.image_id),
    }));
  return json({ configured: true, anyPlatform, results }, 200, env);
}

// The chosen cover's bytes, at IGDB's fixed "cover_big_2x" size, passed
// through so the page can copy it into the user's Drive.
async function handleCoverImage(request, env) {
  await requireUid(request, env);
  let input = {};
  try { input = await request.json(); } catch (e) { /* falls to bad_request */ }
  const id = String(input.id || "");
  if (!/^[a-z0-9]{4,40}$/i.test(id)) return json({ error: "bad_request" }, 400, env);
  const r = await fetch(igdbImage("cover_big_2x", id));
  if (!r.ok) return json({ error: "not_found" }, 404, env);
  return new Response(r.body, {
    status: 200,
    headers: {
      "Content-Type": r.headers.get("Content-Type") || "image/jpeg",
      "Cache-Control": "private, max-age=86400",
      ...corsHeaders(env),
    },
  });
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
      if (url.pathname === "/qr/start" && request.method === "POST") {
        return await handleQrStart(request, env);
      }
      if (url.pathname === "/qr/claim" && request.method === "POST") {
        return await handleQrClaim(request, env);
      }
      if (url.pathname === "/covers/search" && request.method === "POST") {
        return await handleCoverSearch(request, env);
      }
      if (url.pathname === "/covers/image" && request.method === "POST") {
        return await handleCoverImage(request, env);
      }
      if (url.pathname === "/health") {
        return json({ ok: true, linked: "n/a", covers: igdbConfigured(env), qr: !!serviceAccount(env) }, 200, env);
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
export const _internals = { verifyFirebaseToken, b64urlToBytes, b64urlToString, mintCustomToken };
