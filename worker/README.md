# Save Station — Drive token broker (optional)

Deploy this and **the Google Drive connection stops expiring.** Skip it and the
site still works exactly as it does now — you just reconnect Drive when the
hour's token lapses.

## Why this exists

Google won't give a **refresh token** to a browser. Deliberately: they're good
for months, and sitting in JavaScript any XSS would walk off with one. They're
only issued through the authorization-code flow, to something holding a client
secret.

So a browser-only app gets a one-hour access token and nothing to renew it with.
Every site that stays permanently connected to your Drive has a backend doing
exactly what this Worker does. There is no browser-only version of it.

**Free.** Cloudflare's Workers free tier is 100,000 requests/day and KV is
100,000 reads/day, with no card required. This uses a couple of requests per
sign-in.

## What it stores

One Google **refresh token per user**, filed under their Firebase uid, plus
link-attempt states that expire in 10 minutes.

Never a save file. The token only carries the `drive.file` scope, so it reaches
the files Save Station created and nothing else in anyone's Drive.

**This is the trade-off:** your Worker now holds a key to each user's Save
Station folder. That's a real change from "we hold nothing" — worth making with
open eyes. Anyone can revoke theirs at any time from Account → Disconnect Google
Drive, or from their Google account permissions page.

## How a request is authorised

Every call carries the caller's Firebase ID token. The Worker verifies its RSA
signature against Google's published keys, checks the audience is your Firebase
project, the issuer is Google, and that it hasn't expired — then uses the `sub`
claim as the storage key. Since `sub` comes from a signed token rather than
anything the caller asserts, one user can't ask for another's Drive token.

## Deploy

### 1. Install wrangler and sign in

```bash
npm install -g wrangler
wrangler login
```

### 2. Register a workers.dev subdomain

Every Cloudflare account needs one before it can publish, and a fresh account
hasn't got one. Without it `wrangler deploy` stops with *"You need to register a
workers.dev subdomain"* and tries to invent one from your folder name.

Open **Workers & Pages** in the dashboard — visiting the page is enough to
register one:

```
https://dash.cloudflare.com/?to=/:account/workers-and-pages
```

It appears under **Account Details → Subdomain** on the right. To change it,
click the pencil beside it. (Wrangler's own error points at
`/workers/onboarding`, which is a dead URL now.)

Your Worker ends up at `save-station-drive.<subdomain>.workers.dev`.

### 3. Create the KV namespace

```bash
cd worker
wrangler kv namespace create TOKENS
```

It prints an `id`. Paste it into `wrangler.toml` over `PASTE_KV_NAMESPACE_ID`.

### 4. Add the client secret

Google Cloud console → **Clients** → **Save Station Web** → copy the **Client
secret** (same client the site already uses; it has one even though the browser
never touches it). Then:

```bash
wrangler secret put GOOGLE_CLIENT_SECRET
```

Paste it when prompted. It's stored encrypted by Cloudflare and never appears in
this repo — which is why it's a secret rather than a `[vars]` entry.

### 5. Set WORKER_ORIGIN and deploy

You already know the URL from step 2 — it's `save-station-drive` plus your
subdomain. Put it in `wrangler.toml` as `WORKER_ORIGIN`:

```toml
WORKER_ORIGIN = "https://save-station-drive.yourname.workers.dev"
```

Then:

```bash
wrangler deploy
```

The Worker builds this into its own redirect URI, so if it's wrong or still the
placeholder, Google rejects the callback with `redirect_uri_mismatch`.

### 6. Tell Google the callback is allowed

Google Cloud console → **Clients** → **Save Station Web** → **Authorized
redirect URIs** → **Add URI**:

```
https://save-station-drive.yourname.workers.dev/callback
```

Save. (This is the *redirect URI* box, not *JavaScript origins* — the browser
flow uses that one, this flow uses this one. Both can be set at once.)

### 7. Switch the site over

In `index.html`, near the top of the script:

```js
const WORKER_URL = "https://save-station-drive.yourname.workers.dev";
```

Commit and push. Leave it `""` and nothing changes.

### 8. Reconnect once

Existing users have no refresh token stored yet, so each signs in and hits
**Connect Google Drive** one final time. Google will show the consent screen —
that's the point, it's what produces the lasting permission. After that it
should never ask again.

## Checking it works

```bash
curl https://save-station-drive.yourname.workers.dev/health
```

`{"ok":true}` means it's up. Everything else needs a Firebase ID token, so the
real test is the site: connect Drive, close the browser entirely, reopen. You
should land straight in your library, and Account → **Drive session** should say
it's active.

## If something goes wrong

| Symptom | Cause |
|---|---|
| `#drive=exchange_failed` | Client secret wrong or missing — redo step 4 |
| `#drive=no_refresh_token` | Google skipped the lasting permission. The Worker already forces `prompt=consent`, so this usually means the redirect URI doesn't match step 6 exactly |
| `#drive=expired` | More than 10 minutes between starting and finishing the Google screen |
| `redirect_uri_mismatch` from Google | Step 6's URI doesn't match `WORKER_ORIGIN` character for character, `/callback` included |
| `You need to register a workers.dev subdomain` | Step 2 — the account hasn't got one yet |
| Everything 401s | `FIREBASE_PROJECT_ID` in `wrangler.toml` doesn't match the project in `index.html` |

## Turning it off

Set `WORKER_URL = ""` in `index.html` and push. The site drops back to the
browser flow immediately. Refresh tokens stay in KV until deleted — to clear
them out properly, have users hit **Disconnect Google Drive** first, or delete
the KV namespace.
