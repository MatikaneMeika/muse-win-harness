#!/usr/bin/env node
/**
 * MWH Three-Layer Silent Self-Healing & Lifecycle Hygiene Guard
 *
 * Uses only Node.js built-ins at startup so it can run even when all node_modules are missing.
 * Layers:
 *   1. Shell Electron runtime (shell/node_modules/electron/dist/electron.exe, koffi)
 *   2. Backend CLI (root dependencies + src/ -> dist/cli.js mtime check)
 *   3. Frontend UI (frontend dependencies + frontend/src/ -> frontend/dist/index.html mtime check)
 *   4. Cloudflared binary auto-vendoring into .mwh/bin/cloudflared.exe
 *   5. Stale MWH daemon/shell detection & graceful restart when code/build is newer than running PIDs
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const QUIET = process.argv.includes('--quiet');
const FORCE_BUILD = process.argv.includes('--force');

function log(msg) {
  if (!QUIET) console.log(`[ensure-ready] ${msg}`);
}

function resolveNpmCli() {
  const nodeDir = path.dirname(process.execPath);
  const candidate = path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (fs.existsSync(candidate)) return candidate;
  return null;
}

function runNpmInstall(cwd, label) {
  log(`Installing ${label} dependencies...`);
  const npmCli = resolveNpmCli();
  if (npmCli) {
    execFileSync(process.execPath, [npmCli, 'install', '--no-audit', '--prefer-offline'], {
      cwd,
      stdio: QUIET ? 'ignore' : 'inherit',
      windowsHide: true
    });
    return;
  }
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(npmCmd, ['install', '--no-audit', '--prefer-offline'], {
    cwd,
    stdio: QUIET ? 'ignore' : 'inherit',
    windowsHide: true,
    shell: process.platform === 'win32'
  });
}

function newestMtimeMs(targetPath, extensions) {
  if (!fs.existsSync(targetPath)) return 0;
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) {
    return extensions.some((ext) => targetPath.endsWith(ext)) ? stat.mtimeMs : 0;
  }
  let max = 0;
  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    const full = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      const sub = newestMtimeMs(full, extensions);
      if (sub > max) max = sub;
    } else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
      const mtime = fs.statSync(full).mtimeMs;
      if (mtime > max) max = mtime;
    }
  }
  return max;
}

function ensureShellLayer() {
  const shellDir = path.join(root, 'shell');
  const electronExe = path.join(shellDir, 'node_modules', 'electron', 'dist', 'electron.exe');
  const shellKoffi = path.join(shellDir, 'node_modules', 'koffi', 'package.json');
  if (!fs.existsSync(electronExe) || !fs.existsSync(shellKoffi)) {
    runNpmInstall(shellDir, 'shell');
  }
  if (!fs.existsSync(electronExe)) {
    throw new Error(`electron.exe still missing after install: ${electronExe}`);
  }
}

function ensureBackendLayer() {
  const rootYaml = path.join(root, 'node_modules', 'yaml', 'package.json');
  const rootKoffi = path.join(root, 'node_modules', 'koffi', 'package.json');
  const tscBin = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(rootYaml) || !fs.existsSync(rootKoffi) || !fs.existsSync(tscBin)) {
    runNpmInstall(root, 'root');
  }

  const distCli = path.join(root, 'dist', 'cli.js');
  const srcNewest = newestMtimeMs(path.join(root, 'src'), ['.ts']);
  const stale = !fs.existsSync(distCli) || srcNewest > fs.statSync(distCli).mtimeMs;
  if (FORCE_BUILD || stale) {
    log('Building backend (src/ -> dist/)...');
    execFileSync(process.execPath, [tscBin, '-p', path.join(root, 'tsconfig.json')], {
      cwd: root,
      stdio: QUIET ? 'ignore' : 'inherit',
      windowsHide: true
    });
  }
  if (!fs.existsSync(distCli)) {
    throw new Error(`dist/cli.js still missing after build: ${distCli}`);
  }
}

function ensureFrontendLayer() {
  const frontendDir = path.join(root, 'frontend');
  const viteBin = path.join(frontendDir, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!fs.existsSync(viteBin)) {
    runNpmInstall(frontendDir, 'frontend');
  }

  const uiIndex = path.join(frontendDir, 'dist', 'index.html');
  const uiExts = ['.ts', '.tsx', '.css', '.html', '.json', '.svg'];
  const newestUiSrc = Math.max(
    newestMtimeMs(path.join(frontendDir, 'src'), uiExts),
    newestMtimeMs(path.join(frontendDir, 'index.html'), ['.html']),
    newestMtimeMs(path.join(frontendDir, 'vite.config.ts'), ['.ts'])
  );
  const stale = !fs.existsSync(uiIndex) || newestUiSrc > fs.statSync(uiIndex).mtimeMs;
  if (FORCE_BUILD || stale) {
    log('Building frontend UI (frontend/src/ -> frontend/dist/)...');
    execFileSync(
      process.execPath,
      [viteBin, 'build', '--config', path.join(frontendDir, 'vite.config.ts'), frontendDir],
      {
        cwd: frontendDir,
        stdio: QUIET ? 'ignore' : 'inherit',
        windowsHide: true
      }
    );
  }
  if (!fs.existsSync(uiIndex)) {
    throw new Error(`frontend/dist/index.html still missing after build: ${uiIndex}`);
  }
}

function findCloudflaredSource() {
  const envPath = process.env.CLOUDFLARED_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;

  const candidates = [];
  if (process.env.ProgramFiles) {
    candidates.push(path.join(process.env.ProgramFiles, 'cloudflared', 'cloudflared.exe'));
  }
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe'));
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'cloudflared', 'cloudflared.exe'));
  }
  if (process.env.USERPROFILE) {
    candidates.push(path.join(process.env.USERPROFILE, 'scoop', 'apps', 'cloudflared', 'current', 'cloudflared.exe'));
  }
  candidates.push('C:\\ProgramData\\chocolatey\\bin\\cloudflared.exe');

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  try {
    const out = execFileSync('where.exe', ['cloudflared'], {
      windowsHide: true,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    const first = (out.split(/\r?\n/)[0] || '').trim();
    if (first && fs.existsSync(first)) return first;
  } catch {}

  if (process.platform === 'win32') {
    // Check running cloudflared.exe ExecutablePath (e.g. hosted by another local tool)
    try {
      const psOut = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "(Get-CimInstance Win32_Process -Filter \"Name='cloudflared.exe'\" | Select-Object -First 1 -ExpandProperty ExecutablePath)"
        ],
        { windowsHide: true, encoding: 'utf-8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim();
      if (psOut && fs.existsSync(psOut)) return psOut;
    } catch {}
  }
  return '';
}

function ensureCloudflaredVendored() {
  const vendored = path.join(root, '.mwh', 'bin', 'cloudflared.exe');
  if (fs.existsSync(vendored)) return;
  const source = findCloudflaredSource();
  if (!source) {
    log('WARN: cloudflared.exe not found; Quick Tunnel will be unavailable until installed.');
    return;
  }
  try {
    fs.mkdirSync(path.dirname(vendored), { recursive: true });
    fs.copyFileSync(source, vendored);
    log(`Vendored cloudflared.exe into .mwh/bin/ from ${source}`);
  } catch (err) {
    log(`WARN: failed to vendor cloudflared.exe: ${err?.message || err}`);
  }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return Boolean(e && e.code === 'EPERM');
  }
}

function readRuntimeTokenSync() {
  const secretsPath = path.join(root, '.mwh', 'secrets.json');
  if (!fs.existsSync(secretsPath)) return '';
  try {
    const outer = JSON.parse(fs.readFileSync(secretsPath, 'utf-8'));
    if (outer && typeof outer.dpapi === 'string' && outer.dpapi.trim()) {
      const require = createRequire(import.meta.url);
      const koffi = require(path.join(root, 'node_modules', 'koffi'));
      try {
        koffi.struct('MWH_ER_DATA_BLOB', { cbData: 'uint32', pbData: 'void *' });
      } catch {}
      const crypt32 = koffi.load('crypt32.dll');
      const kernel32 = koffi.load('kernel32.dll');
      const CryptUnprotectData = crypt32.func(
        'int __stdcall CryptUnprotectData(MWH_ER_DATA_BLOB *pDataIn, void *ppszDataDescr, void *pOptionalEntropy, void *pvReserved, void *pPromptStruct, uint32_t dwFlags, _Out_ MWH_ER_DATA_BLOB *pDataOut)'
      );
      const LocalFree = kernel32.func('void * __stdcall LocalFree(void *hMem)');
      const inBuf = Buffer.from(outer.dpapi.trim(), 'base64');
      const outBlob = {};
      const ok = CryptUnprotectData({ cbData: inBuf.length, pbData: inBuf }, null, null, null, null, 1, outBlob);
      if (!ok || !outBlob.pbData || typeof outBlob.cbData !== 'number') return '';
      try {
        const json = Buffer.from(koffi.decode(outBlob.pbData, 'uint8_t', outBlob.cbData)).toString('utf-8');
        const inner = JSON.parse(json);
        return String(inner.runtimeToken || inner.token || '');
      } finally {
        LocalFree(outBlob.pbData);
      }
    }
    return String(outer?.runtimeToken || outer?.token || '');
  } catch {
    return '';
  }
}

async function restartStaleMwhProcessesIfNeeded() {
  const artifactFiles = [
    path.join(root, 'dist', 'cli.js'),
    path.join(root, 'frontend', 'dist', 'index.html'),
    path.join(root, 'shell', 'main.cjs'),
    path.join(root, 'shell', 'muse-settings-preload.cjs'),
    path.join(root, 'shell', 'chrome.html')
  ];
  let latestArtifactMs = 0;
  for (const f of artifactFiles) {
    if (fs.existsSync(f)) {
      const m = fs.statSync(f).mtimeMs;
      if (m > latestArtifactMs) latestArtifactMs = m;
    }
  }

  // 1. Check if running MWH daemon is stale (started before latest build) or from another workspace
  const daemonFile = path.join(root, '.mwh', 'daemon.json');
  if (fs.existsSync(daemonFile)) {
    try {
      const info = JSON.parse(fs.readFileSync(daemonFile, 'utf-8'));
      const pid = Number(info?.pid);
      const startedMs = info?.startedAt ? Date.parse(info.startedAt) : 0;
      const sameWorkspace =
        !info?.workspaceRoot ||
        path.resolve(String(info.workspaceRoot)).toLowerCase() === path.resolve(root).toLowerCase();
      if (isPidAlive(pid) && sameWorkspace && startedMs > 0 && startedMs < latestArtifactMs) {
        log(`Detected stale MWH daemon pid=${pid} (started before latest build); restarting cleanly...`);
        const token = readRuntimeTokenSync();
        const port = Number(info?.port || process.env.MWH_PORT || 19820);
        if (token) {
          try {
            await fetch(`http://127.0.0.1:${port}/api/v1/daemon/shutdown`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}` },
              signal: AbortSignal.timeout(2000)
            });
          } catch {}
        }
        const deadline = Date.now() + 2500;
        while (Date.now() < deadline && isPidAlive(pid)) {
          await new Promise((r) => setTimeout(r, 150));
        }
        if (isPidAlive(pid)) {
          try {
            process.kill(pid, 'SIGTERM');
          } catch {}
        }
      }
    } catch {}
  }

  // 2. Check if an interactive Electron shell from this exact repo is running with stale shell/preload files
  if (process.platform === 'win32') {
    try {
      const shellDirNorm = path.join(root, 'shell').replace(/'/g, "''");
      const psScript = [
        `$procs = Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like "*${shellDirNorm}*" -and $_.CommandLine -notlike "*--type=*" -and $_.CommandLine -notlike "*--ensure-daemon-only*" }`,
        `$procs | ForEach-Object { "$($_.ProcessId)|$($_.CreationDate.ToUniversalTime().ToString('o'))" }`
      ].join('; ');
      const out = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', psScript],
        { windowsHide: true, encoding: 'utf-8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim();
      for (const line of out.split(/\r?\n/)) {
        const [pidStr, createdIso] = line.trim().split('|');
        const pid = Number(pidStr);
        const createdMs = createdIso ? Date.parse(createdIso) : 0;
        if (isPidAlive(pid) && createdMs > 0 && createdMs < latestArtifactMs) {
          log(`Detected stale MWH shell pid=${pid} (started before latest build); closing so new shell opens...`);
          try {
            process.kill(pid, 'SIGTERM');
          } catch {}
        }
      }
    } catch {}
  }
}

try {
  ensureShellLayer();
  ensureBackendLayer();
  ensureFrontendLayer();
  ensureCloudflaredVendored();
  await restartStaleMwhProcessesIfNeeded();
  log('All layers ready (shell, backend, frontend, cloudflared, lifecycle).');
} catch (err) {
  console.error(`[ensure-ready] ERROR: ${err?.message || String(err)}`);
  process.exit(1);
}
