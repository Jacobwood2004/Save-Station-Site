"use strict";
/**
 * Save Station — desktop
 * ======================
 * The website, in a window, plus the one thing a browser can't do: watch the
 * save files on this PC and offer to commit them when you're done playing.
 *
 * How the halves fit together
 * ---------------------------
 * The window loads the real index.html from a loopback server (lib/siteserver),
 * so the app is never a copy that drifts. The page keeps doing what it always
 * did — Firebase sign-in, Drive uploads, the library — and this process adds
 * the local half: dialogs, file watching, emulator detection, and the commit
 * prompt.
 *
 * Only the page holds a Drive token, so when this process wants to back
 * something up it hands the bytes to the page and lets it do the upload. That
 * keeps exactly one implementation of "what a backup looks like" (uploadToSlot
 * in index.html), and means a save committed from the app is indistinguishable
 * from one uploaded on the website.
 *
 * What's stored on this PC: which file belongs to which game and slot, and a
 * copy of what was last committed so the next change can be described. No
 * account details, no tokens, no save history — that all lives in your Drive.
 */

const {
  app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, Notification, screen,
} = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

const { Store } = require("./lib/store");
const { startSiteServer } = require("./lib/siteserver");
const { SaveWatcher, Snapshots, hashPath, totalSize, human } = require("./lib/savewatch");
const { zipFolder, unzipTo } = require("./lib/zipfile");
const { runningEmulators, emulatorCovers } = require("./lib/emulators");

/* --------------------------------------------------------------- where things are */

// In development the site is the repo this folder sits in; in a packaged build
// it's copied in beside the app (see "extraResources" in package.json).
// Electron names its data folder after productName, which would put this app's
// files in %APPDATA%\Save Station — a folder anything else called "Save Station"
// may already own. Sharing it isn't just untidy: the single-instance lock is
// keyed on this path, so whichever app opened first would silently stop the
// other from starting. Its own folder, then.
app.setPath("userData", path.join(app.getPath("appData"), "save-station-desktop"));

const SITE_DIR = app.isPackaged ? path.join(process.resourcesPath, "site") : path.join(__dirname, "..");
const RENDERER_DIR = path.join(__dirname, "renderer");
const ICON_PNG = path.join(__dirname, "build", "icon.png");
const ICON_ICO = path.join(__dirname, "build", "icon.ico");
// The tray gets the simplified mark: the full ring of consoles is unreadable
// at 16px, which is all a tray icon ever is.
const ICON_TRAY = path.join(__dirname, "build", "tray.png");

const EMU_POLL_MS = 5000;
// No emulator we recognise is running, and a save has sat untouched this long?
// Ask anyway — a missing entry in lib/emulators.js shouldn't cost you a backup.
const FALLBACK_QUIET_MS = 45000;
// Plenty of emulators write the save out *as they close*, so the change turns
// up seconds after the process is already gone. A close stays "recent" this
// long, and a change that lands inside the window is treated as that session's
// — otherwise the most common case of all would wait for the fallback above.
const CLOSE_GRACE_MS = 120000;
const MAX_COMMIT_BYTES = 300 * 1024 * 1024;

/** One-time move of the links out of the folder this app used to share. Copies
    rather than moves: nothing that might belong to another app is touched. */
function migrateLegacyData() {
  const legacy = path.join(app.getPath("appData"), "Save Station");
  const now = app.getPath("userData");
  if (path.resolve(legacy) === path.resolve(now)) return;
  try {
    const from = path.join(legacy, "links.json");
    const to = path.join(now, "links.json");
    if (!fs.existsSync(from) || fs.existsSync(to)) return;
    fs.mkdirSync(now, { recursive: true });
    fs.copyFileSync(from, to);
    const snaps = path.join(legacy, "snapshots");
    if (fs.existsSync(snaps)) fs.cpSync(snaps, path.join(now, "snapshots"), { recursive: true });
  } catch (e) {
    // Worst case the app starts with nothing linked, which is recoverable in
    // a way that refusing to start is not.
  }
}

/* ------------------------------------------------------------------------ state */

let mainWindow = null;
let commitWindow = null;
let tray = null;
let server = null;
let quitting = false;
let hintShown = false;

let store = null;          // links.json
let watcher = null;
let snaps = null;

let emuRunning = [];       // emulators seen at the last poll
let recentCloses = [];     // [{ emu, at }] — see CLOSE_GRACE_MS
let emuTimer = null;
let queue = [];            // [{ key, reason }] waiting for a prompt
let promptOpen = false;

let jobSeq = 0;
const uploadJobs = new Map();

const linkKey = (gameFolderId, slotId) => gameFolderId + ":" + (slotId || "main");
const getLinks = () => store.get("links", {});
const getLink = (key) => getLinks()[key] || null;

function putLink(key, link) {
  const all = getLinks();
  all[key] = link;
  store.set("links", all);
}

function dropLink(key) {
  const all = getLinks();
  delete all[key];
  store.set("links", all);
}

function deviceName() {
  const host = (os.hostname() || "This PC").replace(/\.local$/i, "");
  return host.length > 40 ? host.slice(0, 40) : host;
}

function sanitize(n) {
  return String(n).replace(/[\/\\<>:"|?*]+/g, "-").replace(/\s{2,}/g, " ").trim().slice(0, 120);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
         "_" + p(d.getHours()) + "-" + p(d.getMinutes()) + "-" + p(d.getSeconds());
}

/** Tell the page something changed, if there's a page to tell. */
function toPage(msg) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("ss:event", msg);
}

function notify(title, body) {
  try {
    if (Notification.isSupported()) {
      const n = new Notification({ title, body, icon: fs.existsSync(ICON_PNG) ? ICON_PNG : undefined });
      n.on("click", () => showWindow());
      n.show();
    }
  } catch (e) { /* notifications are a courtesy, never a requirement */ }
}

/* ------------------------------------------------------------------- the window */

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    // Small enough to sit beside an emulator on one screen. The page lays out
    // as a phone would below 620px, so there's no size where it falls apart.
    minWidth: 380,
    minHeight: 480,
    backgroundColor: "#0e1116",
    title: "Save Station",
    icon: fs.existsSync(ICON_ICO) ? ICON_ICO : (fs.existsSync(ICON_PNG) ? ICON_PNG : undefined),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // The watcher lives in this process, but the *uploading* happens in the
      // page. A throttled background renderer would stall a commit made while
      // the window is hidden in the tray, which is precisely when they happen.
      backgroundThrottling: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadURL(url);
  mainWindow.once("ready-to-show", () => mainWindow.show());

  // Google's sign-in refuses to run inside an embedded browser, and it should:
  // you shouldn't type a Google password into a window an app controls. Any
  // navigation off our own origin goes to the real browser instead.
  const isOurs = (target) => target.startsWith(url) || target.startsWith("http://localhost:" + server.port);
  mainWindow.webContents.on("will-navigate", (e, target) => {
    if (isOurs(target)) return;
    e.preventDefault();
    shell.openExternal(target);
    toPage({ type: "external-nav", url: target });
  });
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: "deny" };
  });

  // Closing the window leaves it watching in the tray — the whole point of the
  // app is to be there when you finish playing, and that's usually after you've
  // put the window away. Quit properly from the tray or the File menu.
  mainWindow.on("close", (e) => {
    if (quitting || !tray) return;
    e.preventDefault();
    mainWindow.hide();
    if (!hintShown) {
      hintShown = true;
      notify("Still watching", "Save Station is in your tray, keeping an eye on your linked saves.");
    }
  });

  mainWindow.on("closed", () => { mainWindow = null; });
}

/* --------------------------------------------------------------- the Drive broker
   The Worker in worker/ answers with the website's origin in its CORS header,
   because that's the origin it was deployed for. This app is the same code,
   the same user and the same Firebase account — every call it makes still
   carries that user's signed ID token, which is what the Worker actually
   checks. So the answer is accepted here too. Nothing is granted by this that
   a browser tab on the website wouldn't already have. */

function patchBrokerCors(session, workerOrigin, appOrigin) {
  if (!workerOrigin) return;
  session.webRequest.onHeadersReceived({ urls: [workerOrigin + "/*"] }, (details, cb) => {
    const headers = {};
    // Header names come back in mixed case; drop any existing CORS ones rather
    // than ending up with two.
    Object.keys(details.responseHeaders || {}).forEach((k) => {
      if (!/^access-control-allow-(origin|headers|methods)$/i.test(k)) {
        headers[k] = details.responseHeaders[k];
      }
    });
    headers["access-control-allow-origin"] = [appOrigin];
    headers["access-control-allow-headers"] = ["Authorization, Content-Type"];
    headers["access-control-allow-methods"] = ["POST, GET, OPTIONS"];
    cb({ responseHeaders: headers });
  });
}

function workerOriginFromSite() {
  try {
    const html = fs.readFileSync(path.join(SITE_DIR, "index.html"), "utf8");
    const m = html.match(/const\s+WORKER_URL\s*=\s*"([^"]*)"/);
    if (m && /^https?:\/\//.test(m[1])) return new URL(m[1]).origin;
  } catch (e) {}
  return null;
}

/* ------------------------------------------------------------------ the commit */

/**
 * Hand the bytes to the page and let it do the upload — it's the half with a
 * Drive token, and index.html's uploadToSlot() is the single definition of
 * what a backup looks like.
 */
function requestUpload(job) {
  return new Promise((resolve) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      resolve({ ok: false, error: "the Save Station window isn't open" });
      return;
    }
    const id = String(++jobSeq);
    const timer = setTimeout(() => {
      uploadJobs.delete(id);
      resolve({ ok: false, error: "the upload timed out" });
    }, 300000);
    uploadJobs.set(id, { resolve, timer });
    mainWindow.webContents.send("ss:upload", Object.assign({ id }, job));
  });
}

ipcMain.on("ss:upload-result", (_e, msg) => {
  const job = uploadJobs.get(msg && msg.id);
  if (!job) return;
  clearTimeout(job.timer);
  uploadJobs.delete(msg.id);
  job.resolve(msg.result || { ok: false, error: "no answer from the page" });
});

/** Read the save (zipping a folder save), upload it, and record what was sent. */
async function commit(key, message, emulatorName) {
  const link = getLink(key);
  if (!link) return { ok: false, error: "that slot isn't linked any more" };
  if (!fs.existsSync(link.path)) return { ok: false, error: "the save file isn't there any more" };

  let bytes, filename;
  const isFolder = link.kind === "folder";
  try {
    if (isFolder) {
      bytes = zipFolder(link.path);
      filename = sanitize(path.basename(link.path)) + ".zip";
    } else {
      bytes = fs.readFileSync(link.path);
      filename = path.basename(link.path);
    }
  } catch (e) {
    return { ok: false, error: "couldn't read the save: " + e.message };
  }
  if (bytes.length > MAX_COMMIT_BYTES) {
    return { ok: false, error: "that save is " + human(bytes.length) + " — too big to upload from here" };
  }

  const hash = hashPath(link.path, link.kind);
  const res = await requestUpload({
    folderId: link.gameFolderId,
    gameName: link.gameName,
    consoleId: link.consoleId,
    slotId: link.slotId,
    slotName: link.slotName,
    emulator: emulatorName || link.emulator || "",
    device: deviceName(),
    filename,
    isFolder,
    label: message || "",
    bytes: new Uint8Array(bytes),
  });

  if (res && res.ok) {
    link.lastCommit = {
      hash,
      at: new Date().toISOString(),
      size: bytes.length,
      message: message || "",
      fileId: res.fileId || null,
    };
    putLink(key, link);
    watcher.markCommitted(key, link.path, link.kind, hash);
    snaps.take(key, link.path, link.kind);
    toPage({ type: "committed", key, link, message: message || "" });
  }
  return res || { ok: false, error: "the upload didn't finish" };
}

/* ----------------------------------------------------------- when to ask at all */

function enqueue(key, reason) {
  if (queue.some((q) => q.key === key)) return;
  queue.push({ key, reason });
  drain();
}

/** An emulator we know just closed — anything it could have written is fair game. */
function queueForEmulator(emu) {
  watcher.offerable().forEach((p) => {
    const link = getLink(p.key);
    if (!link) return;
    if (emu.consoles && !emulatorCovers(emu, link.consoleId)) return;
    enqueue(p.key, emu.name + " closed");
  });
}

/** Nothing recognisable is running and a change has gone quiet — ask anyway. */
function queueQuiet() {
  const now = Date.now();
  watcher.offerable().forEach((p) => {
    if (now - new Date(p.at).getTime() < FALLBACK_QUIET_MS) return;
    enqueue(p.key, "the save has been sitting still");
  });
}

async function drain() {
  if (promptOpen || !queue.length) return;
  const next = queue.shift();
  const link = getLink(next.key);
  const pending = watcher.pendingFor(next.key);
  if (!link || !pending) { drain(); return; }

  if (link.auto) {
    // "Always commit this slot" — do it and say so, rather than asking again.
    promptOpen = true;
    const msg = "Auto-commit — " + next.reason;
    const res = await commit(next.key, msg, null);
    promptOpen = false;
    if (res.ok) notify("Committed " + link.gameName, link.slotName + " — backed up to your Drive");
    else notify("Couldn't commit " + link.gameName, res.error || "the upload failed");
    drain();
    return;
  }

  openCommitPrompt(next.key, next.reason, pending);
}

function openCommitPrompt(key, reason, pending) {
  const link = getLink(key);
  if (!link) { drain(); return; }
  promptOpen = true;

  const diff = snaps.diff(key, link.path, link.kind);
  const payload = {
    key,
    reason,
    game: link.gameName,
    slot: link.slotName,
    console: link.consoleId,
    path: link.path,
    kind: link.kind,
    size: human(pending.size || totalSize(link.path, link.kind)),
    diff: diff.lines,
    firstCommit: !link.lastCommit,
    last: link.lastCommit
      ? { at: link.lastCommit.at, message: link.lastCommit.message || "" }
      : null,
  };

  commitWindow = new BrowserWindow({
    width: 470,
    // Tall enough for the diff, the message box and the buttons without the
    // prompt scrolling — a question you have to scroll is a question you skip.
    height: 712,
    show: false,
    frame: false,
    resizable: false,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    backgroundColor: "#141b24",
    icon: fs.existsSync(ICON_ICO) ? ICON_ICO : undefined,
    webPreferences: {
      preload: path.join(__dirname, "commit", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  commitWindow.loadFile(path.join(__dirname, "commit", "commit.html"));

  const sendData = () => {
    if (commitWindow && !commitWindow.isDestroyed()) commitWindow.webContents.send("ss:commit-data", payload);
  };
  ipcMain.once("ss:commit-ready", sendData);

  commitWindow.once("ready-to-show", () => {
    // Bottom-right, like a notification, so it never lands on top of whatever
    // you're doing next.
    try {
      const area = screen.getPrimaryDisplay().workArea;
      const [w, h] = commitWindow.getSize();
      commitWindow.setPosition(area.x + area.width - w - 24, area.y + area.height - h - 24);
    } catch (e) {}
    commitWindow.show();
  });

  const answered = { done: false };
  const onAnswer = async (_e, msg) => {
    if (answered.done) return;
    answered.done = true;
    ipcMain.removeListener("ss:commit-answer", onAnswer);
    const win = commitWindow;
    commitWindow = null;
    if (win && !win.isDestroyed()) win.close();

    const link2 = getLink(key);
    if (msg && msg.always && link2) { link2.auto = true; putLink(key, link2); toPage({ type: "links" }); }

    if (msg && msg.choice === "commit") {
      const res = await commit(key, (msg.message || "").trim(), null);
      if (res.ok) notify("Committed " + payload.game, payload.slot + " — backed up to your Drive");
      else notify("Couldn't commit " + payload.game, res.error || "the upload failed");
    } else {
      // "Not now" isn't "forget it". The app goes on showing the slot as having
      // uncommitted changes, and ⬆ Commit now is still one click away — it
      // just stops interrupting until the save changes again.
      watcher.snooze(key);
      toPage({ type: "links" });
    }
    promptOpen = false;
    drain();
  };
  ipcMain.on("ss:commit-answer", onAnswer);

  commitWindow.on("closed", () => {
    ipcMain.removeListener("ss:commit-ready", sendData);
    if (!answered.done) {
      answered.done = true;
      ipcMain.removeListener("ss:commit-answer", onAnswer);
      watcher.snooze(key);
      promptOpen = false;
      commitWindow = null;
      drain();
    }
  });
}

/* ------------------------------------------------------------- emulator polling */

async function pollEmulators() {
  let now = [];
  try { now = await runningEmulators(); } catch (e) { now = []; }
  const names = now.map((e) => e.name);
  const closed = emuRunning.filter((e) => names.indexOf(e.name) < 0);
  const changed = closed.length || now.length !== emuRunning.length;
  emuRunning = now;

  closed.forEach((emu) => {
    recentCloses.push({ emu, at: Date.now() });
    queueForEmulator(emu);                 // anything already waiting
  });
  recentCloses = recentCloses.filter((c) => Date.now() - c.at < CLOSE_GRACE_MS);
  if (!now.length) queueQuiet();
  if (changed) toPage({ type: "emulators", running: names });
}

/* ------------------------------------------------------------------------ IPC */

ipcMain.handle("ss:status", () => ({
  isDesktop: true,
  version: app.getVersion(),
  device: deviceName(),
  links: getLinks(),
  emulators: emuRunning.map((e) => e.name),
  pending: watcher ? watcher.allPending() : [],
}));

ipcMain.handle("ss:links", () => getLinks());

ipcMain.handle("ss:link", async (_e, info) => {
  if (!info || !info.gameFolderId) return { ok: false, error: "no game" };
  const folderMode = info.kind === "folder";
  const exts = (info.exts || []).map((e) => String(e).replace(/^\./, "")).filter(Boolean);
  const res = await dialog.showOpenDialog(mainWindow, {
    title: folderMode
      ? "Pick the save folder for " + info.gameName + " — " + info.slotName
      : "Pick the save file for " + info.gameName + " — " + info.slotName,
    buttonLabel: "Link this " + (folderMode ? "folder" : "save"),
    properties: [folderMode ? "openDirectory" : "openFile"],
    filters: folderMode || !exts.length ? undefined : [
      { name: "Save files", extensions: exts },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };

  const target = res.filePaths[0];
  const key = linkKey(info.gameFolderId, info.slotId);

  // The same file in two slots would have them fighting over one save — which
  // is the exact mix-up slots exist to prevent.
  const clash = Object.entries(getLinks()).find(
    ([k, l]) => k !== key && l.path && path.resolve(l.path) === path.resolve(target));
  if (clash) {
    return { ok: false, error: "That's already linked to " + clash[1].gameName +
      " — " + clash[1].slotName + ". One save file, one slot." };
  }

  const existing = getLink(key) || {};
  const link = {
    gameFolderId: info.gameFolderId,
    gameName: info.gameName,
    slotId: info.slotId || "main",
    slotName: info.slotName || "Slot 1",
    consoleId: info.consoleId || "",
    emulator: info.emulator || existing.emulator || "",
    path: target,
    kind: folderMode ? "folder" : "file",
    auto: !!existing.auto,
    // A fresh link has committed nothing yet, so the app offers to back the
    // current save up straight away rather than pretending it's already safe.
    lastCommit: null,
  };
  putLink(key, link);
  watcher.prime(key, target, link.kind);
  snaps.drop(key);
  toPage({ type: "links" });
  return { ok: true, key, link, size: human(totalSize(target, link.kind)) };
});

ipcMain.handle("ss:unlink", (_e, key) => {
  dropLink(key);
  watcher.forget(key);
  snaps.drop(key);
  toPage({ type: "links" });
  return { ok: true };
});

ipcMain.handle("ss:set-auto", (_e, { key, on }) => {
  const link = getLink(key);
  if (!link) return { ok: false };
  link.auto = !!on;
  putLink(key, link);
  return { ok: true, link };
});

/* Names live in your Drive, not here, so they can change on another device.
   The page tells us when what it's showing has drifted from what we stored. */
ipcMain.handle("ss:rename", (_e, { key, gameName, slotName }) => {
  const link = getLink(key);
  if (!link) return { ok: false };
  if (gameName) link.gameName = gameName;
  if (slotName) link.slotName = slotName;
  putLink(key, link);
  return { ok: true, link };
});

ipcMain.handle("ss:reveal", (_e, key) => {
  const link = getLink(key);
  if (link && link.path) shell.showItemInFolder(link.path);
  return { ok: true };
});

ipcMain.handle("ss:commit-now", async (_e, { key, message }) => {
  const res = await commit(key, (message || "").trim(), null);
  if (res.ok) toPage({ type: "links" });
  return res;
});

/** Write a backup from Drive back over the linked save, keeping the old one. */
ipcMain.handle("ss:restore", async (_e, { key, bytes, isZip }) => {
  const link = getLink(key);
  if (!link) return { ok: false, error: "that slot isn't linked on this PC" };
  const buf = Buffer.from(bytes);
  const suffix = ".savestation-" + stamp() + ".bak";
  try {
    if (link.kind === "folder") {
      if (!isZip) return { ok: false, error: "that backup isn't a folder save" };
      let backup = null;
      if (fs.existsSync(link.path)) {
        backup = link.path + suffix;
        fs.cpSync(link.path, backup, { recursive: true });
      }
      fs.mkdirSync(link.path, { recursive: true });
      const written = unzipTo(buf, link.path);
      const hash = hashPath(link.path, link.kind);
      watcher.markCommitted(key, link.path, link.kind, hash);
      snaps.take(key, link.path, link.kind);
      return { ok: true, path: link.path, backup, files: written.length };
    }
    let backup = null;
    if (fs.existsSync(link.path)) {
      backup = link.path + suffix;
      fs.copyFileSync(link.path, backup);
    }
    fs.mkdirSync(path.dirname(link.path), { recursive: true });
    fs.writeFileSync(link.path, buf);
    const hash = hashPath(link.path, link.kind);
    watcher.markCommitted(key, link.path, link.kind, hash);
    snaps.take(key, link.path, link.kind);
    return { ok: true, path: link.path, backup };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle("ss:open-external", (_e, url) => {
  if (/^https?:\/\//i.test(String(url || ""))) shell.openExternal(url);
  return { ok: true };
});

/* ------------------------------------------------------------------------ tray */

function buildTray() {
  const file = fs.existsSync(ICON_TRAY) ? ICON_TRAY : (fs.existsSync(ICON_PNG) ? ICON_PNG : null);
  if (!file) return;                            // no icon built yet — run `npm run icons`
  const img = nativeImage.createFromPath(file);
  if (img.isEmpty()) return;
  tray = new Tray(img.resize({ width: 16, height: 16 }));
  tray.setToolTip("Save Station — watching your saves");
  const menu = Menu.buildFromTemplate([
    { label: "Open Save Station", click: showWindow },
    { type: "separator" },
    {
      label: "Watching " + Object.keys(getLinks()).length + " save(s)",
      enabled: false,
    },
    { type: "separator" },
    { label: "Quit", click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on("double-click", showWindow);
}

/* ----------------------------------------------------------------- app lifecycle */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);

  app.whenReady().then(async () => {
    // Without this, Windows files our notifications under "electron.app".
    app.setAppUserModelId("com.savestation.desktop");
    migrateLegacyData();

    store = new Store(path.join(app.getPath("userData"), "links.json"), { links: {} });
    snaps = new Snapshots(path.join(app.getPath("userData"), "snapshots"));

    watcher = new SaveWatcher(getLinks, (pending, link) => {
      toPage({ type: "pending", key: pending.key, size: pending.size,
               game: link.gameName, slot: link.slotName });
      // Did an emulator that plays this console just close? Then this is the
      // save it wrote on the way out, and the question can be asked now rather
      // than after the fallback timer.
      const recent = recentCloses.find((c) => emulatorCovers(c.emu, link.consoleId));
      if (recent) enqueue(pending.key, recent.emu.name + " closed");
    });
    watcher.start();

    try {
      server = await startSiteServer(SITE_DIR, RENDERER_DIR, 8765);
    } catch (e) {
      dialog.showErrorBox("Save Station couldn't start",
        "The local server wouldn't start: " + e.message);
      app.quit();
      return;
    }

    const { session } = require("electron");
    patchBrokerCors(session.defaultSession, workerOriginFromSite(), "http://localhost:" + server.port);

    createWindow(server.url);
    buildTray();

    pollEmulators();
    emuTimer = setInterval(pollEmulators, EMU_POLL_MS);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(server.url);
      else showWindow();
    });
  });

  app.on("window-all-closed", () => {
    // Deliberately does nothing on Windows and macOS: the tray keeps watching.
    // Quit from the tray menu.
    if (!tray) app.quit();
  });

  app.on("before-quit", () => { quitting = true; });

  app.on("will-quit", () => {
    clearInterval(emuTimer);
    if (watcher) watcher.stop();
    if (server) server.close();
  });
}
