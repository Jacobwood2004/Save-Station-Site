# Save Station — desktop app

The website, in a real window, plus the one thing a browser can't do: **watch
the save files on your PC and offer to commit them when you close your
emulator.**

It isn't a rewrite. The window loads the same `index.html` this repo publishes,
so the library, the slots, the sign-in and the uploads are all the site's own
code. The app adds the local half — file dialogs, watching, emulator detection,
and the commit prompt.

```
┌─ Save Station (Electron) ──────────────────────────────┐
│  main.js          watches your saves, spots emulators  │
│      │ hands over bytes                                │
│      ▼                                                 │
│  index.html       your Drive token, the upload, the UI │
└────────────────────────────────────────────────────────┘
```

---

## Run it

Needs [Node.js](https://nodejs.org) 20 or newer.

```bash
cd desktop-app
npm install
npm start
```

First launch builds the icons from `assets/icon.svg`, then opens the app.

### Signing in

Same account as the website — email and password. Two things work differently
from a browser:

- **Connecting Google Drive opens your normal browser.** Google refuses to run
  its sign-in inside an app window, and it's right to: you shouldn't type a
  Google password into a window an app controls. Approve it there, and the app
  window picks the link up by itself within a few seconds.
- **Your device name** starts as this PC's hostname rather than a browser name,
  so backups made here read as `GAMING-PC` in the history. Change it under
  **⚙ Settings → This device's name**.

Signing in is remembered, so later launches go straight to your games.

---

## Linking a save, per slot

Open a game, pick the slot you're playing (the tabs across the top of its
history), and use **🔗 Link save file** in the *On this PC* panel.

That per-slot bit is the point. Two playthroughs of the same game are two files
on disk:

```
Pokemon Emerald
├── Main run    →  D:\Emulation\mGBA\Pokemon Emerald.sav
└── Nuzlocke    →  D:\Emulation\mGBA\Pokemon Emerald 2.sav
```

Each slot watches its own file and keeps its own history, so a commit can never
land in the wrong playthrough. The same file can't be linked to two slots —
the app refuses, because that's exactly the mix-up slots exist to prevent.

For 3DS, Wii U, Switch, PSP and Vita the button says **📂 Link save folder**
instead; the folder gets zipped on commit, same as on the website.

---

## The commit

When a linked save changes, nothing happens yet — you're still playing. The
prompt waits for the moment the save is actually final:

- **the emulator closes** (mGBA, melonDS, Dolphin, Cemu, Ryujinx, PPSSPP,
  Citra/Azahar, Vita3K, RetroArch and friends — the list is in
  `lib/emulators.js`). Plenty of emulators write the save out *as* they exit, so
  a change that lands within two minutes of one closing counts as that session's
  and is offered straight away, or
- **the save has sat untouched for 45 seconds** and nothing recognisable is
  running, so an emulator that isn't on the list still can't cost you a backup.

Then a small window appears in the corner:

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
> ☐ Commit this slot automatically from now on
> **[⬆ Commit & upload]  [Not now]**

The message becomes the backup's name, so your history reads like a log of the
playthrough instead of a list of timestamps — and it shows up under that name
on the website too.

The diff is real: the app keeps a copy of what it last committed for each slot
(in its own folder, not in your Drive) purely so it can tell you what changed.

**Not now** leaves the change alone, and keeps saying so: the slot goes on
showing an amber dot and "changed since the last commit" until you either commit
it or play again. It just stops interrupting. **⬆ Commit now** in the game's
panel picks it up whenever.

**Commit automatically** does it silently from then on for that one slot, with
a notification instead of a question.

---

## Restoring onto this PC

Any backup in a linked slot gets an extra **⤓ Restore** button. It writes the
backup back over the linked save and keeps the current one beside it as
`....savestation-<date>.bak`, so it's undoable.

Close your emulator first — several write their save back out when they exit,
which would immediately undo the restore.

---

## It keeps watching after you close the window

Closing the window leaves the app in the tray, still watching, because that's
precisely when it's needed: you put the window away, then play. Quit properly
from the tray icon.

---

## Build an installer

```bash
npm run dist
```

Produces, in `desktop-app/dist/`:

- `Save Station Setup <version>.exe` — a normal installer, per-user, no admin
- `Save Station <version>.exe` — a portable single file

Both bundle a copy of `index.html` and `assets/`, so the built app doesn't need
this repo to be present.

`npm run pack` builds an unpacked folder instead, which is quicker for testing.

---

## What it stores on your PC

In `%APPDATA%\save-station-desktop\` — its own folder, deliberately, because
Electron would otherwise name it after the app and collide with anything else
called "Save Station" (they'd share a profile lock, and one would stop the other
from opening):

| | |
|---|---|
| `links.json` | which file on disk belongs to which game and slot, and what was last committed from it |
| `snapshots/` | one copy per slot of what was last committed, so the next prompt can say what changed |

No account details, no tokens, and no save history — those live in your Google
Drive, the same as on the website. Deleting the folder loses your links and
nothing else.

---

## Troubleshooting

**"The local server wouldn't start."** Something else holds port 8765. The app
tries the next 20 ports on its own, so this only shows up if all of them are
taken.

**Sign-in fails but works in a browser.** If you've restricted your Firebase
API key to specific HTTP referrers, add `localhost` — the app window is a
`http://localhost:<port>` origin.

**Drive never connects.** The app links Drive through the Worker in `worker/`.
If `WORKER_URL` in `index.html` is blank, deploy it first (see `worker/README.md`)
— the browser-only flow needs an OAuth origin the app doesn't have.

**Your emulator isn't detected.** Add it to `lib/emulators.js`: its executable
name (lower case, no `.exe`) and which consoles it plays. Until then the
45-second fallback still catches your saves.

**Nothing prompts.** The panel under a game's slot tabs says what the app
thinks: whether the slot is linked, whether it has seen a change, and when it
last committed.
