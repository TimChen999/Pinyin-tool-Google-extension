#!/usr/bin/env node
/**
 * Downloads Make Me a Hanzi's character dictionary and strips it down
 * to just the fields the extension renders in the vocab card's
 * "Components" dropdown. The upstream `dictionary.txt` is JSON-Lines
 * (~9.5k entries, ~2.5 MB) and includes stroke-render data and a few
 * fields we don't use; the stripped TSV is ~600 KB.
 *
 * Make Me a Hanzi is licensed Arphic Public License (the underlying
 * font data) + LGPL (code) — see https://github.com/skishore/makemeahanzi.
 *
 * Output format (UTF-8 TSV, tab-separated, one entry per line):
 *   <character>\t<decomposition>\t<radical>\t<etymologyHint>
 *
 * - <decomposition> uses Unicode IDC operators (U+2FF0..U+2FFB).
 * - <radical> is the entry's primary radical character.
 * - <etymologyHint> is the upstream `etymology.hint` string when present
 *   (e.g. "A woman 女 with a son 子" for 好); empty otherwise.
 *
 * Idempotent: skips when public/dict/components.tsv already exists.
 * Override with FORCE=1 to redownload.
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DICT_DIR = resolve(ROOT, "public", "dict");
const TARGET = resolve(DICT_DIR, "components.tsv");

const SOURCE_URL =
  "https://raw.githubusercontent.com/skishore/makemeahanzi/master/dictionary.txt";

const FORCE = process.env.FORCE === "1";

mkdirSync(DICT_DIR, { recursive: true });

if (existsSync(TARGET) && !FORCE) {
  const size = statSync(TARGET).size;
  if (size > 100_000) {
    console.log(
      "[components] %s already present (%d bytes). Skipping. Set FORCE=1 to redownload.",
      TARGET,
      size,
    );
    process.exit(0);
  }
  console.log("[components] Existing file is suspiciously small; re-downloading.");
}

function fetchText(url) {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = https.get(url, { timeout: 120_000 }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const next = res.headers.location;
        res.resume();
        if (!next) {
          rejectPromise(new Error(`Redirect with no Location header from ${url}`));
          return;
        }
        fetchText(next).then(resolvePromise, rejectPromise);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        rejectPromise(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
      res.on("error", rejectPromise);
    });
    req.on("timeout", () => req.destroy(new Error(`Timeout fetching ${url}`)));
    req.on("error", rejectPromise);
  });
}

/** Tab/CR/LF in any field would corrupt TSV downstream — strip them. */
function sanitizeField(value) {
  return String(value ?? "").replace(/[\t\r\n]+/g, " ").trim();
}

console.log("[components] Downloading from %s …", SOURCE_URL);
let raw;
try {
  raw = await fetchText(SOURCE_URL);
} catch (err) {
  console.error("[components] Download failed:", err.message);
  console.error(
    "[components] You can manually place a TSV (char\\tdecomposition\\tradical\\thint) at:\n  %s",
    TARGET,
  );
  process.exit(1);
}

const lines = raw.split(/\r?\n/);
const out = [];
let skippedNoDecomp = 0;
let skippedAtomic = 0;
let skippedParse = 0;

for (const line of lines) {
  if (!line.trim()) continue;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    skippedParse += 1;
    continue;
  }
  const ch = entry.character;
  const decomposition = entry.decomposition;
  if (!ch || typeof decomposition !== "string") {
    skippedNoDecomp += 1;
    continue;
  }
  // Skip entries with no compositional information: pure "？" (unknown)
  // or a self-reference where decomposition is just the character itself.
  // These would render an empty / circular Components panel.
  if (decomposition === "？" || decomposition === ch) {
    skippedAtomic += 1;
    continue;
  }
  const radical = sanitizeField(entry.radical ?? "");
  const hint = sanitizeField(entry.etymology?.hint ?? "");
  out.push(
    `${sanitizeField(ch)}\t${sanitizeField(decomposition)}\t${radical}\t${hint}`,
  );
}

if (out.length < 5_000) {
  console.error(
    "[components] Parsed only %d entries — upstream format may have changed.",
    out.length,
  );
  process.exit(1);
}

writeFileSync(TARGET, out.join("\n") + "\n", "utf8");
const finalSize = statSync(TARGET).size;
console.log(
  "[components] Wrote %s (%d entries, %d bytes; skipped %d unknown-decomp, %d atomic, %d unparseable).",
  TARGET,
  out.length,
  finalSize,
  skippedNoDecomp,
  skippedAtomic,
  skippedParse,
);
