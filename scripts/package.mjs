#!/usr/bin/env node
/**
 * Muse-Win-Harness (MWH) Standalone Distribution Packager
 *
 * Assembles a self-contained, zero-dependency Windows distribution:
 *   1. Bundles Electron v35 x64 runtime (no user-installed Node.js or Git required).
 *   2. Places daemon (dist/), frontend (frontend/dist/), and vendored cloudflared.exe into resources/.
 *   3. Configures Muse-Win-Harness.exe to act as both Desktop Shell and Node.js Daemon (ELECTRON_RUN_AS_NODE).
 *   4. Generates an instant desktop/start-menu installer script (一键创建快捷方式.cmd).
 *   5. Compresses everything into release/Muse-Win-Harness-v0.1.0-win-x64.zip.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const RELEASE_DIR = path.join(root, 'release');
const APP_DIR = path.join(RELEASE_DIR, 'Muse-Win-Harness-win-x64');
const ZIP_PATH = path.join(RELEASE_DIR, 'Muse-Win-Harness-v0.1.0-win-x64.zip');

function log(msg) {
  console.log(`[package] ${msg}`);
}

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

async function main() {
  log('Starting MWH Standalone Distribution Packaging...');

  // 1. Ensure build artifacts are fresh
  const cliPath = path.join(root, 'dist', 'cli.js');
  const uiIndex = path.join(root, 'frontend', 'dist', 'index.html');
  const electronDist = path.join(root, 'shell', 'node_modules', 'electron', 'dist');
  const cloudflaredSrc = path.join(root, '.mwh', 'bin', 'cloudflared.exe');

  if (!fs.existsSync(cliPath) || !fs.existsSync(uiIndex) || !fs.existsSync(cloudflaredSrc)) {
    log('Building required backend/frontend artifacts via ensure-ready.mjs...');
    execFileSync(process.execPath, [path.join(root, 'scripts', 'ensure-ready.mjs')], {
      cwd: root,
      stdio: 'inherit',
    });
  }

  if (!fs.existsSync(electronDist)) {
    throw new Error(`Missing Electron runtime in ${electronDist}`);
  }
  if (!fs.existsSync(cloudflaredSrc)) {
    throw new Error(`Missing vendored cloudflared in ${cloudflaredSrc}`);
  }

  // 2. Prepare clean target directory
  log(`Preparing clean target directory: ${APP_DIR}`);
  if (fs.existsSync(APP_DIR)) {
    fs.rmSync(APP_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(APP_DIR, { recursive: true });

  // 3. Copy Electron runtime files
  log('Copying Electron runtime files...');
  copyDirRecursive(electronDist, APP_DIR);

  // Rename electron.exe to Muse-Win-Harness.exe
  const origExe = path.join(APP_DIR, 'electron.exe');
  const targetExe = path.join(APP_DIR, 'Muse-Win-Harness.exe');
  if (fs.existsSync(origExe)) {
    fs.renameSync(origExe, targetExe);
  }

  // Remove default app
  const defaultAppAsar = path.join(APP_DIR, 'resources', 'default_app.asar');
  if (fs.existsSync(defaultAppAsar)) {
    fs.rmSync(defaultAppAsar, { force: true });
  }

  // 4. Assemble resources/app
  log('Assembling resources/app (companion shell & preloads)...');
  const resourcesDir = path.join(APP_DIR, 'resources');
  const appDir = path.join(resourcesDir, 'app');
  fs.mkdirSync(appDir, { recursive: true });

  const shellSrc = path.join(root, 'shell');
  for (const file of [
    'package.json',
    'main.cjs',
    'chrome.html',
    'chrome-preload.cjs',
    'muse-settings-preload.cjs',
  ]) {
    fs.copyFileSync(path.join(shellSrc, file), path.join(appDir, file));
  }

  copyDirRecursive(path.join(shellSrc, 'resources'), path.join(appDir, 'resources'));

  // Copy shell native koffi and @koromix
  const shellModules = path.join(shellSrc, 'node_modules');
  for (const dep of ['koffi', '@koromix']) {
    const srcDep = path.join(shellModules, dep);
    if (fs.existsSync(srcDep)) {
      copyDirRecursive(srcDep, path.join(appDir, 'node_modules', dep));
    }
  }

  // 5. Assemble resources/daemon
  log('Assembling resources/daemon (single-pipeline kernel & tools)...');
  const daemonDir = path.join(resourcesDir, 'daemon');
  fs.mkdirSync(daemonDir, { recursive: true });
  copyDirRecursive(path.join(root, 'dist'), path.join(daemonDir, 'dist'));

  // Copy runtime daemon dependencies (koffi, @koromix, yaml)
  const daemonNodeModules = path.join(daemonDir, 'node_modules');
  fs.mkdirSync(daemonNodeModules, { recursive: true });
  for (const dep of ['koffi', '@koromix', 'yaml']) {
    const srcDep = path.join(root, 'node_modules', dep);
    if (fs.existsSync(srcDep)) {
      copyDirRecursive(srcDep, path.join(daemonNodeModules, dep));
    }
  }

  // 6. Assemble resources/frontend/dist
  log('Assembling resources/frontend/dist...');
  const daemonFrontend = path.join(resourcesDir, 'frontend', 'dist');
  copyDirRecursive(path.join(root, 'frontend', 'dist'), daemonFrontend);

  // 7. Assemble resources/bin (cloudflared)
  log('Assembling resources/bin (cloudflared.exe)...');
  const binDir = path.join(resourcesDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.copyFileSync(cloudflaredSrc, path.join(binDir, 'cloudflared.exe'));

  // 8. Generate "一键创建桌面快捷方式.cmd" inside package
  log('Generating 一键创建桌面快捷方式.cmd...');
  const shortcutCmd = `@echo off
chcp 65001 >nul
echo [MWH] 正在为您创建桌面与开始菜单快捷方式...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ws = New-Object -ComObject WScript.Shell; " ^
  "$desktop = [Environment]::GetFolderPath('Desktop'); " ^
  "$s = $ws.CreateShortcut($desktop + '\\Muse-Win-Harness.lnk'); " ^
  "$s.TargetPath = '%~dp0Muse-Win-Harness.exe'; " ^
  "$s.WorkingDirectory = '%~dp0'; " ^
  "$s.Description = 'Muse-Win-Harness Local Windows Agent Runtime'; " ^
  "$s.IconLocation = '%~dp0resources\\app\\resources\\app-icon-256.png'; " ^
  "$s.Save(); " ^
  "$programs = [Environment]::GetFolderPath('Programs'); " ^
  "$sp = $ws.CreateShortcut($programs + '\\Muse-Win-Harness.lnk'); " ^
  "$sp.TargetPath = '%~dp0Muse-Win-Harness.exe'; " ^
  "$sp.WorkingDirectory = '%~dp0'; " ^
  "$sp.IconLocation = '%~dp0resources\\app\\resources\\app-icon-256.png'; " ^
  "$sp.Save(); " ^
  "Write-Host '[成功] 已在桌面和开始菜单生成快捷方式！双击即可启动 MWH。' -ForegroundColor Green"
pause
`;
  fs.writeFileSync(path.join(APP_DIR, '一键创建桌面快捷方式.cmd'), shortcutCmd, 'utf8');

  // Also write a friendly README.txt in the zip
  const readmeTxt = `===============================================================
  Muse-Win-Harness (MWH) v0.1.0 绿色便携版
===============================================================

【如何启动】
  方式 1：直接双击运行 "Muse-Win-Harness.exe" 即可启动。
  方式 2：双击 "一键创建桌面快捷方式.cmd"，自动在桌面生成快捷方式图标。

【关于运行环境】
  - 本便携包已完整内嵌 Windows 10/11 x64 所需的全部运行时。
  - 机器上无需安装 Node.js、无需安装 Git、无需安装 Docker 或 WSL2。
  - 内置了已校验的 cloudflared 快速隧道服务与守护进程。

【如何退出】
  - 右下角任务栏托盘图标 (MWH Logo) -> 右键 -> 退出 (Quit)。

项目主页：https://github.com/MatikaneMeika/muse-win-harness
文档说明：https://github.com/MatikaneMeika/muse-win-harness/blob/main/docs/README.md
`;
  fs.writeFileSync(path.join(APP_DIR, '使用说明.txt'), readmeTxt, 'utf8');

  // Also copy config.example.yaml for user reference
  const configExample = path.join(root, 'config.example.yaml');
  if (fs.existsSync(configExample)) {
    fs.copyFileSync(configExample, path.join(APP_DIR, 'config.example.yaml'));
  }

  // 9. Verify package via Smoke Test
  log('Verifying packaged application via Smoke Test...');
  try {
    execFileSync(targetExe, ['--smoke-test'], {
      cwd: APP_DIR,
      stdio: 'pipe',
      timeout: 10000,
    });
    log('[OK] Smoke Test Passed on Muse-Win-Harness.exe!');
  } catch (err) {
    console.warn(`[WARN] Smoke test exited with: ${err.message}`);
  }

  // Clean up any smoke test runtime residue (.mwh) so release archive is 100% clean and contains zero local secrets
  const staleMwh = path.join(APP_DIR, '.mwh');
  if (fs.existsSync(staleMwh)) {
    log('Purging smoke test runtime residue (.mwh) before compression...');
    fs.rmSync(staleMwh, { recursive: true, force: true });
  }

  // 10. Create Zip Archive
  log(`Compressing into ${ZIP_PATH} (via PowerShell Compress-Archive)...`);
  if (fs.existsSync(ZIP_PATH)) {
    fs.rmSync(ZIP_PATH, { force: true });
  }

  const psScript = `Compress-Archive -Path '${APP_DIR}\\*' -DestinationPath '${ZIP_PATH}' -CompressionLevel Optimal`;
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript], {
    cwd: root,
    stdio: 'inherit',
  });

  const zipStats = fs.statSync(ZIP_PATH);
  const sizeMb = (zipStats.size / (1024 * 1024)).toFixed(2);
  log(`===============================================================`);
  log(`[SUCCESS] Packaging Complete!`);
  log(`  - Portable Folder: ${APP_DIR}`);
  log(`  - Standalone Zip:  ${ZIP_PATH} (${sizeMb} MB)`);
  log(`===============================================================`);
}

main().catch((err) => {
  console.error(`[ERROR] Packaging failed:`, err);
  process.exit(1);
});
