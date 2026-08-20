"use strict";
/**
 * The desktop half of the page.
 *
 * This is the only file the app injects into index.html. It adds three things
 * and touches nothing else:
 *
 *   1. "On this PC" — the panel under a game's slot tabs, where a slot gets
 *      pointed at the save file your emulator actually writes.
 *   2. The upload half of a commit. The app process holds the bytes; this page
 *      holds the Drive token; so the app asks and this does the upload through
 *      the website's own uploadToSlot().
 *   3. Restore. A backup can be written straight back over the linked save,
 *      with the current one kept beside it.
 *
 * Everything it uses from the site is on window.SaveStation, which index.html
 * exposes deliberately. If something here breaks after a site change, that's
 * the surface to look at.
 */

(function () {
  const desktop = window.saveStationDesktop;
  if (!desktop || !desktop.isDesktop) return;   // opened in a browser: do nothing

  const $ = (id) => document.getElementById(id);
  let links = {};             // key -> link, mirrored from the app process
  let pending = {};           // key -> true, saves changed but not committed
  let lastHistory = null;     // the detail of the last savestation:history event
  let linkPollTimer = null;

  const SS = () => window.SaveStation;
  const keyFor = (folderId, slotId) => folderId + ":" + (slotId || "main");
  const esc = (s) => (SS() ? SS().escapeHtml(s) : String(s));

  /* ------------------------------------------------------------- app state */

  async function refreshStatus() {
    try {
      const st = await desktop.status();
      links = st.links || {};
      pending = {};
      (st.pending || []).forEach((p) => { pending[p.key] = true; });
      paintSidebar(st);
      renderPanel();
    } catch (e) { /* the app process will tell us again soon enough */ }
  }

  function paintSidebar(st) {
    const sub = document.querySelector(".sb-title small");
    if (!sub) return;
    const n = Object.keys(links).length;
    sub.textContent = n
      ? "desktop · watching " + n + " save" + (n === 1 ? "" : "s")
      : "desktop app";
    sub.title = (st && st.emulators && st.emulators.length)
      ? "Running: " + st.emulators.join(", ")
      : "No emulator running";
  }

  /* -------------------------------------------------- the "On this PC" panel */

  function renderPanel() {
    const host = $("desktopPanel");
    if (!host || !lastHistory) return;
    const { folderId, name, slots, activeSlot, console: consoleId } = lastHistory;
    const con = SS().consoleOf(consoleId);
    const folderSave = SS().isFolderConsole(consoleId);

    // "All" isn't a slot, and a save file belongs to exactly one of them.
    if (activeSlot === "all" && slots.length > 1) {
      host.innerHTML = card(
        '<div class="ds-empty">Pick a slot above to link it to a save file on this PC. ' +
        'Each slot watches its own file — that’s how two playthroughs stay apart.</div>');
      return;
    }
    const slotId = activeSlot === "all" ? (slots[0] || {}).id || "main" : activeSlot;
    const slot = slots.find((s) => s.id === slotId) || { id: slotId, name: "Slot 1" };
    const key = keyFor(folderId, slotId);
    const link = links[key];

    if (!link) {
      host.innerHTML = card(
        '<div class="ds-empty">' +
          "<b>" + esc(slot.name) + "</b> isn’t linked to a save on this PC yet. Point it at the " +
          (folderSave ? "save folder" : "save file") + " your emulator writes and Save Station will " +
          "offer to commit it every time you finish playing." +
          (con ? '<div class="ds-where">Usually: <code>' + esc(con.where) + "</code></div>" : "") +
        "</div>" +
        '<div class="ds-actions">' +
          '<button class="btn-primary btn-sm" data-ds="link">' +
            (folderSave ? "📂 Link save folder" : "🔗 Link save file") + "</button>" +
        "</div>");
      wire(host, { folderId, name, slot, consoleId, folderSave, key });
      return;
    }

    // Names live in Drive and can be changed on any device; the link only has
    // the copy it was made with. Whenever they differ, this one is the truth.
    if (link.gameName !== name || link.slotName !== slot.name) {
      link.gameName = name;
      link.slotName = slot.name;
      desktop.syncNames(key, { gameName: name, slotName: slot.name });
    }
    const changed = !!pending[key];
    const last = link.lastCommit;
    host.innerHTML = card(
      '<div class="ds-linked">' +
        '<div class="ds-path" title="' + esc(link.path) + '">' +
          (link.kind === "folder" ? "📂 " : "💾 ") + esc(link.path) + "</div>" +
        '<div class="ds-meta">' +
          (changed
            ? '<span class="ds-dot changed"></span>Changed since the last commit'
            : '<span class="ds-dot"></span>Watching — nothing new since the last commit') +
          (last
            ? " · last commit " + SS().relTime(last.at) +
              (last.message ? " · “" + esc(last.message) + "”" : "")
            : " · nothing committed from this PC yet") +
        "</div>" +
      "</div>" +
      '<div class="ds-actions">' +
        '<button class="' + (changed || !last ? "btn-primary" : "btn-ghost") + ' btn-sm" data-ds="commit">' +
          "⬆ Commit now</button>" +
        '<button class="btn-ghost btn-sm" data-ds="link">↻ Change file</button>' +
        '<button class="btn-ghost btn-sm" data-ds="reveal">📁 Show in folder</button>' +
        '<button class="btn-ghost btn-sm danger" data-ds="unlink">✕ Unlink</button>' +
        '<label class="ds-auto"><input type="checkbox" data-ds="auto"' + (link.auto ? " checked" : "") +
          "> Commit automatically</label>" +
      "</div>");
    wire(host, { folderId, name, slot, consoleId, folderSave, key, link });
  }

  function card(inner) {
    return '<div class="ds-panel">' +
      '<div class="ds-head"><span class="ds-badge">🖥️ On this PC</span>' +
      '<span class="ds-sub">Save Station is running as an app here, so it can watch this ' +
      "slot’s save and ask about it when you close your emulator.</span></div>" +
      inner + "</div>";
  }

  function wire(host, ctx) {
    const btn = (what) => host.querySelector('[data-ds="' + what + '"]');
    const link = btn("link");
    if (link) link.onclick = () => doLink(ctx);
    const commit = btn("commit");
    if (commit) commit.onclick = () => doCommit(ctx, commit);
    const reveal = btn("reveal");
    if (reveal) reveal.onclick = () => desktop.reveal(ctx.key);
    const unlink = btn("unlink");
    if (unlink) unlink.onclick = () => doUnlink(ctx);
    const auto = btn("auto");
    if (auto) auto.onchange = async () => {
      await desktop.setAuto(ctx.key, auto.checked);
      links[ctx.key].auto = auto.checked;
      SS().toast(auto.checked
        ? "✓ " + ctx.slot.name + " will commit on its own from now on"
        : "Back to asking first for " + ctx.slot.name, "ok", 4000);
    };
  }

  async function doLink(ctx) {
    const con = SS().consoleOf(ctx.consoleId);
    const res = await desktop.linkSlot({
      gameFolderId: ctx.folderId,
      gameName: ctx.name,
      slotId: ctx.slot.id,
      slotName: ctx.slot.name,
      consoleId: ctx.consoleId,
      kind: ctx.folderSave ? "folder" : "file",
      exts: con ? con.exts : [],
      emulator: con && con.emus ? con.emus[0] : "",
    });
    if (res.canceled) return;
    if (!res.ok) { SS().toast(res.error || "Couldn't link that", "err", 6000); return; }

    links[res.key] = res.link;
    renderPanel();
    decorateRows();

    // A fresh link has nothing backed up yet, so offer the obvious next step
    // rather than waiting for the save to change.
    const go = await SS().askChoice("Linked — back it up now?",
      "<b>" + esc(ctx.slot.name) + "</b> is now watching<br><code>" + esc(res.link.path) + "</code>" +
      (res.size ? " (" + esc(res.size) + ")" : "") +
      "<br><br>Committing it now gives this slot a starting point. After that you'll only be " +
      "asked when the save actually changes.",
      [{ label: "⬆ Commit it now", value: "yes", className: "btn-primary" },
       { label: "Not yet", value: null }]);
    if (go === "yes") doCommit(ctx);
  }

  async function doCommit(ctx, button) {
    const message = prompt("Commit message (optional) — what happened in this save?", "");
    if (message === null) return;
    if (button) { button.disabled = true; button.textContent = "Committing…"; }
    SS().toast("Committing " + ctx.slot.name + "…");
    const res = await desktop.commitNow(ctx.key, message.trim());
    if (button) { button.disabled = false; }
    if (!res.ok) SS().toast("Commit failed: " + (res.error || "unknown error"), "err", 6000);
    // The success path redraws through the upload handler below.
  }

  async function doUnlink(ctx) {
    const sure = await SS().askChoice("Unlink this save?",
      "Save Station stops watching <code>" + esc(ctx.link.path) + "</code>.<br><br>" +
      "The file itself isn't touched, and the backups already in your Drive stay exactly where they are.",
      [{ label: "Unlink", value: "yes", className: "btn-ghost danger" },
       { label: "Cancel", value: null }]);
    if (sure !== "yes") return;
    await desktop.unlinkSlot(ctx.key);
    delete links[ctx.key];
    renderPanel();
    decorateRows();
    SS().toast("Unlinked", "ok");
  }

  /* ------------------------------------------------- restore onto this PC */

  function decorateRows() {
    if (!lastHistory) return;
    const hist = SS().history;
    if (!hist || !hist.saves) return;
    document.querySelectorAll("#historyContainer .save-row").forEach((row) => {
      if (row.querySelector("[data-ds-restore]")) return;
      const dl = row.querySelector("button[data-id]");
      if (!dl) return;
      const save = hist.saves.find((s) => s.id === dl.dataset.id);
      if (!save) return;
      const key = keyFor(hist.folderId, SS().slotOf(save));
      if (!links[key]) return;                       // that slot isn't linked here

      const b = document.createElement("button");
      b.className = "btn-ghost btn-sm";
      b.setAttribute("data-ds-restore", save.id);
      b.title = "Write this backup back onto this PC";
      b.innerHTML = "⤓ Restore";
      b.onclick = () => doRestore(save, key, b);
      dl.parentNode.insertBefore(b, dl.nextSibling);
    });
  }

  async function doRestore(save, key, button) {
    const link = links[key];
    const p = save.appProperties || {};
    const sure = await SS().askChoice("Restore this backup onto this PC?",
      "It will be written to<br><code>" + esc(link.path) + "</code><br><br>" +
      "Whatever is there now is kept beside it as a <code>.bak</code> copy first, so this is " +
      "undoable." + (link.kind === "folder"
        ? " Files in the backup overwrite the ones in the folder; anything else in there is left alone."
        : "") +
      "<br><br><b>Close your emulator first</b> — some write their save back out when they exit.",
      [{ label: "⤓ Restore it", value: "yes", className: "btn-primary" },
       { label: "Cancel", value: null }]);
    if (sure !== "yes") return;

    button.disabled = true;
    const label = button.innerHTML;
    button.innerHTML = "Restoring…";
    try {
      const blob = await SS().fetchSaveBlob(save.id);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const res = await desktop.restore({ key, bytes, isZip: p.kind === "folder" });
      if (!res.ok) throw new Error(res.error || "couldn't write the file");
      SS().toast("✓ Restored to " + res.path + (res.backup ? " (old one kept as .bak)" : ""), "ok", 7000);
      refreshStatus();
    } catch (e) {
      SS().toast("Restore failed: " + (e.message || e), "err", 6000);
    } finally {
      button.disabled = false;
      button.innerHTML = label;
    }
  }

  /* --------------------------------------------------------- doing the upload
     The app process has the bytes but no Drive token; this page has the token
     but no files. So it hands them over and we run the website's own upload. */

  desktop.onUploadRequest(async (job) => {
    try {
      if (!SS() || !SS().signedIn) throw new Error("sign in to Save Station first");
      const blob = new Blob([job.bytes],
        { type: job.isFolder ? "application/zip" : "application/octet-stream" });
      const file = await SS().uploadToSlot({
        folderId: job.folderId,
        gameName: job.gameName,
        consoleId: job.consoleId,
        slot: { id: job.slotId, name: job.slotName },
        blob,
        filename: job.filename,
        isFolder: job.isFolder,
        label: job.label,
        emulator: job.emulator,
        device: localStorage.getItem("ssw_device_name") || job.device,
        source: "desktop",
      });
      desktop.uploadResult(job.id, { ok: true, fileId: file && file.id });
      SS().toast("💾 Committed " + job.gameName + " → " + job.slotName +
                 (job.label ? ": “" + job.label + "”" : ""), "ok", 5000);
      // Show the result where the person is looking.
      const hist = SS().history;
      if (hist && hist.folderId === job.folderId) {
        await SS().openGame(hist.folderId, hist.name, hist.console);
      } else {
        await SS().refreshGames();
      }
      refreshStatus();
    } catch (e) {
      desktop.uploadResult(job.id, { ok: false, error: String((e && e.message) || e) });
    }
  });

  /* ------------------------------------------------------ linking your Drive
     Google won't run its sign-in inside an app window, so the app opens the
     real browser. The page then waits for the link to land rather than making
     anyone hunt for a refresh button. */

  function waitForDriveLink() {
    const status = $("linkStatus");
    if (status) {
      status.innerHTML = '<span class="spinner"></span> Finish connecting Google Drive in your browser — ' +
        "this window will pick it up on its own.";
    }
    clearInterval(linkPollTimer);
    const until = Date.now() + 5 * 60 * 1000;
    linkPollTimer = setInterval(async () => {
      if (Date.now() > until) { clearInterval(linkPollTimer); return; }
      try {
        if (await SS().refreshDriveToken()) {
          clearInterval(linkPollTimer);
          if (status) status.textContent = "";
          await SS().onLoggedIn();
          SS().toast("Google Drive connected ✔", "ok");
        }
      } catch (e) { /* keep waiting */ }
    }, 4000);
  }

  /* ----------------------------------------------------------------- wiring */

  desktop.onEvent((msg) => {
    if (!msg) return;
    if (msg.type === "external-nav") { waitForDriveLink(); return; }
    if (msg.type === "pending") { pending[msg.key] = true; renderPanel(); return; }
    if (msg.type === "committed" || msg.type === "links" || msg.type === "emulators") {
      refreshStatus();
    }
  });

  window.addEventListener("savestation:history", (e) => {
    lastHistory = e.detail;
    renderPanel();
    decorateRows();
  });

  window.addEventListener("savestation:ready", async () => {
    // Backups from the app should say which PC they came from, not which
    // browser engine is behind the window.
    try {
      const st = await desktop.status();
      if (!localStorage.getItem("ssw_device_name") && st.device) {
        localStorage.setItem("ssw_device_name", st.device);
        const box = $("deviceName"); if (box) box.value = st.device;
        const acct = $("acctDevice"); if (acct) acct.value = st.device;
      }
    } catch (e) {}
    refreshStatus();
  });

  refreshStatus();
})();
