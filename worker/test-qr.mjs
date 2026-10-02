// Local check of QR sign-in: node worker/test-qr.mjs
// Google's signing keys and the service account are both stood in for by keys
// made here, so this runs offline and never touches a real account.
import assert from "node:assert";
import worker from "./src/index.js";

const PROJECT = "save-station-fd3a9";
const rsa = () => crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true, ["sign", "verify"]);
const google = await rsa();
const jwk = Object.assign(await crypto.subtle.exportKey("jwk", google.publicKey), { kid: "test-key" });

// The stand-in service account, shaped like the JSON Firebase hands out.
const sa = await rsa();
const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", sa.privateKey)).toString("base64");
const SERVICE_ACCOUNT = JSON.stringify({
  type: "service_account", project_id: PROJECT,
  client_email: "firebase-adminsdk-test@" + PROJECT + ".iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\n" + pkcs8.match(/.{1,64}/g).join("\n") + "\n-----END PRIVATE KEY-----\n",
});

const b64url = (b) => Buffer.from(b).toString("base64url");
async function idToken(sub) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", kid: "test-key" }));
  const body = b64url(JSON.stringify({ aud: PROJECT, iss: "https://securetoken.google.com/" + PROJECT, sub, iat: now, exp: now + 600 }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", google.privateKey, new TextEncoder().encode(head + "." + body));
  return head + "." + body + "." + b64url(new Uint8Array(sig));
}

const kv = new Map();
const TOKENS = {
  async get(k) { const v = kv.get(k); return v === undefined ? null : v.value; },
  async put(k, value, opts) { kv.set(k, { value, ttl: opts && opts.expirationTtl }); },
  async delete(k) { kv.delete(k); },
};
globalThis.fetch = async (url) => {
  if (String(url).includes("securetoken@system")) return Response.json({ keys: [jwk] });
  throw new Error("unexpected fetch " + url);
};

const call = (env, path, body, token) => worker.fetch(new Request("https://w.example" + path, {
  method: "POST",
  headers: Object.assign({ "Content-Type": "application/json" }, token ? { Authorization: "Bearer " + token } : {}),
  body: JSON.stringify(body || {}),
}), env);

const env = { FIREBASE_PROJECT_ID: PROJECT, SITE_ORIGIN: "https://example.github.io", TOKENS, FIREBASE_SERVICE_ACCOUNT: SERVICE_ACCOUNT };
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log("  ✓ " + name); };

await test("without the service account, both routes say so and the site falls back", async () => {
  const bare = Object.assign({}, env, { FIREBASE_SERVICE_ACCOUNT: undefined });
  assert.equal((await call(bare, "/qr/start", {}, await idToken("user-1"))).status, 501);
  assert.equal((await call(bare, "/qr/claim", { code: "a".repeat(48) })).status, 501);
});

await test("starting needs a signed-in account", async () => {
  assert.equal((await call(env, "/qr/start", {})).status, 401);
  assert.equal((await call(env, "/qr/start", {}, "not.a.token")).status, 401);
});

let code;
await test("a signed-in computer gets a one-time code, filed under its uid for two minutes", async () => {
  const r = await call(env, "/qr/start", {}, await idToken("user-1"));
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.match(d.code, /^[0-9a-f]{48}$/);
  assert.equal(d.expires_in, 120);
  assert.deepEqual(kv.get("qr:" + d.code), { value: "user-1", ttl: 120 });
  code = d.code;
});

await test("the phone swaps it for a custom token for that uid, signed by the service account", async () => {
  const r = await call(env, "/qr/claim", { code });
  assert.equal(r.status, 200);
  const { token } = await r.json();
  const [head, body, sig] = token.split(".");
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", sa.publicKey,
    Buffer.from(sig, "base64url"), new TextEncoder().encode(head + "." + body));
  assert.ok(ok, "signature verifies with the service account's public key");
  assert.deepEqual(JSON.parse(Buffer.from(head, "base64url")), { alg: "RS256", typ: "JWT" });
  const p = JSON.parse(Buffer.from(body, "base64url"));
  const email = JSON.parse(SERVICE_ACCOUNT).client_email;
  assert.equal(p.uid, "user-1");
  assert.equal(p.iss, email);
  assert.equal(p.sub, email);
  assert.equal(p.aud, "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit");
  assert.equal(p.exp - p.iat, 3600);
});

await test("a code works once", async () => {
  assert.equal((await call(env, "/qr/claim", { code })).status, 410);
});

await test("made-up and malformed codes get nothing", async () => {
  assert.equal((await call(env, "/qr/claim", { code: "b".repeat(48) })).status, 410);
  assert.equal((await call(env, "/qr/claim", { code: "../rt:user-1" })).status, 400);
  assert.equal((await call(env, "/qr/claim", {})).status, 400);
});

await test("a key pasted with its line breaks turned real still works, and /health says what's wrong if not", async () => {
  const health = async (e) => (await worker.fetch(new Request("https://w.example/health"), e)).json();
  const h = await health(env);
  assert.equal(h.qr, true);
  assert.equal(h.qr_problem, undefined);
  // The key's "\n"s turned into real line breaks: no longer JSON.
  const mangled = SERVICE_ACCOUNT.replace(/\\n/g, "\n");
  assert.throws(() => JSON.parse(mangled));
  const e2 = Object.assign({}, env, { FIREBASE_SERVICE_ACCOUNT: mangled });
  assert.equal((await health(e2)).qr, true);
  const r = await call(e2, "/qr/start", {}, await idToken("user-2"));
  const r2 = await call(e2, "/qr/claim", { code: (await r.json()).code });
  assert.equal(r2.status, 200);
  const problem = async (v) => (await health(Object.assign({}, env, { FIREBASE_SERVICE_ACCOUNT: v }))).qr_problem;
  assert.equal(await problem(""), "missing");
  assert.equal(await problem('{"client_email":"a@b"}'), "no_private_key");
  assert.equal(await problem('{"private_key":"-----BEGIN PRIVATE KEY-----x-----END PRIVATE KEY-----"}'), "no_client_email");
  assert.equal(await problem('{"client_email":"a@b","private_key":"-----BEGIN PRIVATE KEY-----AAAA-----END PRIVATE KEY-----"}'), "bad_private_key");
});

console.log("\n" + passed + " passed");
