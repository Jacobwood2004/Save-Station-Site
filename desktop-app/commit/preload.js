"use strict";
/**
 * The commit prompt's bridge — three calls, because that's all a question
 * with three answers needs.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("commitPrompt", {
  onData: (fn) => ipcRenderer.on("ss:commit-data", (_e, data) => fn(data)),
  answer: (choice, message, always) => ipcRenderer.send("ss:commit-answer", { choice, message, always }),
  ready: () => ipcRenderer.send("ss:commit-ready"),
});
