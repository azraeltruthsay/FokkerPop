// Playwright smoke test: every sidebar tab renders.
//
// This is the headless version of the manual "click every tab" pass that
// would have caught the v0.2.101 bug in seconds (page-effects swallowed
// every subsequent page because of a dropped </div>). We boot the real
// server on a throwaway port, open /dashboard/, and for each sidebar item
// assert that its `.page` becomes visible AND contains a rendered page-title.
//
// Run directly:  node test/smoke.spec.mjs
// Requires:      npm install  (pulls in playwright)
//                npx playwright install chromium
//
// Exits non-zero on any failure. Skips cleanly if Playwright isn't
// installed (so `npm test` still runs in environments without browsers).

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('SKIP: playwright not installed. Run `npm install` then `npx playwright install chromium`.');
  process.exit(0);
}

const PORT = 4800 + Math.floor(Math.random() * 100);
const URL_ROOT = `http://127.0.0.1:${PORT}`;

// Expected sidebar pages. Each entry: button text → page id to verify visible.
const EXPECTED_PAGES = [
  { label: 'Live',         id: 'page-live' },
  { label: 'Chat',         id: 'page-chat' },
  { label: 'Test Effects', id: 'page-effects' },
  { label: 'Goals',        id: 'page-goals' },
  { label: 'Assets',       id: 'page-assets' },
  { label: 'Layout',       id: 'page-layout' },
  { label: 'Config',       id: 'page-config' },
  { label: 'Studio',       id: 'page-studio' },
  { label: 'Event Log',    id: 'page-log' },
  { label: 'Setup',        id: 'page-setup' },
];

const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
console.log(`Smoke test for FokkerPop ${pkg.version}`);

// Boot the server on our throwaway port. Copy settings to force the port.
const env = { ...process.env, PORT: String(PORT), FOKKER_SMOKE: '1' };
const server = spawn('node', ['server/index.js'], {
  cwd: ROOT,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverReady = false;
const serverLog = [];
server.stdout.on('data', d => { serverLog.push(String(d)); if (String(d).includes('http://')) serverReady = true; });
server.stderr.on('data', d => { serverLog.push(String(d)); });

async function waitForServer(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(URL_ROOT + '/dashboard/');
      if (res.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Server did not come up on ${PORT} in ${timeoutMs}ms\n${serverLog.join('')}`);
}

let failed = 0;
try {
  await waitForServer();
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const consoleErrors = [];
  page.on('pageerror', err => consoleErrors.push(`pageerror: ${err.message}`));
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(`console.error: ${msg.text()}`); });

  await page.goto(URL_ROOT + '/dashboard/', { waitUntil: 'domcontentloaded' });
  // Give window.fokkerSemver's module import a tick.
  await page.waitForTimeout(200);

  for (const { label, id } of EXPECTED_PAGES) {
    const btn = await page.locator(`.nav-item[data-page="${id.replace(/^page-/, '')}"]`).first();
    if ((await btn.count()) === 0) {
      console.error(`FAIL ${label}: sidebar button not found`);
      failed++;
      continue;
    }
    await btn.click();
    // Navigation is synchronous (no routing lib) — just verify the page element.
    const pageEl = page.locator(`#${id}`);
    const isActive = await pageEl.evaluate(el => el.classList.contains('active'));
    const visible  = await pageEl.isVisible();
    const hasTitleNode = (await pageEl.locator('.page-title').count()) > 0;
    if (!isActive || !visible || !hasTitleNode) {
      console.error(`FAIL ${label}: active=${isActive} visible=${visible} hasTitle=${hasTitleNode}`);
      failed++;
    } else {
      console.log(`ok  ${label}`);
    }
  }

  // Version banner must NOT appear for a current version (regression guard
  // for the string-compare bug).
  const banner = await page.locator('#error-reporter').isVisible().catch(() => false);
  if (banner) {
    console.error(`FAIL version banner visible on current release ${pkg.version}`);
    failed++;
  } else {
    console.log(`ok  version banner hidden on current release`);
  }

  if (consoleErrors.length) {
    console.error('Console errors during smoke test:');
    for (const e of consoleErrors) console.error('  ' + e);
    failed += consoleErrors.length;
  }

  await browser.close();
} catch (err) {
  console.error('Smoke test crashed:', err);
  failed++;
} finally {
  server.kill('SIGTERM');
  await once(server, 'exit').catch(() => {});
}

process.exit(failed === 0 ? 0 : 1);
