#!/usr/bin/env node
// Asset integrity check.
//
// Regression intent: v0.2.99 shipped mascot "GIFs" that were HTML documents
// from a failed download, and v0.2.92 shipped sound files in the same way.
// The dashboard happily lists them, and they fail silently when a viewer
// triggers them. This script sniffs real magic bytes, matches against the
// file extension, and fails the release if anything obviously-dead is found.
//
// Exit codes: 0 ok, 1 failures, 2 warnings only (configurable below).
// Currently warnings do not fail the build — they're surfaced for triage.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, extname, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

// Minimum plausible sizes for media. Anything smaller is almost certainly a
// placeholder (e.g. the 14-byte `ding.wav` currently in the tree).
const MIN_AUDIO_BYTES = 200;   // RIFF/WAVE header alone is ~44 bytes; real audio > this
const MIN_IMAGE_BYTES = 64;    // even a 1×1 PNG is ~70 bytes

const SNIFFERS = [
  { name: 'png',  match: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 },
  { name: 'jpg',  match: (b) => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF },
  { name: 'gif',  match: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 },   // GIF8
  { name: 'webp', match: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
                               && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 },
  { name: 'wav',  match: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
                               && b[8] === 0x57 && b[9] === 0x41 && b[10] === 0x56 && b[11] === 0x45 },
  // MP3: ID3 tag or MPEG frame sync (FF Ex/Fx).
  { name: 'mp3',  match: (b) => (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33)
                               || (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0) },
  { name: 'glb',  match: (b) => b[0] === 0x67 && b[1] === 0x6C && b[2] === 0x54 && b[3] === 0x46 },  // glTF
  { name: 'html', match: (b) => {
      // crude — look for "<!DOCTYPE" or "<html" in the first 128 bytes
      const s = String.fromCharCode(...b.slice(0, 128)).toLowerCase();
      return s.includes('<!doctype') || s.includes('<html') || s.includes('<head');
    } },
  { name: 'text', match: (b) => {
      // Last-resort: all bytes printable ASCII ⇒ text file, not binary media.
      return b.every(byte => byte === 0x09 || byte === 0x0A || byte === 0x0D || (byte >= 0x20 && byte < 0x7F));
    } },
];

function sniff(buf) {
  for (const s of SNIFFERS) {
    if (s.match(buf)) return s.name;
  }
  return 'unknown';
}

// Tables: for each extension we scan, what magic is acceptable?
// EXACT = must match. ALLOW = tolerated but warned (e.g. PNG in a .gif file
// browsers will sniff, but it won't animate).
const RULES = {
  '.wav':  { exact: ['wav'] },
  '.mp3':  { exact: ['mp3'] },
  '.png':  { exact: ['png'] },
  '.jpg':  { exact: ['jpg'] },
  '.jpeg': { exact: ['jpg'] },
  '.gif':  { exact: ['gif'], allow: ['png', 'jpg', 'webp'] },   // browsers sniff, but no animation
  '.webp': { exact: ['webp'], allow: ['png', 'jpg', 'gif'] },
  '.glb':  { exact: ['glb'] },
  '.gltf': { exact: ['text'] },                                 // JSON
};

// Directories to scan, and how to handle each file.
const SCAN = [
  { dir: 'assets/sounds',    exts: ['.wav', '.mp3'] },
  { dir: 'assets/stickers',  exts: ['.png', '.jpg', '.jpeg', '.gif', '.webp'] },
  { dir: 'assets/dice',      exts: ['.png', '.jpg', '.jpeg', '.webp'], optional: true },
  { dir: 'characters',       exts: ['.gif', '.png', '.jpg', '.jpeg', '.webp'], recurse: true },
];

function* walk(dir, recurse) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    const full = resolve(dir, e.name);
    if (e.isDirectory()) { if (recurse) yield* walk(full, true); continue; }
    if (e.isFile()) yield full;
  }
}

const results = { ok: 0, warn: 0, fail: 0, details: [] };

function check(file) {
  const ext = extname(file).toLowerCase();
  const rule = RULES[ext];
  if (!rule) return;

  const rel = relative(ROOT, file);
  let buf;
  try { buf = readFileSync(file); } catch (err) {
    results.fail++;
    results.details.push(`FAIL ${rel}  could not read: ${err.message}`);
    return;
  }

  const size = buf.length;
  const minSize = (ext === '.wav' || ext === '.mp3') ? MIN_AUDIO_BYTES : MIN_IMAGE_BYTES;
  if (size < minSize) {
    results.fail++;
    results.details.push(`FAIL ${rel}  only ${size} bytes (likely placeholder/corrupt)`);
    return;
  }

  const head = buf.slice(0, 16);
  const magic = sniff(head);

  if (rule.exact.includes(magic)) {
    results.ok++;
    return;
  }

  if (rule.allow?.includes(magic)) {
    results.warn++;
    results.details.push(`WARN ${rel}  extension ${ext} but content sniffs as ${magic} (browsers may auto-correct, but this is not what was intended)`);
    return;
  }

  // Hard failures: extension expects media but we sniffed text/html/unknown.
  results.fail++;
  if (magic === 'html') {
    results.details.push(`FAIL ${rel}  extension ${ext} but file is an HTML document (likely a failed download — overwrite with the real asset)`);
  } else if (magic === 'text') {
    results.details.push(`FAIL ${rel}  extension ${ext} but file is plain text (${size} bytes)`);
  } else {
    results.details.push(`FAIL ${rel}  extension ${ext} but magic bytes indicate ${magic}`);
  }
}

// Gather files
let scanned = 0;
for (const { dir, exts, recurse, optional } of SCAN) {
  const abs = resolve(ROOT, dir);
  try { statSync(abs); } catch {
    if (!optional) console.warn(`(skip) ${dir} does not exist`);
    continue;
  }
  for (const file of walk(abs, recurse)) {
    const ext = extname(file).toLowerCase();
    if (!exts.includes(ext)) continue;
    scanned++;
    check(file);
  }
}

// Report
for (const line of results.details) {
  if (line.startsWith('FAIL')) console.error(line);
  else console.warn(line);
}

const summary = `Asset integrity: ${scanned} files scanned · ${results.ok} ok · ${results.warn} warn · ${results.fail} fail`;
if (results.fail) console.error(summary);
else               console.log(summary);

process.exit(results.fail ? 1 : 0);
