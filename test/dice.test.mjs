// Unit tests for shared/dice.js — the spec parser and percentile expansion
// that both `!roll` chat commands and the Studio rollDiceTray action use.
//
// Regression intent: the dice-sync bug in v0.2.97 came from the two callers
// drifting — and the percentile expansion is duplicated in the code paths
// that needed fixing. These tests pin the shared module so both consumers
// stay honest.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDiceSpec,
  parseChatRollSpec,
  parseTraySpec,
  expandPercentile,
  canRenderInTray,
  TRAY_SIDES_ALLOWED,
  TRAY_SIDES_DIRECT,
} from '../shared/dice.js';

// ───── parseChatRollSpec

test('parseChatRollSpec: basic specs', () => {
  assert.deepEqual(parseChatRollSpec('2d6'),    [{ count: 2, sides: 6 }]);
  assert.deepEqual(parseChatRollSpec('1d20'),   [{ count: 1, sides: 20 }]);
  assert.deepEqual(parseChatRollSpec('d20'),    [{ count: 1, sides: 20 }]);   // implicit count
  assert.deepEqual(parseChatRollSpec('1d100'),  [{ count: 1, sides: 100 }]);
});

test('parseChatRollSpec: compound specs with + and ,', () => {
  assert.deepEqual(parseChatRollSpec('1d20+2d6'), [
    { count: 1, sides: 20 },
    { count: 2, sides: 6 },
  ]);
  assert.deepEqual(parseChatRollSpec('1d20,2d6'), [
    { count: 1, sides: 20 },
    { count: 2, sides: 6 },
  ]);
  assert.deepEqual(parseChatRollSpec('1d6+1d8+1d10'), [
    { count: 1, sides: 6 }, { count: 1, sides: 8 }, { count: 1, sides: 10 },
  ]);
});

test('parseChatRollSpec: whitespace and case', () => {
  assert.deepEqual(parseChatRollSpec(' 2D6 '), [{ count: 2, sides: 6 }]);
  assert.deepEqual(parseChatRollSpec('1d20 + 2d6'), [
    { count: 1, sides: 20 }, { count: 2, sides: 6 },
  ]);
});

test('parseChatRollSpec: clamps count to [1, 20]', () => {
  assert.deepEqual(parseChatRollSpec('0d6'),   [{ count: 1, sides: 6 }]);
  assert.deepEqual(parseChatRollSpec('100d6'), [{ count: 20, sides: 6 }]);
});

test('parseChatRollSpec: accepts exotic sides up to 1000', () => {
  assert.deepEqual(parseChatRollSpec('1d7'),    [{ count: 1, sides: 7 }]);
  assert.deepEqual(parseChatRollSpec('1d1000'), [{ count: 1, sides: 1000 }]);
});

test('parseChatRollSpec: rejects invalid input', () => {
  assert.equal(parseChatRollSpec(''),        null);
  assert.equal(parseChatRollSpec(null),      null);
  assert.equal(parseChatRollSpec(undefined), null);
  assert.equal(parseChatRollSpec('   '),     null);
  assert.equal(parseChatRollSpec('hello'),   null);
  assert.equal(parseChatRollSpec('2d'),      null);
  assert.equal(parseChatRollSpec('d'),       null);
  assert.equal(parseChatRollSpec('2d6+bad'), null);
  assert.equal(parseChatRollSpec('1d1'),     null, 'sides < 2 not allowed');
  assert.equal(parseChatRollSpec('1d1001'),  null, 'sides > 1000 not allowed');
});

// ───── parseTraySpec (Studio rollDiceTray action)

test('parseTraySpec: accepts exactly the mesh+percentile sides', () => {
  for (const sides of TRAY_SIDES_ALLOWED) {
    assert.deepEqual(parseTraySpec(`1d${sides}`), [{ count: 1, sides }]);
  }
});

test('parseTraySpec: rejects non-allowlisted sides', () => {
  // Sides the chat parser accepts but the tray cannot render:
  for (const sides of [2, 3, 5, 7, 11, 13, 50, 99, 101, 1000]) {
    assert.equal(parseTraySpec(`1d${sides}`), null, `d${sides} must be rejected`);
  }
});

test('parseTraySpec: compound specs all-or-nothing', () => {
  assert.deepEqual(parseTraySpec('1d6+1d20'), [
    { count: 1, sides: 6 }, { count: 1, sides: 20 },
  ]);
  // If any group is not allowlisted, the whole spec is rejected.
  assert.equal(parseTraySpec('1d6+1d7'), null);
});

// ───── expandPercentile (D100 → 2×D10)

test('expandPercentile: leaves non-D100 groups untouched', () => {
  const input = [{ count: 2, sides: 6 }, { count: 1, sides: 20 }];
  assert.deepEqual(expandPercentile(input), input);
});

test('expandPercentile: D100×1 → ruby tens + sapphire units', () => {
  const out = expandPercentile([{ count: 1, sides: 100 }]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { sides: 10, count: 1, isPercentile: true, theme: 'ruby' });
  assert.deepEqual(out[1], { sides: 10, count: 1, isPercentile: true, theme: 'sapphire' });
});

test('expandPercentile: D100×N → N tens + N units, interleaved', () => {
  const out = expandPercentile([{ count: 3, sides: 100 }]);
  assert.equal(out.length, 6);
  const themes = out.map(d => d.theme);
  assert.deepEqual(themes, ['ruby', 'sapphire', 'ruby', 'sapphire', 'ruby', 'sapphire']);
  for (const d of out) {
    assert.equal(d.sides, 10);
    assert.equal(d.isPercentile, true);
  }
});

test('expandPercentile: D100 mixed with other groups', () => {
  const out = expandPercentile([
    { count: 1, sides: 6 },
    { count: 1, sides: 100 },
    { count: 2, sides: 20 },
  ]);
  // Non-D100 groups pass through untouched (one element each, even when count>1).
  // D100 groups expand to 2 percentile dice per count. So: 1 + 2 + 1 = 4 elements.
  assert.equal(out.length, 4);
  assert.deepEqual(out[0], { count: 1, sides: 6 });
  assert.equal(out[1].theme, 'ruby');
  assert.equal(out[2].theme, 'sapphire');
  assert.deepEqual(out[3], { count: 2, sides: 20 });
});

test('expandPercentile: tolerates bad input', () => {
  assert.deepEqual(expandPercentile(null),      []);
  assert.deepEqual(expandPercentile(undefined), []);
  assert.deepEqual(expandPercentile('not-array'), []);
  assert.deepEqual(expandPercentile([]),        []);
});

// ───── canRenderInTray

test('canRenderInTray: every direct mesh side passes', () => {
  for (const sides of TRAY_SIDES_DIRECT) {
    assert.equal(canRenderInTray([{ count: 1, sides }]), true, `d${sides} should render`);
  }
});

test('canRenderInTray: D100 counts (via percentile)', () => {
  assert.equal(canRenderInTray([{ count: 1, sides: 100 }]), true);
});

test('canRenderInTray: rejects sides with no mesh', () => {
  assert.equal(canRenderInTray([{ count: 1, sides: 7 }]),  false);
  assert.equal(canRenderInTray([{ count: 1, sides: 50 }]), false);
});

test('canRenderInTray: mixed renderable + non-renderable is false', () => {
  assert.equal(canRenderInTray([
    { count: 1, sides: 6 }, { count: 1, sides: 7 },
  ]), false);
});

test('canRenderInTray: empty or bad input is false', () => {
  assert.equal(canRenderInTray([]),          false);
  assert.equal(canRenderInTray(null),        false);
  assert.equal(canRenderInTray('not-array'), false);
});

// ───── End-to-end: "!roll 1d100" — the path that drove the v0.2.97 percentile work.

test('end-to-end: chat "1d100" parses, renders in tray, expands correctly', () => {
  const spec = parseChatRollSpec('1d100');
  assert.deepEqual(spec, [{ count: 1, sides: 100 }]);
  assert.equal(canRenderInTray(spec), true);
  const dice = expandPercentile(spec);
  assert.equal(dice.length, 2);
  assert.equal(dice[0].theme, 'ruby');
  assert.equal(dice[1].theme, 'sapphire');
});

test('end-to-end: chat "1d20+1d100" parses, renders, expands correctly', () => {
  const spec = parseChatRollSpec('1d20+1d100');
  assert.deepEqual(spec, [{ count: 1, sides: 20 }, { count: 1, sides: 100 }]);
  assert.equal(canRenderInTray(spec), true);
  const dice = expandPercentile(spec);
  // 1 × D20 + 2 × D10 percentile = 3 dice on the tray
  assert.equal(dice.length, 3);
  assert.equal(dice[0].sides, 20);
  assert.equal(dice[1].theme, 'ruby');
  assert.equal(dice[2].theme, 'sapphire');
});

test('end-to-end: "!roll 1d7" parses as chat spec but cannot render in tray', () => {
  const spec = parseChatRollSpec('1d7');
  assert.deepEqual(spec, [{ count: 1, sides: 7 }]);
  assert.equal(canRenderInTray(spec), false,
    'd7 must fall through to server-rolled chat reply, not a broken tray render');
});
