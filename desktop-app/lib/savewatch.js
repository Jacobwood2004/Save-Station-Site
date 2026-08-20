"use strict";
/**
 * Watching a save file, and working out what actually changed in it.
 *
 * Two jobs live here:
 *
 *   1. Notice a write and wait for it to finish. An emulator doesn't write a
 *      save atomically, so the file is polled until it has stopped moving, and
 *      only then hashed. A save that was touched but not changed never counts.
 *
 *   2. Say what changed, so the commit prompt has something honest to show.
 *      That needs a copy of what was last committed, which is why a snapshot
 *      of it is kept next to the link — small for a save file, and it turns
 *      "your save changed" into "4.2 KB of 128 KB differ".
 *
 * Polling, not filesystem events, for the same reason the Python app polls: it
 * behaves the same on a network drive, a USB stick and a Steam Deck share.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { walkFiles } = require("./zipfile");

const POLL_MS = 4000;
const STABLE_POLLS = 2;          // ~8s of stillness before a save counts as final
const MAX_SNAPSHOT = 64 * 1024 * 1024;

/** A cheap fingerprint used to notice a write. null if the path is gone. */
function signature(target, kind) {
  try {
    if (kind === "folder") {
      let count = 0, total = 0, newest = 0;
      for (const f of walkFiles(target)) {
        const st = fs.statSync(f.full);
        count++;
        total += st.size;
        newest = Math.max(newest, st.mtimeMs);
      }
      return count + ":" + total + ":" + Math.round(newest);
    }
    const st = fs.statSync(target);
    return "1:" + st.size + ":" + Math.round(st.mtimeMs);
  } catch (e) {
    return null;
  }
}

function sha256(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }

/** SHA-256 of the content itself — the same one the website stamps on a backup. */
function hashPath(target, kind) {
  try {
    const h = crypto.createHash("sha256");
    if (kind === "folder") {
      for (const f of walkFiles(target)) {
        h.update(f.rel + "\0");
        h.update(fs.readFileSync(f.full));
      }
    } else {
      h.update(fs.readFileSync(target));
    }
    return h.digest("hex");
  } catch (e) {
    return "";
  }
}

function totalSize(target, kind) {
  try {
    if (kind !== "folder") return fs.statSync(target).size;
    return walkFiles(target).reduce((n, f) => n + fs.statSync(f.full).size, 0);
  } catch (e) {
    return 0;
  }
}

/** { rel: {size, hash} } for every file in a save folder. */
function manifest(dir) {
  const out = {};
  for (const f of walkFiles(dir)) {
    const data = fs.readFileSync(f.full);
    out[f.rel] = { size: data.length, hash: sha256(data) };
  }
  return out;
}

/* ------------------------------------------------------------------ snapshots
   What was last committed, kept so the next change can be described rather
   than just announced. One per link, overwritten each commit — this is not a
   second history, the history is in your Drive. */

class Snapshots {
  constructor(dir) {
    this.dir = dir;
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  }

  _base(key) {
    return path.join(this.dir, crypto.createHash("sha1").update(key).digest("hex").slice(0, 16));
  }

  take(key, target, kind) {
    try {
      if (kind === "folder") {
        fs.writeFileSync(this._base(key) + ".json", JSON.stringify(manifest(target)));
        return;
      }
      const st = fs.statSync(target);
      if (st.size > MAX_SNAPSHOT) { this.drop(key); return; }   // too big to be worth it
      fs.copyFileSync(target, this._base(key) + ".bin");
    } catch (e) {
      // A snapshot is a nicety. Failing to take one must never block a commit.
    }
  }

  drop(key) {
    for (const ext of [".bin", ".json"]) {
      try { fs.unlinkSync(this._base(key) + ext); } catch (e) {}
    }
  }

  /**
   * What changed since the last commit, as plain lines for the prompt.
   * Returns { lines: [...], known: bool }.
   */
  diff(key, target, kind) {
    const lines = [];
    try {
      if (kind === "folder") {
        const prevPath = this._base(key) + ".json";
        const now = manifest(target);
        const nowSize = Object.values(now).reduce((n, f) => n + f.size, 0);
        if (!fs.existsSync(prevPath)) {
          return { known: false, lines: [Object.keys(now).length + " files, " + human(nowSize)] };
        }
        const prev = JSON.parse(fs.readFileSync(prevPath, "utf8"));
        const prevSize = Object.values(prev).reduce((n, f) => n + f.size, 0);
        const added = [], removed = [], changed = [];
        Object.keys(now).forEach((rel) => {
          if (!prev[rel]) added.push(rel);
          else if (prev[rel].hash !== now[rel].hash) changed.push(rel);
        });
        Object.keys(prev).forEach((rel) => { if (!now[rel]) removed.push(rel); });
        if (changed.length) lines.push(changed.length + " file" + (changed.length > 1 ? "s" : "") + " changed");
        if (added.length) lines.push(added.length + " added");
        if (removed.length) lines.push(removed.length + " removed");
        if (!lines.length) lines.push("Same files, same contents");
        lines.push(sizeLine(prevSize, nowSize));
        const names = changed.concat(added).slice(0, 3);
        if (names.length) lines.push(names.join(", ") + (changed.length + added.length > 3 ? " …" : ""));
        return { known: true, lines };
      }

      const prevPath = this._base(key) + ".bin";
      const now = fs.readFileSync(target);
      if (!fs.existsSync(prevPath)) {
        return { known: false, lines: [human(now.length)] };
      }
      const prev = fs.readFileSync(prevPath);
      const common = Math.min(prev.length, now.length);
      let differing = 0;
      for (let i = 0; i < common; i++) if (prev[i] !== now[i]) differing++;
      differing += Math.abs(now.length - prev.length);
      const pct = now.length ? (differing / Math.max(now.length, prev.length)) * 100 : 0;
      lines.push(human(differing) + " of " + human(now.length) + " differ (" +
                 (pct < 0.1 ? "<0.1" : pct.toFixed(1)) + "%)");
      lines.push(sizeLine(prev.length, now.length));
      return { known: true, lines };
    } catch (e) {
      return { known: false, lines: [] };
    }
  }
}

function sizeLine(before, now) {
  const d = now - before;
  if (!d) return "Same size as the last backup (" + human(now) + ")";
  return human(now) + " — " + (d > 0 ? "+" : "−") + human(Math.abs(d)) + " on the last backup";
}

function human(b) {
  if (b < 1024) return b + " B";
  if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
  return (b / 1048576).toFixed(1) + " MB";
}

/* -------------------------------------------------------------------- watcher
   Holds a settled change as "pending" rather than acting on it. Whoever owns
   this decides when to ask — this app waits for the emulator to close. */

class SaveWatcher {
  constructor(getLinks, onPending) {
    this._getLinks = getLinks;
    this._onPending = onPending;
    this._state = {};       // key -> { sig, stable, handled }
    this._pending = {};     // key -> { key, hash, size, at }
    this._timer = null;
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => {
      try { this._scan(); } catch (e) { /* a hiccup must never take the app down */ }
    }, POLL_MS);
  }

  stop() { clearInterval(this._timer); this._timer = null; }

  /** Record a freshly linked save as-is, so linking never triggers a prompt. */
  prime(key, target, kind) {
    this._state[key] = { sig: signature(target, kind), stable: STABLE_POLLS };
    delete this._pending[key];
  }

  /** After a successful commit, the file on disk is what's backed up. */
  markCommitted(key, target, kind, hash) {
    this._state[key] = { sig: signature(target, kind), stable: STABLE_POLLS };
    delete this._pending[key];
  }

  forget(key) {
    delete this._state[key];
    delete this._pending[key];
  }

  pendingFor(key) { return this._pending[key] || null; }

  /* "Not now" doesn't mean "pretend it didn't happen". The change stays on the
     books — the app goes on saying the save is uncommitted — it just stops
     being offered until the save changes again. */
  snooze(key) {
    if (this._pending[key]) this._pending[key].snoozed = true;
  }

  allPending() { return Object.values(this._pending); }
  offerable() { return Object.values(this._pending).filter((p) => !p.snoozed); }

  _scan() {
    const links = this._getLinks();
    Object.keys(links).forEach((key) => {
      const link = links[key];
      if (!link || !link.path || link.paused) return;
      const kind = link.kind || "file";
      const sig = signature(link.path, kind);
      if (sig === null) return;                       // path gone — say nothing, it may come back

      const st = this._state[key] || (this._state[key] = { sig, stable: STABLE_POLLS });
      if (sig !== st.sig) {                           // still being written
        st.sig = sig;
        st.stable = 0;
        return;
      }
      if (st.stable >= STABLE_POLLS) return;          // already dealt with at this signature
      st.stable++;
      if (st.stable < STABLE_POLLS) return;

      // Settled. Is it actually different from what's backed up?
      const hash = hashPath(link.path, kind);
      if (!hash) return;
      const committed = (link.lastCommit && link.lastCommit.hash) || null;
      if (hash === committed) { delete this._pending[key]; return; }

      const entry = { key, hash, size: totalSize(link.path, kind), at: new Date().toISOString() };
      const before = this._pending[key];
      this._pending[key] = entry;
      if (!before || before.hash !== hash) this._onPending(entry, link);
    });
  }
}

module.exports = {
  SaveWatcher, Snapshots, signature, hashPath, manifest, totalSize, human,
  POLL_MS, STABLE_POLLS,
};
