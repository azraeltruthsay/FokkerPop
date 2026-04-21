// Unit tests for the shared semver helpers.
//
// Regression guard: v0.2.101 shipped a dashboard string-compare
// (`v < '0.2.49'`) that flipped the moment any component crossed 99 —
// "0.2.100" < "0.2.49" is true as strings. These tests pin numeric
// per-component compare across every transition we care about.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVersion,
  versionScore,
  semverGt,
} from '../shared/semver.js';

test('parseVersion: strips leading v and pads missing components', () => {
  assert.deepEqual(parseVersion('v1.2.3'), [1, 2, 3]);
  assert.deepEqual(parseVersion('1.2.3'),  [1, 2, 3]);
  assert.deepEqual(parseVersion('0.2'),    [0, 2]);
  assert.deepEqual(parseVersion('7'),      [7]);
  assert.deepEqual(parseVersion(''),       [0]);
  assert.deepEqual(parseVersion(null),     [0]);
  assert.deepEqual(parseVersion(undefined),[0]);
});

test('versionScore: monotonic across the 99→100 boundary', () => {
  assert.ok(versionScore('0.2.99')  < versionScore('0.2.100'));
  assert.ok(versionScore('0.2.100') < versionScore('0.2.101'));
  assert.ok(versionScore('0.2.999') < versionScore('0.3.0'));
});

test('semverGt: regression cases that broke in v0.2.101', () => {
  // The actual bug: string compare said 0.2.100 was older than 0.2.49.
  assert.equal(semverGt('0.2.100', '0.2.49'), true,
    '0.2.100 must be greater than 0.2.49 (was broken by string compare)');
  assert.equal(semverGt('0.2.101', '0.2.49'), true);
  assert.equal(semverGt('0.2.49',  '0.2.100'), false);

  // And the dashboard setVersion() guard — "is installed version older than 0.2.49?"
  // Must be false for every release that shipped the guard onwards.
  for (const v of ['0.2.49', '0.2.50', '0.2.99', '0.2.100', '0.2.101', '0.2.102', '0.3.0', '1.0.0']) {
    assert.equal(semverGt('0.2.49', v), false, `0.2.49 must not be greater than ${v}`);
  }
  // But must be true for genuinely-old versions.
  for (const v of ['0.2.48', '0.2.0', '0.1.99', '0.0.1']) {
    assert.equal(semverGt('0.2.49', v), true, `0.2.49 must be greater than ${v}`);
  }
});

test('semverGt: equality and basic ordering', () => {
  assert.equal(semverGt('1.0.0', '1.0.0'), false);
  assert.equal(semverGt('1.0.1', '1.0.0'), true);
  assert.equal(semverGt('1.1.0', '1.0.9'), true);
  assert.equal(semverGt('2.0.0', '1.99.99'), true);
});

test('semverGt: tolerates leading v and ragged component counts', () => {
  assert.equal(semverGt('v1.2.3', '1.2.3'), false);
  assert.equal(semverGt('1.2',    '1.2.0'), false);
  assert.equal(semverGt('1.2.1',  '1.2'),   true);
});
