// Local check of the password-reset email: node worker/test-reset.mjs
// Google, Firebase's admin API, Cloudflare Email Sending and Resend are all
// stood in for, so this runs offline and never sends a real email.
import assert from "node:assert";
import worker from "./src/index.js";

const PROJECT = "save-station-fd3a9";
const sa = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true, ["sign", "verify"]);
const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", sa.privateKey)).toString("base64");
const EMAIL_SA = "firebase-adminsdk-test@" + PROJECT + ".iam.gserviceaccount.com";
const SERVICE_ACCOUNT = JSON.stringify({
  client_email: EMAIL_SA,
  private_key: "-----BEGIN PRIVATE KEY-----\n" + pkcs8.match(/.{1,64}/g).join("\n") + "\n-----END PRIVATE KEY-----\n",
});

const kv = new Map();
const TOKENS = {
  async get(k) { const v = kv.get(k); return v === undefined ? null : v; },
  async put(k, v) { kv.set(k, v); },
  async delete(k) { kv.delete(k); },
};

const calls = { google: 0, oob: [], resend: [] };
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url === "https://oauth2.googleapis.com/token") {
    calls.google++;
    const body = new URLSearchParams(String(init.body));
    assert.equal(body.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [h, p, sig] = body.get("assertion").split(".");
    assert.ok(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", sa.publicKey, Buffer.from(sig, "base64url"),
      new TextEncoder().encode(h + "." + p)), "assertion signed by the service account");
    const claims = JSON.parse(Buffer.from(p, "base64url"));
    assert.equal(claims.iss, EMAIL_SA);
    assert.equal(claims.aud, "https://oauth2.googleapis.com/token");
    assert.match(claims.scope, /identitytoolkit/);
    return Response.json({ access_token: "g-token", expires_in: 3600 });
  }
  if (url === "https://identitytoolkit.googleapis.com/v1/projects/" + PROJECT + "/accounts:sendOobCode") {
    assert.equal(init.headers.Authorization, "Bearer g-token");
    const b = JSON.parse(init.body);
    calls.oob.push(b);
    assert.equal(b.requestType, "PASSWORD_RESET");
    assert.equal(b.returnOobLink, true, "Firebase makes the link and sends nothing itself");
    if (b.email === "nobody@example.com") return Response.json({ error: { message: "EMAIL_NOT_FOUND" } }, { status: 400 });
    return Response.json({ email: b.email, oobLink: "https://" + PROJECT + ".firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=CODE-123&apiKey=k&lang=en" });
  }
  if (url === "https://api.resend.com/emails") {
    assert.equal(init.headers.Authorization, "Bearer re_test");
    calls.resend.push(JSON.parse(init.body));
    return Response.json({ id: "r1" });
  }
  throw new Error("unexpected fetch " + url);
};

const sent = [];
const EMAIL = { async send(m) { sent.push(m); return { messageId: "m" + sent.length }; } };
const base = { FIREBASE_PROJECT_ID: PROJECT, SITE_ORIGIN: "https://savestation.net", SITE_URL: "https://savestation.net/", TOKENS, FIREBASE_SERVICE_ACCOUNT: SERVICE_ACCOUNT };
let ipN = 0;
const reset = (env, email, ip) => worker.fetch(new Request("https://w.example/reset", {
  method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip || "10.0.0." + (++ipN) },
  body: JSON.stringify({ email }),
}), env);

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log("  ✓ " + name); };

await test("with no email sender set up, it says so and the site falls back to Firebase's email", async () => {
  assert.equal((await reset(base, "jacob@example.com")).status, 501);
  const h = await (await worker.fetch(new Request("https://w.example/health"), base)).json();
  assert.equal(h.email, false);
});

const cf = Object.assign({}, base, { EMAIL });
await test("Cloudflare Email Sending: Save Station's own email, from noreply@savestation.net, linking to the site", async () => {
  const r = await reset(cf, "jacob@example.com");
  assert.equal(r.status, 200);
  assert.equal(sent.length, 1);
  const m = sent[0];
  assert.equal(m.to, "jacob@example.com");
  assert.deepEqual(m.from, { email: "noreply@savestation.net", name: "Save Station" });
  assert.equal(m.subject, "Save Station password reset");
  assert.ok(m.html.includes('href="https://savestation.net/?mode=resetPassword&amp;oobCode=CODE-123"'), "the button goes to the site's reset page");
  assert.ok(m.html.includes("https://savestation.net/assets/email-logo.png"));
  assert.ok(m.text.includes("https://savestation.net/?mode=resetPassword&oobCode=CODE-123"));
  assert.ok(!/fd3a9/.test(m.html + m.text + m.subject), "no project id anywhere in it");
  const h = await (await worker.fetch(new Request("https://w.example/health"), cf)).json();
  assert.equal(h.email, "cloudflare");
});

await test("asking again within a minute sends nothing more, and says the same", async () => {
  const r = await reset(cf, "Jacob@Example.com");
  assert.equal(r.status, 200);
  assert.equal(sent.length, 1);
});

await test("an address with no account gets the same answer and no email", async () => {
  const r = await reset(cf, "nobody@example.com");
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  assert.equal(sent.length, 1);
});

await test("the Google token is fetched once and reused", async () => {
  assert.equal(calls.google, 1);
});

await test("an address in a crafted email is escaped, not obeyed", async () => {
  await reset(cf, "a<b>\"x@example.com");
  const m = sent[sent.length - 1];
  assert.ok(!m.html.includes("<b>\"x@"), "markup in the address isn't sent as markup");
});

await test("not an email address: refused", async () => {
  assert.equal((await reset(cf, "not-an-email")).status, 400);
  assert.equal((await reset(cf, "")).status, 400);
});

await test("ten requests an hour from one IP, then no more", async () => {
  for (let i = 0; i < 10; i++) assert.equal((await reset(cf, "p" + i + "@example.com", "10.9.9.9")).status, 200);
  assert.equal((await reset(cf, "p10@example.com", "10.9.9.9")).status, 429);
});

await test("Resend works the same way when that's the sender", async () => {
  kv.clear();
  const env = Object.assign({}, base, { RESEND_API_KEY: "re_test" });
  assert.equal((await reset(env, "jacob@example.com")).status, 200);
  const m = calls.resend[0];
  assert.equal(m.from, "Save Station <noreply@savestation.net>");
  assert.deepEqual(m.to, ["jacob@example.com"]);
  assert.equal(m.subject, "Save Station password reset");
  assert.ok(m.html.includes("oobCode=CODE-123"));
});

await test("if the sender fails, the site is told, so it can fall back", async () => {
  kv.clear();
  const env = Object.assign({}, base, { EMAIL: { async send() { const e = new Error("nope"); e.code = "E_SENDER_NOT_VERIFIED"; throw e; } } });
  const r = await reset(env, "jacob@example.com");
  assert.equal(r.status, 502);
  assert.equal((await r.json()).detail, "E_SENDER_NOT_VERIFIED");
});

console.log("\n" + passed + " passed");
