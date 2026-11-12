#!/usr/bin/env node
/**
 * MWH UI Contract Gate
 *
 * Pure Node.js, zero external dependencies, runs in well under a second.
 * Hard-asserts the shell/preload contract:
 *   1. Syntax of main.cjs / muse-settings-preload.cjs / chrome-preload.cjs.
 *   2. main.cjs has no retired theme sampler, no dangling overlayWin member
 *      access, and still exposes applyDwmTheme + mwh:theme-sync.
 *   3. muse-settings-preload.cjs and chrome.html contain zero emoji.
 *   4. Every mwh:* IPC channel used by the preloads is registered in main.cjs.
 *   5. The drawer / sub-panel / five sections / snapshot folding / approval
 *      island are all physically present in the preload.
 *   6. Muse brand palette: zero purple leftovers, official blue only.
 *   7. Single gradient ring spinner, no breathing pulse animation.
 *   8. Five advanced tabs use 2-4 character titles and an equal-width grid.
 *   9. Full-screen drawer backdrop and transparent-aware theme probing.
 *  10. UI content admission: human audience, zero retired CLI/agent-lecture copy.
 *  11. Tool truth source + zero hardcoded private machine paths.
 *  12. Startup preflight: launcher must verify the daemon before opening a shell.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const files = {
  main: path.join(root, 'shell', 'main.cjs'),
  preload: path.join(root, 'shell', 'muse-settings-preload.cjs'),
  chromePreload: path.join(root, 'shell', 'chrome-preload.cjs'),
  chromeHtml: path.join(root, 'shell', 'chrome.html'),
};

const failures = [];

function fail(message) {
  failures.push(message);
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function cssBlock(source, selector) {
  const start = source.indexOf(selector);
  if (start === -1) return '';
  const end = source.indexOf('}', start);
  return end === -1 ? source.slice(start) : source.slice(start, end + 1);
}

/* 1. Syntax ------------------------------------------------------------- */

for (const key of ['main', 'preload', 'chromePreload']) {
  const file = files[key];
  assert(fs.existsSync(file), `missing file: ${file}`);
  if (!fs.existsSync(file)) continue;
  try {
    execFileSync(process.execPath, ['-c', file], { stdio: 'pipe' });
  } catch (err) {
    const detail = (err.stderr && err.stderr.toString().trim()) || err.message;
    fail(`syntax error in ${path.relative(root, file)}: ${detail}`);
  }
}

const mainSource = read(files.main);
const preloadSource = read(files.preload);
const chromePreloadSource = read(files.chromePreload);
const chromeHtmlSource = read(files.chromeHtml);

const reactModalPath = path.join(root, 'frontend', 'src', 'overlay', 'MwhSettingsModal.tsx');
const reactServicePath = path.join(root, 'frontend', 'src', 'services', 'mwhService.ts');
const reactModalSource = fs.existsSync(reactModalPath) ? read(reactModalPath) : '';
const reactServiceSource = fs.existsSync(reactServicePath) ? read(reactServicePath) : '';

/* 2. main.cjs retired-code & DWM contract ------------------------------- */

assert(!/\bsampleMuseTheme\b/.test(mainSource), 'main.cjs still references sampleMuseTheme');
assert(!/\baverageBitmap\b/.test(mainSource), 'main.cjs still references averageBitmap');
assert(!/\boverlayWin\s*\./.test(mainSource), 'main.cjs still calls a member on undefined overlayWin');
assert(/\bapplyDwmTheme\b/.test(mainSource), 'main.cjs is missing applyDwmTheme');
assert(/mwh:theme-sync/.test(mainSource), 'main.cjs is missing the mwh:theme-sync handler');
assert(/DWMWA_BORDER_COLOR/.test(mainSource), 'main.cjs is missing DWMWA_BORDER_COLOR usage');
assert(/DWMWA_CAPTION_COLOR/.test(mainSource), 'main.cjs is missing DWMWA_CAPTION_COLOR usage');
assert(/DWMWA_TEXT_COLOR/.test(mainSource), 'main.cjs is missing DWMWA_TEXT_COLOR usage');
assert(/connectDaemonSse/.test(mainSource), 'main.cjs is missing connectDaemonSse');
assert(/function daemonFetch/.test(mainSource), 'main.cjs is missing daemonFetch');

/* 3. Zero emoji --------------------------------------------------------- */

const pictographic = /\p{Extended_Pictographic}/u;
assert(!pictographic.test(preloadSource), 'muse-settings-preload.cjs contains emoji characters');
assert(!pictographic.test(chromeHtmlSource), 'chrome.html contains emoji characters');

/* 4. IPC contract ------------------------------------------------------- */

const registered = new Set();
for (const match of mainSource.matchAll(/ipcMain\.(?:handle|on)\(\s*['"](mwh:[^'"]+)['"]/g)) {
  registered.add(match[1]);
}

const used = new Set();
for (const source of [preloadSource, chromePreloadSource]) {
  for (const match of source.matchAll(/ipcRenderer\.(?:invoke|send)\(\s*['"](mwh:[^'"]+)['"]/g)) {
    used.add(match[1]);
  }
}

for (const channel of [...used].sort()) {
  assert(registered.has(channel), `IPC channel not registered in main.cjs: ${channel}`);
}
assert(used.size > 0, 'no mwh:* IPC channels found in preloads');

/* 5. Drawer / sub-panel / sections / island ----------------------------- */

const drawerBlock = cssBlock(preloadSource, '.mwh-drawer {');
const subpanelBlock = cssBlock(preloadSource, '.mwh-subpanel {');

assert(drawerBlock.length > 0, 'preload is missing the .mwh-drawer style block');
assert(/--mwh-drawer-w:\s*min\(clamp\(280px,\s*25vw,\s*420px\)/.test(preloadSource), 'preload must define --mwh-drawer-w as min(clamp(280px, 25vw, 420px), remaining space)');
  assert(/width:\s*var\(--mwh-drawer-w\)/.test(drawerBlock), '.mwh-drawer width must follow --mwh-drawer-w');
  assert(/border-radius:\s*20px/.test(drawerBlock), '.mwh-drawer must use a 20px radius');

  assert(subpanelBlock.length > 0, 'preload is missing the .mwh-subpanel style block');
  assert(/border-radius:\s*24px/.test(subpanelBlock), '.mwh-subpanel must use a 24px radius');
  assert(/--mwh-subpanel-w:/.test(preloadSource), 'preload must define --mwh-subpanel-w');
  assert(/var\(--mwh-drawer-w\)/.test(subpanelBlock), '.mwh-subpanel left/width must follow --mwh-drawer-w');

for (const section of ['connectors', 'daemon', 'resources', 'snapshots-audit']) {
  assert(preloadSource.includes(section), `preload is missing advanced section: ${section}`);
}

assert(preloadSource.includes('mwh-drawer-backdrop'), 'preload is missing .mwh-drawer-backdrop click-to-close');
assert(preloadSource.includes('normalizeWinPath'), 'preload is missing normalizeWinPath snapshot folding');
assert(preloadSource.includes('WAITING_APPROVAL'), 'preload is missing the WAITING_APPROVAL island state');
assert(preloadSource.includes('mwh:task-approve'), 'preload is missing mwh:task-approve island wiring');
assert(preloadSource.includes('mwh-approval-island'), 'preload is missing the approval floating island');
assert(preloadSource.includes('mwh-light'), 'preload is missing the light theme class');
assert(preloadSource.includes('MutationObserver'), 'preload is missing the theme MutationObserver');
assert(preloadSource.includes("mwh:theme-sync"), 'preload is missing mwh:theme-sync emission');

/* 6. Muse brand palette: zero purple, official blue only ------------- */

const purplePattern = /#a855f7|#8b5cf6|#9333ea|#c084fc|168,\s*85,\s*247|139,\s*92,\s*246/i;
assert(!purplePattern.test(preloadSource), 'muse-settings-preload.cjs still contains purple brand colours');
assert(!purplePattern.test(chromeHtmlSource), 'chrome.html still contains purple brand colours');

for (const blue of ['#2B7FFF', '#1B6FEF', '#8AB8FF']) {
  assert(preloadSource.includes(blue), `preload is missing the Muse brand blue: ${blue}`);
}

/* 7. Single gradient ring spinner, no breathing pulse ---------------- */

assert(!preloadSource.includes('mwh-pulse-subtle'), 'preload still defines the mwh-pulse-subtle breathing animation');
assert(preloadSource.includes('mwhSpinGrad'), 'preload spinner is missing the mwhSpinGrad gradient');
assert(preloadSource.includes('mwh-spin'), 'preload spinner is missing the mwh-spin rotation class');

/* 8. Four advanced tabs: equal-width grid bar + resource library copy - */

const sectionsStart = preloadSource.indexOf('const ADVANCED_SECTIONS');
const sectionsEnd = preloadSource.indexOf('];', sectionsStart);
assert(sectionsStart !== -1 && sectionsEnd > sectionsStart, 'preload is missing the ADVANCED_SECTIONS table');
const sectionsBlock =
  sectionsStart !== -1 && sectionsEnd > sectionsStart ? preloadSource.slice(sectionsStart, sectionsEnd) : '';

const sectionTitles = [...sectionsBlock.matchAll(/\btitle:\s*'([^']*)'/g)].map((m) => m[1]);
assert(sectionTitles.length === 4, `ADVANCED_SECTIONS must declare 4 titles, found ${sectionTitles.length}`);
for (const expected of ['连接与权限', '工作区与代理', '资源库', '审计日志']) {
  assert(sectionTitles.includes(expected), `ADVANCED_SECTIONS is missing the title: ${expected}`);
}

const tabsBarBlock = cssBlock(preloadSource, '.mwh-subpanel-tabs-bar {');
assert(/grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/.test(tabsBarBlock), '.mwh-subpanel-tabs-bar must be a 4-column equal-width grid');

// Resource library essential human copy assertions:
for (const [label, src] of [
  ['muse-settings-preload.cjs', preloadSource],
  ['MwhSettingsModal.tsx', reactModalSource],
]) {
  assert(
    src.includes('打开即对 Muse 生效，默认全部关闭。'),
    `${label} is missing the resource library activation note: 打开即对 Muse 生效，默认全部关闭。`
  );
  assert(
    src.includes('MCP 在你的 Windows 用户权限下运行，没有额外沙箱。'),
    `${label} is missing the kernel sandbox disclosure: MCP 在你的 Windows 用户权限下运行，没有额外沙箱。`
  );
}

/* 8b. Switch motion contract: in-place painting + tokenised transition - */
// 开关必须原地绘制，靠整块 innerHTML 重绘会让过渡失效（见 docs/DESIGN.md 4.8 红线 1）。
assert(
  /\bfunction paintSwitch\s*\(/.test(preloadSource),
  'preload is missing paintSwitch() — switch toggles must paint in place, not re-render'
);
assert(
  /pendingSwitchKeys/.test(preloadSource),
  'preload is missing pendingSwitchKeys double-click guard'
);
assert(
  /holdSwitchMin/.test(preloadSource),
  'preload is missing holdSwitchMin() — requests must not cut the switch animation short'
);
// SSE 先于 HTTP 响应到达，重绘必须给正在播放的过渡让路（DESIGN.md 4.8 红线 2）。
assert(
  /pendingSwitchMotionLeftMs/.test(preloadSource) && /switchRenderDeferred/.test(preloadSource),
  'preload is missing the render hold that defers innerHTML rebuild during switch motion'
);
// 用带前导换行的选择器切片，避免被 .mwh-light 变体或后代规则误命中。
const switchBlock = cssBlock(preloadSource, '\n.mwh-switch {');
assert(
  /--mwh-dur-state/.test(switchBlock) && /--mwh-dur-fast/.test(switchBlock),
  '.mwh-switch transition must reference --mwh-dur-state / --mwh-dur-fast tokens'
);
const switchDotBlock = cssBlock(preloadSource, '\n.mwh-switch-dot {');
assert(
  /--mwh-ease-standard/.test(switchDotBlock),
  '.mwh-switch-dot must use --mwh-ease-standard'
);
const reducedMotionStart = preloadSource.indexOf('@media (prefers-reduced-motion: reduce)');
assert(reducedMotionStart !== -1, 'preload is missing the prefers-reduced-motion block');
if (reducedMotionStart !== -1) {
  const reducedBlock = preloadSource.slice(reducedMotionStart, preloadSource.indexOf('\n}', reducedMotionStart));
  assert(/\.mwh-switch,/.test(reducedBlock), 'prefers-reduced-motion block must cover .mwh-switch');
  assert(/\.mwh-switch-dot,/.test(reducedBlock), 'prefers-reduced-motion block must cover .mwh-switch-dot');
  assert(/none !important/.test(reducedBlock), 'prefers-reduced-motion block must zero the transitions');
}
assert(
  /:root \{[^}]*--mwh-dur-state/.test(preloadSource),
  'motion tokens must be declared on :root so overlay/backdrop elements can use them'
);

/* 9. Full-screen backdrop (no left gap / black top border) ----------- */

const backdropBlock = cssBlock(preloadSource, '.mwh-drawer-backdrop {');
assert(backdropBlock.length > 0, 'preload is missing the .mwh-drawer-backdrop style block');
assert(/left:\s*0/.test(backdropBlock), '.mwh-drawer-backdrop must start at left: 0 for full-screen coverage');
assert(!/left:\s*48px/.test(backdropBlock), '.mwh-drawer-backdrop must not leave a 48px left gap');

/* 10. Transparent-aware theme probe + centred activity slot ---------- */

assert(preloadSource.includes('parseOpaqueRgb'), 'preload is missing the parseOpaqueRgb transparent-aware probe');
assert(preloadSource.includes('mwh-activity-slot'), 'preload is missing the .mwh-activity-slot flex container');

/* 11. UI Content Admission Gate (human audience + zero stale CLI/agentask) */

const forbiddenUiPhrases = [
  '云端调用通道',
  '本机 CLI 子代理桥接器',
  '[LOCAL_CONFINEMENT_ADAPTED]',
  '不要在云端手工拼',
  '不要重发同一条命令',
  'agentask',
];

for (const phrase of forbiddenUiPhrases) {
  assert(
    !preloadSource.includes(phrase),
    `muse-settings-preload.cjs contains forbidden agent-lecture or retired phrase: ${phrase}`
  );
  assert(
    !reactModalSource.includes(phrase),
    `MwhSettingsModal.tsx contains forbidden agent-lecture or retired phrase: ${phrase}`
  );
}

const acpProbeMatches = [...preloadSource.matchAll(/if\s*\(\s*action\s*===\s*['"]acp-probe['"]\s*\)/g)];
assert(
  acpProbeMatches.length === 1,
  `muse-settings-preload.cjs must have exactly 1 action === 'acp-probe' handler, found ${acpProbeMatches.length}`
);

for (const [label, src] of [
  ['MwhSettingsModal.tsx', reactModalSource],
  ['mwhService.ts', reactServiceSource],
  ['main.cjs', mainSource],
  ['muse-settings-preload.cjs', preloadSource],
]) {
  assert(
    !/\b(?:dsh|codex|opencode|grok)\b/.test(src),
    `${label} still references retired static CLI identifier (dsh/codex/opencode/grok)`
  );
}

/* 12. Tool Truth-Source & Zero Private Env Leak Gate -------------------- */

const skillExamplePath = path.join(root, 'connectors', 'muse-skill-template', 'SKILL.example.md');
assert(fs.existsSync(skillExamplePath), 'missing connectors/muse-skill-template/SKILL.example.md');
if (fs.existsSync(skillExamplePath)) {
  const skillExampleSource = read(skillExamplePath);
  for (const toolName of [
    'pc_status',
    'fs_explore',
    'fs_mutate',
    'exec_command',
    'job_control',
    'subagent_dispatch',
    'git_checkpoint',
    'desktop_hands',
  ]) {
    assert(
      skillExampleSource.includes(toolName),
      `SKILL.example.md is missing tool reference: ${toolName}`
    );
  }
}

const tunnelsSource = read(path.join(root, 'src', 'network', 'tunnels.ts'));
for (const [label, src] of [
  ['shell/main.cjs', mainSource],
  ['src/network/tunnels.ts', tunnelsSource],
  ['frontend/src/overlay/MwhSettingsModal.tsx', reactModalSource],
]) {
  assert(
    !/[DE]:[\\/]+gongju/i.test(src),
    `${label} still contains hardcoded private machine path (D:/gongju or E:/gongju)`
  );
}

/* 13. Startup Preflight Contract (no dead shell, no global taskkill) ----- */

const launcherPath = path.join(root, 'MWH启动.cmd');
assert(fs.existsSync(launcherPath), 'missing MWH启动.cmd launcher');
const launcherSource = fs.existsSync(launcherPath) ? read(launcherPath) : '';

assert(
  launcherSource.includes('--ensure-daemon-only'),
  'MWH启动.cmd must run the daemon preflight (--ensure-daemon-only) before opening the shell'
);
assert(
  launcherSource.includes('Opening the shell anyway'),
  'MWH启动.cmd must still open the shell after preflight failure (Opening the shell anyway)'
);
assert(
  !/taskkill/i.test(launcherSource),
  'MWH启动.cmd must not kill processes by image name (taskkill)'
);
assert(
  mainSource.includes('--ensure-daemon-only'),
  'main.cjs must support the --ensure-daemon-only preflight mode'
);
assert(
  mainSource.includes('PORT_OCCUPIED_UNAUTHORIZED'),
  'main.cjs must report PORT_OCCUPIED_UNAUTHORIZED instead of silently adopting an unauthenticated listener'
);
assert(
  mainSource.includes("'mwh:daemon-status'"),
  'main.cjs must register the mwh:daemon-status IPC handler'
);
assert(
  chromePreloadSource.includes('getDaemonStatus'),
  'chrome-preload.cjs must expose getDaemonStatus so the chrome shell can show an honest daemon banner'
);

/* 14. Honest tunnel lifecycle + env doctor ------------------------------ */

const tunnelsSourceForProbe = read(path.join(root, 'src', 'network', 'tunnels.ts'));
const stateManagerSource = read(path.join(root, 'src', 'network', 'stateManager.ts'));
const pkg = JSON.parse(read(path.join(root, 'package.json')));

assert(
  fs.existsSync(path.join(root, 'scripts', 'doctor.mjs')),
  'missing scripts/doctor.mjs environment doctor'
);
assert(
  Boolean(pkg.scripts && pkg.scripts.doctor),
  'package.json must expose an "npm run doctor" script'
);
assert(
  fs.existsSync(path.join(root, 'scripts', 'verify.mjs')) && Boolean(pkg.scripts && pkg.scripts.verify),
  'missing scripts/verify.mjs or "npm run verify" script'
);
assert(
  mainSource.includes('requestSingleInstanceLock'),
  'main.cjs must enforce requestSingleInstanceLock for interactive shell instances'
);
assert(
  tunnelsSourceForProbe.includes("'.mwh'") && tunnelsSourceForProbe.includes('bin'),
  'cloudflared probe must include the repo-managed <workspace>/.mwh/bin fallback'
);
assert(
  stateManagerSource.includes('QUICK_TUNNEL_START_FAILED'),
  'stateManager must surface QUICK_TUNNEL_START_FAILED instead of answering 200 for a dead tunnel'
);
assert(
  stateManagerSource.includes('TUNNEL_STOP_FAILED'),
  'stateManager must surface TUNNEL_STOP_FAILED when cloudflared survives a stop request'
);

/* 14. Docs Hierarchy, Multi-Language README & Brand SVG Contract -------- */

const docsRoot = path.join(root, 'docs');
assert(fs.existsSync(path.join(docsRoot, 'README.md')), 'missing docs/README.md index');
assert(!fs.existsSync(path.join(docsRoot, 'archive')), 'docs/archive/ is development residue and must not ship');
assert(!fs.existsSync(path.join(docsRoot, 'plans')), 'docs/plans/ must not ship in the public tree');

const docsRootFiles = fs
  .readdirSync(docsRoot, { withFileTypes: true })
  .filter((e) => e.isFile())
  .map((e) => e.name);
for (const name of docsRootFiles) {
  assert(
    !/\d{8}/.test(name),
    `docs/ root must not contain dated temporary/audit snapshot file: ${name}`
  );
}

for (const rel of [
  'README.md',
  'docs/README.md',
  'docs/ARCHITECTURE.md',
  'docs/PAIRING.md',
  'docs/SECURITY_DISCLOSURE.md',
  'docs/UI.md',
  'docs/ADR.md',
  'docs/WORKFLOW_BRANCH_TESTING.md',
  'docs/readme/README_zh.md',
  'docs/readme/README_zh-TW.md',
  'docs/readme/README_ja.md',
  'assets/brand/mwh-logo.svg',
  'assets/brand/mwh-cover.svg',
  'assets/brand/mwh-ui-mockup.svg',
  'frontend/public/favicon.svg',
]) {
  const abs = path.join(root, rel);
  assert(fs.existsSync(abs), `missing required documentation or brand asset: ${rel}`);
  if (fs.existsSync(abs)) {
    const text = read(abs);
    assert(
      !/[DE]:[\\/]+gongju|C:[\\/]+Users[\\/]+666666/i.test(text),
      `${rel} contains leaked private machine path`
    );
    if (rel.endsWith('.svg')) {
      assert(!purplePattern.test(text), `${rel} contains purple colour leftover`);
    }
    if (rel.endsWith('.md')) {
      const dir = path.dirname(abs);
      const linkRe = /(?:!\[[^\]]*\]|\[[^\]]+\])\(([^)#\s]+)(?:#[^)]*)?\)|src="([^"#]+)"|href="([^"#]+)"/g;
      for (const m of text.matchAll(linkRe)) {
        const target = m[1] || m[2] || m[3];
        if (!target || /^(?:https?:|mailto:|data:)/i.test(target)) continue;
        const resolvedLink = path.resolve(dir, target);
        assert(
          fs.existsSync(resolvedLink),
          `broken relative link in ${rel} -> ${target} (resolved: ${path.relative(root, resolvedLink)})`
        );
      }
    }
  }
}

for (const lockRel of ['package-lock.json', 'frontend/package-lock.json', 'shell/package-lock.json']) {
  const lockAbs = path.join(root, lockRel);
  assert(fs.existsSync(lockAbs), `missing lockfile: ${lockRel}`);
  if (fs.existsSync(lockAbs)) {
    const lockText = read(lockAbs);
    for (const m of lockText.matchAll(/"resolved":\s*"([^"]+)"/g)) {
      assert(
        m[1].startsWith('https://registry.npmjs.org/'),
        `${lockRel} contains non-official registry URL: ${m[1]}`
      );
    }
  }
}

/* Report ---------------------------------------------------------------- */

if (failures.length > 0) {
  console.error('[FAIL] UI Contract Gate');
  for (const message of failures) console.error('  - ' + message);
  process.exit(1);
}

console.log('[PASS] UI Contract Gate');
console.log('  syntax: main.cjs, muse-settings-preload.cjs, chrome-preload.cjs');
console.log('  ipc channels aligned: ' + used.size);
console.log('  drawer 320px/20px + subpanel 640px/24px + 4 sections verified');
console.log('  brand palette: zero purple, Muse blue only, single gradient ring spinner');
console.log('  layout: full-screen backdrop + 4-column tab grid + centred activity slot');
console.log('  content admission: human-only UI, zero agent lecture cards or retired CLI refs');
console.log('  truth source: SKILL.example.md + zero private machine path leaks');
console.log('  preflight: launcher verifies daemon (--ensure-daemon-only) before opening the shell');
process.exit(0);
