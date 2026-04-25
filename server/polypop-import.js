// PolyPop project importer — extracts what PolyPop's data model has 1:1 with
// FokkerPop concepts: channel-point redeem titles + chat aliases + audio
// clip references. Exported as a pure function so both the CLI script
// (scripts/import-polypop.mjs) and the HTTP endpoint (POST /api/import-polypop)
// share one implementation.
//
// Returns { redeems, commands, audioFiles, summary }. Throws if the input
// isn't a recognizable PolyPop project.

import { basename } from 'node:path';

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

function slugify(s) {
  return '!' + (s.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 18) || 'cmd');
}

export function importPolyPop(pop) {
  if (!pop || pop.app !== 'PolyPop') {
    throw new Error('Not a PolyPop project file (missing or wrong "app" field).');
  }

  // 1. Channel-point redeems from the twitch:Twitch Alerts source.
  const twitchSrc = (pop.sources || []).find(s => s.uix === 'twitch:Twitch Alerts');
  const cpRedeems = twitchSrc?.properties?.ChannelPoints?.objects ?? [];
  const redeems = {};
  for (const r of cpRedeems) {
    if (typeof r?.name === 'string' && r.name) {
      redeems[r.name] = guessEffect(r.name);
    }
  }

  // 2. Chat aliases — broadcaster-only by default, slugified from the title.
  const commands = {};
  for (const name of Object.keys(redeems)) {
    const cmd = slugify(name);
    if (commands[cmd]) continue;          // collision, skip — user can rename
    commands[cmd] = { redeem: name, cooldown: 10 };
  }

  // 3. Audio file references from core-app:Audio Clip sources.
  const audioFiles = new Set();
  for (const s of (pop.sources || [])) {
    if (s.uix !== 'core-app:Audio Clip') continue;
    const f = s.properties?.file || s.properties?.filename;
    if (typeof f === 'string') audioFiles.add(basename(f));
    if (typeof s.name === 'string' && !f) audioFiles.add(`${s.name} (Audio Clip)`);
  }

  return {
    redeems,
    commands,
    audioFiles: [...audioFiles].sort(),
    summary: {
      sourceCount: (pop.sources || []).length,
      wireCount:   (pop.wires || []).length,
      sceneCount:  (pop.scenes || []).length,
      polypopVersion: pop.ver || 'unknown',
    },
  };
}
