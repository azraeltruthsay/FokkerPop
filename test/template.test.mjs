// Unit tests for server/template.js — the Studio expression evaluator.
//
// Flows like the "Roll for Pairs" redeem rely on non-trivial JS inside
// {{ … }} (e.g. `{{ payload.dice[0].result === payload.dice[1].result ? 'pair' : 'none' }}`).
// Any regression in resolve() — missing key handling, type preservation
// for single-expression strings, nested path access, interpolation —
// silently breaks match nodes across every flow.
//
// These tests use a hand-built context so the test doesn't boot state.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, resolveDeep } from '../server/template.js';

function makeTestCtx(payload = {}) {
  return {
    payload,
    event:       { payload },
    state:       {},
    session:     { subCount: 12, bitsTotal: 500 },
    crowd:       { energy: 40 },
    leaderboard: { bits: { TopUser: 200 } },
    chatters:    ['Alice', 'Bob', 'Carol'],
    Math,
    pick:   (arr) => (Array.isArray(arr) && arr.length) ? arr[0] : '',  // deterministic for tests
    clamp:  (v, min, max) => Math.min(Math.max(v, min), max),
    plural: (n, word) => `${n} ${word}${n !== 1 ? 's' : ''}`,
  };
}

// ───── Non-template passthrough

test('resolve: non-string inputs pass through', () => {
  const ctx = makeTestCtx();
  assert.equal(resolve(42, ctx), 42);
  assert.equal(resolve(true, ctx), true);
  assert.equal(resolve(null, ctx), null);
  assert.equal(resolve(undefined, ctx), undefined);
  const obj = { x: 1 };
  assert.equal(resolve(obj, ctx), obj);
});

test('resolve: plain string without {{ }} passes through', () => {
  const ctx = makeTestCtx();
  assert.equal(resolve('hello world', ctx), 'hello world');
  assert.equal(resolve('', ctx), '');
});

// ───── Single-expression strings preserve typed values

test('resolve: pure template returns raw typed value', () => {
  const ctx = makeTestCtx({ count: 5, active: true, user: 'Roller' });
  assert.equal(resolve('{{ payload.count }}',  ctx), 5);      // number, not "5"
  assert.equal(resolve('{{ payload.active }}', ctx), true);   // boolean
  assert.equal(resolve('{{ payload.user }}',   ctx), 'Roller');
});

test('resolve: pure template supports arithmetic and comparisons', () => {
  const ctx = makeTestCtx({ a: 3, b: 4 });
  assert.equal(resolve('{{ payload.a + payload.b }}',  ctx), 7);
  assert.equal(resolve('{{ payload.a * payload.b }}',  ctx), 12);
  assert.equal(resolve('{{ payload.a < payload.b }}',  ctx), true);
  assert.equal(resolve('{{ payload.a === payload.b }}', ctx), false);
});

test('resolve: pure template supports ternary (the match-node pattern)', () => {
  // This is the v0.2.96 "Roll for Pairs" pattern. A regression here
  // breaks the entire match-node-with-expression branch of Studio.
  const tmpl = "{{ payload.dice[0].result === payload.dice[1].result ? 'pair' : 'none' }}";
  assert.equal(
    resolve(tmpl, makeTestCtx({ dice: [{ result: 4 }, { result: 4 }] })),
    'pair',
  );
  assert.equal(
    resolve(tmpl, makeTestCtx({ dice: [{ result: 4 }, { result: 5 }] })),
    'none',
  );
});

test('resolve: pure template can call helper functions', () => {
  const ctx = makeTestCtx({ count: 3 });
  assert.equal(resolve('{{ plural(payload.count, "gift") }}', ctx), '3 gifts');
  assert.equal(resolve('{{ plural(1, "gift") }}',             ctx), '1 gift');
  assert.equal(resolve('{{ pick(chatters) }}',                ctx), 'Alice');
  assert.equal(resolve('{{ Math.max(1, 2, 3) }}',             ctx), 3);
  assert.equal(resolve('{{ clamp(150, 0, 100) }}',            ctx), 100);
});

// ───── Mixed interpolation returns a string

test('resolve: mixed text + template interpolates to a string', () => {
  const ctx = makeTestCtx({ user: 'Roller', bits: 500 });
  assert.equal(
    resolve('{{ payload.user }} just subbed!', ctx),
    'Roller just subbed!',
  );
  assert.equal(
    resolve('{{ payload.user }} cheered {{ payload.bits }} bits', ctx),
    'Roller cheered 500 bits',
  );
});

test('resolve: interpolation coerces numbers and booleans to strings', () => {
  const ctx = makeTestCtx({ n: 42, b: true });
  assert.equal(resolve('count is {{ payload.n }}',  ctx), 'count is 42');
  assert.equal(resolve('flag is {{ payload.b }}',   ctx), 'flag is true');
});

test('resolve: null / undefined interpolate as empty string', () => {
  const ctx = makeTestCtx({ x: null });
  assert.equal(resolve('x=[{{ payload.x }}]', ctx), 'x=[]');
  assert.equal(resolve('y=[{{ payload.y }}]', ctx), 'y=[]');   // undefined
});

// ───── Error handling

test('resolve: syntax error returns [ERR: ...], does not throw', () => {
  const ctx = makeTestCtx();
  const out = resolve('{{ payload. }}', ctx);        // invalid syntax
  assert.match(out, /^\[ERR:/);
});

test('resolve: runtime reference error returns [ERR: ...] inline', () => {
  const ctx = makeTestCtx();
  const out = resolve('before {{ undefinedVar.foo }} after', ctx);
  assert.match(out, /before \[ERR: [^\]]+\] after/);
});

test('resolve: malformed template braces are treated as literal text', () => {
  const ctx = makeTestCtx();
  // Single brace — not a template, returned verbatim.
  assert.equal(resolve('plain { text } here', ctx), 'plain { text } here');
});

// ───── resolveDeep for nested node.data structures

test('resolveDeep: walks nested objects and arrays', () => {
  const ctx = makeTestCtx({ user: 'Roller', count: 3 });
  const input = {
    title: '{{ payload.user }} wins!',
    count: '{{ payload.count }}',
    tags:  ['rolled-{{ payload.user }}', 'static'],
    nested: { copy: '{{ payload.count + 1 }}', flag: true },
  };
  assert.deepEqual(resolveDeep(input, ctx), {
    title: 'Roller wins!',
    count: 3,                  // pure template → number
    tags:  ['rolled-Roller', 'static'],
    nested: { copy: 4, flag: true },
  });
});

test('resolveDeep: leaves non-string primitives alone', () => {
  const ctx = makeTestCtx();
  assert.deepEqual(resolveDeep({ n: 42, b: false, arr: [1, 2, 3] }, ctx),
                                { n: 42, b: false, arr: [1, 2, 3] });
});
