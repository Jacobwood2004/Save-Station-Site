// Local check of the IGDB cover routes: node worker/test-covers.mjs
// Twitch, IGDB and Google's signing keys are all stood in for, so this runs
// offline and never touches a real account.
import assert from "node:assert";
import worker from "./src/index.js";

const PROJECT = "save-station-fd3a9";
const { privateKey, publicKey } = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true, ["sign", "verify"]);
const jwk = Object.assign(await crypto.subtle.exportKey("jwk", publicKey), { kid: "test-key" });

const b64url = (b) => Buffer.from(b).toString("base64url");
async function idToken(sub) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", kid: "test-key" }));
  const body = b64url(JSON.stringify({ aud: PROJECT, iss: "https://securetoken.google.com/" + PROJECT, sub, iat: now, exp: now + 600 }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(head + "." + body));
  return head + "." + body + "." + b64url(new Uint8Array(sig));
}

const kv = new Map();
const TOKENS = {
  async get(k, type) { const v = kv.get(k); return v === undefined ? null : type === "json" ? JSON.parse(v) : v; },
  async put(k, v) { kv.set(k, v); },
  async delete(k) { kv.delete(k); },
};
const env = { FIREBASE_PROJECT_ID: PROJECT, SITE_ORIGIN: "https://example.github.io", TOKENS,
              IGDB_CLIENT_ID: "cid", IGDB_CLIENT_SECRET: "secret" };

const calls = [];
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  calls.push({ url, body: init.body ? String(init.body) : "" });
  if (url.includes("securetoken@system")) return Response.json({ keys: [jwk] });
  if (url.startsWith("https://id.twitch.tv/")) return Response.json({ access_token: "app-token", expires_in: 5000000 });
  if (url === "https://api.igdb.com/v4/games") {
    assert.equal(init.headers["Client-ID"], "cid");
    assert.equal(init.headers.Authorization, "Bearer app-token");
    const onPlatform = /platforms = \(24\)/.test(init.body);
    if (/search "Nothing Here"/.test(init.body) && onPlatform) return Response.json([]);
    return Response.json([
      { id: 1, name: "Pokemon Emerald Version", first_release_date: 1095724800, cover: { image_id: "co1abc" } },
      { id: 2, name: "No Cover Game" },
    ]);
  }
  if (url.startsWith("https://images.igdb.com/")) {
    assert.match(url, /t_cover_big_2x\/co1abc\.jpg$/);
    return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { "Content-Type": "image/jpeg" } });
  }
  throw new Error("unexpected fetch " + url);
};

const post = async (path, body, token) => worker.fetch(new Request("https://w.example" + path, {
  method: "POST",
  headers: Object.assign({ "Content-Type": "application/json" }, token ? { Authorization: "Bearer " + token } : {}),
  body: JSON.stringify(body),
}), env);

const tok = await idToken("user-1");

let r = await post("/covers/search", { name: "Pokemon Emerald", console: "gba" });
assert.equal(r.status, 401, "no token, no covers");

r = await post("/covers/search", { name: 'Pokemon "Emerald"; fields *', console: "gba" }, tok);
assert.equal(r.status, 200);
let d = await r.json();
assert.equal(d.configured, true);
assert.equal(d.results.length, 1, "games without a cover are left out");
assert.deepEqual(d.results[0], { id: "co1abc", title: "Pokemon Emerald Version", year: 2004,
  thumb: "https://images.igdb.com/igdb/image/upload/t_cover_big/co1abc.jpg" });
const q = calls.filter((c) => c.url.includes("api.igdb.com")).pop().body;
assert.ok(!/"Emerald"/.test(q) && !/; fields \*/.test(q), "quotes and semicolons can't break out of the search");
assert.match(q, /platforms = \(24\)/, "filtered to GBA");
assert.equal(r.headers.get("access-control-allow-origin"), "https://example.github.io");

const twitchLogins = () => calls.filter((c) => c.url.startsWith("https://id.twitch.tv/")).length;
await post("/covers/search", { name: "Pokemon Emerald", console: "gba" }, tok);
assert.equal(twitchLogins(), 1, "the Twitch app token is reused");

r = await post("/covers/search", { name: "Nothing Here", console: "gba" }, tok);
d = await r.json();
assert.equal(d.anyPlatform, true, "falls back to every platform");
assert.equal(d.results.length, 1);

r = await post("/covers/image", { id: "co1abc" }, tok);
assert.equal(r.status, 200);
assert.equal(r.headers.get("content-type"), "image/jpeg");
r = await post("/covers/image", { id: "../../etc" }, tok);
assert.equal(r.status, 400, "only IGDB image ids");

delete env.IGDB_CLIENT_SECRET;
r = await post("/covers/search", { name: "Pokemon Emerald", console: "gba" }, tok);
assert.deepEqual(await r.json(), { configured: false, results: [] }, "unset secrets mean libretro only");

r = await worker.fetch(new Request("https://w.example/health"), env);
assert.equal((await r.json()).covers, false);

console.log("worker cover routes: all checks passed");
