#!/usr/bin/env node
// Lightweight HTML structural validator.
//
// Walks every HTML file passed on the CLI (or the default set below) and
// asserts tag balance — any unclosed or mismatched tag fails the process.
// This is the cheapest guard we have against the v0.2.101-style bug where
// a dropped </div> silently nested every subsequent sidebar page inside
// #page-effects and blanked them.
//
// Zero runtime deps. Handles the HTML5 void-element list explicitly; treats
// <script> / <style> bodies as opaque so JS-template string content with
// stray angle brackets doesn't trip the parser.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const VOID_ELEMENTS = new Set([
  'area','base','br','col','embed','hr','img','input','link',
  'meta','param','source','track','wbr',
]);

// Tags whose content is treated as raw text until the matching close tag.
const RAW_TEXT_ELEMENTS = new Set(['script','style','textarea','title']);

function validate(filePath) {
  const src = readFileSync(filePath, 'utf8');
  const stack = [];
  const issues = [];
  let i = 0;
  const len = src.length;

  const linePos = (offset) => {
    let line = 1, col = 1;
    for (let k = 0; k < offset && k < src.length; k++) {
      if (src[k] === '\n') { line++; col = 1; } else col++;
    }
    return { line, col };
  };

  while (i < len) {
    // Skip comments
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      if (end === -1) { i = len; break; }
      i = end + 3;
      continue;
    }
    // Skip doctype / processing instructions / CDATA
    if (src.startsWith('<!', i) || src.startsWith('<?', i)) {
      const end = src.indexOf('>', i);
      if (end === -1) { i = len; break; }
      i = end + 1;
      continue;
    }

    if (src[i] !== '<') { i++; continue; }

    // Closing tag
    if (src[i + 1] === '/') {
      const end = src.indexOf('>', i);
      if (end === -1) { issues.push({ pos: linePos(i), msg: 'Unterminated close tag' }); break; }
      const tag = src.slice(i + 2, end).trim().toLowerCase();
      const top = stack[stack.length - 1];
      if (!top) {
        issues.push({ pos: linePos(i), msg: `Orphan </${tag}>` });
      } else if (top.tag !== tag) {
        issues.push({
          pos: linePos(i),
          msg: `Mismatch: </${tag}> at close does not match <${top.tag}> opened at line ${top.pos.line}:${top.pos.col}`,
        });
        // Don't pop — give the next close a chance to match something older.
      } else {
        stack.pop();
      }
      i = end + 1;
      continue;
    }

    // Opening tag
    const end = findTagEnd(src, i);
    if (end === -1) { issues.push({ pos: linePos(i), msg: 'Unterminated tag' }); break; }
    const inner = src.slice(i + 1, end);
    const selfClose = inner.endsWith('/');
    const nameMatch = inner.match(/^([a-zA-Z][\w:-]*)/);
    if (!nameMatch) { i = end + 1; continue; }
    const tag = nameMatch[1].toLowerCase();
    const pos = linePos(i);

    if (!VOID_ELEMENTS.has(tag) && !selfClose) {
      stack.push({ tag, pos });
    }
    i = end + 1;

    // Skip raw text body for <script>, <style>, etc.
    if (RAW_TEXT_ELEMENTS.has(tag) && !selfClose) {
      const closer = `</${tag}`;
      const idx = indexOfCI(src, closer, i);
      if (idx === -1) {
        issues.push({ pos, msg: `<${tag}> has no closing tag` });
        stack.pop();
        break;
      }
      // Let the normal closing-tag path on the next iteration consume it.
      i = idx;
    }
  }

  for (const frame of stack) {
    issues.push({
      pos: frame.pos,
      msg: `Unclosed <${frame.tag}> (opened at line ${frame.pos.line}:${frame.pos.col})`,
    });
  }

  return issues;
}

function findTagEnd(src, from) {
  // Respect quoted attribute values so a `>` in a data-url or similar doesn't
  // close the tag early.
  let i = from + 1;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    if (quote) { if (c === quote) quote = null; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i;
    i++;
  }
  return -1;
}

function indexOfCI(hay, needle, from) {
  const n = needle.toLowerCase();
  const h = hay.toLowerCase();
  return h.indexOf(n, from);
}

const ROOT = new URL('..', import.meta.url).pathname;
const argv = process.argv.slice(2);
const files = (argv.length ? argv : ['dashboard/index.html', 'overlay.html'])
  .map(f => resolve(ROOT, f));

let totalIssues = 0;
for (const file of files) {
  const issues = validate(file);
  if (issues.length === 0) {
    console.log(`ok  ${file}`);
    continue;
  }
  totalIssues += issues.length;
  console.error(`FAIL ${file}`);
  for (const it of issues) {
    console.error(`  line ${it.pos.line}:${it.pos.col}  ${it.msg}`);
  }
}

process.exit(totalIssues === 0 ? 0 : 1);
