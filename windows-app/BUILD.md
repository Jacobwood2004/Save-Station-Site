# Save Station — Windows Companion (build the .exe)

This desktop app connects to the **same** `Save Station Web Saves` Google Drive
folder your website uses, lists your games, and pulls down the latest (or any)
save. It only ever **reads** from Drive.

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
cached in `%USERPROFILE%\.save_station\token.json`.

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

## 4. Use it

Double-click `SaveStation.exe` → sign in once → pick a game on the left → see the
full backup history (with the device each save came from) → **Pull latest** or
**Download selected**.

## What it can do

Full two-way parity with the website:
- Sign in with Google (one-time per PC).
- Browse games with cover art; full history behind a **See all saves** button.
- **Upload** saves (game name auto-detected from the filename, editable; pick
  emulator; device auto-detected as this PC's name).
- **Set / change cover art.**
- **Pull latest** or download any older backup.
- **Per-game download folders** — set a fixed path per game (saved in
  `%USERPROFILE%\.save_station\config.json`) so pulls drop straight into that
  game's emulator save folder with no prompt.

## Notes

- The app uses the full read-write `drive` scope so it can upload as well as
  download. This is a restricted scope, so you'll see the same
  "unverified app → Advanced → continue" screen on first sign-in.
- Because Google can't reliably read a game's title out of a raw `.sav`, the
  game name is taken from the **file name** (editable before upload), and the
  device is this PC's Windows name (editable, remembered).
- Cover thumbnails need Pillow (in `requirements.txt`); PyInstaller bundles it.
