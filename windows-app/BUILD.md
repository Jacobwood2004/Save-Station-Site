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

## Notes / limits

- This companion is **download-only** for now (matches the "pull saves" ask).
  Uploading from Windows would need the read-write `drive` scope + an upload
  button — easy to add later if you want two-way sync.
- Because Google can't reliably read a game's title out of a raw `.sav`, the
  game name and the "uploaded from" device come from metadata the **website**
  attaches at upload time. So always upload through the website first.
