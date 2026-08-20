"use strict";
/**
 * Turns the logo into the files Windows wants.
 *
 *   assets/icon.svg     -> build/icon.png  (512), 256, 128, 64, 48
 *   assets/favicon.svg  -> 32, 24, 16, and build/tray.png
 *   all of them         -> build/icon.ico
 *
 * The small sizes come from the simplified mark on purpose: the full ring of
 * consoles turns to porridge at 16px, so the favicon cut — floppy, ring, five
 * dots — is what ends up in the taskbar and the tray.
 *
 * Rendering is done by Electron's own Chromium, off-screen, so there's no image
 * library to install and the result is exactly what the app itself would draw.
 *
 *   npm run icons              rebuild everything
 *   electron tools/make-icons.js --if-missing   only if they're stale
 */

const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const ASSETS = path.join(ROOT, "..", "assets");
const BUILD = path.join(ROOT, "build");
const FULL_SVG = path.join(ASSETS, "icon.svg");
const SMALL_SVG = path.join(ASSETS, "favicon.svg");

// size -> which artwork reads best at it
const SIZES = [
  { px: 512, svg: FULL_SVG, file: "icon.png" },
  { px: 256, svg: FULL_SVG, file: "icon-256.png" },
  { px: 128, svg: FULL_SVG, file: "icon-128.png" },
  { px: 64, svg: FULL_SVG, file: "icon-64.png" },
  { px: 48, svg: FULL_SVG, file: "icon-48.png" },
  { px: 32, svg: SMALL_SVG, file: "tray.png" },
  { px: 24, svg: SMALL_SVG, file: "icon-24.png" },
  { px: 16, svg: SMALL_SVG, file: "icon-16.png" },
];

function upToDate() {
  try {
    const newest = Math.max(fs.statSync(FULL_SVG).mtimeMs, fs.statSync(SMALL_SVG).mtimeMs);
    for (const s of SIZES) {
      if (fs.statSync(path.join(BUILD, s.file)).mtimeMs < newest) return false;
    }
    return fs.statSync(path.join(BUILD, "icon.ico")).mtimeMs >= newest;
  } catch (e) {
    return false;
  }
}

/** Is there anything actually drawn in this frame, or is it still blank? */
function hasInk(image) {
  try {
    const bm = image.toBitmap();           // BGRA
    let lit = 0;
    for (let i = 3; i < bm.length; i += 4) {
      if (bm[i] > 8 && ++lit > 64) return true;
    }
  } catch (e) {}
  return false;
}

/**
 * Render one SVG at one size, off-screen, and hand back the PNG bytes.
 *
 * Off-screen rendering paints in frames, and the first one or two can land
 * before the SVG has drawn — so this waits for a frame with something in it,
 * then for a quarter-second of no further painting, and keeps that.
 */
function render(svgPath, px) {
  return new Promise((resolve, reject) => {
    const svg = fs.readFileSync(svgPath, "utf8");
    const win = new BrowserWindow({
      width: px, height: px, show: false, frame: false, transparent: true,
      webPreferences: { offscreen: true, backgroundThrottling: false },
    });
    let settled = false;
    let best = null;
    let quiet = null;
    const finish = (err, png) => {
      if (settled) return;
      settled = true;
      clearTimeout(quiet);
      try { win.destroy(); } catch (e) {}
      err ? reject(err) : resolve(png);
    };

    win.webContents.on("paint", (_e, _dirty, image) => {
      if (image.isEmpty() || !hasInk(image)) return;
      best = image;
      clearTimeout(quiet);
      quiet = setTimeout(() => finish(null, best.toPNG()), 250);
    });
    win.webContents.once("did-fail-load", (_e, code, desc) =>
      finish(new Error(desc || "load failed " + code)));
    setTimeout(() => {
      if (best) finish(null, best.toPNG());
      else finish(new Error("nothing rendered for " + path.basename(svgPath) + " at " + px + "px"));
    }, 15000);

    const html = "<!doctype html><meta charset=utf-8>" +
      "<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}" +
      "svg{display:block;width:" + px + "px;height:" + px + "px}</style>" + svg;
    win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  });
}

/**
 * Pack the PNGs into an .ico. Windows has taken PNG-compressed icon entries
 * since Vista, so each size goes in as-is rather than being re-encoded as a
 * bitmap.
 */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);            // reserved
  header.writeUInt16LE(1, 2);            // 1 = icon
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;
  entries.forEach((e, i) => {
    const at = i * 16;
    dir.writeUInt8(e.px >= 256 ? 0 : e.px, at);       // 0 means 256
    dir.writeUInt8(e.px >= 256 ? 0 : e.px, at + 1);
    dir.writeUInt8(0, at + 2);                        // palette
    dir.writeUInt8(0, at + 3);                        // reserved
    dir.writeUInt16LE(1, at + 4);                     // colour planes
    dir.writeUInt16LE(32, at + 6);                    // bits per pixel
    dir.writeUInt32LE(e.png.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += e.png.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

app.disableHardwareAcceleration();      // deterministic output, no GPU needed

// Each size is rendered in its own window, and Electron quits by default the
// moment the last one closes — which would end the run after the first icon.
app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  try {
    if (process.argv.includes("--if-missing") && upToDate()) {
      console.log("icons are up to date");
      app.exit(0);
      return;
    }
    fs.mkdirSync(BUILD, { recursive: true });

    const made = [];
    for (const s of SIZES) {
      const png = await render(s.svg, s.px);
      fs.writeFileSync(path.join(BUILD, s.file), png);
      made.push({ px: s.px, png });
      console.log("  " + s.file + "  (" + s.px + "px, " + (png.length / 1024).toFixed(1) + " KB)");
    }

    // Largest first is what Windows' own tooling emits, and some readers care.
    const ico = buildIco(made.slice().sort((a, b) => b.px - a.px));
    fs.writeFileSync(path.join(BUILD, "icon.ico"), ico);
    console.log("  icon.ico  (" + made.length + " sizes, " + (ico.length / 1024).toFixed(1) + " KB)");
    app.exit(0);
  } catch (e) {
    console.error("icon build failed:", e.message);
    app.exit(1);
  }
});
