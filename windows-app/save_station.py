"""
Save Station — Windows Companion
=================================
Full-featured desktop companion for the Save Station Web website. Connects to
the SAME Google Drive folder ("Save Station Web Saves"), and can do everything
the website can:

- Signs you in with Google once, then signs you back in automatically on every
  later launch (cached refresh token — no button to click).
- Your account profile (which consoles you keep saves for) lives in Drive as
  `station.json`, so the website and this app always agree.
- Supports Game Boy, Game Boy Color, GBA, DS, 3DS, Wii, Wii U, Switch, PSP and
  PS Vita. Consoles whose saves are *folders* (3DS, Wii U, Switch, PSP, Vita)
  are zipped on upload and can be extracted straight back on download.
- Browse games with cover art + a summary; full history behind "See all saves".
- Upload saves, set cover art, pull the latest save or any older backup.
- Per-game download folders.

**Linked saves & the watcher** — the reason this app exists:
link a game to its real save file (or save folder) on this PC, and Save Station
watches it in the background. When you play and the emulator writes the save,
the app notices, waits for the writing to finish, and asks whether to upload the
new save. Tick "always" per game to skip the question.

Build to a standalone .exe with PyInstaller — see BUILD.md.
"""

import os
import sys
import io
import re
import json
import queue
import shutil
import hashlib
import zipfile
import tempfile
import platform
import threading
import datetime
import tkinter as tk
from tkinter import ttk, filedialog, messagebox, simpledialog

import google.auth.transport.requests
from google_auth_oauthlib.flow import InstalledAppFlow
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload, MediaFileUpload

try:
    from PIL import Image, ImageTk
    HAVE_PIL = True
except Exception:
    HAVE_PIL = False

# drive.file — read + write, but ONLY for files this project created. It cannot
# see the rest of your Drive. Deliberately the same non-sensitive scope the
# website uses: full "drive" is a restricted scope, which would drag the whole
# Cloud project into Google's verification process once the consent screen is
# published. See BUILD.md → "Scopes and publishing".
SCOPES = ["https://www.googleapis.com/auth/drive.file"]
ROOT_FOLDER_NAME = "Save Station Web Saves"

# If this PC previously signed in with the broader "drive" scope, Google may hand
# back a token still carrying it. Without this, oauthlib treats the wider grant as
# a mismatch and raises instead of accepting the sign-in.
os.environ.setdefault("OAUTHLIB_RELAX_TOKEN_SCOPE", "1")
PROFILE_FILE = "station.json"

APP_DIR = os.path.join(os.path.expanduser("~"), ".save_station")
TOKEN_PATH = os.path.join(APP_DIR, "token.json")
CONFIG_PATH = os.path.join(APP_DIR, "config.json")

BG = "#0e1116"
PANEL = "#161b22"
PANEL2 = "#1c232d"
TEXT = "#e6edf3"
MUTED = "#8b98a5"
ACCENT = "#7c5cff"
OK = "#3fb950"
WARN = "#f0c674"

COVER_W, COVER_H = 200, 128  # fixed cover box (px)

# How often the watcher looks at linked saves, and how many consecutive
# identical readings mean "the emulator has finished writing".
POLL_SECONDS = 4.0
STABLE_POLLS = 2


# ----------------------------------------------------------------------------
# Consoles — mirrors the CONSOLES table in ../index.html. Keep the two in sync.
#
#   kind: "file"   → one save file per game
#         "folder" → the save is a folder; zipped on upload
#         "both"   → either, depending on the emulator
# ----------------------------------------------------------------------------
CONSOLES = [
    {"id": "gb", "label": "Game Boy", "short": "GB", "kind": "file",
     "exts": [".sav", ".srm", ".rtc", ".state"] + [f".ss{i}" for i in range(10)],
     "emus": ["mGBA", "SameBoy", "Gambatte", "Delta", "BGB"],
     "where": "mGBA / SameBoy .sav next to the ROM, or a Delta export"},

    {"id": "gbc", "label": "Game Boy Color", "short": "GBC", "kind": "file",
     "exts": [".sav", ".srm", ".rtc", ".state"] + [f".ss{i}" for i in range(10)],
     "emus": ["mGBA", "SameBoy", "Gambatte", "Delta"],
     "where": "mGBA / SameBoy .sav next to the ROM, or a Delta export"},

    {"id": "gba", "label": "Game Boy Advance", "short": "GBA", "kind": "file",
     "exts": [".sav", ".srm", ".flash", ".state"] + [f".ss{i}" for i in range(10)],
     "emus": ["mGBA", "VBA-M", "Delta", "GBA.emu"],
     "where": "mGBA .sav / VBA .srm next to the ROM, or a Delta export"},

    {"id": "nds", "label": "Nintendo DS", "short": "DS", "kind": "file",
     "exts": [".sav", ".dsv", ".duc", ".state"] + [f".ss{i}" for i in range(10)],
     "emus": ["melonDS", "DeSmuME", "Delta", "DraStic"],
     "where": "melonDS .sav or DeSmuME .dsv, usually next to the ROM"},

    {"id": "3ds", "label": "Nintendo 3DS", "short": "3DS", "kind": "folder",
     "exts": [".sav", ".zip"],
     "emus": ["Citra", "Azahar", "Lime3DS", "Panda3DS"],
     "where": "Citra/Azahar sdmc/Nintendo 3DS/.../title/<id>/data folder"},

    {"id": "wii", "label": "Wii", "short": "Wii", "kind": "both",
     "exts": [".bin", ".raw", ".gci", ".sav", ".zip"],
     "emus": ["Dolphin"],
     "where": "Dolphin .gci / memory-card .raw, or a Wii/<title-id>/data folder"},

    {"id": "wiiu", "label": "Wii U", "short": "Wii U", "kind": "folder",
     "exts": [".zip"],
     "emus": ["Cemu"],
     "where": "Cemu mlc01/usr/save/00050000/<title-id>/user/80000001 folder"},

    {"id": "switch", "label": "Nintendo Switch", "short": "Switch", "kind": "folder",
     "exts": [".zip"],
     "emus": ["Ryujinx"],
     "where": "Ryujinx bis/user/save/<id> folder"},

    {"id": "psp", "label": "PSP", "short": "PSP", "kind": "folder",
     "exts": [".zip", ".bin"],
     "emus": ["PPSSPP"],
     "where": "PSP/SAVEDATA/<game id> folder"},

    {"id": "vita", "label": "PS Vita", "short": "Vita", "kind": "folder",
     "exts": [".zip", ".bin"],
     "emus": ["Vita3K"],
     "where": "Vita3K ux0/user/00/savedata/<title-id> folder"},
]

CONSOLE_BY_ID = {c["id"]: c for c in CONSOLES}
CONSOLE_BY_LABEL = {c["label"]: c for c in CONSOLES}

# Saves uploaded before consoles existed carry only an emulator name.
LEGACY_EMU_CONSOLE = {"Delta": "gba", "mGBA": "gba"}

ALL_SAVE_EXTS = sorted({e for c in CONSOLES for e in c["exts"]})


def console_of(cid):
    return CONSOLE_BY_ID.get(cid)


def console_label(cid):
    c = console_of(cid)
    return c["short"] if c else ""


def is_folder_console(cid):
    c = console_of(cid)
    return bool(c) and c["kind"] in ("folder", "both")


def guess_console(fn, allowed=None):
    """Narrow a console from the file extension. Never guesses wildly — returns
    None when the extension doesn't identify one."""
    ext = os.path.splitext(fn)[1].lower()
    if ext in (".dsv", ".duc"):
        return "nds"
    if ext == ".gci":
        return "wii"
    if ext == ".flash":
        return "gba"
    pool = [c for c in CONSOLES if not allowed or c["id"] in allowed]
    for c in pool:
        if ext in c["exts"]:
            return c["id"]
    return None


# ----------------------------------------------------------------------------
# Local config
# ----------------------------------------------------------------------------
def load_config():
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_config(cfg):
    os.makedirs(APP_DIR, exist_ok=True)
    try:
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2)
    except Exception:
        pass


def resource_path(rel):
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, rel)


def client_secrets_path():
    for p in (
        os.path.join(os.path.dirname(sys.executable), "client_secret.json"),
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "client_secret.json"),
        resource_path("client_secret.json"),
    ):
        if os.path.exists(p):
            return p
    return None


# ----------------------------------------------------------------------------
# Small helpers
# ----------------------------------------------------------------------------
def game_name_from_filename(fn):
    name = re.sub(r"\.[^.]+$", "", fn)
    name = re.sub(r"\s*[\(\[][^)\]]*[\)\]]", "", name)
    name = name.replace("_", " ")
    return re.sub(r"\s{2,}", " ", name).strip()


def sanitize(n):
    return re.sub(r"[\/\\<>:\"|?*]+", "-", n).strip()[:120]


def timestamp():
    return datetime.datetime.now().strftime("%Y-%m-%d_%H-%M-%S")


def fmt_time(iso):
    if not iso:
        return ""
    try:
        dt = datetime.datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone()
        return dt.strftime("%b %d, %Y  %I:%M %p")
    except Exception:
        return iso


def human_size(b):
    if b is None:
        return ""
    b = int(b)
    if b < 1024:
        return f"{b} B"
    if b < 1048576:
        return f"{b/1024:.1f} KB"
    return f"{b/1048576:.1f} MB"


def split_cover(files):
    cover = None
    saves = []
    for f in files:
        if f.get("appProperties", {}).get("role") == "cover":
            if cover is None:
                cover = f
        elif f.get("name") == PROFILE_FILE:
            pass  # the account profile is never a save
        else:
            saves.append(f)
    return cover, saves


def save_console_id(save):
    p = save.get("appProperties", {})
    if p.get("console") in CONSOLE_BY_ID:
        return p["console"]
    return LEGACY_EMU_CONSOLE.get(p.get("emulator", ""))


def walk_files(folder):
    """(relative path, full path) for every file under `folder`, sorted so the
    hash of a folder is stable."""
    out = []
    for root, _dirs, files in os.walk(folder):
        for fn in files:
            full = os.path.join(root, fn)
            rel = os.path.relpath(full, folder).replace("\\", "/")
            out.append((rel, full))
    out.sort()
    return out


def path_signature(path, kind):
    """A cheap fingerprint used to notice a write. None if the path is gone."""
    try:
        if kind == "folder":
            count = 0
            total = 0
            newest = 0
            for _rel, full in walk_files(path):
                st = os.stat(full)
                count += 1
                total += st.st_size
                newest = max(newest, st.st_mtime_ns)
            return (count, total, newest)
        st = os.stat(path)
        return (1, st.st_size, st.st_mtime_ns)
    except OSError:
        return None


def path_hash(path, kind):
    """SHA-256 of the actual content, so a save that was touched but not changed
    doesn't trigger a pointless upload."""
    h = hashlib.sha256()
    try:
        if kind == "folder":
            for rel, full in walk_files(path):
                h.update(rel.encode("utf-8") + b"\0")
                with open(full, "rb") as f:
                    for chunk in iter(lambda: f.read(65536), b""):
                        h.update(chunk)
        else:
            with open(path, "rb") as f:
                for chunk in iter(lambda: f.read(65536), b""):
                    h.update(chunk)
    except OSError:
        return ""
    return h.hexdigest()


def zip_folder(folder):
    """Zip a save folder's *contents* to a temp .zip; returns its path."""
    fd, tmp = tempfile.mkstemp(suffix=".zip", prefix="savestation_")
    os.close(fd)
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        for rel, full in walk_files(folder):
            z.write(full, rel)
    return tmp


def hash_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


# ----------------------------------------------------------------------------
# Google Drive access
# ----------------------------------------------------------------------------
class Drive:
    def __init__(self):
        self.service = None
        self.root_created = False

    def has_cached_token(self):
        return os.path.exists(TOKEN_PATH)

    def authenticate(self, interactive=True):
        """Sign in. With interactive=False this only uses a cached token (and
        refreshes it) — it never opens a browser, so it's safe to run at launch."""
        os.makedirs(APP_DIR, exist_ok=True)
        creds = None
        if os.path.exists(TOKEN_PATH):
            try:
                creds = Credentials.from_authorized_user_file(TOKEN_PATH, SCOPES)
            except Exception:
                creds = None
        # Force re-consent if cached token lacks the scopes we now need.
        if creds and not creds.has_scopes(SCOPES):
            creds = None
        if not creds or not creds.valid:
            refreshed = False
            if creds and creds.expired and creds.refresh_token:
                try:
                    creds.refresh(google.auth.transport.requests.Request())
                    refreshed = True
                except Exception:
                    creds = None  # refresh token revoked/expired → sign in again
            if not refreshed and (not creds or not creds.valid):
                if not interactive:
                    raise RuntimeError("no valid cached sign-in")
                secrets = client_secrets_path()
                if not secrets:
                    raise RuntimeError(
                        "client_secret.json not found. Put your Google OAuth "
                        "'Desktop app' client_secret.json next to this program. "
                        "See BUILD.md."
                    )
                flow = InstalledAppFlow.from_client_secrets_file(secrets, SCOPES)
                # offline + consent guarantees a refresh token, so the app can
                # stay signed in across launches (no re-login every time).
                creds = flow.run_local_server(port=0, access_type="offline",
                                              prompt="consent")
            with open(TOKEN_PATH, "w") as f:
                f.write(creds.to_json())
        self.service = build("drive", "v3", credentials=creds, cache_discovery=False)

    def account_email(self):
        try:
            about = self.service.about().get(fields="user(emailAddress)").execute()
            return about.get("user", {}).get("emailAddress", "")
        except Exception:
            return ""

    def find_root(self):
        q = ("mimeType='application/vnd.google-apps.folder' and trashed=false "
             f"and name='{ROOT_FOLDER_NAME}'")
        res = self.service.files().list(q=q, fields="files(id,name)", spaces="drive").execute()
        files = res.get("files", [])
        return files[0]["id"] if files else None

    def ensure_folder(self, name, parent_id, app_properties=None):
        q = ("mimeType='application/vnd.google-apps.folder' and trashed=false "
             f"and name='{name}' and '{parent_id}' in parents")
        res = self.service.files().list(q=q, fields="files(id)").execute()
        files = res.get("files", [])
        if files:
            return files[0]["id"]
        meta = {"name": name, "mimeType": "application/vnd.google-apps.folder",
                "parents": [parent_id]}
        if app_properties:
            meta["appProperties"] = app_properties
        return self.service.files().create(body=meta, fields="id").execute()["id"]

    def ensure_root(self):
        """Find the Save Station folder, creating it if this account has none.

        Sets `root_created` so the caller can tell "brand new setup" apart from
        "found the existing folder" — with drive.file we only ever see files this
        project made, so a miss is worth mentioning rather than silently making a
        second folder the user never finds."""
        rid = self.find_root()
        if rid:
            self.root_created = False
            return rid
        meta = {"name": ROOT_FOLDER_NAME, "mimeType": "application/vnd.google-apps.folder"}
        rid = self.service.files().create(body=meta, fields="id").execute()["id"]
        self.root_created = True
        return rid

    def list_subfolders(self, parent_id):
        q = ("mimeType='application/vnd.google-apps.folder' and trashed=false "
             f"and '{parent_id}' in parents")
        res = self.service.files().list(
            q=q, fields="files(id,name,appProperties)", orderBy="name", pageSize=200
        ).execute()
        return res.get("files", [])

    def list_saves(self, folder_id):
        q = ("trashed=false and mimeType!='application/vnd.google-apps.folder' "
             f"and '{folder_id}' in parents")
        res = self.service.files().list(
            q=q,
            fields="files(id,name,createdTime,size,appProperties)",
            orderBy="createdTime desc",
            pageSize=500,
        ).execute()
        return res.get("files", [])

    def upload(self, folder_id, name, local_path, app_properties):
        meta = {"name": name, "parents": [folder_id], "appProperties": app_properties}
        media = MediaFileUpload(local_path, resumable=False)
        self.service.files().create(body=meta, media_body=media, fields="id").execute()

    def set_folder_props(self, folder_id, props):
        self.service.files().update(fileId=folder_id, body={"appProperties": props}).execute()

    def delete(self, file_id):
        self.service.files().delete(fileId=file_id).execute()

    def trash(self, file_id):
        self.service.files().update(fileId=file_id, body={"trashed": True}).execute()

    def set_label(self, file_id, label):
        # metadata only — never touches the file name
        props = {"label": label if label else None}
        self.service.files().update(fileId=file_id, body={"appProperties": props}).execute()

    def download_bytes(self, file_id):
        request = self.service.files().get_media(fileId=file_id)
        buf = io.BytesIO()
        downloader = MediaIoBaseDownload(buf, request)
        done = False
        while not done:
            _, done = downloader.next_chunk()
        return buf.getvalue()

    def download(self, file_id, dest_path):
        with open(dest_path, "wb") as f:
            f.write(self.download_bytes(file_id))

    # -- account profile (station.json, shared with the website) -------------
    def find_profile(self, root_id):
        q = f"trashed=false and name='{PROFILE_FILE}' and '{root_id}' in parents"
        res = self.service.files().list(q=q, fields="files(id)", pageSize=5).execute()
        files = res.get("files", [])
        return files[0]["id"] if files else None

    def read_profile(self, root_id):
        fid = self.find_profile(root_id)
        if not fid:
            return None
        try:
            data = json.loads(self.download_bytes(fid).decode("utf-8"))
        except Exception:
            return None
        data["_fileId"] = fid
        if not isinstance(data.get("consoles"), list):
            data["consoles"] = []
        return data

    def write_profile(self, root_id, profile):
        profile = dict(profile)
        fid = profile.pop("_fileId", None)
        profile["version"] = 1
        profile["updatedAt"] = datetime.datetime.now().isoformat()
        profile.setdefault("createdAt", profile["updatedAt"])
        fd, tmp = tempfile.mkstemp(suffix=".json", prefix="station_")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(profile, f, indent=2)
            media = MediaFileUpload(tmp, mimetype="application/json", resumable=False)
            if fid:
                self.service.files().update(fileId=fid, media_body=media).execute()
            else:
                meta = {"name": PROFILE_FILE, "parents": [root_id],
                        "appProperties": {"role": "profile"}}
                fid = self.service.files().create(
                    body=meta, media_body=media, fields="id").execute()["id"]
        finally:
            try:
                os.remove(tmp)
            except OSError:
                pass
        profile["_fileId"] = fid
        return profile


# ----------------------------------------------------------------------------
# The watcher — notices when a linked save file/folder is written to
# ----------------------------------------------------------------------------
class SaveWatcher(threading.Thread):
    """Polls every linked save. When one changes and then *stops* changing (the
    emulator has finished writing), it puts an event on the queue for the UI
    thread to act on. Polling rather than filesystem events on purpose: it works
    the same on network drives, USB sticks and Steam Deck shares."""

    def __init__(self, get_links, on_change):
        super().__init__(daemon=True)
        self._get_links = get_links
        self._on_change = on_change
        self._stop = threading.Event()
        self._state = {}      # game -> {"sig", "stable", "handled"}
        self._paused = set()  # games we've been told to leave alone this session

    def stop(self):
        self._stop.set()

    def pause_game(self, game):
        self._paused.add(game)

    def resume_game(self, game):
        self._paused.discard(game)

    def forget(self, game):
        self._state.pop(game, None)
        self._paused.discard(game)

    def mark_uploaded(self, game, sig, digest):
        """Called after a successful upload so the current contents count as
        already-backed-up."""
        st = self._state.setdefault(game, {})
        st["sig"] = sig
        st["stable"] = STABLE_POLLS
        st["handled"] = digest

    def prime(self, game, path, kind):
        """Record a freshly-linked save without prompting about it."""
        sig = path_signature(path, kind)
        self._state[game] = {"sig": sig, "stable": STABLE_POLLS,
                             "handled": path_hash(path, kind) if sig else None}

    def run(self):
        while not self._stop.wait(POLL_SECONDS):
            try:
                self._scan()
            except Exception:
                pass  # a watcher hiccup must never take the app down

    def _scan(self):
        links = dict(self._get_links())
        for game, link in links.items():
            path = link.get("path")
            kind = link.get("kind", "file")
            if not path or not os.path.exists(path):
                continue
            sig = path_signature(path, kind)
            if sig is None:
                continue
            st = self._state.setdefault(game, {"sig": sig, "stable": STABLE_POLLS,
                                               "handled": None})
            if sig != st["sig"]:
                # Still being written — reset the settle counter and wait.
                st["sig"] = sig
                st["stable"] = 0
                continue
            if st["stable"] >= STABLE_POLLS:
                continue
            st["stable"] += 1
            if st["stable"] < STABLE_POLLS:
                continue
            # Settled. Has the content actually changed since the last upload?
            digest = path_hash(path, kind)
            if not digest or digest == st.get("handled"):
                st["handled"] = digest
                continue
            st["handled"] = digest
            if game in self._paused:
                continue
            self._on_change(game, dict(link), sig, digest)


# ----------------------------------------------------------------------------
# Dialogs
# ----------------------------------------------------------------------------
class ConsolePicker(tk.Toplevel):
    """First-run (and any-time) 'which consoles do you keep saves for?' picker."""

    def __init__(self, parent, selected, first_run=True):
        super().__init__(parent)
        self.title("Your consoles")
        self.configure(bg=BG)
        self.resizable(False, False)
        self.transient(parent)
        self.result = None
        self.vars = {}

        tk.Label(self, text="Which consoles do you plan on keeping saves for?"
                 if first_run else "Your consoles",
                 bg=BG, fg=TEXT, font=("Segoe UI", 14, "bold")).pack(
                     anchor="w", padx=22, pady=(20, 4))
        tk.Label(self,
                 text=("Pick as many as you like — it just tailors the pickers to you.\n"
                       "Saved to your Google Drive, so the website matches."),
                 bg=BG, fg=MUTED, font=("Segoe UI", 9), justify="left").pack(
                     anchor="w", padx=22, pady=(0, 14))

        grid = tk.Frame(self, bg=BG)
        grid.pack(padx=22, fill="x")
        for i, c in enumerate(CONSOLES):
            v = tk.BooleanVar(value=c["id"] in selected)
            self.vars[c["id"]] = v
            cell = tk.Frame(grid, bg=BG)
            cell.grid(row=i // 2, column=i % 2, sticky="w", padx=(0, 26), pady=3)
            tk.Checkbutton(cell, text=c["label"], variable=v, bg=BG, fg=TEXT,
                           selectcolor=PANEL2, activebackground=BG, activeforeground=TEXT,
                           font=("Segoe UI", 10), borderwidth=0, highlightthickness=0,
                           anchor="w", width=20).pack(anchor="w")
            tk.Label(cell, text=c["where"], bg=BG, fg=MUTED,
                     font=("Segoe UI", 8), anchor="w", wraplength=230,
                     justify="left").pack(anchor="w", padx=(24, 0))

        btns = tk.Frame(self, bg=BG)
        btns.pack(fill="x", padx=22, pady=18)
        tk.Button(btns, text="Save" if not first_run else "Continue", command=self._ok,
                  bg=ACCENT, fg="white", borderwidth=0, font=("Segoe UI", 10, "bold"),
                  cursor="hand2", padx=18, pady=6).pack(side="right")
        if not first_run:
            tk.Button(btns, text="Cancel", command=self.destroy, bg=PANEL2, fg=TEXT,
                      borderwidth=0, font=("Segoe UI", 10), cursor="hand2",
                      padx=16, pady=6).pack(side="right", padx=8)
        tk.Button(btns, text="Select all", command=self._all, bg=PANEL2, fg=TEXT,
                  borderwidth=0, font=("Segoe UI", 9), cursor="hand2",
                  padx=12, pady=6).pack(side="left")

        self.update_idletasks()
        x = parent.winfo_rootx() + max((parent.winfo_width() - self.winfo_width()) // 2, 0)
        y = parent.winfo_rooty() + 60
        self.geometry(f"+{x}+{y}")
        self.grab_set()

    def _all(self):
        for v in self.vars.values():
            v.set(True)

    def _ok(self):
        picked = [cid for cid, v in self.vars.items() if v.get()]
        if not picked:
            messagebox.showinfo("Pick at least one",
                                "Choose at least one console.", parent=self)
            return
        self.result = picked
        self.destroy()


class UploadPrompt(tk.Toplevel):
    """'Your save changed — upload it?' — the watcher's question."""

    def __init__(self, parent, game, link, info, on_choice):
        super().__init__(parent)
        self.title("Save changed")
        self.configure(bg=BG)
        self.resizable(False, False)
        self._on_choice = on_choice
        self._answered = False

        wrap = tk.Frame(self, bg=BG)
        wrap.pack(padx=24, pady=20)
        tk.Label(wrap, text="💾  Save file updated", bg=BG, fg=TEXT,
                 font=("Segoe UI", 14, "bold")).pack(anchor="w")
        tk.Label(wrap, text=game, bg=BG, fg=ACCENT,
                 font=("Segoe UI", 12, "bold")).pack(anchor="w", pady=(8, 2))
        tk.Label(wrap, text=info, bg=BG, fg=MUTED, font=("Segoe UI", 9),
                 justify="left", wraplength=380).pack(anchor="w")
        tk.Label(wrap, text="Upload this as a new backup?", bg=BG, fg=TEXT,
                 font=("Segoe UI", 10)).pack(anchor="w", pady=(14, 0))

        btns = tk.Frame(wrap, bg=BG)
        btns.pack(anchor="w", pady=(16, 0))
        tk.Button(btns, text="⬆ Upload now", command=lambda: self._choose("upload"),
                  bg=ACCENT, fg="white", borderwidth=0, font=("Segoe UI", 10, "bold"),
                  cursor="hand2", padx=16, pady=7).pack(side="left")
        tk.Button(btns, text="Not now", command=lambda: self._choose("skip"),
                  bg=PANEL2, fg=TEXT, borderwidth=0, font=("Segoe UI", 10),
                  cursor="hand2", padx=16, pady=7).pack(side="left", padx=8)
        tk.Button(btns, text="Always upload this game",
                  command=lambda: self._choose("always"),
                  bg=PANEL2, fg=MUTED, borderwidth=0, font=("Segoe UI", 9),
                  cursor="hand2", padx=12, pady=7).pack(side="left")

        self.protocol("WM_DELETE_WINDOW", lambda: self._choose("skip"))
        self.update_idletasks()
        # Bottom-right, like a notification, so it doesn't cover what you're doing.
        sw, sh = self.winfo_screenwidth(), self.winfo_screenheight()
        self.geometry(f"+{sw - self.winfo_width() - 40}+{sh - self.winfo_height() - 90}")
        self.attributes("-topmost", True)
        try:
            self.bell()
        except Exception:
            pass

    def _choose(self, what):
        if self._answered:
            return
        self._answered = True
        cb, self._on_choice = self._on_choice, None
        self.destroy()
        if cb:
            cb(what)


# ----------------------------------------------------------------------------
# GUI
# ----------------------------------------------------------------------------
class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Save Station — Windows Companion")
        self.geometry("1000x700")
        self.minsize(880, 600)
        self.configure(bg=BG)
        self.drive = Drive()
        self.config_data = load_config()
        self.config_data.setdefault("links", {})
        self.profile = None
        self.root_id = None
        self.games = []
        self.current_saves = []
        self.current_game = None
        self._cover_img = None
        self.history_visible = False
        self._prompts = {}          # game -> open UploadPrompt
        self._busy_uploads = set()  # games mid-upload, so we don't double-fire

        self.watcher = SaveWatcher(lambda: self.config_data.get("links", {}),
                                   self._watcher_event)

        self.login_frame = tk.Frame(self, bg=BG)
        self.main_frame = tk.Frame(self, bg=BG)
        self._build_login()
        self._build_main()
        self.show_login()
        self.protocol("WM_DELETE_WINDOW", self._on_close)

        # Auto sign-in: if this PC has signed in before, go straight in.
        self.after(120, self.try_auto_sign_in)

    # -- login --------------------------------------------------------------
    def _build_login(self):
        wrap = tk.Frame(self.login_frame, bg=BG)
        wrap.place(relx=0.5, rely=0.5, anchor="center")
        tk.Label(wrap, text="🎮", bg=BG, font=("Segoe UI", 52)).pack()
        tk.Label(wrap, text="Save Station", bg=BG, fg=TEXT,
                 font=("Segoe UI", 24, "bold")).pack(pady=(6, 2))
        tk.Label(wrap, text="Your game saves, backed up to your own Google Drive",
                 bg=BG, fg=MUTED, font=("Segoe UI", 11)).pack(pady=(0, 24))
        self.login_btn = tk.Button(
            wrap, text="   Sign in with Google   ", command=self.sign_in,
            bg="#ffffff", fg="#3c4043", borderwidth=0, font=("Segoe UI", 12, "bold"),
            activebackground="#f1f1f1", cursor="hand2", padx=18, pady=12)
        self.login_btn.pack()
        self.login_status = tk.Label(wrap, text="", bg=BG, fg=MUTED, font=("Segoe UI", 10))
        self.login_status.pack(pady=(18, 0))

    def _build_main(self):
        header = tk.Frame(self.main_frame, bg=BG)
        header.pack(fill="x", padx=16, pady=(14, 8))
        tk.Label(header, text="🎮  Save Station", bg=BG, fg=TEXT,
                 font=("Segoe UI", 16, "bold")).pack(side="left")
        tk.Button(header, text="Sign out", command=self.sign_out, bg=PANEL2, fg=MUTED,
                  borderwidth=0, font=("Segoe UI", 9), activebackground="#232c38",
                  cursor="hand2", padx=10, pady=4).pack(side="right")
        tk.Button(header, text="⚙ Consoles", command=self.edit_consoles, bg=PANEL2,
                  fg=TEXT, borderwidth=0, font=("Segoe UI", 9),
                  activebackground="#232c38", cursor="hand2",
                  padx=10, pady=4).pack(side="right", padx=8)
        self.status = tk.Label(header, text="", bg=BG, fg=MUTED, font=("Segoe UI", 10))
        self.status.pack(side="right", padx=12)

        style = ttk.Style(self)
        try:
            style.theme_use("clam")
        except Exception:
            pass
        style.configure("Treeview", background=PANEL, foreground=TEXT,
                        fieldbackground=PANEL, rowheight=26, borderwidth=0)
        style.configure("Treeview.Heading", background=PANEL2, foreground=MUTED)
        style.map("Treeview", background=[("selected", ACCENT)])

        body = tk.Frame(self.main_frame, bg=BG)
        body.pack(fill="both", expand=True, padx=16, pady=8)

        # Left: games + global upload
        left = tk.Frame(body, bg=BG)
        left.pack(side="left", fill="y", padx=(0, 14))
        tk.Label(left, text="GAMES", bg=BG, fg=MUTED,
                 font=("Segoe UI", 9, "bold")).pack(anchor="w")
        self.games_list = tk.Listbox(left, width=28, bg=PANEL, fg=TEXT,
                                     selectbackground=ACCENT, borderwidth=0,
                                     highlightthickness=0, activestyle="none",
                                     font=("Segoe UI", 10))
        self.games_list.pack(fill="y", expand=True, pady=6)
        self.games_list.bind("<<ListboxSelect>>", self.on_game_select)
        tk.Button(left, text="＋ New game", command=self.new_game, bg=ACCENT,
                  fg="white", borderwidth=0, font=("Segoe UI", 10, "bold"),
                  activebackground="#6a4fe0", cursor="hand2", pady=6).pack(fill="x", pady=(0, 6))
        tk.Button(left, text="↻ Refresh", command=self.load_games, bg=PANEL2,
                  fg=TEXT, borderwidth=0, font=("Segoe UI", 9),
                  activebackground="#232c38", cursor="hand2").pack(fill="x")

        # Right: detail
        right = tk.Frame(body, bg=BG)
        right.pack(side="left", fill="both", expand=True)

        top = tk.Frame(right, bg=BG)
        top.pack(fill="x")
        cover_box = tk.Frame(top, bg=PANEL2, width=COVER_W, height=COVER_H,
                             highlightbackground="#2a323d", highlightthickness=1)
        cover_box.pack(side="left", padx=(0, 14))
        cover_box.pack_propagate(False)
        self.cover_label = tk.Label(cover_box, bg=PANEL2, text="🎮", fg=MUTED,
                                    font=("Segoe UI", 36))
        self.cover_label.place(relx=0.5, rely=0.5, anchor="center")
        info = tk.Frame(top, bg=BG)
        info.pack(side="left", fill="both", expand=True, anchor="n")
        title_row = tk.Frame(info, bg=BG)
        title_row.pack(anchor="w", fill="x", pady=(2, 4))
        self.game_title = tk.Label(title_row, text="Select a game", bg=BG, fg=TEXT,
                                   font=("Segoe UI", 16, "bold"), anchor="w", justify="left")
        self.game_title.pack(side="left")
        self.console_tag = tk.Label(title_row, text="", bg=PANEL2, fg=TEXT,
                                    font=("Segoe UI", 9, "bold"), padx=8, pady=2)
        self.summary = tk.Label(info, text="", bg=BG, fg=MUTED, font=("Segoe UI", 10),
                                anchor="w", justify="left", wraplength=520)
        self.summary.pack(anchor="w")

        actions = tk.Frame(info, bg=BG)
        actions.pack(anchor="w", pady=(12, 0))
        self.upload_here_btn = self._abtn(actions, "⬆ Upload save", self.upload_to_current_game, primary=True)
        self.pull_latest_btn = self._abtn(actions, "⬇ Pull latest", self.pull_latest)
        self.see_all_btn = self._abtn(actions, "☰ See all saves", self.toggle_history)
        actions2 = tk.Frame(info, bg=BG)
        actions2.pack(anchor="w", pady=(8, 0))
        self.cover_btn = self._abtn(actions2, "🖼 Set cover", self.set_cover)
        self.folder_btn = self._abtn(actions2, "📁 Set download folder", self.set_download_folder)
        self.delete_game_btn = self._abtn(actions2, "🗑 Delete game", self.delete_game)
        self.delete_game_btn.config(fg="#ff8f8f", activebackground="#3a2626")
        self.pull_latest_btn.config(state="disabled")
        self.delete_game_btn.config(state="disabled")

        # -- Linked save (the watcher) --------------------------------------
        self.link_frame = tk.Frame(right, bg=PANEL, highlightbackground="#2a323d",
                                   highlightthickness=1)
        self.link_frame.pack(fill="x", pady=(16, 0))
        inner = tk.Frame(self.link_frame, bg=PANEL)
        inner.pack(fill="x", padx=14, pady=12)
        head = tk.Frame(inner, bg=PANEL)
        head.pack(fill="x")
        tk.Label(head, text="🔗  LINKED SAVE ON THIS PC", bg=PANEL, fg=MUTED,
                 font=("Segoe UI", 9, "bold")).pack(side="left")
        self.watch_state = tk.Label(head, text="", bg=PANEL, fg=OK,
                                    font=("Segoe UI", 9, "bold"))
        self.watch_state.pack(side="right")
        self.link_path_lbl = tk.Label(
            inner,
            text="Link this game to its save file and Save Station will notice when "
                 "you play and ask to upload the new save.",
            bg=PANEL, fg=MUTED, font=("Segoe UI", 9), anchor="w", justify="left",
            wraplength=620)
        self.link_path_lbl.pack(anchor="w", pady=(6, 10))
        lbtns = tk.Frame(inner, bg=PANEL)
        lbtns.pack(anchor="w")
        self.link_file_btn = tk.Button(lbtns, text="🔗 Link save file", command=self.link_save_file,
                                       bg=PANEL2, fg=TEXT, borderwidth=0, font=("Segoe UI", 10),
                                       activebackground="#232c38", cursor="hand2", padx=14, pady=6)
        self.link_file_btn.pack(side="left")
        self.link_folder_btn = tk.Button(lbtns, text="📂 Link save folder", command=self.link_save_folder,
                                         bg=PANEL2, fg=TEXT, borderwidth=0, font=("Segoe UI", 10),
                                         activebackground="#232c38", cursor="hand2", padx=14, pady=6)
        self.link_folder_btn.pack(side="left", padx=8)
        self.unlink_btn = tk.Button(lbtns, text="✕ Unlink", command=self.unlink_save,
                                    bg=PANEL2, fg=MUTED, borderwidth=0, font=("Segoe UI", 9),
                                    activebackground="#232c38", cursor="hand2", padx=12, pady=6)
        self.unlink_btn.pack(side="left")
        self.auto_var = tk.BooleanVar(value=False)
        self.auto_chk = tk.Checkbutton(
            inner, text="Upload automatically — don't ask me each time",
            variable=self.auto_var, command=self.toggle_auto, bg=PANEL, fg=MUTED,
            selectcolor=PANEL2, activebackground=PANEL, activeforeground=TEXT,
            font=("Segoe UI", 9), borderwidth=0, highlightthickness=0)
        self.auto_chk.pack(anchor="w", pady=(10, 0))

        # History (hidden until "See all saves")
        self.history_frame = tk.Frame(right, bg=BG)
        tk.Label(self.history_frame, text="SAVE HISTORY", bg=BG, fg=MUTED,
                 font=("Segoe UI", 9, "bold")).pack(anchor="w", pady=(14, 0))
        cols = ("name", "when", "device", "console", "size")
        self.tree = ttk.Treeview(self.history_frame, columns=cols, show="headings",
                                 selectmode="browse", height=8)
        headings = {"name": "Backup name"}
        for c, w in zip(cols, (150, 160, 140, 80, 70)):
            self.tree.heading(c, text=headings.get(c, c.capitalize()))
            self.tree.column(c, width=w, anchor="w")
        self.tree.pack(fill="both", expand=True, pady=6)
        hbtns = tk.Frame(self.history_frame, bg=BG)
        hbtns.pack(anchor="w", fill="x")
        tk.Button(hbtns, text="⬇ Download selected", command=self.download_selected,
                  bg=PANEL2, fg=TEXT, borderwidth=0, font=("Segoe UI", 10),
                  activebackground="#232c38", cursor="hand2", padx=14, pady=6).pack(side="left")
        tk.Button(hbtns, text="✏ Rename", command=self.rename_selected,
                  bg=PANEL2, fg=TEXT, borderwidth=0, font=("Segoe UI", 10),
                  activebackground="#232c38", cursor="hand2", padx=14, pady=6).pack(side="left", padx=8)
        tk.Button(hbtns, text="🗑 Delete selected", command=self.delete_selected,
                  bg=PANEL2, fg="#ff8f8f", borderwidth=0, font=("Segoe UI", 10),
                  activebackground="#3a2626", cursor="hand2", padx=14, pady=6).pack(side="left", padx=8)

        self._set_actions_enabled(False)
        self.refresh_link_panel()

    def _abtn(self, parent, text, cmd, primary=False):
        b = tk.Button(parent, text=text, command=cmd, borderwidth=0, cursor="hand2",
                      font=("Segoe UI", 10, "bold" if primary else "normal"),
                      bg=ACCENT if primary else PANEL2, fg="white" if primary else TEXT,
                      activebackground="#6a4fe0" if primary else "#232c38", padx=14, pady=6)
        b.pack(side="left", padx=(0, 8))
        return b

    def _set_actions_enabled(self, on):
        state = "normal" if on else "disabled"
        for b in (self.upload_here_btn, self.see_all_btn, self.cover_btn, self.folder_btn):
            b.config(state=state)

    # -- frame switching ----------------------------------------------------
    def show_login(self):
        self.main_frame.pack_forget()
        self.login_frame.pack(fill="both", expand=True)

    def show_main(self):
        self.login_frame.pack_forget()
        self.main_frame.pack(fill="both", expand=True)

    def _on_close(self):
        self.watcher.stop()
        self.destroy()

    # -- helpers ------------------------------------------------------------
    def set_status(self, text):
        self.status.config(text=text)

    def device_name(self):
        if self.config_data.get("device"):
            return self.config_data["device"]
        n = os.environ.get("COMPUTERNAME") or platform.node() or "Windows PC"
        return f"{n} (Windows)"

    def my_console_ids(self):
        picked = (self.profile or {}).get("consoles") or []
        return picked or [c["id"] for c in CONSOLES]

    def run_bg(self, fn, on_done=None, on_err=None):
        def worker():
            try:
                result = fn()
                if on_done:
                    self.after(0, lambda: on_done(result))
            except Exception as e:
                msg = str(e)
                if on_err:
                    self.after(0, lambda: on_err(msg))
                else:
                    self.after(0, lambda: messagebox.showerror("Error", msg))
        threading.Thread(target=worker, daemon=True).start()

    # -- auth ---------------------------------------------------------------
    def try_auto_sign_in(self):
        """Signed in before on this PC? Go straight back in, no click needed."""
        if not self.drive.has_cached_token():
            return
        self.login_btn.pack_forget()
        self.login_status.config(text="Signing you in…")
        self._start_session(interactive=False, on_fail=self._auto_sign_in_failed)

    def _auto_sign_in_failed(self, _msg):
        self.login_btn.pack()
        self.login_status.config(text="Please sign in again.")

    def sign_in(self):
        self.login_btn.config(state="disabled")
        self.login_status.config(text="Opening Google sign-in in your browser…")

        def failed(m):
            self.login_btn.config(state="normal")
            self.login_status.config(text="⚠ " + m)

        self._start_session(interactive=True, on_fail=failed)

    def _start_session(self, interactive, on_fail):
        def work():
            self.drive.authenticate(interactive=interactive)
            root_id = self.drive.ensure_root()
            profile = self.drive.read_profile(root_id)
            email = self.drive.account_email()
            return root_id, profile, email

        def done(payload):
            self.root_id, self.profile, email = payload
            self.show_main()
            self.set_status(f"Signed in{(' — ' + email) if email else ''} ✔")
            # We had to make the folder ourselves and there's no profile in it —
            # so either this really is a first run, or the website's folder is
            # sitting in a different Google account. Say so once, plainly.
            if self.drive.root_created and not self.profile:
                messagebox.showinfo(
                    "New Save Station folder",
                    f'Created a fresh "{ROOT_FOLDER_NAME}" folder in this Google '
                    "account's Drive.\n\n"
                    "If you already have saves from the website and don't see them "
                    "here, this app is probably signed in to a different Google "
                    "account — use Sign out, then sign in with the same one the "
                    "website uses.\n\n"
                    "See BUILD.md → \"I can't see my saves\".")
            if not self.profile:
                # Brand-new account → ask which consoles, same as the website.
                self.ask_consoles(first_run=True)
            if not self.watcher.is_alive():
                self.watcher.start()
            self.prime_all_links()
            self.load_games()

        self.run_bg(work, done, on_fail)

    def sign_out(self):
        try:
            if os.path.exists(TOKEN_PATH):
                os.remove(TOKEN_PATH)
        except Exception:
            pass
        self.drive = Drive()
        self.root_id = None
        self.profile = None
        self.current_game = None
        self.games_list.delete(0, tk.END)
        for i in self.tree.get_children():
            self.tree.delete(i)
        self.login_btn.config(state="normal")
        self.login_btn.pack()
        self.login_status.config(text="Signed out.")
        self.show_login()

    # -- console profile ----------------------------------------------------
    def ask_consoles(self, first_run=False):
        dlg = ConsolePicker(self, set((self.profile or {}).get("consoles", [])),
                            first_run=first_run)
        self.wait_window(dlg)
        if dlg.result is None:
            return
        picked = dlg.result
        base = dict(self.profile or {})
        base["consoles"] = picked
        self.set_status("Saving your consoles…")

        def work():
            return self.drive.write_profile(self.root_id, base)

        def done(p):
            self.profile = p
            self.set_status("Consoles saved ✔")

        self.run_bg(work, done, lambda m: messagebox.showerror("Could not save", m))

    def edit_consoles(self):
        if not self.root_id:
            return
        self.ask_consoles(first_run=False)

    # -- games / history ----------------------------------------------------
    def load_games(self, select_name=None):
        self.set_status("Loading games…")

        def work():
            if not self.root_id:
                self.root_id = self.drive.find_root()
            if not self.root_id:
                return []
            return self.drive.list_subfolders(self.root_id)

        def done(folders):
            self.games = folders
            self.games_list.delete(0, tk.END)
            links = self.config_data.get("links", {})
            for g in folders:
                mark = "🔗 " if g["name"] in links else "   "
                self.games_list.insert(tk.END, mark + g["name"])
            self.set_status(f"{len(folders)} game(s)" if folders
                            else "No games yet — upload one to get started")
            if select_name:
                self.select_game_by_name(select_name)

        self.run_bg(work, done, lambda m: self.set_status("⚠ " + m))

    def select_game_by_name(self, name):
        for i, g in enumerate(self.games):
            if g["name"] == name:
                self.games_list.selection_clear(0, tk.END)
                self.games_list.selection_set(i)
                self.games_list.see(i)
                self.on_game_select()
                return

    def game_console_id(self, folder, saves):
        tag = (folder.get("appProperties") or {}).get("console")
        if tag in CONSOLE_BY_ID:
            return tag
        for s in saves:
            cid = save_console_id(s)
            if cid:
                return cid
        return None

    def on_game_select(self, _evt=None):
        sel = self.games_list.curselection()
        if not sel:
            return
        game = self.games[sel[0]]
        self.current_game = game
        self.game_title.config(text=game["name"])
        self.cover_label.config(image="", text="🎮")
        self._cover_img = None
        self.summary.config(text="Loading…")
        self._set_actions_enabled(True)
        self.refresh_link_panel()
        for i in self.tree.get_children():
            self.tree.delete(i)

        def work():
            files = self.drive.list_saves(game["id"])
            cover, saves = split_cover(files)
            cover_bytes = None
            if cover and HAVE_PIL:
                try:
                    cover_bytes = self.drive.download_bytes(cover["id"])
                except Exception:
                    cover_bytes = None
            return saves, cover_bytes

        def done(payload):
            saves, cover_bytes = payload
            self.current_saves = saves
            if cover_bytes and HAVE_PIL:
                try:
                    img = Image.open(io.BytesIO(cover_bytes))
                    img.thumbnail((COVER_W - 8, COVER_H - 8))
                    self._cover_img = ImageTk.PhotoImage(img)
                    self.cover_label.config(image=self._cover_img, text="")
                except Exception:
                    pass
            self.cover_btn.config(text="🖼 Change cover" if self._cover_img else "🖼 Set cover")
            cid = self.game_console_id(game, saves)
            if cid:
                self.console_tag.config(text=console_of(cid)["label"])
                self.console_tag.pack(side="left", padx=(10, 0))
            else:
                self.console_tag.pack_forget()
            for idx, s in enumerate(saves):
                p = s.get("appProperties", {})
                when = fmt_time(s.get("createdTime", ""))
                if idx == 0:
                    when = "● " + when + "  (latest)"
                name = p.get("label") or p.get("originalName", s.get("name", "—"))
                if p.get("kind") == "folder":
                    name = "📦 " + name
                self.tree.insert("", tk.END, iid=str(idx), values=(
                    name, when, p.get("device", "Unknown"),
                    console_label(save_console_id(s)) or p.get("emulator", ""),
                    human_size(s.get("size")),
                ))
            self.update_summary()
            self.refresh_link_panel()
            has = bool(saves)
            self.pull_latest_btn.config(state="normal" if has else "disabled")
            self.delete_game_btn.config(state="disabled" if has else "normal")  # only when empty
            self.set_status(f"“{game['name']}” · {len(saves)} backup(s)")

        self.run_bg(work, done)

    def update_summary(self):
        if not self.current_game:
            return
        lines = []
        if self.current_saves:
            latest = self.current_saves[0]
            p = latest.get("appProperties", {})
            bits = [fmt_time(latest.get("createdTime", "")), f"from {p.get('device','Unknown')}"]
            if p.get("emulator"):
                bits.append(p["emulator"])
            lines.append("Latest: " + " · ".join(bits))
            lines.append(f"{len(self.current_saves)} backup(s) total")
        else:
            lines.append("No backups yet.")
        path = self.config_data.get("download_paths", {}).get(self.current_game["name"])
        if path:
            lines.append(f"⬇ Downloads to: {path}")
        self.summary.config(text="\n".join(lines))

    def toggle_history(self):
        self.history_visible = not self.history_visible
        if self.history_visible:
            self.history_frame.pack(fill="both", expand=True)
            self.see_all_btn.config(text="✕ Hide saves")
        else:
            self.history_frame.pack_forget()
            self.see_all_btn.config(text="☰ See all saves")

    # -- linked saves + watcher --------------------------------------------
    def current_link(self):
        if not self.current_game:
            return None
        return self.config_data.get("links", {}).get(self.current_game["name"])

    def current_console_id(self):
        if not self.current_game:
            return None
        return self.game_console_id(self.current_game, self.current_saves)

    def refresh_link_panel(self):
        link = self.current_link()
        enabled = self.current_game is not None
        for b in (self.link_file_btn, self.link_folder_btn):
            b.config(state="normal" if enabled else "disabled")
        self.unlink_btn.config(state="normal" if link else "disabled")
        self.auto_chk.config(state="normal" if link else "disabled")
        cid = self.current_console_id()
        # Folder linking only makes sense for folder-save consoles.
        self.link_folder_btn.config(
            state="normal" if (enabled and (cid is None or is_folder_console(cid))) else "disabled")

        if not enabled:
            self.watch_state.config(text="")
            self.link_path_lbl.config(
                text="Select a game to link its save file on this PC.", fg=MUTED)
            self.auto_var.set(False)
            return

        if not link:
            self.watch_state.config(text="not linked", fg=MUTED)
            self.link_path_lbl.config(
                text="Link this game to its save file and Save Station will notice when "
                     "you play and ask to upload the new save.", fg=MUTED)
            self.auto_var.set(False)
            self.link_file_btn.config(text="🔗 Link save file")
            return

        path = link.get("path", "")
        exists = os.path.exists(path)
        kind = link.get("kind", "file")
        self.auto_var.set(bool(link.get("auto")))
        self.link_file_btn.config(text="🔗 Change file")
        if exists:
            self.watch_state.config(text="● watching", fg=OK)
            extra = ""
            try:
                if kind == "file":
                    st = os.stat(path)
                    extra = (f"\nLast written {fmt_time(datetime.datetime.fromtimestamp(st.st_mtime).isoformat())}"
                             f" · {human_size(st.st_size)}")
                else:
                    n = len(walk_files(path))
                    extra = f"\n{n} file(s) — uploaded as a .zip"
            except OSError:
                pass
            self.link_path_lbl.config(text=("📂 " if kind == "folder" else "📄 ") + path + extra,
                                      fg=TEXT)
        else:
            self.watch_state.config(text="⚠ missing", fg=WARN)
            self.link_path_lbl.config(
                text=("📂 " if kind == "folder" else "📄 ") + path +
                     "\nThis path no longer exists — link it again.", fg=WARN)

    def link_save_file(self):
        if not self.current_game:
            return
        cid = self.current_console_id()
        con = console_of(cid)
        exts = con["exts"] if con else ALL_SAVE_EXTS
        types = [("Save files", " ".join("*" + e for e in exts)), ("All files", "*.*")]
        path = filedialog.askopenfilename(
            title=f"Pick the save file for {self.current_game['name']}", filetypes=types)
        if not path:
            return
        self._set_link(path, "file")

    def link_save_folder(self):
        if not self.current_game:
            return
        path = filedialog.askdirectory(
            title=f"Pick the save folder for {self.current_game['name']}")
        if not path:
            return
        self._set_link(path, "folder")

    def _set_link(self, path, kind):
        game = self.current_game["name"]
        links = self.config_data.setdefault("links", {})
        prev = links.get(game, {})
        links[game] = {
            "path": path,
            "kind": kind,
            "console": self.current_console_id(),
            "auto": bool(prev.get("auto")),
        }
        save_config(self.config_data)
        self.watcher.forget(game)
        self.watcher.prime(game, path, kind)
        self.refresh_link_panel()
        self.load_games(select_name=game)
        self.set_status("Linked — watching for changes")

    def unlink_save(self):
        if not self.current_game:
            return
        game = self.current_game["name"]
        self.config_data.get("links", {}).pop(game, None)
        save_config(self.config_data)
        self.watcher.forget(game)
        self.refresh_link_panel()
        self.load_games(select_name=game)
        self.set_status("Unlinked")

    def toggle_auto(self):
        link = self.current_link()
        if not link:
            return
        link["auto"] = bool(self.auto_var.get())
        save_config(self.config_data)
        self.set_status("Auto-upload on" if link["auto"] else "Auto-upload off")

    def prime_all_links(self):
        """At startup, take the current state of every linked save as the
        baseline so we don't prompt about writes that happened while closed."""
        for game, link in self.config_data.get("links", {}).items():
            p = link.get("path")
            if p and os.path.exists(p):
                self.watcher.prime(game, p, link.get("kind", "file"))

    # -- watcher callback (arrives on the watcher thread) -------------------
    def _watcher_event(self, game, link, sig, digest):
        self.after(0, lambda: self._on_save_changed(game, link, sig, digest))

    def _on_save_changed(self, game, link, sig, digest):
        if game in self._busy_uploads or game in self._prompts:
            return
        if link.get("auto"):
            self.set_status(f"“{game}” changed — uploading…")
            self._upload_linked(game, link, sig, digest)
            return

        path = link.get("path", "")
        kind = link.get("kind", "file")
        if kind == "folder":
            n = len(walk_files(path))
            info = f"{path}\n{n} file(s) — will be uploaded as a .zip"
        else:
            try:
                info = f"{path}\n{human_size(os.path.getsize(path))}"
            except OSError:
                info = path

        def choice(what):
            self._prompts.pop(game, None)
            if what == "always":
                link["auto"] = True
                stored = self.config_data.get("links", {}).get(game)
                if stored:
                    stored["auto"] = True
                    save_config(self.config_data)
                if self.current_game and self.current_game["name"] == game:
                    self.auto_var.set(True)
                self._upload_linked(game, link, sig, digest)
            elif what == "upload":
                self._upload_linked(game, link, sig, digest)
            else:
                self.set_status(f"“{game}” not uploaded")

        self._prompts[game] = UploadPrompt(self, game, link, info, choice)
        self.set_status(f"“{game}” changed — waiting on you")

    def _upload_linked(self, game, link, sig, digest):
        """Upload the linked save as a new backup for `game`."""
        path = link.get("path")
        kind = link.get("kind", "file")
        if not path or not os.path.exists(path):
            self.set_status("⚠ linked save is missing")
            return
        folder = next((g for g in self.games if g["name"] == game), None)
        if not folder:
            self.set_status("⚠ game not found in Drive — hit Refresh")
            return
        cid = link.get("console") or "gba"
        con = console_of(cid)
        emu = (con["emus"][0] if con and con["emus"] else "")
        device = self.device_name()
        self._busy_uploads.add(game)
        self.set_status(f"Uploading “{game}”…")

        def work():
            tmp = None
            try:
                if kind == "folder":
                    tmp = zip_folder(path)
                    src = tmp
                    original = sanitize(os.path.basename(os.path.normpath(path))) + ".zip"
                else:
                    src = path
                    original = os.path.basename(path)
                ext = os.path.splitext(original)[1]
                vname = timestamp() + "__" + sanitize(device) + ext
                props = {
                    "game": game, "device": device, "console": cid, "emulator": emu,
                    "kind": "folder" if kind == "folder" else "file",
                    "originalName": original,
                    "uploadedAt": datetime.datetime.now().isoformat(),
                    "hash": hash_file(src),
                    "source": "watcher",
                }
                self.drive.upload(folder["id"], vname, src, props)
                return True
            finally:
                if tmp:
                    try:
                        os.remove(tmp)
                    except OSError:
                        pass

        def done(_):
            self._busy_uploads.discard(game)
            self.watcher.mark_uploaded(game, sig, digest)
            self.set_status(f"“{game}” backed up ✔")
            if self.current_game and self.current_game["name"] == game:
                self.select_game_by_name(game)

        def err(m):
            self._busy_uploads.discard(game)
            self.set_status("⚠ upload failed")
            messagebox.showerror("Upload failed", f"{game}\n\n{m}")

        self.run_bg(work, done, err)

    # -- upload -------------------------------------------------------------
    def _pick_save_file(self, cid=None):
        con = console_of(cid)
        exts = con["exts"] if con else ALL_SAVE_EXTS
        types = [("Save files", " ".join("*" + e for e in exts)), ("All files", "*.*")]
        return filedialog.askopenfilename(title="Choose a save file to upload", filetypes=types)

    def new_game(self):
        """＋ New game — the only flow that asks you to name the game."""
        path = self._pick_save_file()
        if not path:
            return
        fn = os.path.basename(path)
        cid = guess_console(fn, self.my_console_ids()) or self.my_console_ids()[0]
        details = self.ask_upload_details(game_name_from_filename(fn), cid, self.device_name())
        if not details:
            return
        self.config_data["device"] = details["device"]
        save_config(self.config_data)
        self._do_upload(path, "file", details["game"], details["console"],
                        details["emulator"], details["device"], details.get("label", ""))

    def upload_to_current_game(self):
        """Upload straight into the selected game — no game-naming needed."""
        if not self.current_game:
            messagebox.showinfo("Pick a game", "Select a game first, or use ＋ New game.")
            return
        cid = self.current_console_id()
        kind = "file"
        if is_folder_console(cid):
            ans = messagebox.askquestion(
                "Folder save",
                f"{console_of(cid)['label']} saves are folders.\n\n"
                "Upload a whole save folder (it gets zipped)?\n\n"
                "Yes = pick a folder    No = pick a single file",
                icon="question")
            kind = "folder" if ans == "yes" else "file"
        if kind == "folder":
            path = filedialog.askdirectory(title="Choose the save folder to upload")
        else:
            path = self._pick_save_file(cid)
        if not path:
            return
        if not cid:
            cid = guess_console(os.path.basename(path), self.my_console_ids()) \
                  or self.my_console_ids()[0]
        emu = ""
        if self.current_saves:
            emu = self.current_saves[0].get("appProperties", {}).get("emulator", "")
        if not emu:
            con = console_of(cid)
            emu = con["emus"][0] if con and con["emus"] else ""
        label = simpledialog.askstring("Name this backup",
                                       "Backup name (optional — leave blank to skip):",
                                       parent=self) or ""
        self._do_upload(path, kind, self.current_game["name"], cid, emu,
                        self.device_name(), label.strip())

    def _do_upload(self, path, kind, game_name, console_id, emulator, device, label=""):
        self.set_status("Zipping…" if kind == "folder" else "Uploading…")

        def work():
            root = self.root_id or self.drive.ensure_root()
            self.root_id = root
            folder = self.drive.ensure_folder(sanitize(game_name), root,
                                              {"console": console_id, "role": "game"})
            try:
                self.drive.set_folder_props(folder, {"console": console_id, "role": "game"})
            except Exception:
                pass
            tmp = None
            try:
                if kind == "folder":
                    tmp = zip_folder(path)
                    src = tmp
                    original = sanitize(os.path.basename(os.path.normpath(path))) + ".zip"
                else:
                    src = path
                    original = os.path.basename(path)
                ext = os.path.splitext(original)[1]
                vname = timestamp() + "__" + sanitize(device) + ext
                props = {
                    "game": game_name, "device": device, "console": console_id,
                    "emulator": emulator,
                    "kind": "folder" if kind == "folder" else "file",
                    "originalName": original,
                    "uploadedAt": datetime.datetime.now().isoformat(),
                    "hash": hash_file(src),
                }
                if label:
                    props["label"] = label
                self.drive.upload(folder, vname, src, props)
            finally:
                if tmp:
                    try:
                        os.remove(tmp)
                    except OSError:
                        pass
            return game_name

        def done(game):
            self.set_status("Uploaded ✔")
            self.load_games(select_name=game)

        self.run_bg(work, done, lambda m: (self.set_status("⚠ upload failed"),
                                           messagebox.showerror("Upload failed", m)))

    def ask_upload_details(self, default_game, default_console, default_device):
        dlg = tk.Toplevel(self)
        dlg.title("Upload save")
        dlg.configure(bg=BG)
        dlg.resizable(False, False)
        dlg.transient(self)
        result = {}

        def row(label):
            tk.Label(dlg, text=label, bg=BG, fg=MUTED, font=("Segoe UI", 9, "bold")).pack(
                anchor="w", padx=20, pady=(12, 2))

        row("Game name")
        game_var = tk.StringVar(value=default_game)
        tk.Entry(dlg, textvariable=game_var, width=44, bg=PANEL2, fg=TEXT,
                 insertbackground=TEXT, relief="flat").pack(padx=20, ipady=4, fill="x")

        row("Console")
        mine = self.my_console_ids()
        ordered = [c for c in CONSOLES if c["id"] in mine] + \
                  [c for c in CONSOLES if c["id"] not in mine]
        labels = [c["label"] for c in ordered]
        con = console_of(default_console) or ordered[0]
        console_var = tk.StringVar(value=con["label"])
        console_cb = ttk.Combobox(dlg, textvariable=console_var, values=labels, state="readonly")
        console_cb.pack(padx=20, fill="x")

        row("Emulator (optional)")
        emu_var = tk.StringVar(value=(con["emus"][0] if con["emus"] else ""))
        emu_cb = ttk.Combobox(dlg, textvariable=emu_var, values=con["emus"])
        emu_cb.pack(padx=20, fill="x")

        def on_console(_e=None):
            c = CONSOLE_BY_LABEL.get(console_var.get())
            if c:
                emu_cb["values"] = c["emus"]
                emu_var.set(c["emus"][0] if c["emus"] else "")
        console_cb.bind("<<ComboboxSelected>>", on_console)

        row("Uploaded from (device)")
        dev_var = tk.StringVar(value=default_device)
        tk.Entry(dlg, textvariable=dev_var, width=44, bg=PANEL2, fg=TEXT,
                 insertbackground=TEXT, relief="flat").pack(padx=20, ipady=4, fill="x")
        row("Backup name (optional)")
        label_var = tk.StringVar(value="")
        tk.Entry(dlg, textvariable=label_var, width=44, bg=PANEL2, fg=TEXT,
                 insertbackground=TEXT, relief="flat").pack(padx=20, ipady=4, fill="x")

        btns = tk.Frame(dlg, bg=BG)
        btns.pack(fill="x", padx=20, pady=18)

        def ok():
            if not game_var.get().strip():
                messagebox.showinfo("Game name", "Please enter a game name.", parent=dlg)
                return
            c = CONSOLE_BY_LABEL.get(console_var.get()) or con
            result.update(game=game_var.get().strip(), console=c["id"],
                          emulator=emu_var.get().strip(),
                          device=dev_var.get().strip() or "Windows PC",
                          label=label_var.get().strip())
            dlg.destroy()

        tk.Button(btns, text="Upload", command=ok, bg=ACCENT, fg="white", borderwidth=0,
                  font=("Segoe UI", 10, "bold"), cursor="hand2", padx=16, pady=6).pack(side="right")
        tk.Button(btns, text="Cancel", command=dlg.destroy, bg=PANEL2, fg=TEXT, borderwidth=0,
                  font=("Segoe UI", 10), cursor="hand2", padx=16, pady=6).pack(side="right", padx=8)

        dlg.update_idletasks()
        x = self.winfo_rootx() + (self.winfo_width() - dlg.winfo_width()) // 2
        y = self.winfo_rooty() + 100
        dlg.geometry(f"+{x}+{y}")
        dlg.grab_set()
        self.wait_window(dlg)
        return result if result.get("game") else None

    # -- cover --------------------------------------------------------------
    def set_cover(self):
        if not self.current_game:
            return
        game = self.current_game
        path = filedialog.askopenfilename(
            title="Choose a cover image",
            filetypes=[("Images", "*.png *.jpg *.jpeg *.gif *.webp *.bmp"), ("All files", "*.*")])
        if not path:
            return
        self.set_status("Uploading cover…")

        def work():
            for f in self.drive.list_saves(game["id"]):
                if f.get("appProperties", {}).get("role") == "cover":
                    try:
                        self.drive.delete(f["id"])
                    except Exception:
                        pass
            ext = os.path.splitext(path)[1]
            self.drive.upload(game["id"], "cover" + ext, path,
                              {"role": "cover", "originalName": os.path.basename(path)})
            return True

        def done(_):
            self.set_status("Cover updated ✔")
            self.select_game_by_name(game["name"])

        self.run_bg(work, done, lambda m: messagebox.showerror("Cover failed", m))

    # -- download -----------------------------------------------------------
    def set_download_folder(self):
        if not self.current_game:
            return
        d = filedialog.askdirectory(title=f"Download folder for {self.current_game['name']}")
        if not d:
            return
        self.config_data.setdefault("download_paths", {})[self.current_game["name"]] = d
        save_config(self.config_data)
        self.update_summary()
        self.set_status("Download folder set")

    def delete_game(self):
        if not self.current_game:
            return
        if self.current_saves:
            messagebox.showinfo("Not empty", "This game still has saves — delete them first.")
            return
        name = self.current_game["name"]
        if not messagebox.askyesno(
                "Delete game",
                f'Delete the game "{name}"?\n\n'
                "The empty game folder will be moved to your Google Drive trash."):
            return
        folder_id = self.current_game["id"]
        self.set_status("Deleting game…")

        def work():
            self.drive.trash(folder_id)
            return True

        def done(_):
            self.config_data.get("links", {}).pop(name, None)
            save_config(self.config_data)
            self.watcher.forget(name)
            self.current_game = None
            self.game_title.config(text="Select a game")
            self.console_tag.pack_forget()
            self.summary.config(text="")
            self.cover_label.config(image="", text="🎮")
            self._cover_img = None
            for i in self.tree.get_children():
                self.tree.delete(i)
            self._set_actions_enabled(False)
            self.pull_latest_btn.config(state="disabled")
            self.delete_game_btn.config(state="disabled")
            self.refresh_link_panel()
            self.set_status("Game deleted")
            self.load_games()

        self.run_bg(work, done, lambda m: messagebox.showerror("Delete failed", m))

    def pull_latest(self):
        if self.current_saves:
            self._download(self.current_saves[0])

    def download_selected(self):
        sel = self.tree.selection()
        if not sel:
            messagebox.showinfo("Pick a save", "Select a save from the list first.")
            return
        self._download(self.current_saves[int(sel[0])])

    def rename_selected(self):
        sel = self.tree.selection()
        if not sel:
            messagebox.showinfo("Pick a save", "Select a save from the list first.")
            return
        save = self.current_saves[int(sel[0])]
        cur = save.get("appProperties", {}).get("label", "")
        name = simpledialog.askstring("Rename backup",
                                      "Backup name (leave blank to clear):",
                                      initialvalue=cur, parent=self)
        if name is None:
            return
        game = self.current_game
        self.set_status("Renaming…")

        def work():
            self.drive.set_label(save["id"], name.strip())
            return True

        def done(_):
            self.set_status("Renamed ✔")
            if game:
                self.select_game_by_name(game["name"])

        self.run_bg(work, done, lambda m: messagebox.showerror("Rename failed", m))

    def delete_selected(self):
        sel = self.tree.selection()
        if not sel:
            messagebox.showinfo("Pick a save", "Select a save from the list first.")
            return
        save = self.current_saves[int(sel[0])]
        p = save.get("appProperties", {})
        label = p.get("originalName", save["name"])
        if not messagebox.askyesno(
                "Delete backup",
                f"Delete this backup?\n\n{label}\n({fmt_time(save.get('createdTime',''))})\n\n"
                "It will be moved to your Google Drive trash (recoverable there for 30 days)."):
            return
        game = self.current_game
        self.set_status("Deleting…")

        def work():
            self.drive.trash(save["id"])
            return True

        def done(_):
            self.set_status("Backup deleted")
            if game:
                self.select_game_by_name(game["name"])

        self.run_bg(work, done, lambda m: messagebox.showerror("Delete failed", m))

    def _download(self, save):
        p = save.get("appProperties", {})
        suggested = p.get("originalName", save["name"])
        game_name = self.current_game["name"] if self.current_game else ""
        link = self.config_data.get("links", {}).get(game_name)

        # A folder save + a linked folder → offer to restore it in place.
        if p.get("kind") == "folder" and link and link.get("kind") == "folder":
            if messagebox.askyesno(
                    "Restore into linked folder",
                    f"Extract this backup straight into\n\n{link['path']}\n\n"
                    "Files with the same name will be overwritten. Continue?"):
                self._restore_folder(save, link["path"], game_name)
                return

        # A file save + a linked file → offer to write straight over it.
        if p.get("kind") != "folder" and link and link.get("kind") == "file":
            if messagebox.askyesno(
                    "Restore over linked save",
                    f"Write this backup over your linked save?\n\n{link['path']}\n\n"
                    "Your current save file will be replaced. Continue?"):
                self._restore_file(save, link["path"], game_name)
                return

        preset = self.config_data.get("download_paths", {}).get(game_name)
        if preset:
            dest = os.path.join(preset, suggested)
        else:
            dest = filedialog.asksaveasfilename(
                title="Save file as…", initialfile=suggested,
                defaultextension=os.path.splitext(suggested)[1] or ".sav")
            if not dest:
                return
        self.set_status("Downloading…")

        def work():
            self.drive.download(save["id"], dest)
            return dest

        def done(path):
            self.set_status("Downloaded ✔")
            messagebox.showinfo("Done", f"Saved to:\n{path}\n\n"
                                        f"Uploaded from: {p.get('device', 'Unknown')}")

        self.run_bg(work, done, lambda m: (self.set_status("⚠ download failed"),
                                           messagebox.showerror("Download failed", m)))

    def _restore_folder(self, save, dest_folder, game_name):
        self.set_status("Restoring…")

        def work():
            data = self.drive.download_bytes(save["id"])
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                for member in z.infolist():
                    # Refuse path traversal out of the destination folder.
                    target = os.path.normpath(os.path.join(dest_folder, member.filename))
                    if not target.startswith(os.path.normpath(dest_folder) + os.sep):
                        raise RuntimeError(f"unsafe path in zip: {member.filename}")
                z.extractall(dest_folder)
            return dest_folder

        def done(path):
            link = self.config_data.get("links", {}).get(game_name)
            if link:  # the restore is now the known-good state, don't re-prompt
                self.watcher.prime(game_name, link["path"], link.get("kind", "file"))
            self.set_status("Restored ✔")
            messagebox.showinfo("Restored", f"Extracted into:\n{path}")

        self.run_bg(work, done, lambda m: (self.set_status("⚠ restore failed"),
                                           messagebox.showerror("Restore failed", m)))

    def _restore_file(self, save, dest_path, game_name):
        self.set_status("Restoring…")

        def work():
            # Keep the current save next to it before overwriting.
            if os.path.exists(dest_path):
                backup = dest_path + ".before-restore-" + timestamp()
                try:
                    shutil.copy2(dest_path, backup)
                except OSError:
                    pass
            self.drive.download(save["id"], dest_path)
            return dest_path

        def done(path):
            link = self.config_data.get("links", {}).get(game_name)
            if link:
                self.watcher.prime(game_name, link["path"], link.get("kind", "file"))
            self.set_status("Restored ✔")
            messagebox.showinfo("Restored",
                                f"Written to:\n{path}\n\n"
                                "Your previous save was copied alongside it as "
                                "*.before-restore-*.")

        self.run_bg(work, done, lambda m: (self.set_status("⚠ restore failed"),
                                           messagebox.showerror("Restore failed", m)))


if __name__ == "__main__":
    App().mainloop()
