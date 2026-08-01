"""
Save Station — Windows Companion
=================================
Connects to the SAME Google Drive folder ("Save Station Web Saves") used by the
Save Station Web website. Sign in with Google, browse your games (with cover
art), and pull down the latest — or any — uploaded save.

- Reads from your Google Drive (read-only).
- Login screen with a single "Sign in with Google" button.
- Shows each game's cover (uploaded from the website) + full backup history with
  the device each save came from.
- "Pull latest" grabs the newest save for a game in one click.

Build to a standalone .exe with PyInstaller — see BUILD.md.
"""

import os
import sys
import io
import threading
import datetime
import tkinter as tk
from tkinter import ttk, filedialog, messagebox

import google.auth.transport.requests
from google_auth_oauthlib.flow import InstalledAppFlow
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload

try:
    from PIL import Image, ImageTk
    HAVE_PIL = True
except Exception:
    HAVE_PIL = False

SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]
ROOT_FOLDER_NAME = "Save Station Web Saves"

APP_DIR = os.path.join(os.path.expanduser("~"), ".save_station")
TOKEN_PATH = os.path.join(APP_DIR, "token.json")

BG = "#0e1116"
PANEL = "#161b22"
PANEL2 = "#1c232d"
TEXT = "#e6edf3"
MUTED = "#8b98a5"
ACCENT = "#7c5cff"


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

    def signed_in(self):
        return self.service is not None

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


def split_cover(files):
    cover = None
    saves = []
    for f in files:
        if f.get("appProperties", {}).get("role") == "cover":
            if cover is None:
                cover = f
        else:
            saves.append(f)
    return cover, saves


# ----------------------------------------------------------------------------
# GUI
# ----------------------------------------------------------------------------
class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Save Station — Windows Companion")
        self.geometry("880x600")
        self.minsize(760, 520)
        self.configure(bg=BG)
        self.drive = Drive()
        self.root_id = None
        self.games = []
        self.current_saves = []
        self._cover_img = None  # keep ref so Tk doesn't GC it

        self.login_frame = tk.Frame(self, bg=BG)
        self.main_frame = tk.Frame(self, bg=BG)
        self._build_login()
        self._build_main()
        self.show_login()

    # -- login screen -------------------------------------------------------
    def _build_login(self):
        wrap = tk.Frame(self.login_frame, bg=BG)
        wrap.place(relx=0.5, rely=0.5, anchor="center")
        tk.Label(wrap, text="🎮", bg=BG, font=("Segoe UI", 52)).pack()
        tk.Label(wrap, text="Save Station", bg=BG, fg=TEXT,
                 font=("Segoe UI", 24, "bold")).pack(pady=(6, 2))
        tk.Label(wrap, text="Pull your Delta & mGBA saves from Google Drive",
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
        self.status = tk.Label(header, text="", bg=BG, fg=MUTED, font=("Segoe UI", 10))
        self.status.pack(side="right")

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

        # Left: games
        left = tk.Frame(body, bg=BG)
        left.pack(side="left", fill="y", padx=(0, 12))
        tk.Label(left, text="GAMES", bg=BG, fg=MUTED,
                 font=("Segoe UI", 9, "bold")).pack(anchor="w")
        self.games_list = tk.Listbox(left, width=26, bg=PANEL, fg=TEXT,
                                     selectbackground=ACCENT, borderwidth=0,
                                     highlightthickness=0, activestyle="none",
                                     font=("Segoe UI", 10))
        self.games_list.pack(fill="y", expand=True, pady=6)
        self.games_list.bind("<<ListboxSelect>>", self.on_game_select)
        tk.Button(left, text="↻ Refresh", command=self.load_games, bg=PANEL2,
                  fg=TEXT, borderwidth=0, font=("Segoe UI", 9),
                  activebackground="#232c38", cursor="hand2").pack(fill="x")

        # Right: cover + saves
        right = tk.Frame(body, bg=BG)
        right.pack(side="left", fill="both", expand=True)

        top = tk.Frame(right, bg=BG)
        top.pack(fill="x")
        self.cover_label = tk.Label(top, bg=PANEL2, width=16, height=6, text="🎮",
                                    fg=MUTED, font=("Segoe UI", 30))
        self.cover_label.pack(side="left", padx=(0, 12))
        self.game_title = tk.Label(top, text="Select a game", bg=BG, fg=TEXT,
                                   font=("Segoe UI", 15, "bold"), anchor="w", justify="left")
        self.game_title.pack(side="left", anchor="n", pady=4)

        tk.Label(right, text="SAVE HISTORY", bg=BG, fg=MUTED,
                 font=("Segoe UI", 9, "bold")).pack(anchor="w", pady=(12, 0))
        cols = ("when", "device", "emulator", "size")
        self.tree = ttk.Treeview(right, columns=cols, show="headings", selectmode="browse")
        for c, w in zip(cols, (180, 170, 90, 80)):
            self.tree.heading(c, text=c.capitalize())
            self.tree.column(c, width=w, anchor="w")
        self.tree.pack(fill="both", expand=True, pady=6)

        btns = tk.Frame(right, bg=BG)
        btns.pack(fill="x")
        self.pull_latest_btn = tk.Button(btns, text="⬇ Pull latest", command=self.pull_latest,
                  bg=ACCENT, fg="white", borderwidth=0, font=("Segoe UI", 10, "bold"),
                  activebackground="#6a4fe0", cursor="hand2", padx=14, pady=6, state="disabled")
        self.pull_latest_btn.pack(side="left")
        self.download_btn = tk.Button(btns, text="⬇ Download selected", command=self.download_selected,
                  bg=PANEL2, fg=TEXT, borderwidth=0, font=("Segoe UI", 10),
                  activebackground="#232c38", cursor="hand2", padx=14, pady=6, state="disabled")
        self.download_btn.pack(side="left", padx=8)
        tk.Button(btns, text="Sign out", command=self.sign_out, bg=PANEL2, fg=MUTED,
                  borderwidth=0, font=("Segoe UI", 9), activebackground="#232c38",
                  cursor="hand2", padx=10, pady=6).pack(side="right")

    # -- frame switching ----------------------------------------------------
    def show_login(self):
        self.main_frame.pack_forget()
        self.login_frame.pack(fill="both", expand=True)

    def show_main(self):
        self.login_frame.pack_forget()
        self.main_frame.pack(fill="both", expand=True)

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

    # -- auth flow ----------------------------------------------------------
    def sign_in(self):
        self.login_btn.config(state="disabled")
        self.login_status.config(text="Opening Google sign-in in your browser…")

        def work():
            self.drive.authenticate()
            self.root_id = self.drive.find_root()
            return True

        def done(_):
            self.show_main()
            self.set_status("Signed in ✔")
            self.load_games()

        def err(m):
            self.login_btn.config(state="normal")
            self.login_status.config(text="⚠ " + m)

        self.run_bg(work, done, err)

    def sign_out(self):
        try:
            if os.path.exists(TOKEN_PATH):
                os.remove(TOKEN_PATH)
        except Exception:
            pass
        self.drive = Drive()
        self.root_id = None
        self.games_list.delete(0, tk.END)
        for i in self.tree.get_children():
            self.tree.delete(i)
        self.login_btn.config(state="normal")
        self.login_status.config(text="Signed out.")
        self.show_login()

    # -- data flow ----------------------------------------------------------
    def load_games(self):
        self.set_status("Loading games…")

        def work():
            if not self.root_id:
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
            if folders:
                self.set_status(f"{len(folders)} game(s)")
            else:
                self.set_status("No games yet — upload one from the website")

        self.run_bg(work, done, lambda m: self.set_status("⚠ " + m))

    def on_game_select(self, _evt=None):
        sel = self.games_list.curselection()
        if not sel:
            return
        game = self.games[sel[0]]
        self.game_title.config(text=game["name"])
        self.cover_label.config(image="", text="🎮")
        self._cover_img = None
        self.set_status(f"Loading “{game['name']}”…")
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
                    img.thumbnail((150, 100))
                    self._cover_img = ImageTk.PhotoImage(img)
                    self.cover_label.config(image=self._cover_img, text="")
                except Exception:
                    pass
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
        if self.current_saves:
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
