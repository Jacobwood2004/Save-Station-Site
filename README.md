# 🎮 Save Station Web

Back up your console and emulator saves to your own **Google Drive**.
Sign in with Google, drop in a save, and it's versioned in a per-game folder so
you can restore any backup from any device — and see which device each one came from.

- **Sign in once.** After that you're signed back in automatically, on the site
  and in the Windows app.
- **Your Drive is the storage.** On first use it creates a folder named
  **`Save Station Web Saves`**. Nothing is stored on this site's server — there
  isn't one. The page talks straight to Google from your browser.
- **Ten consoles supported** (below), including the ones whose saves are folders.
- **Per-game folders + full history.** Each game gets its own subfolder; every
  upload is a new timestamped file, so old backups are never overwritten.
- **Windows app watches your saves.** Link a game to its real save file; when you
  play and the game saves, the app asks whether to upload it.

---

## Supported consoles

Picked once when you make your account, changeable any time under **⚙ Account**.

| Console | Saves look like | Where they usually live |
|---|---|---|
| Game Boy | single file | mGBA / SameBoy `.sav` next to the ROM |
| Game Boy Color | single file | mGBA / SameBoy `.sav` next to the ROM |
| Game Boy Advance | single file | mGBA `.sav`, VBA `.srm`, or a Delta export |
| Nintendo DS | single file | melonDS `.sav`, DeSmuME `.dsv` |
| Nintendo 3DS | **folder** | Citra/Azahar `sdmc/Nintendo 3DS/…/title/<id>/data` |
| Wii | either | Dolphin `.gci` / memory-card `.raw`, or a save folder |
| Wii U | **folder** | Cemu `mlc01/usr/save/00050000/<title-id>/user/80000001` |
| Nintendo Switch | **folder** | Ryujinx `bis/user/save/<id>` |
| PSP | **folder** | `PSP/SAVEDATA/<game id>` (PPSSPP) |
| PS Vita | **folder** | Vita3K `ux0/user/00/savedata/<title-id>` |

**Folder saves** (3DS, Wii U, Switch, PSP, Vita) are packed into a single `.zip`
on upload — on the website by picking the folder, in the Windows app
automatically. Downloading gives you that `.zip` back; the Windows app can
extract it straight into the linked folder for you.

> Save Station stores and versions save files. It doesn't run games, and it
> isn't an emulator — bring your own emulator and your own ROMs.

---

## Your account

Signing in with Google *is* the account — there's no separate password to make.
The first time you sign in, Save Station asks **which consoles you plan to keep
saves for** and writes your answer to a small `station.json` inside your
`Save Station Web Saves` folder.

Because that file lives in your Drive rather than on a server:

- the website and the Windows app always show the same consoles,
- your picks follow you to a new PC the moment you sign in,
- and nobody but you can read them.

After that first visit the site signs you back in silently — no button, no
account chooser — and quietly refreshes the session so an open tab never gets
logged out.

### Signing in on a phone or iPad by QR code

Typing a Google password on a phone is miserable, so a computer that's already
signed in can hand its session over:

1. On the computer: **⚙ Account → Sign in on another device → Show QR code**.
2. On the phone or iPad: open the **Camera app** and point it at the code (or tap
   **Scan a QR code from a signed-in device** on the sign-in screen — that option
   only appears on phones and iPads).
3. The phone lands on Save Station already signed in, and quietly picks up a
   session of its own so it stays signed in afterwards.

**The code is a live sign-in — treat it like a password.** It's only valid for
**two minutes**, the countdown is on screen, and it's wiped from the page the
moment you hide it or the timer runs out. Don't screenshot it, share it, or show
it on a stream. If one leaks, hit **Sign out** on the computer: that revokes the
token and the code dies with it.

The sign-in travels in the URL's `#fragment`, which browsers never send to any
server, and it's stripped from the address bar the instant the phone reads it.
The QR code itself is generated on your own machine — the page loads no
third-party scripts, so your session never leaves this origin.

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
├── station.json                                    ← your account profile
├── Pokemon - Emerald/
│   ├── 2026-08-16_14-30-00__Windows PC (Chrome).sav
│   └── 2026-08-16_16-05-12__iPhone.sav             ← newer backup, kept separately
└── Crisis Core/
    └── 2026-08-16_09-12-44__Gaming PC.zip          ← a PSP folder save
```

Each file also carries hidden metadata — game, console, device, emulator,
original file name, timestamp, and a SHA-256 of the contents — that the website
and the Windows app read to build the history and to avoid re-uploading a save
that hasn't actually changed.

---

## Windows companion app

See [`windows-app/BUILD.md`](windows-app/BUILD.md) to run it or build the `.exe`.
It signs into the same account, reads the same `station.json`, and adds the one
thing a website can't do: **watching your save files**.

Link a game to its save file on your PC and the app checks it every few seconds.
When you play and the game writes its save, it waits for the writing to finish
and then asks:

> 💾 **Save file updated** — Pokemon Emerald
> `D:\Emulation\mGBA\Pokemon Emerald.sav` · 128.0 KB
> Upload this as a new backup? **[⬆ Upload now] [Not now] [Always upload this game]**

Pick *Always* and that game uploads silently from then on. Restoring works the
other way too: pull any backup and the app offers to write it straight back over
the linked save (keeping a copy of the old one first).

---

## Privacy note

The website uses the **`drive.file`** scope — it can only see files **it**
creates. It can't read the rest of your Drive. The Windows app uses full Drive
access so it can find the folder the website made and upload into it.

Nothing — not your saves, not your console picks, not your email — is ever sent
anywhere except Google Drive, under your own account.
