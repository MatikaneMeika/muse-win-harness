#!/usr/bin/env node
/**
 * MWH Three-Layer Silent Self-Healing Guard
 *
 * Uses only Node.js built-ins so it can run even when all node_modules are missing.
 * Layers:
 *   1. Shell Electron runtime (shell/node_modules/electron/dist/electron.exe, koffi)
 *   2. Backend CLI (root dependencies + src/ -> dist/cli.js mtime check)
 *   3. Frontend UI (frontend dependencies + frontend/src/ -> frontend/dist/index.html mtime check)
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
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

try {
  ensureShellLayer();
  ensureBackendLayer();
  ensureFrontendLayer();
  log('All 3 layers ready (shell, backend, frontend).');
} catch (err) {
  console.error(`[ensure-ready] ERROR: ${err?.message || String(err)}`);
  process.exit(1);
}
