// Local check of the SteamGridDB routes: node worker/test-sgdb.mjs
// SteamGridDB and Google's signing keys are stood in for, so this runs
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
const env = { FIREBASE_PROJECT_ID: PROJECT, SITE_ORIGIN: "https://example.github.io", TOKENS };

const GOOD = "abcdef0123456789abcdef0123456789";
const calls = [];
const img = (kind, n) => ({ id: n, url: "https://cdn2.steamgriddb.com/" + kind + "/" + n + ".png",
  thumb: "https://cdn2.steamgriddb.com/thumb/" + n + ".png", width: 512, height: 512, mime: "image/png", author: { name: "artist" } });
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.includes("securetoken@system")) return Response.json({ keys: [jwk] });
  if (url.startsWith("https://www.steamgriddb.com/api/v2")) {
    calls.push(url);
    if (init.headers.Authorization !== "Bearer " + GOOD) return new Response("{}", { status: 401 });
    const path = url.slice("https://www.steamgriddb.com/api/v2".length);
    if (path.startsWith("/search/autocomplete/")) {
      return Response.json({ success: true, data: [{ id: 5001, name: "Pokémon Emerald", release_date: 1095724800 }] });
    }
    const m = /^\/(icons|heroes|logos|grids)\/game\/(\d+)\?(.*)$/.exec(path);
    if (m) {
      assert.match(m[3], /nsfw=false/);
      return Response.json({ success: true, data: [img(m[1], m[2] + "a"), img(m[1], m[2] + "b")] });
    }
  }
  if (url.startsWith("https://cdn2.steamgriddb.com/")) return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { "Content-Type": "image/png" } });
  throw new Error("unexpected fetch " + url);
};

const post = async (path, body, token) => worker.fetch(new Request("https://w.example" + path, {
  method: "POST",
  headers: Object.assign({ "Content-Type": "application/json" }, token ? { Authorization: "Bearer " + token } : {}),
  body: JSON.stringify(body || {}),
}), env);
const j = async (r) => r.json();

const tok = await idToken("user-1");
const other = await idToken("user-2");

assert.equal((await post("/sgdb/status", {})).status, 401, "signed in only");
assert.deepEqual(await j(await post("/sgdb/status", {}, tok)), { connected: false });

// Not connected: art says so, nothing fetched
let a = await j(await post("/sgdb/art", { id: "folder1", name: "Pokemon Emerald" }, tok));
assert.equal(a.connected, false);
assert.equal(a.icon, null);

// Connecting: a wrong key is turned away, the right one kept
let r = await post("/sgdb/link", { key: "wrongwrongwrongwrong" }, tok);
assert.equal(r.status, 400);
assert.match((await j(r)).message, /didn't accept/);
r = await post("/sgdb/link", { key: GOOD }, tok);
assert.deepEqual(await j(r), { connected: true });
assert.equal(kv.get("sgdb:user-1"), GOOD);
assert.deepEqual(await j(await post("/sgdb/status", {}, tok)), { connected: true });
assert.deepEqual(await j(await post("/sgdb/status", {}, other)), { connected: false }, "one person's key is theirs");

// Art, found by itself: the best of each kind
a = await j(await post("/sgdb/art", { id: "folder1", name: "Pokemon Emerald" }, tok));
assert.equal(a.connected, true);
assert.deepEqual(a.game, { id: 5001, name: "Pokémon Emerald" });
assert.equal(a.icon.url, "https://cdn2.steamgriddb.com/icons/5001a.png");
assert.equal(a.hero.url, "https://cdn2.steamgriddb.com/heroes/5001a.png");
assert.equal(a.logo.url, "https://cdn2.steamgriddb.com/logos/5001a.png");
assert.deepEqual(a.picked, {});
const before = calls.length;
await post("/sgdb/art", { id: "folder1", name: "Pokemon Emerald" }, tok);
assert.equal(calls.length, before, "looked up once, then kept");

// The choices, for a picker
const s = await j(await post("/sgdb/search", { q: "emerald" }, tok));
assert.equal(s.results[0].year, 2004);
const list = await j(await post("/sgdb/assets", { gameId: 5001, kind: "hero", page: 0 }, tok));
assert.equal(list.items.length, 2);
assert.equal(list.items[1].author, "artist");
assert.equal((await post("/sgdb/assets", { gameId: "x", kind: "hero" }, tok)).status, 400);

// A pick wins, on every device; "none" shows nothing; clear goes back
r = await post("/sgdb/pick", { id: "folder1", kind: "hero", url: list.items[1].url, thumb: list.items[1].thumb }, tok);
assert.equal(r.status, 200);
a = await j(await post("/sgdb/art", { id: "folder1", name: "Pokemon Emerald" }, tok));
assert.equal(a.hero.url, "https://cdn2.steamgriddb.com/heroes/5001b.png");
assert.equal(a.hero.thumb, "https://cdn2.steamgriddb.com/thumb/5001b.png");
assert.equal(a.picked.hero, true);
await post("/sgdb/pick", { id: "folder1", kind: "logo", none: true }, tok);
a = await j(await post("/sgdb/art", { id: "folder1", name: "Pokemon Emerald" }, tok));
assert.equal(a.logo, null);
await post("/sgdb/pick", { id: "folder1", kind: "logo", clear: true }, tok);
a = await j(await post("/sgdb/art", { id: "folder1", name: "Pokemon Emerald" }, tok));
assert.equal(a.logo.url, "https://cdn2.steamgriddb.com/logos/5001a.png");
assert.equal((await post("/sgdb/pick", { id: "folder1", kind: "hero", url: "https://evil.example/x.png" }, tok)).status, 400,
  "only SteamGridDB's images");

// Another SteamGridDB game for it: its picks start over
await post("/sgdb/pick", { id: "folder1", kind: "game", game: { id: 7777, name: "Pokémon Emerald (Hack)" } }, tok);
a = await j(await post("/sgdb/art", { id: "folder1", name: "Pokemon Emerald" }, tok));
assert.deepEqual(a.game, { id: 7777, name: "Pokémon Emerald (Hack)" });
assert.equal(a.hero.url, "https://cdn2.steamgriddb.com/heroes/7777a.png");

// The 3DS: a short key per picture, and the picture by game and kind
a = await j(await post("/sgdb/art", { id: "folder1", name: "Pokemon Emerald" }, tok));
assert.equal(a.icon.key, "S7777a");
r = await post("/sgdb/file", { id: "folder1", name: "Pokemon Emerald", kind: "icon" }, tok);
assert.equal(r.status, 200);
assert.equal(r.headers.get("content-type"), "image/png");
await post("/sgdb/pick", { id: "folder1", kind: "hero", none: true }, tok);
assert.equal((await post("/sgdb/file", { id: "folder1", name: "Pokemon Emerald", kind: "hero" }, tok)).status, 404, "none: nothing to send");
assert.equal((await post("/sgdb/file", { id: "folder1", kind: "box" }, tok)).status, 400);

// The 3DS's way to an image
r = await post("/sgdb/image", { url: "https://cdn2.steamgriddb.com/thumb/5001a.png" }, tok);
assert.equal(r.status, 200);
assert.equal(r.headers.get("content-type"), "image/png");
assert.equal((await post("/sgdb/image", { url: "https://example.com/x.png" }, tok)).status, 400);

// A key SteamGridDB stops taking is dropped, and devices hear "connect again"
kv.set("sgdb:user-1", "revokedrevokedrevoked");
kv.delete("sgdba:7777:icon:0");
a = await j(await post("/sgdb/art", { id: "folder2", name: "Something Else" }, tok));
assert.equal(a.connected, false);
assert.equal(a.expired, true);
assert.equal(kv.get("sgdb:user-1"), undefined);

// Disconnecting
await post("/sgdb/link", { key: GOOD }, tok);
assert.deepEqual(await j(await post("/sgdb/unlink", {}, tok)), { connected: false });
assert.equal(kv.get("sgdb:user-1"), undefined);

console.log("worker SteamGridDB routes: all checks passed");
