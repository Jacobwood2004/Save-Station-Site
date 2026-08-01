# 🎮 Save Station Web

Back up your **Delta** and **mGBA** emulator saves to your own **Google Drive**.
Sign in with Google, drop in a `.sav`, and it's versioned in a per-game folder so
you can restore any backup from any device — and see which device each one came from.

- **Login gate:** nothing happens until you sign in with Google.
- **Your Drive is the storage.** On first use it creates a folder named
  **`Save Station Web Saves`**.
- **Per-game folders + full history.** Each game gets its own subfolder; every
  upload is a new timestamped file, so old backups are never overwritten.
- **Game name auto-detected** from the file name, editable before you upload.
- **Device shown** on every save in the history.
- **Windows companion app** (`windows-app/`) pulls the latest/any save to your PC.

---

## ⚠️ Why this isn't a "Claude Artifact"

Claude Artifacts block all outside network calls, so they **cannot** talk to
Google. This is a normal standalone web page you host yourself — that's the only
way real Google Drive login/sync works. Hosting is free (see below).

---

## Setup — get your Google Client ID (about 5 minutes)

You need one free Google OAuth "Web" client ID. Do this once:

1. **Create a project** at <https://console.cloud.google.com> (or reuse one).
2. **Enable the Drive API:** APIs & Services → Library → search **Google Drive API** → **Enable**.
3. **Configure the consent screen:** APIs & Services → OAuth consent screen.
   - User type **External**, fill in the app name + your email.
   - Add the scopes `.../auth/drive.file` and `userinfo.email` (optional).
   - Under **Test users**, add your own Google account. (Keeps it in "Testing"
     mode — fine for personal use, no Google verification needed.)
4. **Create the client ID:** APIs & Services → Credentials →
   **Create Credentials → OAuth client ID → Web application**.
   - Under **Authorized JavaScript origins**, add the exact origin you'll open
     the site from. Add each that applies:
     - `http://localhost:8000` (local testing)
     - `https://YOURNAME.github.io` (GitHub Pages)
   - Create, then copy the **Client ID** (looks like `1234-abc.apps.googleusercontent.com`).
5. **Paste it into `index.html`:** near the top of the `<script>`, set
   ```js
   const GOOGLE_CLIENT_ID = "YOUR_CLIENT_ID.apps.googleusercontent.com";
   ```

> Google's sign-in requires a real `http(s)://` origin — opening `index.html` by
> double-clicking (a `file://` path) will **not** work. Use one of the hosting
> options below.

---

## Run it locally

From this folder:

```bash
python -m http.server 8000
```

Then open <http://localhost:8000>. (Make sure `http://localhost:8000` is in your
OAuth client's Authorized JavaScript origins.)

## Host it for free (use from anywhere)

**GitHub Pages:** create a repo, upload `index.html`, enable Pages
(Settings → Pages → deploy from `main`/root). Your URL becomes
`https://YOURNAME.github.io/REPO/` — add that origin to the OAuth client.

Netlify Drop (<https://app.netlify.com/drop>) and Cloudflare Pages work the same
way — just add the resulting URL as an authorized origin.

---

## How saves are organized in your Drive

```
Save Station Web Saves/
├── Pokemon - Emerald/
│   ├── 2026-07-31_14-30-00__Windows PC (Chrome).sav
│   └── 2026-07-31_16-05-12__iPhone.sav        ← newer backup, kept separately
└── Pokemon - FireRed/
    └── 2026-07-31_09-12-44__Mac.sav
```

Each file also carries hidden metadata (game, device, emulator, original file
name, timestamp) that the website and the Windows app read to build the history.

## Supported files

Delta & mGBA saves: `.sav`, `.srm`, and save states (`.dsv`, `.ss0`–`.ss9`,
`.state`). The emulator is guessed from the extension and you can change it.

## Windows companion app

See [`windows-app/BUILD.md`](windows-app/BUILD.md) to run it or build the `.exe`.
It connects to the same Drive folder and pulls the latest (or any) save to your PC.

---

## Privacy note

The website uses the **`drive.file`** scope — it can only see files **it**
creates. It can't read the rest of your Drive. The Windows app uses read-only
Drive access so it can locate the folder the website made.
