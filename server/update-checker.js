// GitHub release auto-updater.
//
// Polls the repo's "latest release" once on startup and every 6 hours.
// When a newer version is available, pre-downloads the NSIS updater EXE so
// "Install Now" from the dashboard is instant. On apply, we spawn the EXE
// silently with the current install dir pre-set, then exit this server.
// The updater will relaunch start.bat which boots the new version; the
// dashboard's auto-reload (v0.2.54) picks up the version change.

import { existsSync, createWriteStream, unlinkSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { request } from 'node:https';
import log from './logger.js';

const REPO          = 'azraeltruthsay/FokkerPop';
const LATEST_URL    = `https://api.github.com/repos/${REPO}/releases/latest`;
const CHECK_EVERY   = 6 * 60 * 60 * 1000; // 6h
const USER_AGENT    = 'FokkerPop-Updater';

let available = null;       // { version, notes, exeUrl, localPath }
let downloading = false;
let broadcast = null;       // set by wireUpdateChecker

function semverGt(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

function httpsGetJson(url) {
  return new Promise((ok, fail) => {
    const req = request(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGetJson(res.headers.location).then(ok, fail);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return fail(new Error(`GitHub API ${res.statusCode}`));
      }
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { ok(JSON.parse(body)); } catch (e) { fail(e); } });
    });
    req.on('error', fail);
    req.end();
  });
}

function downloadTo(url, destPath) {
  return new Promise((ok, fail) => {
    const go = (u) => {
      const req = request(u, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/octet-stream' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return go(res.headers.location);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return fail(new Error(`Download ${res.statusCode}`));
        }
        const out = createWriteStream(destPath);
        res.pipe(out);
        out.on('finish', () => out.close(() => ok(destPath)));
        out.on('error', fail);
      });
      req.on('error', fail);
      req.end();
    };
    go(url);
  });
}

function broadcastAvailable() {
  if (!broadcast) return;
  broadcast({
    type: 'state',
    path: 'update.available',
    value: available ? { version: available.version, notes: available.notes, ready: !!available.localPath } : null,
  });
}

export async function checkForUpdate({ currentVersion, root, broadcastToDashboards }) {
  broadcast = broadcastToDashboards;
  if (process.platform !== 'win32') {
    log.debug('Update checker: skipping non-Windows host.');
    return;
  }
  try {
    const rel = await httpsGetJson(LATEST_URL);
    const tag = (rel.tag_name || '').replace(/^v/, '');
    if (!tag || !semverGt(tag, currentVersion)) {
      if (available) { available = null; broadcastAvailable(); }
      return;
    }

    const asset = (rel.assets || []).find(a => /FokkerPop-Updater-.*\.exe$/i.test(a.name));
    if (!asset) {
      log.warn(`Update ${tag} has no Updater EXE asset — skipping.`);
      return;
    }

    // Already announced this version? Just keep the cached file.
    if (available?.version === tag && available.localPath && existsSync(available.localPath)) {
      broadcastAvailable();
      return;
    }

    available = {
      version:   tag,
      notes:     (rel.body || '').slice(0, 2000),
      exeUrl:    asset.browser_download_url,
      localPath: null,
    };
    broadcastAvailable();

    // Pre-download so "Install Now" is instant.
    if (downloading) return;
    downloading = true;
    const dest = resolve(root, `FokkerPop-Updater-v${tag}.exe`);
    try { if (existsSync(dest)) unlinkSync(dest); } catch {}
    log.info(`Update v${tag} detected. Downloading updater…`);
    await downloadTo(asset.browser_download_url, dest);
    const size = statSync(dest).size;
    log.info(`Updater v${tag} ready (${Math.round(size / 1024)} KB) at ${dest}`);
    available.localPath = dest;
    broadcastAvailable();
  } catch (err) {
    log.warn(`Update check failed: ${err.message}`);
  } finally {
    downloading = false;
  }
}

export function applyUpdate({ root, onBeforeExit }) {
  if (!available?.localPath || !existsSync(available.localPath)) {
    throw new Error('No updater downloaded yet.');
  }
  if (onBeforeExit) try { onBeforeExit(); } catch {}

  // NSIS: /S = silent, /D=<path> must be the LAST arg and unquoted.
  // detached + unref + stdio:ignore so the child survives after we exit.
  const child = spawn(available.localPath, ['/S', `/D=${root}`], {
    detached: true,
    stdio: 'ignore',
    cwd: root,
    windowsHide: true,
  });
  child.unref();
  log.info(`Spawned updater v${available.version} (pid=${child.pid}). Exiting server so FokkerPop.exe releases its locks and port.`);
  // Exit fast so port 4747 and node\FokkerPop.exe are released BEFORE the
  // updater tries to overwrite them. The child is detached — it survives us.
  setTimeout(() => process.exit(0), 150);
}

export function getAvailable() {
  return available ? { version: available.version, ready: !!available.localPath } : null;
}

export function scheduleChecks(opts) {
  checkForUpdate(opts);
  return setInterval(() => checkForUpdate(opts), CHECK_EVERY);
}
