<img src="assets/logo.svg" width="112" align="right" alt="">

# Save Station

Back up your console and emulator saves to your own **Google Drive**.
Make an account, link your Drive, drop in a save, and it's versioned in a
per-game folder so you can restore any backup from any device — and see which
device each one came from.

- **Real accounts.** Email and password, with a sign-up page; Google Drive is
  linked to your account as the storage, not used as the login.
- **Sign in once.** After that you're signed back in automatically, on the site
  and in the desktop app.
- **Your Drive is the storage.** On first use it creates a folder named
  **`Save Station Web Saves`**. No save file ever touches this site's server —
  there isn't one. The page talks straight to Google from your browser.
- **Ten consoles supported** (below), including the ones whose saves are folders.
- **Per-game folders + full history.** Each game gets its own subfolder; every
  upload is a new timestamped file, so old backups are never overwritten.
- **Save slots.** One game can have more than one save file on the go — a second
  playthrough, a co-op file, a nuzlocke. Each slot keeps its own history, so the
  two never mix.
- **A desktop app that watches your saves.** Link a slot to the real save file on
  your PC; close your emulator and it offers to commit it, message and all, like
  a commit in git.

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

Save Station has its own accounts — **email and password**, with a sign-up page.
Opening the site gives you a **Log in / Create account** screen, not a Google
button.

Creating an account is two steps:

1. **Make the account** — display name, email, password.
2. **Link your Google Drive** — this is where the saves actually go, so sign-up
   walks straight into it. You can't finish without it.

Then it asks **which consoles you plan to keep saves for** and writes your answer
to a small `station.json` inside your `Save Station Web Saves` folder.

Keeping the two separate is deliberate: the Save Station account is your
identity, and Google Drive is just the storage it's pointed at.

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

## Setup 1 of 2 — Firebase, for the accounts (about 5 minutes)

Accounts need somewhere to check the password, and a static site can't do that on
its own. Firebase Authentication handles it without you running a server.

**This is free.** The Spark plan covers email/password sign-in and password-reset
emails, and it doesn't ask for a credit card. Firebase only stores accounts — a
few hundred bytes each. Your saves never touch it; they go straight from the
browser into each user's own Drive.

1. Go to <https://console.firebase.google.com> → **Add project** → give it any
   name (e.g. `save-station`).

   > Make this a **brand-new project**, not the one holding your Drive OAuth
   > client. Firebase Auth and the Drive API are completely independent here, so
   > a separate project means nothing you do in Firebase can affect the working
   > site. (Attaching Firebase to the existing project also works, but there's
   > no benefit and a fresh one is impossible to break.)

   Google Analytics is offered during setup — **turn it off**, it isn't used.
2. Open **Authentication**. Firebase moves this around — the reliable way is the
   **Search for products** box at the top of the sidebar; type `Authentication`.
   (Older consoles list it under **Build**, newer ones under **Security**.)
   Then **Get started**.
3. **Sign-in method** tab → **Email/Password** → toggle **Enable** → **Save**.
   (Leave "Email link / passwordless" off.)
4. **Settings → Authorized domains** → **Add domain** → `YOURNAME.github.io`.
   `localhost` is already on the list for local testing.
5. Register the web app: **+ Add app** on the Project Overview page (or ⚙
   **Project settings** → **Your apps**) → the **web** icon `</>` → give it a
   nickname → **Register app**. Don't tick "Also set up Firebase Hosting" —
   GitHub Pages already hosts the site.
6. Copy the `firebaseConfig` values it shows you into `index.html`:
   ```js
   const FIREBASE_CONFIG = {
     apiKey: "AIza…",
     authDomain: "your-project.firebaseapp.com",
     projectId: "your-project",
     appId: "1:123…:web:abc…",
   };
   ```

> These four values are **public identifiers, not secrets** — Firebase web apps
> are designed to ship them in the page, and what actually protects your data is
> the Drive `drive.file` scope plus your Firebase sign-in settings. There is no
> secret to leak here.

Until you fill them in, the site shows a "Not set up yet" notice instead of a
login form, so nobody hits a box that can't work.

---

## Setup 2 of 2 — get your Google Client ID (about 5 minutes)

You need one free Google OAuth "Web" client ID. Do this once:

1. **Create a project** at <https://console.cloud.google.com> (or reuse one).
2. **Enable the Drive API:** APIs & Services → Library → search **Google Drive API** → **Enable**.
3. **Configure the consent screen:** APIs & Services → OAuth consent screen.
   - User type **External**, fill in the app name + your email.
   - Add the scopes `.../auth/drive.file` and `userinfo.email` (optional).
     **Only `drive.file`** — do not add `.../auth/drive`; it's a *restricted*
     scope and listing it is what forces Google's verification review.
   - Then hit **Publish app** (status becomes "In production"). See
     "Letting other people sign in" below for why.
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

## Save slots — one game, two playthroughs

A game's history is a row of tabs, one per save file you're playing it on:

```
Pokemon Emerald
┌──────────┬──────────────┬──────────────┐
│ 🗂 All   │ 💾 Main run  │ 💾 Nuzlocke  │  ＋ New slot
└──────────┴──────────────┴──────────────┘
```

Uploads land in the slot you're looking at, the history filters to it, and the
desktop app watches a **different file on your PC** for each one. That last part
is the point: two playthroughs of the same game are two files, and one restore
into the wrong one costs you forty hours.

- **＋ New slot** on any game's page. Name it whatever the playthrough is.
- A backup in the wrong slot moves with the 🗂 button on its row — metadata only,
  so it's instant and costs no upload.
- Deleting a slot asks what happens to its backups: move them to another slot,
  or send them to your Drive trash.

Slot names live in `station.json` in your Drive, so every device and the desktop
app agree on them, and every backup also carries its slot in Drive metadata, so
the lanes survive even if that file is lost. **Nothing needs migrating**: a
backup made before slots existed simply belongs to the first one.

---

## Moving a GBA save to Delta

Delta on iPhone and iPad runs a different GBA core from mGBA, and mGBA writes
one thing Delta's core can't read: **16 bytes of real-time-clock data appended
to the end of the `.sav`**, which Pokémon Ruby/Sapphire/Emerald all have. The
file comes out 131,088 bytes where 131,072 was expected, and Delta rejects it.

So downloading a **GBA** save asks where it's going:

> **Which emulator is this for?**
> 🖥️ mGBA, VBA-M or RetroArch  ·  📱 Delta on iPhone or iPad

Pick Delta and the save is reshaped on the way out: the clock footer comes off,
and the file is padded to the real save-chip size with `0xFF` — the same thing
mGBA's own *Convert save game* does. Nothing inside the save is touched, which
is why it's safe, and also why it can't rescue a save that's broken some other
way. The other direction needs nothing: mGBA reads a Delta save as-is.

---

## Desktop app

The website, in a real window, plus the thing a browser can't do: **watching
your save files and offering to commit them when you close your emulator.**

It isn't a rewrite — the window loads this repo's own `index.html`, so the
library, the slots and the uploads are the site's code. See
[`desktop-app/BUILD.md`](desktop-app/BUILD.md) to run it or build the installer.

```bash
cd desktop-app
npm install
npm start
```

Link a slot to the save your emulator writes, and when you close the emulator:

> 💾 **Save changed** — mGBA closed
> **Pokemon Emerald** · 💾 Main run
> `D:\Emulation\mGBA\Pokemon Emerald.sav · 128.0 KB`
>
> **Changes since the last backup**
> · 4.2 KB of 128.0 KB differ (3.3%)
> · Same size as the last backup (128.0 KB)
> · Last commit Aug 18, 21:40 — "Before the 4th gym"
>
> Commit message: `Beat the 4th gym`
> **[⬆ Commit & upload]  [Not now]**

The message becomes the backup's name, so the history reads like a log of the
playthrough rather than a list of timestamps — on the website too. The diff is
real: the app keeps a copy of what it last committed for each slot, purely so it
can tell you what changed.

Tick **commit automatically** and that one slot backs itself up silently from
then on. Any backup in a linked slot also gets a **⤓ Restore** button, which
writes it back over the save on your PC and keeps the old one as a `.bak`.

Closing the window leaves it watching in the tray, because that's exactly when
it's needed.

---

## Windows companion app (the older one)

The original Python/Tk app, kept because it still works — see
[`windows-app/BUILD.md`](windows-app/BUILD.md). The Electron app above supersedes
it: same Drive folder, same `station.json`, but with the website's own interface,
save slots, and commit messages. It reads and writes the same profile, so having
both installed is harmless; it just doesn't know about slots, so everything it
uploads lands in a game's first one.

> **Note:** this one signs in with Google directly — it never showed the Save
> Station email/password screen the website does. It reaches the same Drive
> folder and the same profile, so everything stays in sync; it just skips the
> account front door. The Electron app doesn't have that gap.

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

## Letting other people sign in

**Your users never do any of the setup above.** They open the site, create an
account, click **Connect Google Drive**, and approve Google's consent screen.
No Cloud console, no client ID, no secret — and you never see or touch their
Google account.

One thing gates that: while the OAuth consent screen sits in **Testing** mode,
only Google accounts you've manually pasted into the **Test users** list can sign
in at all — capped at 100. So publish it:

> Google Cloud console → APIs & Services → **OAuth consent screen** → **Publish app**

Because this project only uses the non-sensitive `drive.file` scope, publishing
needs **no verification review and costs nothing**. Check the **Scopes** list
first and remove `.../auth/drive` if it's there — that one is restricted, and
it's the thing that would force a review (and possibly a paid security
assessment) for the whole project.

Publishing is worth doing even if it's only ever you: in Testing mode Google
expires refresh tokens after **7 days**, which would make the desktop app ask you
to sign in again every week.

---

## Privacy note

Both the website and the Windows app use the **`drive.file`** scope — they can
only see files **they** create, never the rest of your Drive.

That also keeps the project free to run. `drive.file` is a **non-sensitive**
scope, so once you publish the consent screen (below) there's no verification
review, no fee, and no list of approved testers to maintain: anyone can make
their own account and connect their own Drive with no involvement from you. You
never see or touch anyone else's Google account.

Nothing — not your saves, not your console picks, not your email — is ever sent
anywhere except Google Drive, under your own account.
