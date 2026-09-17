#!/usr/bin/env node
/*
  Refreshes the GameTDB title databases in assets/gametdb/.

    node tools/update-gametdb.js

  They're mirrored here because gametdb.com serves no CORS headers: a browser
  is allowed to show their cartridge and disc pictures, but not to read the
  database that says which picture belongs to which game. Served from our own
  origin, it's a plain same-origin fetch — and the desktop app gets a copy in
  its bundle, so an open case looks right without a round trip.

  Each file is a list of "CODE = Title" lines, a few hundred KB. Rerun this when
  games newer than the mirror start turning up without their real cart art.
*/
"use strict";
const fs = require("fs");
const path = require("path");
const https = require("https");

const SYSTEMS = ["ds", "3ds", "wii", "wiiu", "switch"];
const OUT = path.join(__dirname, "..", "assets", "gametdb");

function get(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "save-station-update-gametdb" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 3) {
        res.resume();
        resolve(get(new URL(res.headers.location, url).href, redirects + 1));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(url + " -> HTTP " + res.statusCode)); return; }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    }).on("error", reject);
  });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  for (const sys of SYSTEMS) {
    const url = "https://www.gametdb.com/" + sys + "tdb.txt?LANG=EN";
    const body = await get(url);
    // A database that arrives empty or as an error page would quietly cost every
    // game its cart art, so it has to look like the real thing before it lands.
    const text = body.toString("utf8");
    if (!/^TITLES = /.test(text) || text.split("\n").length < 100) {
      throw new Error(sys + ": that didn't look like a title database");
    }
    fs.writeFileSync(path.join(OUT, sys + ".txt"), body);
    console.log(sys.padEnd(7), text.split("\n").length - 1, "titles,", body.length, "bytes");
  }
  console.log("\nDone. Commit assets/gametdb/ to publish them.");
})().catch((e) => { console.error(e.message); process.exit(1); });
