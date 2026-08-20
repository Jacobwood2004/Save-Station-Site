"use strict";
/**
 * The only bridge between the website and the machine it's running on.
 *
 * The page keeps context isolation on and no Node access, exactly as it would
 * in a browser. What it gains here is this object: a fixed list of things the
 * desktop app will do on its behalf — pick a file, watch it, write one back.
 * Nothing here takes a path from the page without the person choosing it in a
 * native dialog first.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("saveStationDesktop", {
  isDesktop: true,
  platform: process.platform,

  /* ---- what the app knows ---- */
  status: () => ipcRenderer.invoke("ss:status"),
  links: () => ipcRenderer.invoke("ss:links"),

  /* ---- linking a slot to a real save on this PC ---- */
  // Opens a native picker; the page never names a path itself.
  linkSlot: (info) => ipcRenderer.invoke("ss:link", info),
  unlinkSlot: (key) => ipcRenderer.invoke("ss:unlink", key),
  setAuto: (key, on) => ipcRenderer.invoke("ss:set-auto", { key, on }),
  reveal: (key) => ipcRenderer.invoke("ss:reveal", key),
  // A game or slot renamed elsewhere: keep the app's copy of the name in step.
  syncNames: (key, names) => ipcRenderer.invoke("ss:rename", Object.assign({ key }, names)),
  commitNow: (key, message) => ipcRenderer.invoke("ss:commit-now", { key, message }),

  /* ---- restoring a backup onto this PC ---- */
  restore: (payload) => ipcRenderer.invoke("ss:restore", payload),

  openExternal: (url) => ipcRenderer.invoke("ss:open-external", url),

  /* ---- main -> page ---- */
  // Anything worth redrawing for: a link changed, a commit finished, a save
  // was noticed. { type, ... }
  onEvent: (fn) => {
    const h = (_e, msg) => fn(msg);
    ipcRenderer.on("ss:event", h);
    return () => ipcRenderer.removeListener("ss:event", h);
  },
  // The app has bytes it wants uploaded, and the page is the only half that
  // holds a Drive token. It does the upload and reports back.
  onUploadRequest: (fn) => {
    const h = (_e, job) => fn(job);
    ipcRenderer.on("ss:upload", h);
    return () => ipcRenderer.removeListener("ss:upload", h);
  },
  uploadResult: (id, result) => ipcRenderer.send("ss:upload-result", { id, result }),
});
