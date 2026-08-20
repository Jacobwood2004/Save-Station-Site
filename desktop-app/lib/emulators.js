"use strict";
/**
 * Which emulators are running, and what they play.
 *
 * This is the bit a website can't do, and it's what makes the commit prompt
 * arrive at the right moment: not while you're mid-battle and the game has
 * just autosaved, but when you've closed the emulator and the save is final.
 *
 * Process polling rather than anything cleverer, because it costs a few
 * milliseconds every few seconds and works the same for a store install, a
 * portable build on a USB stick, or something launched through a frontend.
 *
 * An emulator that isn't on this list simply isn't recognised — the watcher
 * falls back to committing once a save has sat still for a while, so nothing
 * is ever lost by an omission. Add yours and it gets the better behaviour.
 */

const { execFile } = require("child_process");

const EMULATORS = [
  { name: "mGBA",        consoles: ["gb", "gbc", "gba"], procs: ["mgba", "mgba-qt", "mgba-sdl"] },
  { name: "VBA-M",       consoles: ["gba"],              procs: ["visualboyadvance-m", "vbam"] },
  { name: "SameBoy",     consoles: ["gb", "gbc"],        procs: ["sameboy"] },
  { name: "BGB",         consoles: ["gb", "gbc"],        procs: ["bgb", "bgb64"] },
  { name: "Gambatte",    consoles: ["gb", "gbc"],        procs: ["gambatte_qt", "gambatte-speedrun", "gambatte"] },
  { name: "melonDS",     consoles: ["nds"],              procs: ["melonds"] },
  { name: "DeSmuME",     consoles: ["nds"],              procs: ["desmume", "desmume_x64", "desmume-cli"] },
  { name: "Citra",       consoles: ["3ds"],              procs: ["citra", "citra-qt"] },
  { name: "Azahar",      consoles: ["3ds"],              procs: ["azahar"] },
  { name: "Lime3DS",     consoles: ["3ds"],              procs: ["lime3ds", "lime3ds-gui"] },
  { name: "Panda3DS",    consoles: ["3ds"],              procs: ["panda3ds", "alber"] },
  { name: "Dolphin",     consoles: ["wii"],              procs: ["dolphin", "dolphin-emu", "dolphinqt2"] },
  { name: "Cemu",        consoles: ["wiiu"],             procs: ["cemu"] },
  { name: "Ryujinx",     consoles: ["switch"],           procs: ["ryujinx", "ryujinx.ava", "ryujinx.headless.sdl2"] },
  { name: "Switch emulator", consoles: ["switch"],       procs: ["yuzu", "suyu", "sudachi", "citron", "eden"] },
  { name: "PPSSPP",      consoles: ["psp"],              procs: ["ppssppwindows64", "ppssppwindows", "ppssppqt", "ppssppsdl", "ppsspp"] },
  { name: "Vita3K",      consoles: ["vita"],             procs: ["vita3k"] },
  // RetroArch plays everything, so it can't narrow anything down — but knowing
  // it just closed is still the signal we want.
  { name: "RetroArch",   consoles: null,                 procs: ["retroarch"] },
];

const BY_PROC = {};
EMULATORS.forEach((e) => e.procs.forEach((p) => { BY_PROC[p] = e; }));

/** "C:\\Emu\\mGBA.exe" or "mGBA.exe" -> "mgba" */
function procKey(name) {
  const base = String(name || "").replace(/\\/g, "/").split("/").pop();
  return base.replace(/\.(exe|app|bin)$/i, "").toLowerCase();
}

function emulatorFor(procName) {
  return BY_PROC[procKey(procName)] || null;
}

/** Does this emulator cover that console? (RetroArch covers everything.) */
function emulatorCovers(emu, consoleId) {
  if (!emu) return false;
  if (!emu.consoles) return true;
  return emu.consoles.indexOf(consoleId) >= 0;
}

/**
 * The emulators running right now, as [{ name, consoles, proc }].
 *
 * Never rejects: a process list that fails to come back is reported as "none
 * running", which only costs us the nicer trigger, and the settle-timer
 * fallback still catches the save.
 */
function runningEmulators() {
  return new Promise((resolve) => {
    const done = (names) => {
      const seen = {};
      const out = [];
      names.forEach((n) => {
        const emu = emulatorFor(n);
        if (!emu || seen[emu.name]) return;
        seen[emu.name] = true;
        out.push(emu);
      });
      resolve(out);
    };

    if (process.platform === "win32") {
      execFile("tasklist", ["/fo", "csv", "/nh"], { windowsHide: true, maxBuffer: 8 << 20 },
        (err, stdout) => {
          if (err) return resolve([]);
          const names = [];
          for (const line of String(stdout).split(/\r?\n/)) {
            const m = line.match(/^"([^"]+)"/);
            if (m) names.push(m[1]);
          }
          done(names);
        });
      return;
    }
    execFile("ps", ["-A", "-o", "comm="], { maxBuffer: 8 << 20 }, (err, stdout) => {
      if (err) return resolve([]);
      done(String(stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
    });
  });
}

module.exports = { EMULATORS, emulatorFor, emulatorCovers, runningEmulators, procKey };
