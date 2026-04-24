#!/usr/bin/env node
// Generate CHANGELOG.md from git commit history.
//
// Runs locally (`node scripts/gen-changelog.mjs`) and in the release workflow
// right before the zip is assembled, so the shipped app always has the notes
// for the version it shipped and everything before it (capped at MAX_ENTRIES).
//
// Scans commits whose subject starts with `Release v<semver>:`, pulls the
// title + body, and emits structured markdown. Keeps the most recent
// MAX_ENTRIES releases.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT  = resolve(ROOT, 'CHANGELOG.md');
const MAX_ENTRIES = 25;

// ASCII control-char separators (0x1F between fields, 0x1E between records)
// are safe against anything a commit message might contain. Passed directly
// as argv so the shell doesn't re-interpret them.
const FS = '\x1f';
const RS = '\x1e';
const FORMAT = `%H${FS}%ai${FS}%s${FS}%b${RS}`;

const raw = execFileSync('git', ['log', `--format=${FORMAT}`], { cwd: ROOT }).toString();

const entries = [];
for (const block of raw.split(RS)) {
  const t = block.trim();
  if (!t) continue;
  const [hash, iso, subject, body = ''] = t.split(FS);
  const m = /^Release v(\d+\.\d+\.\d+):\s*(.+)$/.exec(subject || '');
  if (!m) continue;
  const [, version, title] = m;
  const date = iso.slice(0, 10);
  entries.push({ hash, version, date, title, body: body.trim() });
  if (entries.length >= MAX_ENTRIES) break;
}

if (entries.length === 0) {
  console.error('No Release commits found.');
  process.exit(1);
}

// Some historical commits reuse a version number by mistake. Keep the most
// recent entry per version (first-seen in the reversed log).
const seen = new Set();
const unique = [];
for (const e of entries) {
  if (seen.has(e.version)) continue;
  seen.add(e.version);
  unique.push(e);
}

const lines = [
  '# FokkerPop Changelog',
  '',
  `_Auto-generated from the last ${unique.length} Release commits. Newest first._`,
  '',
];

for (const e of unique) {
  lines.push(`## v${e.version} — ${e.date}`);
  lines.push('');
  lines.push(`**${e.title.replace(/\*/g, '\\*')}**`);
  if (e.body) {
    lines.push('');
    // Strip the trailing Co-Authored-By line(s) — they're noise for users.
    const body = e.body
      .split('\n')
      .filter(l => !/^Co-Authored-By:/i.test(l.trim()))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (body) lines.push(body);
  }
  lines.push('');
  lines.push('---');
  lines.push('');
}

// Trim the trailing separator
while (lines.length && (lines[lines.length - 1] === '' || lines[lines.length - 1] === '---')) {
  lines.pop();
}
lines.push('');

writeFileSync(OUT, lines.join('\n'));
console.log(`Wrote ${OUT} — ${unique.length} releases.`);
