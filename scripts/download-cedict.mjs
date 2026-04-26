#!/usr/bin/env node
/**
 * Downloads CC-CEDICT (Creative Commons Chinese-English dictionary) into
 * public/dict/ so the build copies it into dist/dict/. CC-CEDICT is
 * licensed CC BY-SA 4.0 by MDBG (https://www.mdbg.net/chinese/dictionary).
 *
 * Idempotent: skips the download when public/dict/cedict_ts.u8 already
 * exists. Override with FORCE=1 to redownload.
 */

import { createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import https from "node:https";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DICT_DIR = resolve(ROOT, "public", "dict");
const TARGET = resolve(DICT_DIR, "cedict_ts.u8");

const PRIMARY_URL =
  "https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz";
const MIRROR_URL =
  "https://raw.githubusercontent.com/cschiller/zhongwen/master/data/cedict_ts.u8";

const FORCE = process.env.FORCE === "1";

mkdirSync(DICT_DIR, { recursive: true });

if (existsSync(TARGET) && !FORCE) {
  const size = statSync(TARGET).size;
  if (size > 1_000_000) {
    console.log(
      "[cedict] %s already present (%d bytes). Skipping. Set FORCE=1 to redownload.",
      TARGET,
      size,
    );
    process.exit(0);
  }
  console.log("[cedict] Existing file is suspiciously small; re-downloading.");
}

function fetchToFile(url, destination, opts = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = https.get(url, { timeout: 120_000 }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const next = res.headers.location;
        res.resume();
        if (!next) {
          rejectPromise(new Error(`Redirect with no Location header from ${url}`));
          return;
        }
        fetchToFile(next, destination, opts).then(resolvePromise, rejectPromise);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        rejectPromise(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        return;
      }
      const out = createWriteStream(destination);
      const stream = opts.gunzip ? res.pipe(createGunzip()) : res;
      pipeline(stream, out).then(resolvePromise, rejectPromise);
    });
    req.on("timeout", () => {
      req.destroy(new Error(`Timeout fetching ${url}`));
    });
    req.on("error", rejectPromise);
  });
}

async function tryMdbg() {
  console.log("[cedict] Downloading from MDBG (gzipped) …");
  await fetchToFile(PRIMARY_URL, TARGET, { gunzip: true });
}

async function tryMirror() {
  console.log("[cedict] Falling back to mirror (raw .u8) …");
  await fetchToFile(MIRROR_URL, TARGET, { gunzip: false });
}

try {
  try {
    await tryMdbg();
  } catch (err) {
    console.warn("[cedict] MDBG download failed:", err.message);
    await tryMirror();
  }

  const size = statSync(TARGET).size;
  if (size < 1_000_000) {
    throw new Error(
      `Downloaded file is too small (${size} bytes); CC-CEDICT should be ~10 MB.`,
    );
  }
  console.log("[cedict] Wrote %s (%d bytes).", TARGET, size);
} catch (err) {
  console.error("[cedict] All download attempts failed:", err.message);
  console.error(
    "[cedict] You can manually place cedict_ts.u8 at:\n  %s",
    TARGET,
  );
  process.exit(1);
}
