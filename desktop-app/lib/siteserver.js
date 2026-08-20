"use strict";
/**
 * Serves the website to the app window.
 *
 * The desktop app isn't a copy of Save Station — it *is* Save Station. The same
 * index.html the browser gets is served from 127.0.0.1 and loaded into the
 * window, with one script and one stylesheet injected before </body>. So the
 * app can't drift from the site: fix something in index.html and both get it.
 *
 * Why a local server instead of loading the file straight off disk: a file://
 * page has an opaque origin, and Firebase's login (and its "stay signed in")
 * needs a real one. http://localhost is a real origin, and it's the same one
 * the README already tells you to test the site on.
 *
 * It listens on the loopback interface only, so nothing else on your network —
 * or in a coffee shop — can reach it.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const INJECT = '\n<!-- Save Station desktop: everything the app adds to the page lives here. -->\n' +
  '<link rel="stylesheet" href="/__desktop/desktop.css">\n' +
  '<script src="/__desktop/desktop.js"></script>\n';

function serveFile(res, file, extraHeaders) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end("not found"); return; }
    res.writeHead(200, Object.assign({
      "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store",
    }, extraHeaders || {}));
    res.end(data);
  });
}

/**
 * @param siteDir    the folder holding index.html (the repo root, or the
 *                   copy inside the packaged app)
 * @param desktopDir the folder holding desktop.js / desktop.css
 * @returns { url, port, close() }
 */
function startSiteServer(siteDir, desktopDir, firstPort) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let pathname;
      try { pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname); }
      catch (e) { res.writeHead(400).end("bad request"); return; }

      if (pathname === "/" || pathname === "/index.html") {
        fs.readFile(path.join(siteDir, "index.html"), "utf8", (err, html) => {
          if (err) { res.writeHead(500).end("index.html is missing"); return; }
          const out = html.includes("</body>")
            ? html.replace("</body>", INJECT + "</body>")
            : html + INJECT;
          res.writeHead(200, { "Content-Type": TYPES[".html"], "Cache-Control": "no-store" });
          res.end(out);
        });
        return;
      }

      // The app's own additions, kept on a path the website will never use.
      if (pathname.startsWith("/__desktop/")) {
        const rel = pathname.slice("/__desktop/".length);
        const file = path.resolve(desktopDir, rel);
        if (!file.startsWith(path.resolve(desktopDir))) { res.writeHead(403).end("no"); return; }
        serveFile(res, file);
        return;
      }

      // An allowlist rather than "anything under siteDir", because in
      // development siteDir is the whole repository — and a loopback server
      // has no business handing out .git, the Worker source, or this app's own
      // files. The site itself only ever asks for index.html and assets/.
      if (!/^\/assets\/[\w.\-/]+$/.test(pathname)) { res.writeHead(404).end("not found"); return; }
      const file = path.resolve(siteDir, "." + pathname);
      if (!file.startsWith(path.resolve(siteDir, "assets"))) { res.writeHead(403).end("no"); return; }
      serveFile(res, file);
    });

    let port = firstPort || 8765;
    let tries = 0;
    server.on("error", (err) => {
      // Something else has the port — step along rather than refusing to start.
      if (err.code === "EADDRINUSE" && tries++ < 20) { server.listen(++port, "127.0.0.1"); return; }
      reject(err);
    });
    server.listen(port, "127.0.0.1", () => {
      resolve({
        // localhost, not 127.0.0.1: it's the origin Firebase already trusts,
        // and the one the README tells you to add for local testing.
        url: "http://localhost:" + port + "/",
        port,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

module.exports = { startSiteServer };
