/**
 * Save recipes: how each emulator lays out its saves, so a picked folder can
 * be understood instead of guessed at.
 *
 * Shared, unchanged, by the desktop app and the Android engine (require) and
 * the website (a plain <script>, as window.SaveRecipes). The website keeps a
 * copy as save-recipes.js; change both together.
 *
 * Two kinds of layout:
 *
 *   Folder saves, many to a folder. PPSSPP's PSP/SAVEDATA holds one folder per
 *   game save; Azahar's title/00040000 one per 3DS game; and so on. Each
 *   recipe says what one of those entry folders looks like (its name, its
 *   parent's name, a file or folder inside it), where in it the save itself
 *   starts (root), and where its game's name can be read.
 *
 *   Junk. Files no save needs and every OS leaves around: skipped when a
 *   folder save is read, hashed or uploaded.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SaveRecipes = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const hexAscii = (h) => {
    let s = "";
    for (let i = 0; i + 1 < h.length; i += 2) s += String.fromCharCode(parseInt(h.slice(i, i + 2), 16));
    return /^[A-Z0-9]{4}$/.test(s) ? s : h.toUpperCase();
  };

  /* --------------------------------------------------------------- recipes
     entry   the entry folder's own name
     parent  its parent folder's name (left out: any)
     marker  a path that must exist inside the entry (left out: none)
     root    where the save starts, inside the entry ("" = the entry itself)
     title   { file (inside root), parse } or titleAt(entryPath) for a file
             outside it; parse is one of "sfo", "wibn", "metaxml"
     code    the game's id, shown beside its name
     slot    for games with several save folders: which one this is      */
  const FOLDER_RECIPES = [
    {
      id: "ppsspp", name: "PPSSPP", console: "psp",
      entry: /^[A-Z]{4}\d{5}[A-Za-z0-9_-]*$/, marker: "PARAM.SFO", root: "",
      title: { file: "PARAM.SFO", parse: "sfo" },
      code: (n) => n.slice(0, 9).toUpperCase(), slot: (n) => n.slice(9),
    },
    {
      id: "vita3k", name: "Vita3K", console: "vita",
      entry: /^[A-Z]{4}\d{5}$/, parent: /^savedata$/i, root: "",
      title: { file: "sce_sys/param.sfo", parse: "sfo" },
      code: (n) => n.toUpperCase(),
    },
    {
      id: "azahar", name: "Azahar / Citra", console: "3ds",
      entry: /^[0-9a-f]{8}$/i, parent: /^00040000$/, marker: "data/00000001", root: "data/00000001",
      code: (n) => "00040000" + n.toUpperCase(),
    },
    {
      id: "dolphin-wii", name: "Dolphin", console: "wii",
      entry: /^[0-9a-f]{8}$/i, parent: /^0001000[014]$/i, marker: "data", root: "data",
      title: { file: "banner.bin", parse: "wibn" },
      code: (n) => hexAscii(n),
    },
    {
      id: "cemu", name: "Cemu", console: "wiiu",
      entry: /^[0-9a-f]{8}$/i, parent: /^00050000$/, marker: "user", root: "user",
      titleAt: (entry) => {
        const m = /^(.*)[\\/]usr[\\/]save[\\/]00050000[\\/]([0-9a-f]{8})$/i.exec(entry);
        return m ? [m[1], "usr", "title", "00050000", m[2], "meta", "meta.xml"].join(entry.indexOf("\\") >= 0 ? "\\" : "/") : null;
      },
      titleParse: "metaxml",
      code: (n) => "00050000" + n.toUpperCase(),
    },
    {
      // bis/user/save/<index>/0 is the save; /1 is Ryujinx's working copy
      id: "ryujinx", name: "Ryujinx", console: "switch",
      entry: /^[0-9a-f]{16}$/i, parent: /^save$/i, marker: "0", root: "0",
      code: () => "",
    },
    {
      id: "yuzu", name: "Eden / Citron / yuzu", console: "switch",
      entry: /^[0-9a-f]{16}$/i, parent: /^[0-9a-f]{32}$/i, root: "",
      code: (n) => n.toUpperCase(),
    },
  ];

  /* Folders with save *files* in them: named, so the app can say whose they
     are. The console comes from the file itself, as before. */
  const FILE_RECIPES = [
    { id: "dolphin-gc", name: "Dolphin's GameCube memory card folder", path: /(^|[\\/])GC[\\/](USA|EUR|JAP)([\\/]Card [AB])?$/i, console: "wii" },
    { id: "melonds", name: "melonDS", path: /melonds/i, console: "nds" },
    { id: "desmume", name: "DeSmuME", path: /desmume/i, console: "nds" },
    { id: "drastic", name: "DraStic", path: /drastic/i, console: "nds" },
    { id: "mgba", name: "mGBA", path: /mgba/i, console: null },
    { id: "vbam", name: "VisualBoyAdvance-M", path: /visualboy|vba-?m/i, console: "gba" },
    { id: "sameboy", name: "SameBoy", path: /sameboy/i, console: null },
    { id: "retroarch", name: "RetroArch", path: /retroarch/i, console: null },
  ];

  /* Save states, not saves: snapshots an emulator takes of itself. Offered
     last, and flagged, wherever save files are listed. */
  const STATE_RE = /\.(state(\d+|\.auto)?|ss\d|ml\d|ds\d|dst|dss|sgm)$/i;

  // Folders that are never worth looking inside for saves, and can be huge
  const HEAVY_DIR_RE = /^(shaders?|shader ?cache|shadercache|cache|caches|logs?|dump|load|screenshots?|textures?|mods|sysdata|keys|games|roms|isos|updates?|dlc|content|graphic ?packs|graphicpacks|hfiotemp|crash ?dumps?|temp|tmp|amiibo|cheats|patches|resourcepacks|fonts|system|node_modules)$/i;

  /** Files nobody's save needs: OS leftovers, and Save Station's own .bak copies. */
  function isJunk(rel) {
    const parts = String(rel).replace(/\\/g, "/").split("/");
    const base = parts[parts.length - 1].toLowerCase();
    if (parts.some((p) => p.toLowerCase() === "__macosx")) return true;
    if (base === "thumbs.db" || base === "desktop.ini" || base === ".ds_store" || base.startsWith("._")) return true;
    return /\.savestation-[^/]*\.bak$/i.test(base);
  }

  /**
   * Is a folder one save entry, by its name, its parent's name and what's
   * inside it? exists(rel) answers for paths inside it.
   * -> { recipe, root: "data/00000001"|"", code, slot } | null
   */
  function entryAt(name, parentName, exists) {
    for (const r of FOLDER_RECIPES) {
      if (!r.entry.test(name)) continue;
      if (r.parent && !r.parent.test(parentName || "")) continue;
      if (r.marker && !exists(r.marker)) continue;
      return { recipe: r, root: r.root, code: r.code ? r.code(name) : name, slot: r.slot ? r.slot(name) : "" };
    }
    return null;
  }

  function fileRecipeFor(dirPath) {
    return FILE_RECIPES.find((r) => r.path.test(String(dirPath).replace(/[\\/]+$/, ""))) || null;
  }

  /* ---------------------------------------------------------------- titles */

  const utf8 = (bytes) => new TextDecoder("utf-8").decode(bytes);
  const cleanTitle = (s) => String(s || "").replace(/[™®©]/g, "").replace(/[\0\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ").trim();

  /** A PSP / Vita PARAM.SFO: { TITLE, SAVEDATA_TITLE, … } */
  function parseSfo(b) {
    if (!b || b.length < 20 || b[0] !== 0 || b[1] !== 0x50 || b[2] !== 0x53 || b[3] !== 0x46) return null;
    const u16 = (o) => b[o] | (b[o + 1] << 8);
    const u32 = (o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
    const keys = u32(8), data = u32(12), n = Math.min(u32(16), 256);
    const out = {};
    for (let i = 0; i < n; i++) {
      const e = 20 + i * 16;
      if (e + 16 > b.length) break;
      let k = "";
      for (let j = keys + u16(e); j < b.length && b[j]; j++) k += String.fromCharCode(b[j]);
      const fmt = u16(e + 2), len = u32(e + 4), at = data + u32(e + 12);
      if (at >= b.length) continue;
      if (fmt === 0x0404) out[k] = u32(at);
      else out[k] = utf8(b.subarray(at, Math.min(b.length, at + len))).replace(/\0[\s\S]*$/, "");
    }
    return out;
  }

  /** A Wii save's banner.bin: "WIBN", then its title and subtitle in UTF-16. */
  function parseWibn(b) {
    if (!b || b.length < 0xa0 || String.fromCharCode(b[0], b[1], b[2], b[3]) !== "WIBN") return null;
    const u16be = (off, len) => {
      let s = "";
      for (let i = off; i + 1 < off + len; i += 2) {
        const c = (b[i] << 8) | b[i + 1];
        if (!c) break;
        s += String.fromCharCode(c);
      }
      return s;
    };
    return { title: u16be(0x20, 0x40), detail: u16be(0x60, 0x40) };
  }

  /** A GameCube .gci: its game code, and the name it shows in the memory card screen. */
  function parseGci(b) {
    if (!b || b.length < 0x40) return null;
    const code = String.fromCharCode(b[0], b[1], b[2], b[3]);
    if (!/^[A-Z0-9]{4}$/.test(code)) return null;
    const at = 0x40 + (((b[0x3c] << 24) | (b[0x3d] << 16) | (b[0x3e] << 8) | b[0x3f]) >>> 0);
    if (at + 64 > b.length) return { code };
    const text = (s, e) => {
      let end = s;
      while (end < e && b[end]) end++;
      try { return new TextDecoder(code[3] === "J" ? "shift_jis" : "windows-1252").decode(b.subarray(s, end)); }
      catch (err) { return String.fromCharCode.apply(null, Array.from(b.subarray(s, end))); }
    };
    return { code, title: text(at, at + 32), detail: text(at + 32, at + 64) };
  }

  /** Cemu's meta.xml: the game's English name. */
  function parseMetaXml(bytes) {
    const m = /<longname_en[^>]*>([\s\S]*?)<\/longname_en>/i.exec(utf8(bytes));
    if (!m) return null;
    const t = m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'");
    return { title: t };
  }

  /** The game's name (and what the save says about itself) from a title file. */
  function readTitle(kind, bytes) {
    try {
      if (kind === "sfo") {
        const s = parseSfo(bytes);
        return s ? { title: cleanTitle(s.TITLE || s.STITLE || ""), detail: cleanTitle(s.SAVEDATA_TITLE || s.SAVEDATA_DETAIL || "") } : null;
      }
      if (kind === "wibn") { const w = parseWibn(bytes); return w ? { title: cleanTitle(w.title), detail: cleanTitle(w.detail) } : null; }
      if (kind === "gci") { const g = parseGci(bytes); return g ? { title: cleanTitle(g.title || ""), detail: cleanTitle(g.detail || ""), code: g.code } : null; }
      if (kind === "metaxml") { const x = parseMetaXml(bytes); return x ? { title: cleanTitle(x.title), detail: "" } : null; }
    } catch (e) { /* a damaged title file names nothing */ }
    return null;
  }

  /** Where an entry's title file is: [path inside root] or an absolute path. */
  function titleSource(recipe, entryPath) {
    if (recipe.title) return { inRoot: recipe.title.file, parse: recipe.title.parse };
    if (recipe.titleAt) { const p = recipe.titleAt(entryPath); return p ? { path: p, parse: recipe.titleParse } : null; }
    return null;
  }

  /**
   * The browser's half: a picked folder as a list of files, each with its
   * path from the picked folder's parent ("SAVEDATA/ULUS10336DATA00/PARAM.SFO"
   * -- what webkitRelativePath gives). Finds the saves in it.
   * -> [{ recipe, entry, prefix (the save's root, as a path prefix), code, slot, size, mtime, fileCount }]
   */
  function findInList(files) {
    const known = new Set();
    const dirs = new Set();
    for (const f of files) {
      const p = String(f.rel).replace(/\\/g, "/");
      known.add(p.toLowerCase());
      const parts = p.split("/");
      for (let i = 1; i < parts.length; i++) {
        const d = parts.slice(0, i).join("/");
        dirs.add(d);
        known.add(d.toLowerCase());
      }
    }
    const hits = [];
    const sorted = Array.from(dirs).sort((a, b) => a.split("/").length - b.split("/").length);
    const taken = [];
    for (const d of sorted) {
      if (taken.some((t) => d === t || d.startsWith(t + "/"))) continue;   // inside a save already found
      const parts = d.split("/");
      const hit = entryAt(parts[parts.length - 1], parts[parts.length - 2] || "",
        (rel) => known.has((d + "/" + rel).toLowerCase()));
      if (!hit) continue;
      taken.push(d);
      const prefix = hit.root ? d + "/" + hit.root : d;
      let size = 0, mtime = 0, fileCount = 0;
      for (const f of files) {
        const p = String(f.rel).replace(/\\/g, "/");
        if (!p.startsWith(prefix + "/") || isJunk(p)) continue;
        size += f.size || 0;
        mtime = Math.max(mtime, f.mtime || 0);
        fileCount++;
      }
      if (fileCount) hits.push(Object.assign(hit, { entry: d, prefix, size, mtime, fileCount }));
    }
    return hits.sort((a, b) => b.mtime - a.mtime);
  }

  return {
    FOLDER_RECIPES, FILE_RECIPES, STATE_RE, HEAVY_DIR_RE,
    isJunk, entryAt, fileRecipeFor, titleSource, readTitle, cleanTitle,
    parseSfo, parseWibn, parseGci, parseMetaXml, findInList,
  };
});
