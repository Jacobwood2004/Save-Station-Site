"use strict";
/**
 * The only state this app keeps on your PC.
 *
 * Deliberately small: which save file on disk belongs to which game and slot,
 * and what was last committed from it. Nothing about your account, no token,
 * no save data. Everything else lives in your Drive, where the website can see
 * it too — a link is the one thing that can't, because a path only means
 * something on this machine.
 */

const fs = require("fs");
const path = require("path");

class Store {
  constructor(file, fallback) {
    this.file = file;
    this.data = fallback;
    try {
      const raw = fs.readFileSync(file, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") this.data = Object.assign(fallback, parsed);
    } catch (e) {
      // No file yet, or a half-written one. Either way the fallback stands —
      // losing a link is annoying, refusing to start is worse.
    }
  }

  /** Write through a temp file, so a crash mid-write can't leave a broken one. */
  save() {
    const tmp = this.file + ".tmp";
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
      fs.renameSync(tmp, this.file);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (e2) {}
      throw e;
    }
  }

  get(key, dflt) {
    return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : dflt;
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
  }
}

module.exports = { Store };
