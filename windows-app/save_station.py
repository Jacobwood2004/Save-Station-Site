"""
Save Station — Windows Companion
=================================
A small desktop app that connects to the SAME Google Drive folder
("Save Station Web Saves") used by the Save Station Web website, lets you
browse your games, and pull down the latest (or any) uploaded save.

- Reads from your Google Drive (read-only).
- Lists each game folder, shows every backup with its timestamp + the
  device it was uploaded from + emulator, and lets you download any of them.
- "Pull latest" grabs the newest save for a game in one click.

Build to a standalone .exe with PyInstaller — see BUILD.md.
"""

import os
import sys
import json
import threading
import datetime
import tkinter as tk
from tkinter import ttk, filedialog, messagebox

import google.auth.transport.requests
from google_auth_oauthlib.flow import InstalledAppFlow
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload
import io

# Read-only access is enough to find the folder (created by the website) and
# download saves. This scope sees the whole Drive read-only, so it can locate
# the website's app-created folder by name.
SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]
ROOT_FOLDER_NAME = "Save Station Web Saves"

APP_DIR = os.path.join(os.path.expanduser("~"), ".save_station")
TOKEN_PATH = os.path.join(APP_DIR, "token.json")


def resource_path(rel):
    """Locate bundled files whether running from source or a PyInstaller exe."""
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, rel)


def client_secrets_path():
    # Look next to the exe/script first, then bundled.
    for p in (
        os.path.join(os.path.dirname(sys.executable), "client_secret.json"),
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "client_secret.json"),
        resource_path("client_secret.json"),
    ):
        if os.path.exists(p):
            return p
    return None


# ----------------------------------------------------------------------------
# Google Drive access
# ----------------------------------------------------------------------------
class Drive:
    def __init__(self):
        self.service = None

    def authenticate(self):
        os.makedirs(APP_DIR, exist_ok=True)
        creds = None
        if os.path.exists(TOKEN_PATH):
            try:
                creds = Credentials.from_authorized_user_file(TOKEN_PATH, SCOPES)
            except Exception:
                creds = None
        if not creds or not creds.valid:
            if creds and creds.expired and creds.refresh_token:
                creds.refresh(google.auth.transport.requests.Request())
            else:
                secrets = client_secrets_path()
                if not secrets:
                    raise RuntimeError(
                        "client_secret.json not found. Put your Google OAuth "
                        "'Desktop app' client_secret.json next to this program. "
                        "See BUILD.md."
                    )
                flow = InstalledAppFlow.from_client_secrets_file(secrets, SCOPES)
                creds = flow.run_local_server(port=0)
            with open(TOKEN_PATH, "w") as f:
                f.write(creds.to_json())
        self.service = build("drive", "v3", credentials=creds, cache_discovery=False)

    def find_root(self):
        q = ("mimeType='application/vnd.google-apps.folder' and trashed=false "
             f"and name='{ROOT_FOLDER_NAME}'")
        res = self.service.files().list(q=q, fields="files(id,name)", spaces="drive").execute()
        files = res.get("files", [])
        return files[0]["id"] if files else None

    def list_subfolders(self, parent_id):
        q = ("mimeType='application/vnd.google-apps.folder' and trashed=false "
             f"and '{parent_id}' in parents")
        res = self.service.files().list(
            q=q, fields="files(id,name)", orderBy="name", pageSize=200
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

    def download(self, file_id, dest_path):
        request = self.service.files().get_media(fileId=file_id)
        buf = io.BytesIO()
        downloader = MediaIoBaseDownload(buf, request)
        done = False
        while not done:
            _, done = downloader.next_chunk()
        with open(dest_path, "wb") as f:
            f.write(buf.getvalue())


# ----------------------------------------------------------------------------
# GUI
# ----------------------------------------------------------------------------
class App(tk.Tk):
    BG = "#0e1116"; PANEL = "#161b22"; TEXT = "#e6edf3"; MUTED = "#8b98a5"; ACCENT = "#7c5cff"

    def __init__(self):
        super().__init__()
        self.title("Save Station — Windows Companion")
        self.geometry("820x560")
        self.configure(bg=self.BG)
        self.drive = Drive()
        self.root_id = None
        self.games = []          # [{id,name}]
        self.current_saves = []  # saves for selected game

        self._build_ui()
        self.after(200, self.connect)

    def _build_ui(self):
        style = ttk.Style(self)
        try:
            style.theme_use("clam")
        except Exception:
            pass
        style.configure("Treeview", background=self.PANEL, foreground=self.TEXT,
                        fieldbackground=self.PANEL, rowheight=26, borderwidth=0)
        style.configure("Treeview.Heading", background="#1c232d", foreground=self.MUTED)
        style.map("Treeview", background=[("selected", self.ACCENT)])

        header = tk.Frame(self, bg=self.BG)
        header.pack(fill="x", padx=16, pady=(14, 8))
        tk.Label(header, text="🎮  Save Station", bg=self.BG, fg=self.TEXT,
                 font=("Segoe UI", 16, "bold")).pack(side="left")
        self.status = tk.Label(header, text="Connecting…", bg=self.BG, fg=self.MUTED,
                               font=("Segoe UI", 10))
        self.status.pack(side="right")

        body = tk.Frame(self, bg=self.BG)
        body.pack(fill="both", expand=True, padx=16, pady=8)

        # Left: games
        left = tk.Frame(body, bg=self.BG)
        left.pack(side="left", fill="y", padx=(0, 12))
        tk.Label(left, text="GAMES", bg=self.BG, fg=self.MUTED,
                 font=("Segoe UI", 9, "bold")).pack(anchor="w")
        self.games_list = tk.Listbox(left, width=28, bg=self.PANEL, fg=self.TEXT,
                                     selectbackground=self.ACCENT, borderwidth=0,
                                     highlightthickness=0, activestyle="none",
                                     font=("Segoe UI", 10))
        self.games_list.pack(fill="y", expand=True, pady=6)
        self.games_list.bind("<<ListboxSelect>>", self.on_game_select)
        tk.Button(left, text="↻ Refresh", command=self.connect, bg="#1c232d",
                  fg=self.TEXT, borderwidth=0, font=("Segoe UI", 9),
                  activebackground="#232c38", cursor="hand2").pack(fill="x")

        # Right: saves
        right = tk.Frame(body, bg=self.BG)
        right.pack(side="left", fill="both", expand=True)
        tk.Label(right, text="SAVE HISTORY", bg=self.BG, fg=self.MUTED,
                 font=("Segoe UI", 9, "bold")).pack(anchor="w")
        cols = ("when", "device", "emulator", "size")
        self.tree = ttk.Treeview(right, columns=cols, show="headings", selectmode="browse")
        for c, w in zip(cols, (170, 170, 90, 80)):
            self.tree.heading(c, text=c.capitalize())
            self.tree.column(c, width=w, anchor="w")
        self.tree.pack(fill="both", expand=True, pady=6)

        btns = tk.Frame(right, bg=self.BG)
        btns.pack(fill="x")
        self.pull_latest_btn = tk.Button(btns, text="⬇ Pull latest", command=self.pull_latest,
                  bg=self.ACCENT, fg="white", borderwidth=0, font=("Segoe UI", 10, "bold"),
                  activebackground="#6a4fe0", cursor="hand2", padx=14, pady=6, state="disabled")
        self.pull_latest_btn.pack(side="left")
        self.download_btn = tk.Button(btns, text="⬇ Download selected", command=self.download_selected,
                  bg="#1c232d", fg=self.TEXT, borderwidth=0, font=("Segoe UI", 10),
                  activebackground="#232c38", cursor="hand2", padx=14, pady=6, state="disabled")
        self.download_btn.pack(side="left", padx=8)

    # -- helpers ------------------------------------------------------------
    def set_status(self, text):
        self.status.config(text=text)

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

    # -- flow ---------------------------------------------------------------
    def connect(self):
        self.set_status("Connecting to Google Drive…")

        def work():
            self.drive.authenticate()
            self.root_id = self.drive.find_root()
            if not self.root_id:
                raise RuntimeError(
                    f"Couldn't find the '{ROOT_FOLDER_NAME}' folder. "
                    "Upload a save from the website first."
                )
            return self.drive.list_subfolders(self.root_id)

        def done(folders):
            self.games = folders
            self.games_list.delete(0, tk.END)
            for g in folders:
                self.games_list.insert(tk.END, "  " + g["name"])
            self.set_status(f"Connected · {len(folders)} game(s)")
            if not folders:
                self.set_status("Connected · no games yet — upload one from the website")

        self.run_bg(work, done, lambda m: self.set_status("⚠ " + m))

    def on_game_select(self, _evt=None):
        sel = self.games_list.curselection()
        if not sel:
            return
        game = self.games[sel[0]]
        self.set_status(f"Loading “{game['name']}”…")
        for i in self.tree.get_children():
            self.tree.delete(i)

        def work():
            return self.drive.list_saves(game["id"])

        def done(saves):
            self.current_saves = saves
            for idx, s in enumerate(saves):
                p = s.get("appProperties", {})
                when = fmt_time(s.get("createdTime", ""))
                if idx == 0:
                    when = "● " + when + "  (latest)"
                self.tree.insert("", tk.END, iid=str(idx), values=(
                    when,
                    p.get("device", "Unknown"),
                    p.get("emulator", ""),
                    human_size(s.get("size")),
                ))
            self.set_status(f"“{game['name']}” · {len(saves)} backup(s)")
            self.pull_latest_btn.config(state="normal" if saves else "disabled")
            self.download_btn.config(state="normal" if saves else "disabled")

        self.run_bg(work, done)

    def pull_latest(self):
        if not self.current_saves:
            return
        self._download(self.current_saves[0])

    def download_selected(self):
        sel = self.tree.selection()
        if not sel:
            messagebox.showinfo("Pick a save", "Select a save from the list first.")
            return
        self._download(self.current_saves[int(sel[0])])

    def _download(self, save):
        p = save.get("appProperties", {})
        suggested = p.get("originalName", save["name"])
        dest = filedialog.asksaveasfilename(
            title="Save file as…",
            initialfile=suggested,
            defaultextension=os.path.splitext(suggested)[1] or ".sav",
        )
        if not dest:
            return
        self.set_status("Downloading…")

        def work():
            self.drive.download(save["id"], dest)
            return dest

        def done(path):
            self.set_status("Downloaded ✔")
            messagebox.showinfo("Done", f"Saved to:\n{path}\n\nUploaded from: {p.get('device', 'Unknown')}")

        self.run_bg(work, done, lambda m: (self.set_status("⚠ download failed"),
                                           messagebox.showerror("Download failed", m)))


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


if __name__ == "__main__":
    App().mainloop()
