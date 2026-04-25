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
// each redeem in the dashboard's Config tab afterwards. The Setup page in the
// dashboard wraps this same logic with a file picker + apply buttons; this
// script stays around for headless / migration-script use.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { importPolyPop } from '../server/polypop-import.js';

const args = process.argv.slice(2);
const popPath = args[0];
if (!popPath) {
  console.error('Usage: node scripts/import-polypop.mjs <path-to-project.pop> [--out-dir <dir>]');
  process.exit(1);
}
const outDirIdx = args.indexOf('--out-dir');
const outDir = outDirIdx >= 0 ? args[outDirIdx + 1] : process.cwd();

const pop = JSON.parse(readFileSync(popPath, 'utf8'));

let result;
try {
  result = importPolyPop(pop);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const { redeems, commands, audioFiles, summary } = result;

console.log(`Reading "${basename(popPath)}" — PolyPop ${summary.polypopVersion}`);
console.log(`  ${summary.sourceCount} sources · ${summary.wireCount} wires · ${summary.sceneCount} scenes`);

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
  ...audioFiles,
  '',
].join('\n'));

console.log('');
console.log(`Wrote ${Object.keys(redeems).length} redeems → ${redeemsOut}`);
console.log(`Wrote ${Object.keys(commands).length} chat aliases → ${cmdsOut}`);
console.log(`Wrote ${audioFiles.length} audio references → ${audioOut}`);
console.log('');
console.log('Next steps for Fokker:');
console.log('  1. Open redeems.from-polypop.json in a text editor; review each entry.');
console.log('  2. Copy entries you want into your real redeems.json (or replace it wholesale).');
console.log('  3. Same for commands.from-polypop.json → commands.json.');
console.log('  4. Drop any custom audio files into assets/sounds/ to match the names');
console.log('     in the redeems (currently they default to alert.wav / pop.wav / boom.wav).');
console.log('  5. Restart FokkerPop and test each redeem from Config → Redeems → ▶ Test.');
console.log('');
console.log('Or skip this CLI and use the dashboard\'s Setup → Import from PolyPop button.');
