// Local check of the IGDB game routes (the site's game search and game pages):
//   node worker/test-games.mjs
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

const queries = [];
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.includes("securetoken@system")) return Response.json({ keys: [jwk] });
  if (url.startsWith("https://id.twitch.tv/")) return Response.json({ access_token: "app-token", expires_in: 5000000 });
  if (url === "https://api.igdb.com/v4/games") {
    const q = String(init.body);
    queries.push(q);
    if (/^search /.test(q)) {
      return Response.json([
        { id: 1, name: "Pokémon Y", first_release_date: 1381449600, cover: { image_id: "co2y" },
          platforms: [{ id: 37, name: "Nintendo 3DS", abbreviation: "3DS" }] },
        { id: 2, name: "Pokémon Snap", first_release_date: 932169600,
          platforms: [{ id: 4, name: "Nintendo 64", abbreviation: "N64" }] },
      ]);
    }
    if (/where id = 99;/.test(q)) return Response.json([]);
    return Response.json([{
      id: 37382, name: "Pokémon Ultra Sun", summary: "Take on the role of a Pokémon Trainer.",
      first_release_date: 1510876800, url: "https://www.igdb.com/games/pokemon-ultra-sun",
      total_rating: 77.6, total_rating_count: 120,
      cover: { image_id: "co1us" }, artworks: [{ image_id: "ar1" }], screenshots: [{ image_id: "sc1" }, { image_id: "sc2" }],
      videos: [{ video_id: "yt123", name: "Trailer" }],
      genres: [{ name: "Role-playing (RPG)" }, { name: "Adventure" }],
      platforms: [{ id: 37, name: "Nintendo 3DS", abbreviation: "3DS" }],
      involved_companies: [
        { developer: true, publisher: false, company: { name: "Game Freak" } },
        { developer: false, publisher: true, company: { name: "Nintendo" } },
      ],
      parent_game: { id: 9999, name: "Pokémon Sun" },
    }]);
  }
  throw new Error("unexpected fetch " + url);
};

const post = async (path, body, token) => worker.fetch(new Request("https://w.example" + path, {
  method: "POST",
  headers: Object.assign({ "Content-Type": "application/json" }, token ? { Authorization: "Bearer " + token } : {}),
  body: JSON.stringify(body),
}), env);

const tok = await idToken("user-1");

let r = await post("/games/search", { q: "pokemon" });
assert.equal(r.status, 401, "signed in only");

r = await post("/games/search", { q: 'pokemon"; fields *' }, tok);
assert.equal(r.status, 200);
let d = await r.json();
assert.equal(d.results.length, 2, "games without a cover still show (as Backloggd's do)");
assert.deepEqual(d.results[0], { id: 1, name: "Pokémon Y", year: 2013, cover: "co2y",
  platforms: [{ id: 37, name: "Nintendo 3DS", abbr: "3DS", console: "3ds" }] });
assert.equal(d.results[1].platforms[0].console, null, "N64 isn't a Save Station console");
const q = queries[queries.length - 1];
assert.ok(!/"; fields \*/.test(q), "the search can't break out");
assert.match(q, /version_parent = null/, "not every edition of a game");

r = await post("/games/search", { q: "p" }, tok);
assert.deepEqual((await r.json()).results, [], "one letter is too few");

r = await post("/games/info", { id: 37382 }, tok);
assert.equal(r.status, 200);
const g = (await r.json()).game;
assert.equal(g.name, "Pokémon Ultra Sun");
assert.equal(g.released, "2017-11-17");
assert.equal(g.year, 2017);
assert.deepEqual(g.developers, ["Game Freak"]);
assert.deepEqual(g.publishers, ["Nintendo"]);
assert.deepEqual(g.parent, { id: 9999, name: "Pokémon Sun" });
assert.equal(g.versionOf, null);
assert.equal(g.hero, "ar1");
assert.deepEqual(g.screenshots, ["sc1", "sc2"]);
assert.deepEqual(g.videos, [{ id: "yt123", name: "Trailer" }]);
assert.equal(g.rating, 78);
assert.equal(g.platforms[0].console, "3ds");
assert.match(queries[queries.length - 1], /where id = 37382;/);

r = await post("/games/info", { id: "1; fields *" }, tok);
assert.equal(r.status, 400, "ids are numbers");
r = await post("/games/info", { id: 99 }, tok);
assert.equal(r.status, 404);

r = await post("/games/browse", { console: "3ds", offset: 30 }, tok);
assert.equal(r.status, 200);
d = await r.json();
assert.equal(d.results[0].name, "Pokémon Ultra Sun");
assert.equal(d.results[0].platforms[0].console, "3ds");
let bq = queries[queries.length - 1];
assert.match(bq, /platforms = \(37,137\)/, "one console's platforms");
assert.match(bq, /sort total_rating_count desc/);
assert.match(bq, /offset 30;/);
r = await post("/games/browse", { offset: "9; fields *" }, tok);
bq = queries[queries.length - 1];
assert.match(bq, /offset 0;/, "offsets are numbers");
assert.match(bq, /platforms = \(33,22,24,20,37,137,5,41,130,38,46\)/, "every Save Station console");
r = await post("/games/browse", {});
assert.equal(r.status, 401, "signed in only");

delete env.IGDB_CLIENT_SECRET;
r = await post("/games/search", { q: "pokemon" }, tok);
assert.deepEqual(await r.json(), { configured: false, results: [] });

console.log("worker game routes: all checks passed");
