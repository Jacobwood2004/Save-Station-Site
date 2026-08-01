"""
Save Station — Windows Companion
=================================
Full-featured desktop companion for the Save Station Web website. Connects to
the SAME Google Drive folder ("Save Station Web Saves"), and can do everything
the website can:

- Sign in with Google (one-time per PC).
- Browse games with cover art + a summary; full history behind "See all saves".
- Upload saves (game name auto-detected from the filename, editable; pick emulator).
- Set / change game cover art.
- Pull the latest save, or download any older backup.
- Per-game download folders: set a fixed path per game so pulls drop straight
  into that game's emulator save folder — no prompt.

Build to a standalone .exe with PyInstaller — see BUILD.md.
"""

import os
import sys
import io
import re
import json
import platform
import threading
import datetime
import tkinter as tk
from tkinter import ttk, filedialog, messagebox

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

# Read + write, so the app can upload as well as download. (Restricted scope —
# same "unverified app / Advanced" flow as before.)
SCOPES = ["https://www.googleapis.com/auth/drive"]
ROOT_FOLDER_NAME = "Save Station Web Saves"

APP_DIR = os.path.join(os.path.expanduser("~"), ".save_station")
TOKEN_PATH = os.path.join(APP_DIR, "token.json")
CONFIG_PATH = os.path.join(APP_DIR, "config.json")

SAVE_EXTS = [".sav", ".srm", ".dsv", ".ss0", ".ss1", ".ss2", ".ss3", ".ss4",
             ".ss5", ".ss6", ".ss7", ".ss8", ".ss9", ".state"]

BG = "#0e1116"
PANEL = "#161b22"
PANEL2 = "#1c232d"
TEXT = "#e6edf3"
MUTED = "#8b98a5"
ACCENT = "#7c5cff"

COVER_W, COVER_H = 200, 128  # fixed cover box (px)


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


def game_name_from_filename(fn):
    name = re.sub(r"\.[^.]+$", "", fn)
    name = re.sub(r"\s*[\(\[][^)\]]*[\)\]]", "", name)
    name = name.replace("_", " ")
    return re.sub(r"\s{2,}", " ", name).strip()


def sanitize(n):
    return re.sub(r"[\/\\<>:\"|?*]+", "-", n).strip()[:120]


def timestamp():
    return datetime.datetime.now().strftime("%Y-%m-%d_%H-%M-%S")


def guess_emulator(fn):
    ext = os.path.splitext(fn)[1].lower().lstrip(".")
    if ext.startswith("ss") or ext == "state":
        return "mGBA"
    if ext == "dsv":
        return "Delta"
    return "Delta"


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
        # Force re-consent if cached token lacks the scopes we now need.
        if creds and not creds.has_scopes(SCOPES):
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

    def ensure_folder(self, name, parent_id):
        q = ("mimeType='application/vnd.google-apps.folder' and trashed=false "
             f"and name='{name}' and '{parent_id}' in parents")
        res = self.service.files().list(q=q, fields="files(id)").execute()
        files = res.get("files", [])
        if files:
            return files[0]["id"]
        meta = {"name": name, "mimeType": "application/vnd.google-apps.folder",
                "parents": [parent_id]}
        return self.service.files().create(body=meta, fields="id").execute()["id"]

    def ensure_root(self):
        rid = self.find_root()
        if rid:
            return rid
        meta = {"name": ROOT_FOLDER_NAME, "mimeType": "application/vnd.google-apps.folder"}
        return self.service.files().create(body=meta, fields="id").execute()["id"]

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

    def upload(self, folder_id, name, local_path, app_properties):
        meta = {"name": name, "parents": [folder_id], "appProperties": app_properties}
        media = MediaFileUpload(local_path, resumable=False)
        self.service.files().create(body=meta, media_body=media, fields="id").execute()

    def delete(self, file_id):
        self.service.files().delete(fileId=file_id).execute()

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


# ----------------------------------------------------------------------------
# GUI
# ----------------------------------------------------------------------------
class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Save Station — Windows Companion")
        self.geometry("940x640")
        self.minsize(820, 560)
        self.configure(bg=BG)
        self.drive = Drive()
        self.config_data = load_config()
        self.root_id = None
        self.games = []
        self.current_saves = []
        self.current_game = None
        self._cover_img = None
        self.history_visible = False

        self.login_frame = tk.Frame(self, bg=BG)
        self.main_frame = tk.Frame(self, bg=BG)
        self._build_login()
        self._build_main()
        self.show_login()

    # -- login --------------------------------------------------------------
    def _build_login(self):
        wrap = tk.Frame(self.login_frame, bg=BG)
        wrap.place(relx=0.5, rely=0.5, anchor="center")
        tk.Label(wrap, text="🎮", bg=BG, font=("Segoe UI", 52)).pack()
        tk.Label(wrap, text="Save Station", bg=BG, fg=TEXT,
                 font=("Segoe UI", 24, "bold")).pack(pady=(6, 2))
        tk.Label(wrap, text="Your Delta & mGBA saves, synced with Google Drive",
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
        self.games_list = tk.Listbox(left, width=24, bg=PANEL, fg=TEXT,
                                     selectbackground=ACCENT, borderwidth=0,
                                     highlightthickness=0, activestyle="none",
                                     font=("Segoe UI", 10))
        self.games_list.pack(fill="y", expand=True, pady=6)
        self.games_list.bind("<<ListboxSelect>>", self.on_game_select)
        tk.Button(left, text="⬆ Upload save…", command=self.upload_save, bg=ACCENT,
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
        self.game_title = tk.Label(info, text="Select a game", bg=BG, fg=TEXT,
                                   font=("Segoe UI", 16, "bold"), anchor="w", justify="left")
        self.game_title.pack(anchor="w", pady=(2, 4))
        self.summary = tk.Label(info, text="", bg=BG, fg=MUTED, font=("Segoe UI", 10),
                                anchor="w", justify="left", wraplength=460)
        self.summary.pack(anchor="w")

        actions = tk.Frame(info, bg=BG)
        actions.pack(anchor="w", pady=(12, 0))
        self.pull_latest_btn = self._abtn(actions, "⬇ Pull latest", self.pull_latest, primary=True)
        self.see_all_btn = self._abtn(actions, "☰ See all saves", self.toggle_history)
        self.cover_btn = self._abtn(actions, "🖼 Set cover", self.set_cover)
        actions2 = tk.Frame(info, bg=BG)
        actions2.pack(anchor="w", pady=(8, 0))
        self.folder_btn = self._abtn(actions2, "📁 Set download folder", self.set_download_folder)

        # History (hidden until "See all saves")
        self.history_frame = tk.Frame(right, bg=BG)
        tk.Label(self.history_frame, text="SAVE HISTORY", bg=BG, fg=MUTED,
                 font=("Segoe UI", 9, "bold")).pack(anchor="w", pady=(14, 0))
        cols = ("when", "device", "emulator", "size")
        self.tree = ttk.Treeview(self.history_frame, columns=cols, show="headings",
                                 selectmode="browse", height=8)
        for c, w in zip(cols, (180, 170, 90, 80)):
            self.tree.heading(c, text=c.capitalize())
            self.tree.column(c, width=w, anchor="w")
        self.tree.pack(fill="both", expand=True, pady=6)
        tk.Button(self.history_frame, text="⬇ Download selected", command=self.download_selected,
                  bg=PANEL2, fg=TEXT, borderwidth=0, font=("Segoe UI", 10),
                  activebackground="#232c38", cursor="hand2", padx=14, pady=6).pack(anchor="w")

        self._set_actions_enabled(False)

    def _abtn(self, parent, text, cmd, primary=False):
        b = tk.Button(parent, text=text, command=cmd, borderwidth=0, cursor="hand2",
                      font=("Segoe UI", 10, "bold" if primary else "normal"),
                      bg=ACCENT if primary else PANEL2, fg="white" if primary else TEXT,
                      activebackground="#6a4fe0" if primary else "#232c38", padx=14, pady=6)
        b.pack(side="left", padx=(0, 8))
        return b

    def _set_actions_enabled(self, on):
        state = "normal" if on else "disabled"
        for b in (self.pull_latest_btn, self.see_all_btn, self.cover_btn, self.folder_btn):
            b.config(state=state)

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

    def device_name(self):
        if self.config_data.get("device"):
            return self.config_data["device"]
        n = os.environ.get("COMPUTERNAME") or platform.node() or "Windows PC"
        return f"{n} (Windows)"

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
        self.current_game = None
        self.games_list.delete(0, tk.END)
        for i in self.tree.get_children():
            self.tree.delete(i)
        self.login_btn.config(state="normal")
        self.login_status.config(text="Signed out.")
        self.show_login()

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
            for g in folders:
                self.games_list.insert(tk.END, "  " + g["name"])
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
            for idx, s in enumerate(saves):
                p = s.get("appProperties", {})
                when = fmt_time(s.get("createdTime", ""))
                if idx == 0:
                    when = "● " + when + "  (latest)"
                self.tree.insert("", tk.END, iid=str(idx), values=(
                    when, p.get("device", "Unknown"), p.get("emulator", ""),
                    human_size(s.get("size")),
                ))
            self.update_summary()
            has = bool(saves)
            self.pull_latest_btn.config(state="normal" if has else "disabled")
            self.set_status(f"“{game['name']}” · {len(saves)} backup(s)")

        self.run_bg(work, done)

    def update_summary(self):
        if not self.current_game:
            return
        lines = []
        if self.current_saves:
            latest = self.current_saves[0]
            p = latest.get("appProperties", {})
            lines.append(f"Latest: {fmt_time(latest.get('createdTime',''))} · "
                         f"from {p.get('device','Unknown')} · {p.get('emulator','')}")
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

    # -- upload -------------------------------------------------------------
    def upload_save(self):
        types = [("Save files", " ".join("*" + e for e in SAVE_EXTS)), ("All files", "*.*")]
        path = filedialog.askopenfilename(title="Choose a save file to upload", filetypes=types)
        if not path:
            return
        fn = os.path.basename(path)
        default_game = game_name_from_filename(fn)
        sel = self.games_list.curselection()
        if sel:
            default_game = self.games[sel[0]]["name"]
        details = self.ask_upload_details(default_game, guess_emulator(fn), self.device_name())
        if not details:
            return
        # remember device for next time
        self.config_data["device"] = details["device"]
        save_config(self.config_data)
        self.set_status("Uploading…")

        def work():
            root = self.root_id or self.drive.ensure_root()
            self.root_id = root
            folder = self.drive.ensure_folder(sanitize(details["game"]), root)
            ext = os.path.splitext(fn)[1].lstrip(".")
            vname = timestamp() + "__" + sanitize(details["device"]) + (("." + ext) if ext else "")
            props = {
                "game": details["game"], "device": details["device"],
                "emulator": details["emulator"], "originalName": fn,
                "uploadedAt": datetime.datetime.now().isoformat(),
            }
            self.drive.upload(folder, vname, path, props)
            return details["game"]

        def done(game):
            self.set_status("Uploaded ✔")
            self.load_games(select_name=game)

        self.run_bg(work, done, lambda m: (self.set_status("⚠ upload failed"),
                                           messagebox.showerror("Upload failed", m)))

    def ask_upload_details(self, default_game, default_emu, default_device):
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
        tk.Entry(dlg, textvariable=game_var, width=40, bg=PANEL2, fg=TEXT,
                 insertbackground=TEXT, relief="flat").pack(padx=20, ipady=4, fill="x")
        row("Emulator")
        emu_var = tk.StringVar(value=default_emu)
        ttk.Combobox(dlg, textvariable=emu_var, values=["Delta", "mGBA"],
                     state="readonly").pack(padx=20, fill="x")
        row("Uploaded from (device)")
        dev_var = tk.StringVar(value=default_device)
        tk.Entry(dlg, textvariable=dev_var, width=40, bg=PANEL2, fg=TEXT,
                 insertbackground=TEXT, relief="flat").pack(padx=20, ipady=4, fill="x")

        btns = tk.Frame(dlg, bg=BG)
        btns.pack(fill="x", padx=20, pady=18)

        def ok():
            if not game_var.get().strip():
                messagebox.showinfo("Game name", "Please enter a game name.", parent=dlg)
                return
            result.update(game=game_var.get().strip(), emulator=emu_var.get(),
                          device=dev_var.get().strip() or "Windows PC")
            dlg.destroy()

        tk.Button(btns, text="Upload", command=ok, bg=ACCENT, fg="white", borderwidth=0,
                  font=("Segoe UI", 10, "bold"), cursor="hand2", padx=16, pady=6).pack(side="right")
        tk.Button(btns, text="Cancel", command=dlg.destroy, bg=PANEL2, fg=TEXT, borderwidth=0,
                  font=("Segoe UI", 10), cursor="hand2", padx=16, pady=6).pack(side="right", padx=8)

        dlg.update_idletasks()
        x = self.winfo_rootx() + (self.winfo_width() - dlg.winfo_width()) // 2
        y = self.winfo_rooty() + 120
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
            ext = os.path.splitext(path)[1].lstrip(".")
            self.drive.upload(game["id"], "cover" + (("." + ext) if ext else ""), path,
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
        game_name = self.current_game["name"] if self.current_game else ""
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
