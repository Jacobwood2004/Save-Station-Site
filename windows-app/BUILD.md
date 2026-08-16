# Save Station — Windows Companion (build the .exe)

This desktop app signs into the **same** Google account as the website, uses the
same `Save Station Web Saves` Drive folder and the same `station.json` account
profile, and adds the thing a browser can't do: **watching your save files and
offering to upload them when you play.**

## 1. Get a Google OAuth "Desktop app" client

The website uses a *Web* OAuth client. The .exe needs a separate **Desktop app**
client (same Google Cloud project is fine).

1. Go to <https://console.cloud.google.com/apis/credentials> (same project as the website).
2. **Create Credentials → OAuth client ID → Application type: Desktop app**.
3. Download the JSON. Rename it to **`client_secret.json`**.
4. Put `client_secret.json` next to `save_station.py` (and later, next to the `.exe`).

> The Drive API must be enabled in the project (it already is if the website works).
> While your OAuth consent screen is in **Testing**, add your Google account under
> **Audience → Test users**, or sign-in will be blocked.

## 2. Run from source (quick test)

```bash
cd windows-app
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python save_station.py
```

The first launch opens your browser to sign in to Google. After that the token is
cached in `%USERPROFILE%\.save_station\token.json` and **every later launch signs
you in automatically** — the app goes straight to your games with no button to click.

## 3. Build a standalone .exe

```bash
.venv\Scripts\activate
pip install pyinstaller
pyinstaller --noconfirm --windowed --onefile --name "SaveStation" ^
  --add-data "client_secret.json;." save_station.py
```

The exe lands in `dist\SaveStation.exe`.

- `--windowed` = no console window.
- `--add-data "client_secret.json;."` bundles the credentials inside the exe.
  (If you'd rather keep the secret out of the exe, drop that flag and just ship
  `client_secret.json` in the same folder as `SaveStation.exe`.)

## 4. Link a save and let it watch

1. Launch the app — it signs you in on its own.
2. Pick a game on the left (or **＋ New game** to create one).
3. In the **🔗 Linked save on this PC** panel, click **Link save file** and point
   it at the real save your emulator writes — e.g.
   `D:\Emulation\mGBA\Pokemon Emerald.sav`.
   For 3DS / Wii U / Switch / PSP / Vita, use **Link save folder** instead; the
   folder gets zipped on upload.
4. The panel shows **● watching**. Go play.
5. When the game saves, the app waits for the write to settle and pops:

   > 💾 **Save file updated** — Pokemon Emerald
   > **[⬆ Upload now] [Not now] [Always upload this game]**

Linked games show a 🔗 in the games list. Tick *Upload automatically* (or answer
*Always*) to stop being asked for that game.

**How the watching works.** The app polls each linked save every 4 seconds and
only acts once the file has stopped changing for two consecutive checks — so a
game that writes its save in bursts produces one prompt, not five. Before
prompting it hashes the contents, so a save that was rewritten with identical
bytes is ignored. Polling is deliberate rather than filesystem events: it behaves
the same on network drives, USB sticks and Steam Deck shares.

## 5. Restoring

**Pull latest** (or **Download selected**) on a game with a linked save offers to
put the backup straight back where it belongs:

- linked **file** → written over your save, with the previous one copied
  alongside as `*.before-restore-<timestamp>`.
- linked **folder** → the `.zip` is extracted into the folder (entries that try
  to escape the destination are rejected).

Otherwise you get a normal save-as dialog, or the per-game download folder if
you've set one.

## What it can do

Full parity with the website, plus the watcher:
- **Automatic sign-in** after the first time.
- **Account profile shared with the website** — the consoles you picked live in
  `station.json` in your Drive; **⚙ Consoles** edits them from either side.
- **All ten consoles** — GB, GBC, GBA, DS, 3DS, Wii, Wii U, Switch, PSP, PS Vita.
  Folder saves are zipped on upload and can be extracted back on download.
- **Linked saves + watcher** — see above.
- Browse games with cover art; full history behind a **See all saves** button.
- **Upload** saves (game name auto-detected from the filename, editable; console
  auto-detected from the extension; device auto-detected as this PC's name).
- **Set / change cover art**, rename and delete backups.
- **Per-game download folders** — a fixed path per game (saved in
  `%USERPROFILE%\.save_station\config.json`).

## Scopes and publishing

The app asks for **`drive.file`** — read and write, but only for files this
project created. It cannot see anything else in your Drive.

That's the same non-sensitive scope the website uses, and it's deliberate. The
full `drive` scope this app used to request is **restricted**: because the OAuth
consent screen is shared by every client in the Cloud project, leaving it in the
project's scope list would drag the whole project into Google's verification
process the moment you publish the consent screen — potentially including a paid
third-party security assessment.

With only `drive.file` in the project you can publish freely: no review, no fee,
and no manual test-user list, so anyone can sign themselves in.

**After switching, sign in once more.** Tokens cached from the old broader scope
no longer satisfy the new one, so the app will ask you to sign in again — once.

**If you're upgrading**, also remove `.../auth/drive` from
*Google Cloud console → APIs & Services → OAuth consent screen → Scopes*,
leaving `drive.file`. Publishing while the restricted scope is still listed is
the thing that triggers verification.

## I can't see my saves

`drive.file` only shows an app the files **this Cloud project** created, so if the
app starts up and can't find your `Save Station Web Saves` folder, it makes a new
one and tells you it did.

Almost always that means **the app is signed in to a different Google account
than the website**. Hit *Sign out*, then sign in with the same account and the
folder appears.

If it happens even with the right account, the two OAuth clients aren't sharing
per-file access. Either do your uploads from one place, or set

```python
SCOPES = ["https://www.googleapis.com/auth/drive"]
```

back in `save_station.py` for personal use — just keep the consent screen in
**Testing** mode if you do, since that restricted scope is what makes publishing
expensive.

## Notes

- Because Google can't reliably read a game's title out of a raw `.sav`, the
  game name is taken from the **file name** (editable before upload), and the
  device is this PC's Windows name (editable, remembered).
- Local settings — links, download folders, device name — live in
  `%USERPROFILE%\.save_station\config.json`. Deleting that file only forgets the
  links; nothing in Drive is touched.
- Cover thumbnails need Pillow (in `requirements.txt`); PyInstaller bundles it.
- The console table at the top of `save_station.py` mirrors the one in
  `../index.html`. If you add a console, edit both.
