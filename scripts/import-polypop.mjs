#!/usr/bin/env node
// Import a PolyPop project (.pop) into FokkerPop config.
//
// Usage:
//   node scripts/import-polypop.mjs <path-to-project.pop> [--out-dir <dir>]
//
// Produces (in --out-dir, default cwd):
//   redeems.from-polypop.json  — channel-point redeems mapped to FokkerPop effects
//   commands.from-polypop.json — !chat aliases for the redeems (broadcaster-only)
//   audio-files.txt            — list of audio filenames PolyPop's Action Sequences
//                                referenced; Fokker drops them into assets/sounds/
//                                manually, since .pop files don't bundle audio
//
// This is a skeleton import — extracts what PolyPop's data model has 1:1 with
// FokkerPop concepts (redeem titles, audio file references). It does NOT try
// to walk PolyPop's full Action Sequence graph (different paradigm) or import
// scenes/3D models/animations (no equivalent). Fokker reviews + customizes
// each redeem in the dashboard's Config tab afterwards.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';

const args = process.argv.slice(2);
const popPath = args[0];
if (!popPath) {
  console.error('Usage: node scripts/import-polypop.mjs <path-to-project.pop> [--out-dir <dir>]');
  process.exit(1);
}
const outDirIdx = args.indexOf('--out-dir');
const outDir = outDirIdx >= 0 ? args[outDirIdx + 1] : process.cwd();

const pop = JSON.parse(readFileSync(popPath, 'utf8'));
if (pop.app !== 'PolyPop') {
  console.error(`Not a PolyPop project file (app=${pop.app}).`);
  process.exit(1);
}

console.log(`Reading "${basename(popPath)}" — PolyPop ${pop.ver}`);
console.log(`  ${(pop.sources || []).length} sources · ${(pop.wires || []).length} wires · ${(pop.scenes || []).length} scenes`);

// ── 1. Extract channel-point redeems ─────────────────────────────────────────
const redeems = {};
const sourceById = new Map(pop.sources.map(s => [s.id, s]));
const wires = pop.wires || [];
const twitchSrc = pop.sources.find(s => s.uix === 'twitch:Twitch Alerts');
const cpRedeems = twitchSrc?.properties?.ChannelPoints?.objects ?? [];

// Heuristic: pick a default FokkerPop effect from the redeem name. Fokker can
// edit each one afterwards. Goal is "do something sensible by default" — a
// firework for "fire/blast", balloons for "pop/bub", dice for "roll", etc.
function guessEffect(name) {
  const n = name.toLowerCase();
  if (/\broll\b|\bdice\b|\bd\d+\b/.test(n))                  return { effect: 'dice-tray-roll', payload: { user: 'Roller' } };
  if (/\bbub|\bballoon|\bpop\b|popoff|pop off/.test(n))      return { effect: 'balloon',    count: 10, sound: 'pop.wav' };
  if (/firework|salvo|chaos|fokker|slam|fire|blast/.test(n)) return { effect: 'firework-salvo', count: 5, sound: 'boom.wav' };
  if (/sticker|confetti|party|love/.test(n))                 return { effect: 'sticker-rain', duration: 6000 };
  if (/sing|cur|word|jugger|cam|mode/.test(n))               return { effect: 'alert-banner', tier: 'A', icon: '⏱️', text: name, sound: 'alert.wav' };
  return { effect: 'alert-banner', tier: 'B', icon: '🎉', text: name, sound: 'alert.wav' };
}

for (const r of cpRedeems) {
  redeems[r.name] = guessEffect(r.name);
}

// ── 2. Generate !chat aliases (broadcaster-only by default) ──────────────────
// Slugify "Roll 6s for 12 PUSHUPS!" → "!roll6s12pushups". Fokker can rename.
function slugify(s) {
  return '!' + s.toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 18) || '!cmd';
}
const commands = {};
for (const name of Object.keys(redeems)) {
  const cmd = slugify(name);
  if (commands[cmd]) continue; // collision — skip, user can rename
  commands[cmd] = { redeem: name, cooldown: 10 };  // allow defaults to broadcaster
}

// ── 3. Find audio files referenced anywhere in the project ───────────────────
const audioFiles = new Set();
for (const s of pop.sources) {
  if (s.uix !== 'core-app:Audio Clip') continue;
  const f = s.properties?.file || s.properties?.filename;
  if (typeof f === 'string') audioFiles.add(basename(f));
  if (typeof s.name === 'string') audioFiles.add(s.name + ' (Audio Clip)');
}

// ── 4. Write outputs ─────────────────────────────────────────────────────────
const redeemsOut = resolve(outDir, 'redeems.from-polypop.json');
const cmdsOut    = resolve(outDir, 'commands.from-polypop.json');
const audioOut   = resolve(outDir, 'audio-files.txt');

writeFileSync(redeemsOut, JSON.stringify({
  _comment: 'Imported from PolyPop project. Review each entry in the Config → Redeems tab and customize the effect/sound. Then merge into your real redeems.json.',
  ...redeems,
}, null, 2));

writeFileSync(cmdsOut, JSON.stringify({
  _comment: 'Imported chat-command aliases for the PolyPop redeems. allow defaults to broadcaster (only Fokker can fire); set "allow":"anyone" on the ones you want viewers to type. Merge into your real commands.json.',
  ...commands,
}, null, 2));

writeFileSync(audioOut, [
  '# Audio clips referenced by PolyPop project',
  '# Drop matching files into assets/sounds/ in your FokkerPop install.',
  '# Filenames PolyPop tracks may or may not appear here depending on how the',
  '# project stored them; use this list as a hint, then verify against PolyPop\'s',
  '# Sounds folder (typically %USERPROFILE%\\Documents\\PolyPop\\Sounds\\).',
  '',
  ...[...audioFiles].sort(),
  '',
].join('\n'));

console.log('');
console.log(`Wrote ${Object.keys(redeems).length} redeems → ${redeemsOut}`);
console.log(`Wrote ${Object.keys(commands).length} chat aliases → ${cmdsOut}`);
console.log(`Wrote ${audioFiles.size} audio references → ${audioOut}`);
console.log('');
console.log('Next steps for Fokker:');
console.log('  1. Open redeems.from-polypop.json in a text editor; review each entry.');
console.log('  2. Copy entries you want into your real redeems.json (or replace it wholesale).');
console.log('  3. Same for commands.from-polypop.json → commands.json.');
console.log('  4. Drop any custom audio files into assets/sounds/ to match the names');
console.log('     in the redeems (currently they default to alert.wav / pop.wav / boom.wav).');
console.log('  5. Restart FokkerPop and test each redeem from Config → Redeems → ▶ Test.');
