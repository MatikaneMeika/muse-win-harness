#!/usr/bin/env node
/**
 * MWH doctor — one-shot environment self-check.
 *
 * Answers the recurring "why did it work yesterday" class of problems by
 * printing the real state of every hop: build artifacts, daemon, token,
 * cloudflared binary, and leftover tunnel/shell processes.
 *
 * Usage:
 *   node scripts/doctor.mjs            # report only
 *   node scripts/doctor.mjs --fix      # also vendor a discovered cloudflared
 *                                      # into <workspace>/.mwh/bin/
 *   node scripts/doctor.mjs --quiet    # 3 lines, for MWH启动.cmd
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import koffi from 'koffi';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const QUIET = process.argv.includes('--quiet');
const FIX = process.argv.includes('--fix');
const PORT = Number(process.env.MWH_PORT || 19820);
// `--cloudflared <dir-or-exe>`: vendor an explicit copy into <workspace>/.mwh/bin.
const cloudflaredArgIndex = process.argv.indexOf('--cloudflared');
const EXPLICIT_CLOUDFLARED =
  cloudflaredArgIndex !== -1 ? String(process.argv[cloudflaredArgIndex + 1] || '') : '';

const problems = [];
const notes = [];

function ok(label, detail) {
  if (!QUIET) console.log(`  [OK]   ${label}${detail ? ' — ' + detail : ''}`);
}
function warn(label, detail, fixHint) {
  notes.push(`${label}: ${detail}`);
  if (!QUIET) console.log(`  [WARN] ${label} — ${detail}${fixHint ? '\n         fix: ' + fixHint : ''}`);
}
function bad(label, detail, fixHint) {
  problems.push(`${label}: ${detail}`);
  console.log(`  [FAIL] ${label} — ${detail}${fixHint ? '\n         fix: ' + fixHint : ''}`);
}

function head(title) {
  if (!QUIET) console.log(`\n${title}`);
}

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, {
      windowsHide: true,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(700);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, '127.0.0.1');
  });
}

/* 1. Node / build artifacts ------------------------------------------------ */
head('1. Runtime & build artifacts');
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor >= 22) ok('node', process.version);
else bad('node', `v${process.versions.node} is below the required >=22`, 'install Node 22 LTS');

const distCli = path.join(root, 'dist', 'cli.js');
if (fs.existsSync(distCli)) ok('dist/cli.js');
else bad('dist/cli.js', 'missing', 'npm run build (or: node node_modules\\typescript\\bin\\tsc -p tsconfig.json)');

const uiIndex = path.join(root, 'frontend', 'dist', 'index.html');
if (fs.existsSync(uiIndex)) ok('frontend/dist');
else warn('frontend/dist', 'missing (the /ui debug page will show the build guide page)', 'npm --prefix frontend run build');

/* 2. Daemon & token ------------------------------------------------------- */
head('2. Host daemon');
const listening = await portOpen(PORT);
if (listening) ok(`port ${PORT}`, 'listening');
else bad(`port ${PORT}`, 'nothing is listening', 'double-click MWH启动.cmd (it starts and verifies the daemon)');

function dpapiUnprotectDoctor(b64) {
  if (process.platform !== 'win32') return null;
  try {
    try {
      koffi.struct('MWH_DOC_DATA_BLOB', { cbData: 'uint32', pbData: 'void *' });
    } catch {}
    const crypt32 = koffi.load('crypt32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    const CryptUnprotectData = crypt32.func(
      'int __stdcall CryptUnprotectData(MWH_DOC_DATA_BLOB *pDataIn, void *ppszDataDescr, void *pOptionalEntropy, void *pvReserved, void *pPromptStruct, uint32_t dwFlags, _Out_ MWH_DOC_DATA_BLOB *pDataOut)'
    );
    const LocalFree = kernel32.func('void * __stdcall LocalFree(void *hMem)');
    const inBuf = Buffer.from(b64, 'base64');
    const outBlob = {};
    const ok = CryptUnprotectData({ cbData: inBuf.length, pbData: inBuf }, null, null, null, null, 1, outBlob);
    if (!ok || !outBlob.pbData || typeof outBlob.cbData !== 'number') return null;
    try {
      return Buffer.from(koffi.decode(outBlob.pbData, 'uint8_t', outBlob.cbData)).toString('utf-8');
    } finally {
      LocalFree(outBlob.pbData);
    }
  } catch {
    return null;
  }
}

let token = '';
const secretsPath = path.join(root, '.mwh', 'secrets.json');
if (fs.existsSync(secretsPath)) {
  try {
    const outer = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
    const isDpapi = Boolean(outer && typeof outer.dpapi === 'string' && outer.dpapi.trim().length > 0);
    const secrets = isDpapi ? JSON.parse(dpapiUnprotectDoctor(outer.dpapi.trim()) || '{}') : outer;
    token = String(secrets.runtimeToken || secrets.token || '');
    if (token) {
      ok(
        '.mwh/secrets.json',
        `token present (${token.slice(0, 8)}…, ${isDpapi ? 'DPAPI v2 encrypted' : 'legacy plaintext'})`
      );
    } else {
      warn('.mwh/secrets.json', 'file exists but has no runtime token');
    }
  } catch (err) {
    warn('.mwh/secrets.json', `unreadable: ${err.message}`);
  }
} else {
  warn('.mwh/secrets.json', 'missing — it is created on first daemon boot');
}

if (listening && token) {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/v1/state`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then((r) => r.status).catch(() => 0);
  if (res === 200) ok('GET /api/v1/state', '200 — the running daemon accepts the persisted token');
  else if (res === 401) bad('GET /api/v1/state', '401 — a different process owns the port, or the token rotated', 'quit MWH from the tray, then run MWH启动.cmd again');
  else warn('GET /api/v1/state', `unexpected status ${res || 'no response'}`);
}

const daemonPidPath = path.join(root, '.mwh', 'daemon.json');
if (fs.existsSync(daemonPidPath)) {
  try {
    const info = JSON.parse(fs.readFileSync(daemonPidPath, 'utf8'));
    const pid = Number(info && info.pid);
    let alive = false;
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (e) {
        alive = e && e.code === 'EPERM';
      }
    }
    if (alive) {
      ok('.mwh/daemon.json', `pid=${pid} startedAt=${info.startedAt || 'unknown'}`);
    } else {
      warn('.mwh/daemon.json', `stale pid=${pid || 'unknown'} (process not running)`);
    }
  } catch (err) {
    warn('.mwh/daemon.json', `unreadable: ${err.message}`);
  }
}

const exitLogPath = path.join(root, '.mwh', 'logs', 'exit-reason.log');
if (fs.existsSync(exitLogPath)) {
  try {
    const lines = fs
      .readFileSync(exitLogPath, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0);
    if (lines.length > 0) {
      const last = JSON.parse(lines[lines.length - 1]);
      ok(
        'last exit record',
        `${last.process || 'unknown'} pid=${last.pid ?? '-'} reason=${last.reason || '-'} trigger=${last.trigger || '-'} @ ${last.timestamp || '-'}`
      );
    }
  } catch {}
}

/* 3. cloudflared ---------------------------------------------------------- */
head('3. cloudflared (Quick Tunnel binary)');
let probe = null;
try {
  const mod = await import(pathToFileURL(path.join(root, 'dist', 'network', 'tunnels.js')).href);
  probe = mod.QuickTunnelDriver.probeCloudflared(undefined, root);
} catch (err) {
  warn('probe', `cannot load dist/network/tunnels.js (${err.message}); run npm run build first`);
}

if (probe && probe.found) {
  ok('cloudflared', `${probe.path} (source: ${probe.source || 'unknown'})`);
} else {
  bad(
    'cloudflared',
    'not found on PATH, in well-known install dirs, <workspace>/.mwh/bin, MWH_CLOUDFLARED_DIR, or a versions dir',
    'node scripts/doctor.mjs --fix --cloudflared "<your-versions-dir>"   (vendors a copy into .mwh/bin)'
  );
  if (FIX) {
    const vendored = vendorCloudflared();
    if (vendored) ok('cloudflared (vendored)', vendored);
    else
      console.log(
        '         nothing to vendor: pass --cloudflared "<dir>" (a versions dir or cloudflared.exe), ' +
          'or set MWH_CLOUDFLARED_DIR.'
      );
  }
}

/* 4. Leftover processes --------------------------------------------------- */
head('4. Leftover processes');
// tasklist is used instead of Get-Process: no PowerShell quoting pitfalls, no
// dependency on $_ interpolation, and it works on every Windows SKU.
function tasklist(image) {
  const raw = run('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH']);
  if (!raw || /^INFO:/i.test(raw)) return [];
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith('"'))
    .map((line) => line.split('","').map((cell) => cell.replace(/^"|"$/g, '')))
    .filter((cells) => cells.length >= 2)
    .map((cells) => [image.replace(/\.exe$/i, ''), cells[1], cells[4] || '']);
}

const rows = [...tasklist('cloudflared.exe'), ...tasklist('electron.exe')];
const cloudflaredRows = rows.filter((r) => r[0] === 'cloudflared');
if (cloudflaredRows.length === 0) ok('cloudflared processes', 'none');
else if (cloudflaredRows.length === 1) ok('cloudflared processes', `${cloudflaredRows[0][1]} since ${cloudflaredRows[0][2]}`);
else
  warn(
    'cloudflared processes',
    `${cloudflaredRows.length} running (${cloudflaredRows.map((r) => r[1]).join(', ')}); same-name processes may belong to other local tools`,
    'inspect each pid first: Get-CimInstance Win32_Process -Filter "Name=\'cloudflared.exe\'" | Select ProcessId,CommandLine ; never kill by image name'
  );

const electronRows = rows.filter((r) => r[0] === 'electron');
if (electronRows.length > 0) {
  const oldest = electronRows.reduce((a, b) => (a[2] < b[2] ? a : b));
  notes.push(`electron processes: ${electronRows.length} (oldest pid ${oldest[1]} since ${oldest[2]})`);
  if (!QUIET) {
    console.log(`  [INFO] electron: ${electronRows.map((r) => `${r[1]}@${r[2]}`).join(', ')}`);
  }
}

/* 5. Verdict -------------------------------------------------------------- */
if (QUIET) {
  console.log(`doctor: daemon=${listening ? 'up' : 'down'} cloudflared=${probe && probe.found ? 'ok' : 'missing'} issues=${problems.length}`);
  process.exit(problems.length === 0 ? 0 : 1);
}

console.log('\n' + '='.repeat(60));
if (problems.length === 0) {
  console.log('RESULT: environment OK');
  if (notes.length) console.log('notes: ' + notes.join(' | '));
} else {
  console.log(`RESULT: ${problems.length} problem(s) need attention`);
  for (const p of problems) console.log('  - ' + p);
}
console.log('='.repeat(60));
process.exit(problems.length === 0 ? 0 : 1);

/* ------------------------------------------------------------------------ */
function vendorCloudflared() {
  const target = path.join(root, '.mwh', 'bin', 'cloudflared.exe');
  const candidates = [];
  if (EXPLICIT_CLOUDFLARED) candidates.push(EXPLICIT_CLOUDFLARED);
  const envDir = process.env.MWH_CLOUDFLARED_DIR;
  if (envDir) candidates.push(envDir);
  for (const dir of candidates) {
    const found = findExe(dir);
    if (found) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(found, target);
      return `${target} (copied from ${found})`;
    }
  }
  return '';
}

function findExe(dir) {
  try {
    if (!fs.existsSync(dir)) return '';
    const stat = fs.statSync(dir);
    if (stat.isFile()) {
      return path.basename(dir).toLowerCase() === 'cloudflared.exe' ? dir : '';
    }
    const direct = path.join(dir, 'cloudflared.exe');
    if (fs.existsSync(direct)) return direct;
    // Accept either ".../components/cloudflared" (contains versions/) or the
    // versions directory itself.
    const versionRoots = [path.join(dir, 'versions'), dir];
    for (const versions of versionRoots) {
      if (!fs.existsSync(versions)) continue;
      const entries = fs
        .readdirSync(versions, { withFileTypes: true })
        .filter((e) => e.isDirectory() && /^[0-9A-Za-z._-]+$/.test(e.name) && e.name !== '.' && e.name !== '..')
        .map((e) => e.name)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const version of entries) {
        const exe = path.join(versions, version, 'cloudflared.exe');
        if (fs.existsSync(exe)) return exe;
      }
    }
  } catch {
    // ignore and fall through
  }
  return '';
}
