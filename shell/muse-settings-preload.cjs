/**
 * MWH Muse Settings & Activity Bar In-Page Injection Preload
 *
 * Injects:
 * 1. A first-class MWH icon into Muse.ai's left Activity Bar.
 * 2. The dual-column MWH control surface:
 *    - Primary drawer (.mwh-drawer, 320px, 20px radius) with the four-tier
 *      permission cards, pairing endpoints and the advanced-config-center hero
 *      entry. The five advanced sections (connectors / permissions / daemon /
 *      subagents / snapshots-audit) live only in the companion sub-panel tabs.
 *    - Companion sub-panel (.mwh-subpanel, 640px, 24px radius) with the full
 *      connectors / permissions / daemon / subagents / snapshots-audit sections.
 *    - In-page approval floating island (.mwh-approval-island) driven by liveTask.
 * 3. Millisecond theme tracking via MutationObserver -> mwh:theme-sync.
 *
 * Complies with official security rules:
 * - Zero access to cookies (document.cookie is never read/written)
 * - Zero access to user tokens/credentials/chats
 * - Zero network request interception
 * - Pure UI extension for local host configuration
 * - Zero emojis: all icons are pure vector SVGs
 * - No real Bearer token literal is ever rendered or logged
 */

const { ipcRenderer } = require('electron');

/* ------------------------------------------------------------------ *
 * SVG icon set (no emoji anywhere)
 * ------------------------------------------------------------------ */

const SVG_LOGO = `<svg viewBox="0 0 120 120" width="36" height="36" class="mwh-logo-svg">
  <defs>
    <linearGradient id="mwhGradLarge" x1="100%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#8B5CF6" />
      <stop offset="50%" stop-color="#6366F1" />
      <stop offset="100%" stop-color="#3B82F6" />
    </linearGradient>
    <filter id="mwhGlow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#6366F1" flood-opacity="0.35"/>
    </filter>
  </defs>
  <g transform="rotate(12 60 60)" filter="url(#mwhGlow)">
    <path d="M 30 80 C 40 20, 55 30, 55 60 C 55 90, 70 40, 75 30 C 80 20, 90 50, 95 45"
          fill="none" stroke="url(#mwhGradLarge)" stroke-width="15" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="88" cy="82" r="11" class="mwh-pc-status-dot" fill="url(#mwhGradLarge)" />
  </g>
</svg>`;

const ICON = {
  close:
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  check:
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  copy:
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  shield:
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
  folder:
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
  link:
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
  grid:
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
  hand:
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v6"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2a8 8 0 0 1-8-8v-1a2 2 0 1 1 4 0"/></svg>',
  monitor:
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
  bot:
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="18" height="12" rx="3"/><path d="M12 8V4M8 14h.01M16 14h.01M9 18h6"/></svg>',
  lock:
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  plus:
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  trash:
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>',
  refresh:
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>',
  edit:
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  chevronDown:
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
  chevronRight:
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
  alert:
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>',
  terminal:
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><path d="M12 19h8"/></svg>',
  pin:
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.8V4h6v6.8l3 3.2H6z"/></svg>',
  merge:
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 9v3a6 6 0 0 0 6 6h3"/></svg>',
  rotate:
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
  stop:
    '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>',
  eye:
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff:
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>',
  spinner:
    '<svg class="mwh-spin" viewBox="0 0 24 24" width="14" height="14" fill="none"><defs><linearGradient id="mwhSpinGrad" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#8B5CF6"/><stop offset="50%" stop-color="#6366F1"/><stop offset="100%" stop-color="#A5B4FC" stop-opacity="0.2"/></linearGradient></defs><circle cx="12" cy="12" r="9" stroke="rgba(99,102,241,0.18)" stroke-width="2.4"/><path d="M12 3a9 9 0 0 1 9 9" stroke="url(#mwhSpinGrad)" stroke-width="2.4" stroke-linecap="round"/></svg>',
  checkCircle:
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="16 10 11 15 8 12"/></svg>',
  audit:
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
  help:
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
};

/* ------------------------------------------------------------------ *
 * Permission profile metadata (mirrors frontend/src/services/mwhRules.ts)
 * ------------------------------------------------------------------ */

const PERMISSION_PROFILE_LIST = [
  {
    id: 'plan',
    confinementMode: 'read-only',
    approvalPolicy: 'smart-risk',
    shortLabel: '计划模式',
    cleanTitle: '计划 (只读)',
    tagline: '仅探查不修改',
    dotColor: '#38BDF8',
    title: '计划模式（只读，先计划再改）',
    subtitle:
      '仅允许读取工作区文件、检索代码与只读状态查询，先制定方案再动手，拦截一切文件修改与写入命令。',
    enforcedProtections: [
      '拦截所有文件写入、编辑、重命名与删除调用 (fs_mutate)',
      '仅放行白名单只读探针命令 (git status / git log / git diff / rg / Get-ChildItem)',
      '强制校验物理路径 (realpathSync.native) 阻断 NTFS Junction 与符号链接越界读取',
    ],
    uncoveredBoundaries: [
      '授权工作区目录内的非黑名单明文文件仍可被读取分析',
      '无法执行编译、测试脚本或启动写文件代理',
    ],
  },
  {
    id: 'confirm',
    confinementMode: 'workspace-write',
    approvalPolicy: 'smart-risk',
    shortLabel: '变更前确认',
    cleanTitle: '变更前确认',
    tagline: '写前弹窗确认',
    dotColor: '#6366F1',
    title: '变更前确认（改文件前问 · 默认）',
    subtitle:
      '只读探针静默放行；每次修改文件、运行脚本或拉起代理前均在桌面浮岛询问确认。',
    enforcedProtections: [
      '严格校验 realpath 物理路径，阻断 NTFS Junction 与符号链接越界写入',
      '内置敏感路径硬黑名单：拦截 .env*、~/.ssh、~/.aws、%APPDATA% 与浏览器凭据目录',
      '写文件或执行命令前在底部浮岛弹出确认，批准后自动记录无密钥回执供 Muse 轮询',
      '每次写操作前自动创建 Git Shadow 快照，支持按工作区单条一键回滚',
    ],
    uncoveredBoundaries: [
      '经人工确认放行的工作区脚本在当前登录用户权限下运行，无 OS 内核级虚拟化沙箱',
    ],
  },
  {
    id: 'autonomous',
    confinementMode: 'workspace-write',
    approvalPolicy: 'auto-workspace',
    shortLabel: '自主模式',
    cleanTitle: '自主模式',
    tagline: '自动快照放行',
    dotColor: '#8B5CF6',
    title: '自主模式（有风险才问）',
    subtitle:
      '授权工作区内的常规文件读写自动创建写前快照并静默执行，仅高风险命令或破坏性操作询问确认。',
    enforcedProtections: [
      '保留完整工作区路径围栏 (realpath) 与敏感凭据路径黑名单拦截',
      '工作区内常规 fs_mutate 读写自动前置创建 Git Shadow 影子快照，无需逐次点击确认',
      '高风险命令、强制推送 (git push --force)、递归删除 (rm -rf / Remove-Item -Recurse) 与系统级指令仍强制要求人工确认',
      '所有子进程绑定 Win32 Job Object (JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) + CREATE_NO_WINDOW',
    ],
    uncoveredBoundaries: [
      '授权工作区内的常规代码修改会自动落盘，若需撤销请前往「数据控制」单条回滚快照',
    ],
  },
  {
    id: 'full-access',
    confinementMode: 'danger-full-access',
    approvalPolicy: 'unattended-yolo',
    shortLabel: '完全访问',
    cleanTitle: '完全访问',
    tagline: '跨盘普通放行',
    dotColor: '#E06C60',
    title: '完全访问（减少确认）',
    subtitle:
      '解除工作区目录围栏，跨盘普通文件读写直接执行；仅强制推送、递归删除、磁盘格式化及敏感凭据路径仍需确认。',
    enforcedProtections: [
      '工作区外的普通文件读写、重命名、单文件删除不再因「越界」单独升为 critical，大幅减少打断',
      '真正破坏性操作（强制推送、递归删除、磁盘格式化、系统管理命令）及敏感凭据黑名单路径仍强制要求人工确认',
      '保留 Win32 Job Object 进程树句柄追踪、全局急停、审计日志与 2 小时自动降级保护计时器',
      '左侧活动栏 MWH 状态图标与面板常亮红环警示（不渲染全窗口边框光晕）',
    ],
    uncoveredBoundaries: [
      '已解除工作区目录边界限制，模型可跨盘读写普通目录文件，请仅在受信任任务中开启',
    ],
  },
];

const PERMISSION_PROFILE_MAP = {};
for (const prof of PERMISSION_PROFILE_LIST) PERMISSION_PROFILE_MAP[prof.id] = prof;

function resolvePermissionProfile(mode, policy) {
  if (mode === 'read-only') return 'plan';
  if (mode === 'danger-full-access') return 'full-access';
  if (policy === 'auto-workspace' || policy === 'unattended-yolo') return 'autonomous';
  return 'confirm';
}

function getPermissionProfileMeta(mode, policy) {
  return PERMISSION_PROFILE_MAP[resolvePermissionProfile(mode, policy)];
}

/* ------------------------------------------------------------------ *
 * Snapshot grouping helpers (100% port of MwhSettingsModal.tsx)
 * ------------------------------------------------------------------ */

function normalizeWinPath(rawPath) {
  const trimmed = String(rawPath || '未归类工作区')
    .trim()
    .replace(/\//g, '\\')
    .replace(/\\+$/, '');
  const displayPath = trimmed || '未归类工作区';
  const normKey = displayPath.toLowerCase();
  const segments = displayPath.split('\\').filter(Boolean);
  if (segments.length <= 1) {
    return { normKey, displayPath, parentPrefix: '', folderName: displayPath };
  }
  const folderName = segments[segments.length - 1];
  const parentPrefix = segments.slice(0, -1).join('\\');
  return { normKey, displayPath, parentPrefix, folderName };
}

function parseModifiedFileCount(diffStat) {
  const m = String(diffStat || '').match(/(\d+)\s*files?/i);
  if (m) return Number(m[1]) || 0;
  const cn = String(diffStat || '').match(/(\d+)\s*个文件/);
  return cn ? Number(cn[1]) || 0 : 0;
}

function formatCompactTime(ts) {
  const raw = String(ts || '').trim();
  if (!raw) return '--';
  const d = new Date(raw);
  if (!Number.isNaN(d.getTime())) {
    const pad = (n) => String(n).padStart(2, '0');
    return (
      pad(d.getMonth() + 1) +
      '-' +
      pad(d.getDate()) +
      ' ' +
      pad(d.getHours()) +
      ':' +
      pad(d.getMinutes()) +
      ':' +
      pad(d.getSeconds())
    );
  }
  return raw.length > 19 ? raw.slice(0, 19) : raw;
}

/* ------------------------------------------------------------------ *
 * Pairing artifacts (no live secret) — port of generatePairingArtifacts
 * ------------------------------------------------------------------ */

function generatePairingArtifacts(baseUrl, mode, workspaceRoots, policy, tokenOverride) {
  const cleanUrl = String(baseUrl || '').trim().replace(/\/+$/, '');
  const mcpEndpoint = cleanUrl + '/mcp';
  const restEndpoint = cleanUrl + '/api/v1';
  const profileMeta = getPermissionProfileMeta(mode, policy || 'smart-risk');
  const workspaceDisplay =
    workspaceRoots && workspaceRoots.length > 0 ? workspaceRoots.join(', ') : '当前默认工作区';

  const authHeaderValue = tokenOverride ? `Bearer ${tokenOverride}` : 'Bearer <在连接器页复制 Bearer Token>';

  const mcpJsonConfig = JSON.stringify(
    {
      mcpServers: {
        'muse-windows-host': {
          type: 'streamable-http',
          url: mcpEndpoint,
          headers: { Authorization: authHeaderValue },
          metadata: {
            platform: 'win32-x64',
            permissionProfile: profileMeta.id,
            workspaceRoots: workspaceRoots || [],
          },
        },
      },
    },
    null,
    2
  );

  const skillMarkdownPrompt = `[MWH 配对指令（不含密钥）]
以下为本机 MWH 宿主守护进程的接入信息。请在完成连接器配置后验证是否真正接通：
- Streamable HTTP MCP 端点: ${mcpEndpoint}
- REST API 端点: ${restEndpoint}
- 当前权限档位: ${profileMeta.shortLabel}（${profileMeta.title}）
- 授权工作区: ${workspaceDisplay}

调用与协同规范：
1. 请先调用 pc_status 探测当前隧道状态、权限档位、工作区路径与最近一次审批回执等非秘密字段（切勿读取 .env、Cookie 或任何本地密钥文件）；只有成功返回权限档位 / 工作区 / 隧道状态，才算真正接通。
2. 本指令是模板文本，粘贴它本身不代表已连接。若 pc_status 返回鉴权失败（401/403），请让用户在设置抽屉的「连接器与隧道」复制当前 Bearer Token 并重新填入 Muse 连接器，而不是反复重发本指令。
3. 当工具返回 CONFIRMATION_REQUIRED（含 approvalId）时，请在用户于桌面浮岛点击允许后直接调用 job_control(action="poll", approvalId="<approvalId>") 轮询 CONSUMED 完成回执与输出。
4. 如需用户查看或修改本地配置，请指引用户点击 Muse 左侧导航栏 MWH 图标打开抽屉面板：
   - 查看或复制连接器密钥：连接器与隧道
   - 切换四档权限模式：权限与安全模式
   - 添加或移除授权工作区目录：本地电脑引擎
   - 按工作区查看快照、单条回滚或清理历史记录：快照回滚与审计日志`;

  return { mcpEndpoint, restEndpoint, skillMarkdownPrompt, mcpJsonConfig };
}

function getActiveBaseUrl(settings) {
  const t = settings.tunnel || {};
  const stripHttp = (v) => String(v || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (t.activeDriver === 'cloudflare-quick' && t.cfQuickUrl) return String(t.cfQuickUrl).replace(/\/+$/, '');
  if (t.activeDriver === 'custom-tls' && t.customPublicUrl) return String(t.customPublicUrl).replace(/\/+$/, '');
  if (t.activeDriver === 'cloudflare-named' && t.cfNamedDomain) return 'https://' + stripHttp(t.cfNamedDomain);
  if (t.activeDriver === 'tailscale-funnel') {
    if (t.tailscaleFunnelEnabled && t.tailscaleMagicDns) return 'https://' + stripHttp(t.tailscaleMagicDns);
    if (t.tailscaleIp) return 'http://' + stripHttp(t.tailscaleIp) + ':19820';
    if (t.tailscaleMagicDns) return 'https://' + stripHttp(t.tailscaleMagicDns);
  }
  return 'http://127.0.0.1:19820';
}

/* ------------------------------------------------------------------ *
 * In-page styles
 * ------------------------------------------------------------------ */

const INJECT_STYLE = `
/* ---------- Motion tokens ---------- *
 * 文档真源 docs/DESIGN.md 3.4。挂在 :root 上是为了让遮罩、活动栏等
 * 不在面板子树里的注入元素也能取到；名字统一 mwh- 前缀避免与宿主页面冲突。
 * 组件里禁止再写裸时长/曲线。 */
:root {
  --mwh-dur-fast: 80ms;
  --mwh-dur-base: 150ms;
  --mwh-dur-state: 180ms;
  --mwh-dur-overlay: 220ms;
  --mwh-dur-panel: 240ms;
  --mwh-ease-color: ease;
  --mwh-ease-standard: cubic-bezier(0.16, 1, 0.3, 1);
  --mwh-ease-spring: cubic-bezier(0.22, 1, 0.36, 1);
}

/* ---------- Left Activity Bar ---------- */
.mwh-activity-btn {
  width: 44px !important;
  height: 44px !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  border-radius: 11px !important;
  cursor: pointer !important;
  color: #a1a1aa !important;
  transition: all 0.18s cubic-bezier(0.16, 1, 0.3, 1) !important;
  position: relative !important;
  margin: 0 auto !important;
  flex-shrink: 0 !important;
  user-select: none !important;
  background: transparent !important;
  border: 0 !important;
  outline: none !important;
  padding: 0 !important;
}
.mwh-activity-slot {
  width: 100% !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  flex-shrink: 0 !important;
  padding: 4px 0 !important;
  margin: 0 auto !important;
  box-sizing: border-box !important;
}
.mwh-activity-btn:hover { background: rgba(255, 255, 255, 0.08) !important; transform: scale(1.05) !important; }
.mwh-activity-btn.active { background: rgba(99, 102, 241, 0.18) !important; }
.mwh-activity-dot {
  position: absolute !important;
  left: 2px !important;
  top: 50% !important;
  transform: translateY(-50%) !important;
  width: 3.5px !important;
  height: 16px !important;
  border-radius: 2px !important;
  background: linear-gradient(180deg, #8B5CF6 0%, #6366F1 50%, #3B82F6 100%) !important;
  display: none !important;
}
.mwh-activity-btn.active .mwh-activity-dot { display: block !important; }
.mwh-tooltip {
  position: absolute;
  left: 56px;
  top: 50%;
  transform: translateY(-50%);
  background: #1f2024;
  color: #f4f4f5;
  border: 1px solid rgba(255, 255, 255, 0.1);
  font-size: 11.5px;
  font-weight: 500;
  padding: 4px 8px;
  border-radius: 5px;
  white-space: nowrap;
  pointer-events: none;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  opacity: 0;
  transition: opacity 0.15s ease;
  z-index: 100000;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
.mwh-activity-btn:hover .mwh-tooltip { opacity: 1; }

/* ---------- Shared shell (Opaque glass to block background skeleton bleed) ---------- */
.mwh-drawer,
.mwh-subpanel,
.mwh-approval-island,
.mwh-toast,
.mwh-confirm-card,
.mwh-tour-card {
  /* 取值对齐 muse.ai 官方暗色阶：面板 #1C1D20 / 卡片 #27282C / 内嵌 #1E1F23 / 代码 #141518 */
  --mwh-bg: #1c1d20;
  --mwh-card: #27282c;
  --mwh-card-2: #1e1f23;
  --mwh-code: #141518;
  --mwh-text: #ececee;
  --mwh-text-2: #c4c5cc;
  --mwh-muted: #9e9fa6;
  /* 官方描边是 7% 白，只在面板外框；内部卡片降到 4-5% */
  --mwh-border: rgba(255, 255, 255, 0.07);
  --mwh-subtle: rgba(255, 255, 255, 0.05);
  --mwh-hover: rgba(255, 255, 255, 0.09);
  --mwh-accent-start: #8B5CF6;
  --mwh-accent: #6366F1;
  --mwh-accent-end: #3B82F6;
  --mwh-accent-grad: linear-gradient(135deg, #8B5CF6 0%, #6366F1 50%, #3B82F6 100%);
  --mwh-accent-grad-hover: linear-gradient(135deg, #7C3AED 0%, #4F46E5 50%, #2563EB 100%);
  --mwh-accent-soft: rgba(99, 102, 241, 0.16);
  --mwh-accent-text: #A5B4FC;
  --mwh-status-ok: #38BDF8;
  --mwh-status-ok-text: #7DD3FC;
  --mwh-status-ok-bg: rgba(56, 189, 248, 0.12);
  --mwh-status-warn: #D99B43;
  --mwh-status-warn-text: #EAB364;
  --mwh-status-warn-bg: rgba(234, 179, 100, 0.14);
  --mwh-status-danger: #E06C60;
  --mwh-status-danger-text: #F28B82;
  --mwh-status-danger-bg: rgba(224, 108, 96, 0.15);
  --mwh-shadow: 0 6px 20px 0 rgba(17, 17, 18, 0.45), 0 8px 36px 0 rgba(17, 17, 18, 0.35);
  --mwh-rail: 56px;
  --mwh-gap: 16px;
  --mwh-drawer-w: min(clamp(280px, 25vw, 420px), calc(100vw - var(--mwh-rail) - 320px - var(--mwh-gap) * 2));
  --mwh-subpanel-w: min(640px, calc(100vw - var(--mwh-rail) - var(--mwh-drawer-w) - var(--mwh-gap) * 2));
}
.mwh-drawer.mwh-light,
.mwh-subpanel.mwh-light,
.mwh-approval-island.mwh-light,
.mwh-toast.mwh-light,
.mwh-confirm-card.mwh-light,
.mwh-light .mwh-confirm-card,
.mwh-tour-card.mwh-light,
.mwh-light .mwh-tour-card {
  /* 对齐 muse.ai 官方亮色阶：纸感米白 #F7F6F2 / 面板 #EFECE6 / 内嵌 #E6E4DE */
  --mwh-bg: #efece6;
  --mwh-card: #f7f6f2;
  --mwh-card-2: #e6e4de;
  --mwh-code: #f2f1ec;
  --mwh-text: #1d1d1f;
  --mwh-text-2: #4a4a4f;
  --mwh-muted: #63636a;
  --mwh-border: rgba(0, 0, 0, 0.06);
  --mwh-subtle: rgba(0, 0, 0, 0.04);
  --mwh-hover: rgba(0, 0, 0, 0.07);
  --mwh-accent-soft: rgba(99, 102, 241, 0.12);
  --mwh-accent-text: #4F46E5;
  --mwh-status-ok-text: #0284C7;
  --mwh-status-ok-bg: rgba(14, 165, 233, 0.12);
  --mwh-status-warn-text: #B45309;
  --mwh-status-warn-bg: rgba(217, 119, 6, 0.12);
  --mwh-status-danger-text: #C2410C;
  --mwh-status-danger-bg: rgba(224, 108, 96, 0.14);
  --mwh-shadow: 0 4px 16px 0 rgba(17, 17, 18, 0.12), 0 6px 28px 0 rgba(17, 17, 18, 0.08);
}
.mwh-drawer,
.mwh-drawer *,
.mwh-subpanel,
.mwh-subpanel *,
.mwh-approval-island,
.mwh-approval-island * {
  box-sizing: border-box;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}

/* ---------- Primary drawer ---------- */
.mwh-drawer-backdrop {
  position: fixed;
  /* 遮罩用 overlay 档，比面板略快，视觉上"底先暗、面后到" */
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.35);
  backdrop-filter: blur(4px);
  z-index: 99985;
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--mwh-dur-overlay) var(--mwh-ease-color);
}
.mwh-drawer-backdrop.open {
  opacity: 1;
  pointer-events: auto;
}
.mwh-drawer {
  position: fixed;
  left: var(--mwh-rail);
  top: 12.5vh;
  height: 75vh;
  width: var(--mwh-drawer-w);
  max-width: calc(100vw - var(--mwh-rail) - 24px);
  border-radius: 20px;
  background: var(--mwh-bg);
  border: none;
  box-shadow: var(--mwh-shadow);
  color: var(--mwh-text);
  z-index: 99999;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transform: translateX(calc(-100% - 72px));
  opacity: 0;
  pointer-events: none;
  transition: transform 0.24s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.2s ease;
  user-select: none;
}
.mwh-drawer.open {
  transform: translateX(0);
  opacity: 1;
  pointer-events: auto;
}
.mwh-drawer-header {
  height: 56px;
  flex-shrink: 0;
  padding: 0 14px 0 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--mwh-border);
}
.mwh-drawer-title {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--mwh-text);
  letter-spacing: -0.01em;
}
.mwh-icon-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--mwh-muted);
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.mwh-icon-btn:hover { background: var(--mwh-hover); color: var(--mwh-text); }
.mwh-drawer-body {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  scrollbar-width: none !important;
  -ms-overflow-style: none !important;
}
.mwh-drawer-body::-webkit-scrollbar,
.mwh-subpanel-body::-webkit-scrollbar,
.mwh-scroll::-webkit-scrollbar,
.mwh-snap-rows-container::-webkit-scrollbar {
  display: none !important;
  width: 0 !important;
  height: 0 !important;
}
/* 快照列表 / 审计日志容器：组件内独立滚动，显式细滚动条 */
.mwh-thin-scroll { scrollbar-width: thin; scrollbar-color: var(--mwh-border) transparent; }
.mwh-scroll.mwh-thin-scroll::-webkit-scrollbar {
  display: block !important;
  width: 6px !important;
  height: 6px !important;
}
.mwh-scroll.mwh-thin-scroll::-webkit-scrollbar-thumb {
  background: var(--mwh-border);
  border-radius: 3px;
}
.mwh-scroll.mwh-thin-scroll::-webkit-scrollbar-track { background: transparent; }

/* Horizontal resize handle */
.mwh-resize-handle {
  position: absolute;
  top: 0;
  right: 0;
  width: 6px;
  height: 100%;
  cursor: ew-resize;
  z-index: 10;
  transition: background-color 0.15s ease;
}
.mwh-resize-handle:hover,
.mwh-resize-handle.active {
  background: var(--mwh-accent);
}

/* Integrated PC Connection Dot */
.mwh-pc-status-dot {
  transition: fill 0.25s ease, filter 0.25s ease;
}
.mwh-connected .mwh-pc-status-dot {
  fill: #38BDF8 !important;
  filter: drop-shadow(0 0 4px rgba(56, 189, 248, 0.85));
}
.mwh-disconnected .mwh-pc-status-dot {
  fill: #E06C60 !important;
  filter: drop-shadow(0 0 4px rgba(224, 108, 96, 0.85));
}

/* ---------- Cards & primitives ---------- */
.mwh-card {
  background: var(--mwh-card);
  border: none;
  border-radius: 14px;
  padding: 13px 15px;
}
.mwh-card-flat {
  background: var(--mwh-card-2);
  border: none;
  border-radius: 12px;
  padding: 10px 12px;
}
.mwh-section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--mwh-text);
  margin-bottom: 10px;
}
.mwh-muted { color: var(--mwh-muted); }
.mwh-mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.mwh-hint { font-size: 12px; line-height: 1.55; color: var(--mwh-muted); }
/* 元信息：界面字体 + tabular-nums，不继承行标题的 600 字重。见 DESIGN.md 3.3 */
.mwh-tool-count {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 11px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  line-height: 1.4;
  color: var(--mwh-muted);
  letter-spacing: 0;
  white-space: nowrap;
  flex-shrink: 0;
}
/* 工具名芯片：同一套等宽字体，字号落到 3.3 等宽档（11px），不用 9.5px */
.mwh-tool-chip {
  font-size: 11px;
  font-weight: 400;
  line-height: 1.4;
  padding: 2.5px 8.5px;
  background: rgba(255, 255, 255, 0.06);
}
.mwh-tool-chip .mwh-tool-orig {
  opacity: 0.6;
  font-size: 11px;
  font-weight: 400;
}
.mwh-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}
.mwh-btn {
  border: 0;
  border-radius: 10px;
  padding: 7px 12px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  background: var(--mwh-hover);
  color: var(--mwh-text);
  transition: background-color 0.15s ease, opacity 0.15s ease;
  white-space: nowrap;
  max-width: 100%;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mwh-btn:hover { background: var(--mwh-subtle); opacity: 0.95; }
.mwh-btn-primary { background: var(--mwh-accent-grad); color: #ffffff; }
.mwh-btn-primary:hover { background: var(--mwh-accent-grad-hover); opacity: 1; }
.mwh-btn-danger { background: var(--mwh-status-danger-bg); color: var(--mwh-status-danger-text); }
.mwh-btn-danger:hover { background: rgba(224, 108, 96, 0.24); }
.mwh-btn-ghost { background: var(--mwh-card-2); border: none; }
.mwh-btn:disabled { opacity: 0.4; cursor: default; }
.mwh-btn-switch { min-width: 84px; height: 28px; padding: 0 10px; justify-content: center; }
.mwh-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  font-weight: 500;
  padding: 2.5px 8.5px;
  border-radius: 9999px;
  background: var(--mwh-subtle);
  color: var(--mwh-muted);
  white-space: nowrap;
}
.mwh-pill-accent { background: var(--mwh-accent-soft); color: var(--mwh-accent-text); }
.mwh-pill-green { background: var(--mwh-status-ok-bg); color: var(--mwh-status-ok-text); }
.mwh-pill-amber { background: var(--mwh-status-warn-bg); color: var(--mwh-status-warn-text); }
.mwh-pill-red { background: var(--mwh-status-danger-bg); color: var(--mwh-status-danger-text); }
.mwh-code {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 11.5px;
  background: var(--mwh-card-2);
  border: none;
  border-radius: 10px;
  padding: 9px 10px;
  color: var(--mwh-text-2);
  overflow-x: auto;
  white-space: pre;
  line-height: 1.55;
}
.mwh-truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.mwh-input {
  width: 100%;
  background: var(--mwh-card-2);
  border: none;
  border-radius: 9px;
  padding: 7px 9px;
  color: var(--mwh-text);
  font-size: 11.5px;
  outline: none;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.03);
  transition: box-shadow 0.15s ease, background-color 0.15s ease;
}
.mwh-input:focus,
.mwh-input:focus-visible {
  box-shadow: 0 0 0 1px rgba(99, 102, 241, 0.45), 0 0 0 4px rgba(99, 102, 241, 0.16);
}
.mwh-select {
  background: var(--mwh-card-2);
  border: none;
  border-radius: 8px;
  padding: 5px 7px;
  color: var(--mwh-text);
  font-size: 11px;
  outline: none;
  cursor: pointer;
  transition: box-shadow 0.15s ease;
}
.mwh-select:focus,
.mwh-select:focus-visible {
  box-shadow: 0 0 0 1px rgba(99, 102, 241, 0.45), 0 0 0 4px rgba(99, 102, 241, 0.16);
}
.mwh-check {
  width: 13px;
  height: 13px;
  accent-color: var(--mwh-accent);
  cursor: pointer;
  flex-shrink: 0;
}
/* ---------- Switch：iOS 式布尔开关（规格见 docs/DESIGN.md 4.1） ---------- */
.mwh-switch {
  position: relative;
  flex-shrink: 0;
  display: inline-block;
  width: 46px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 9999px;
  background: var(--mwh-hover);
  cursor: pointer;
  outline: none;
  -webkit-appearance: none;
  appearance: none;
  transition:
    background-color var(--mwh-dur-state) var(--mwh-ease-color),
    transform var(--mwh-dur-fast) var(--mwh-ease-color);
}
.mwh-switch:hover { background: rgba(255, 255, 255, 0.12); }
.mwh-switch:active { transform: scale(0.97); }
.mwh-switch.is-on { background: var(--mwh-accent-grad); }
.mwh-switch.is-on:hover { background: var(--mwh-accent-grad-hover); }
.mwh-switch:focus-visible { box-shadow: 0 0 0 3px var(--mwh-accent-soft); }
.mwh-switch-dot {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 22px;
  height: 22px;
  border-radius: 9999px;
  background: #ffffff;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
  transform: translateX(0);
  transition: transform var(--mwh-dur-state) var(--mwh-ease-standard);
  pointer-events: none;
}
.mwh-switch.is-on .mwh-switch-dot { transform: translateX(18px); }
.mwh-switch:disabled,
.mwh-switch.is-disabled { opacity: 0.45; cursor: not-allowed; transform: none; }
.mwh-light .mwh-switch { background: rgba(0, 0, 0, 0.12); }
.mwh-light .mwh-switch:hover { background: rgba(0, 0, 0, 0.16); }
.mwh-light .mwh-switch.is-on { background: var(--mwh-accent-grad); }
.mwh-light .mwh-switch.is-on:hover { background: var(--mwh-accent-grad-hover); }
/* 开关 + 文字的设置行：整行可点击，文字在左、开关在右 */
.mwh-switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  background: var(--mwh-card-2);
  border: none;
  border-radius: 10px;
  padding: 8px 12px;
  min-height: 44px;
  cursor: pointer;
}
.mwh-switch-row-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--mwh-text);
  line-height: 1.45;
}
.mwh-switch-row-sub {
  font-size: 10.5px;
  color: var(--mwh-muted);
  margin-top: 2px;
  line-height: 1.4;
}
.mwh-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.mwh-pulse {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--mwh-status-ok);
  box-shadow: 0 0 7px rgba(56, 189, 248, 0.75);
}

/* ---------- Permission grid ---------- */
.mwh-mode-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 7px;
}
.mwh-mode-card {
  background: var(--mwh-card-2);
  border: none;
  border-radius: 12px;
  padding: 11px 13px;
  cursor: pointer;
  text-align: left;
  color: var(--mwh-text-2);
  transition: background-color 0.15s ease, box-shadow 0.15s ease;
}
.mwh-mode-card:hover { background: var(--mwh-hover); }
.mwh-mode-card.active { box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.16); background: rgba(255, 255, 255, 0.13); color: var(--mwh-text); }
.mwh-drawer.mwh-light .mwh-mode-card.active, .mwh-subpanel.mwh-light .mwh-mode-card.active { box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.12); background: rgba(0, 0, 0, 0.08); color: var(--mwh-text); }
.mwh-mode-card.active.danger { box-shadow: inset 0 0 0 1.5px var(--mwh-status-danger); background: var(--mwh-status-danger-bg); }
.mwh-mode-name {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 5px;
  font-size: 13px;
  font-weight: 600;
}
.mwh-mode-desc {
  font-size: 11.5px;
  line-height: 1.45;
  color: var(--mwh-muted);
  margin-top: 4px;
}

/* ---------- Endpoint rows ---------- */
.mwh-endpoint-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  background: var(--mwh-card-2);
  border: none;
  border-radius: 10px;
  padding: 8px 11px;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 11.5px;
  color: var(--mwh-muted);
  margin-top: 6px;
}
.mwh-endpoint-row span.mwh-ep-label { flex-shrink: 0; color: var(--mwh-muted); font-size: 11.5px; }

/* ---------- Disclosure styles ---------- */
.mwh-disclosure {
  border: none;
  border-radius: 12px;
  background: var(--mwh-card-2);
  overflow: hidden;
  margin-top: 8px;
  /* <details> 是原生开合，不做高度动画；这里只留背景过渡，别再写 transition: all */
  transition: background-color var(--mwh-dur-base) var(--mwh-ease-color);
}
.mwh-disclosure summary {
  padding: 9px 12px;
  font-size: 11.5px;
  font-weight: 500;
  color: var(--mwh-text-2);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: space-between;
  user-select: none;
}
.mwh-disclosure summary:hover {
  background: var(--mwh-hover);
  color: var(--mwh-text);
}
.mwh-disclosure[open] summary {
  border-bottom: 1px solid var(--mwh-border);
}
.mwh-disclosure-content {
  padding: 10px 12px;
  font-size: 11.5px;
  color: var(--mwh-text-2);
}

/* ---------- Advanced list ---------- */
.mwh-adv-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 9px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 10px;
  padding: 8px 9px;
  cursor: pointer;
  text-align: left;
  color: var(--mwh-text-2);
  transition: background-color 0.15s ease, border-color 0.15s ease;
}
.mwh-adv-item:hover { background: var(--mwh-hover); }
.mwh-adv-item.active { background: var(--mwh-accent-soft); border-color: rgba(99, 102, 241, 0.4); color: var(--mwh-text); }
.mwh-adv-icon {
  width: 26px;
  height: 26px;
  border-radius: 8px;
  background: var(--mwh-subtle);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--mwh-muted);
}
.mwh-adv-item.active .mwh-adv-icon { background: rgba(99, 102, 241, 0.18); color: var(--mwh-accent-text); }
.mwh-adv-text { flex: 1; min-width: 0; }
.mwh-adv-title { font-size: 12px; font-weight: 600; display: block; }
.mwh-adv-sub { font-size: 10.5px; color: var(--mwh-muted); display: block; margin-top: 1px; }

/* ---------- Footer ---------- */
.mwh-drawer-footer {
  flex-shrink: 0;
  border-top: 1px solid var(--mwh-border);
  padding: 9px 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 10.5px;
  color: var(--mwh-muted);
}

/* ---------- Companion sub-panel ---------- */
.mwh-subpanel {
  position: fixed;
  left: calc(var(--mwh-rail) + var(--mwh-drawer-w) + var(--mwh-gap));
  top: 12.5vh;
  height: 75vh;
  width: var(--mwh-subpanel-width, var(--mwh-subpanel-w));
  max-width: calc(100vw - var(--mwh-rail) - var(--mwh-drawer-w) - var(--mwh-gap) * 2);
  border-radius: 24px;
  background: var(--mwh-bg);
  border: none;
  box-shadow: var(--mwh-shadow);
  color: var(--mwh-text);
  z-index: 99998;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transform: translateX(-16px);
  opacity: 0;
  pointer-events: none;
  transition: transform 0.24s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.2s ease;
  user-select: none;
}
.mwh-subpanel.open {
  transform: translateX(0);
  opacity: 1;
  pointer-events: auto;
}
.mwh-subpanel-body {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 16px 20px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  scrollbar-width: none !important;
  -ms-overflow-style: none !important;
}
.mwh-subpanel-body::-webkit-scrollbar {
  display: none !important;
  width: 0 !important;
  height: 0 !important;
}
.mwh-subpanel-header {
  position: sticky;
  top: 0;
  z-index: 2;
  flex-shrink: 0;
  background: var(--mwh-bg);
  border-bottom: 1px solid var(--mwh-border);
  padding: 12px 18px 10px;
  display: flex;
  flex-direction: column;
}
.mwh-subpanel-top-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.mwh-subpanel-tabs-bar {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
  padding-bottom: 2px;
}
.mwh-subpanel-tab-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  gap: 5px;
  padding: 6px 8px;
  border-radius: 8px;
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  background: var(--mwh-subtle);
  border: none;
  color: var(--mwh-muted);
  transition: all 0.15s ease;
  white-space: nowrap;
  overflow: hidden;
  min-width: 0;
}
.mwh-subpanel-tab-btn:hover {
  background: var(--mwh-hover);
  color: var(--mwh-text);
}
.mwh-subpanel-tab-btn.active {
  background: rgba(255, 255, 255, 0.14);
  color: #ffffff;
  font-weight: 600;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.28);
}
.mwh-subpanel.mwh-light .mwh-subpanel-tab-btn.active {
  background: rgba(0, 0, 0, 0.08);
  color: var(--mwh-text);
  box-shadow: none;
}
.mwh-subpanel-title { font-size: 15px; font-weight: 650; letter-spacing: -0.01em; }
.mwh-subpanel-eyebrow {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--mwh-muted);
  margin-bottom: 3px;
}
.mwh-subpanel-body {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 14px 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* ---------- Section content pieces ---------- */
.mwh-grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(118px, 1fr)); gap: 8px; }
.mwh-grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.mwh-driver-card {
  border: 1px solid transparent;
  background: var(--mwh-card-2);
  border-radius: 13px;
  padding: 11px;
  text-align: left;
  cursor: pointer;
  color: var(--mwh-text-2);
  transition: border-color 0.15s ease, background-color 0.15s ease;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  min-height: 84px;
  height: 100%;
}
.mwh-driver-card:hover { border-color: rgba(99, 102, 241, 0.4); }
.mwh-driver-card.active { border-color: var(--mwh-accent); background: var(--mwh-accent-soft); color: var(--mwh-text); }
.mwh-driver-title { font-size: 12px; font-weight: 600; }
.mwh-driver-sub { font-size: 10.5px; color: var(--mwh-muted); margin-top: 3px; line-height: 1.4; }
.mwh-field { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--mwh-muted); }
.mwh-list-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  background: var(--mwh-card-2);
  border: none;
  border-radius: 10px;
  padding: 8px 9px;
}
.mwh-list-col { min-width: 0; flex: 1; }
.mwh-list-title { font-size: 11.5px; font-weight: 600; color: var(--mwh-text); display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.mwh-list-sub { font-size: 10.5px; color: var(--mwh-muted); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mwh-divider { height: 1px; background: var(--mwh-border); margin: 2px 0; }
.mwh-protection-list { display: flex; flex-direction: column; gap: 4px; font-size: 11px; line-height: 1.55; }
.mwh-protection-item { padding-left: 10px; position: relative; color: var(--mwh-text-2); }
.mwh-protection-item::before { content: "-"; position: absolute; left: 0; color: var(--mwh-muted); }
.mwh-green-title { color: var(--mwh-status-ok-text); font-weight: 600; font-size: 11.5px; }
.mwh-amber-title { color: var(--mwh-status-warn-text); font-weight: 600; font-size: 11.5px; }

/* Snapshot groups: 抗挤压弹性盒 + 两行式人类可读卡片体系 */
.mwh-snap-group {
  border: 1px solid var(--mwh-border);
  border-radius: 12px;
  overflow: hidden;
  background: var(--mwh-card-2);
  margin-bottom: 8px;
  flex-shrink: 0;
  min-height: 44px;
  box-sizing: border-box;
}
.mwh-snap-group-head {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  background: transparent;
  border: 0;
  color: var(--mwh-text-2);
  font-size: 12.5px;
  cursor: pointer;
  text-align: left;
  transition: background-color 0.15s ease;
  flex-shrink: 0;
  min-height: 44px;
  height: 44px;
  box-sizing: border-box;
}
.mwh-snap-group-head:hover { background: var(--mwh-hover); }
.mwh-snap-group-head-left {
  display: flex;
  align-items: center;
  gap: 7px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
}
.mwh-snap-group-head-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
}
.mwh-snap-caret { display: inline-flex; align-items: center; flex: 0 0 auto; color: var(--mwh-muted); }
.mwh-snap-folder-ico { display: inline-flex; align-items: center; flex: 0 0 auto; color: var(--mwh-accent-text); }
.mwh-snap-folder { font-weight: 600; color: var(--mwh-text); flex: 0 1 auto; min-width: 0; }
.mwh-snap-parent { font-size: 11px; color: var(--mwh-muted); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; flex: 1; min-width: 0; }
.mwh-snap-count {
  font-size: 11px;
  color: var(--mwh-muted);
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--mwh-subtle);
  border: 1px solid var(--mwh-border);
  white-space: nowrap;
}
.mwh-snap-rows-container {
  padding: 4px 6px 8px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  border-top: 1px solid rgba(255, 255, 255, 0.04);
}
.mwh-snap-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 52px;
  padding: 8px 10px;
  background: var(--mwh-card);
  border: 1px solid rgba(255, 255, 255, 0.04);
  border-radius: 8px;
  transition: background-color 0.12s ease;
  flex-shrink: 0;
  box-sizing: border-box;
}
.mwh-snap-card:hover {
  background: var(--mwh-hover);
}
.mwh-snap-card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}
.mwh-snap-card-main {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
}
.mwh-snap-card-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}
.mwh-snap-reason {
  font-size: 12px;
  font-weight: 600;
  color: var(--mwh-text);
  flex: 1;
  min-width: 0;
}
.mwh-snap-time {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 11px;
  color: var(--mwh-muted);
  white-space: nowrap;
}
.mwh-snap-rollback {
  flex: 0 0 auto;
  padding: 4px 10px;
  font-size: 11.5px;
  font-weight: 500;
  border-radius: 6px;
  white-space: nowrap;
}
.mwh-snap-card-sub {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--mwh-muted);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  padding-left: 24px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mwh-snap-files { color: var(--mwh-accent-text); flex: 0 0 auto; }
.mwh-snap-hash { color: var(--mwh-muted); flex: 0 0 auto; }
.mwh-snap-divider { color: var(--mwh-muted); opacity: 0.5; flex: 0 0 auto; }
.mwh-snap-id { color: var(--mwh-muted); opacity: 0.7; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 1; }
.mwh-snap-more-row {
  padding: 4px 6px;
  text-align: center;
  flex-shrink: 0;
}
.mwh-snap-more-btn {
  background: transparent;
  border: 0;
  font-size: 11.5px;
  color: var(--mwh-accent-text);
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 6px;
}
.mwh-snap-more-btn:hover {
  background: var(--mwh-hover);
  text-decoration: underline;
}

/* Pure Web Confirm Dialog */
.mwh-confirm-dialog-backdrop {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.65);
  backdrop-filter: blur(8px);
  z-index: 100010;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.18s ease;
}
.mwh-confirm-dialog-backdrop.open {
  opacity: 1;
  pointer-events: auto;
}
.mwh-confirm-card {
  width: min(420px, calc(100vw - 32px));
  max-width: min(420px, calc(100vw - 32px));
  background: var(--mwh-bg);
  border: none;
  border-radius: 18px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.6);
  padding: 22px 24px;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  color: var(--mwh-text);
  box-sizing: border-box;
}
.mwh-confirm-icon {
  width: 44px;
  height: 44px;
  border-radius: 12px;
  background: var(--mwh-accent-soft);
  color: var(--mwh-accent);
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 14px;
}
.mwh-confirm-icon.danger {
  background: var(--mwh-status-danger-bg);
  color: var(--mwh-status-danger);
}
.mwh-confirm-title {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 8px;
}
.mwh-confirm-message {
  font-size: 12px;
  line-height: 1.55;
  color: var(--mwh-muted);
  margin-bottom: 20px;
}
.mwh-confirm-actions {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  width: 100%;
}
.mwh-confirm-actions .mwh-btn {
  flex: 1;
  padding: 8px 16px;
  font-size: 12.5px;
  border-radius: 10px;
}

/* Spinner (single gradient ring, smooth rotation) */
@keyframes mwh-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
.mwh-spin {
  animation: mwh-spin 0.75s linear infinite;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transform-origin: center;
}
.mwh-spin-tag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--mwh-accent-text);
}
.mwh-is-loading {
  pointer-events: none !important;
  opacity: 0.7 !important;
}

/* Audit */
.mwh-audit-entry {
  border: 1px solid transparent;
  border-radius: 10px;
  background: var(--mwh-card-2);
  padding: 8px 9px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 10.5px;
}
.mwh-audit-entry.security {
  background: var(--mwh-status-warn-bg);
  border-color: rgba(217, 155, 67, 0.45);
  box-shadow: 0 0 0 1px rgba(217, 155, 67, 0.22);
}
.mwh-audit-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.mwh-audit-tags { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; min-width: 0; }
.mwh-audit-ALLOW { color: var(--mwh-status-ok-text); font-weight: 700; }
.mwh-audit-ASK { color: var(--mwh-status-warn-text); font-weight: 700; }
.mwh-audit-BLOCK { color: var(--mwh-status-danger-text); font-weight: 700; }

/* ---------- Approval island ---------- */
/* 三态：胶囊 / 展开面板 / 隐藏。位置与尺寸由 mwhIslandLayout 通过 CSS 变量 + transform 驱动，
   全程只动 transform 与宽高，不触发页面重排风暴。 */
.mwh-approval-island {
  position: fixed;
  left: 0;
  top: 0;
  width: var(--mwh-island-w, 624px);
  height: var(--mwh-island-h, 384px);
  max-width: calc(100vw - 24px);
  max-height: calc(100vh - 24px);
  border-radius: 20px;
  background: var(--mwh-card-2);
  border: 1px solid var(--mwh-border);
  box-shadow: 0 16px 44px rgba(0, 0, 0, 0.45);
  color: var(--mwh-text);
  z-index: 99997;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  opacity: 0;
  pointer-events: none;
  transform: translate3d(0, 0, 0);
  transition:
    width 0.24s cubic-bezier(0.22, 1, 0.36, 1),
    height 0.24s cubic-bezier(0.22, 1, 0.36, 1),
    border-radius 0.24s cubic-bezier(0.22, 1, 0.36, 1),
    box-shadow 0.24s ease,
    opacity 0.18s ease;
  will-change: transform;
}
.mwh-approval-island.open {
  opacity: 1;
  pointer-events: auto;
}
.mwh-approval-island.is-dragging {
  transition: none;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.1);
}
.mwh-approval-island.is-resizing {
  transition: none;
}
.mwh-approval-island.is-capsule {
  width: 108px !important;
  min-width: 108px !important;
  max-width: 108px !important;
  height: 42px !important;
  min-height: 42px !important;
  max-height: 42px !important;
  border-radius: 999px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.36);
  cursor: pointer;
  box-sizing: border-box !important;
  white-space: nowrap !important;
  overflow: hidden !important;
}
.mwh-island-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 9px;
  height: 52px;
  padding: 0 14px 0 16px;
  cursor: grab;
  user-select: none;
  -webkit-user-select: none;
  touch-action: none;
}
.mwh-island-head:active { cursor: grabbing; }
.mwh-island-head-right { display: flex; align-items: center; gap: 8px; flex: 0 1 auto; min-width: 0; }
.mwh-island-title { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; min-width: 0; }
.mwh-island-meta { font-size: 11.5px; color: var(--mwh-muted); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.mwh-island-body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 0 16px 14px;
}
.mwh-island-foot {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
  row-gap: 6px;
  padding: 0 16px 14px;
}
.mwh-island-code {
  flex: 1 1 auto;
  min-height: 0;
  border-radius: 12px;
  background: var(--mwh-code);
  padding: 10px 12px;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 12px;
  line-height: 1.65;
  color: var(--mwh-text-2);
  /* 关键修复：块级流 + 子项固定行高，避免 flex 收缩把每行压成一条线 */
  display: block;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.mwh-island-line {
  display: block;
  flex: 0 0 auto;
  min-height: 20px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mwh-island-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
.mwh-approval-island .mwh-btn { border-radius: 9999px; padding: 7px 16px; font-size: 12.5px; }
.mwh-island-capsule-label { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; text-align: center; }
.mwh-approval-island.is-capsule .mwh-island-head {
  height: 42px;
  width: 100%;
  box-sizing: border-box;
  padding: 0 12px;
  /* 胶囊态：居中紧凑，状态点与文字居中对称，严禁溢出 */
  justify-content: center;
  align-items: center;
  gap: 7px;
}
.mwh-approval-island.is-capsule .mwh-island-body,
.mwh-approval-island.is-capsule .mwh-island-foot,
.mwh-approval-island.is-capsule .mwh-island-resize,
.mwh-approval-island.is-capsule [data-action="task-kill"],
.mwh-approval-island.is-capsule [data-action="task-dismiss"],
.mwh-approval-island.is-capsule [data-action="task-collapse"],
.mwh-approval-island.is-capsule .mwh-island-meta,
.mwh-approval-island.is-capsule .mwh-island-badge {
  display: none;
}
.mwh-island-resize {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 18px;
  height: 18px;
  cursor: nwse-resize;
  z-index: 2;
  touch-action: none;
}
.mwh-island-resize::after {
  content: '';
  position: absolute;
  right: 4px;
  bottom: 4px;
  width: 9px;
  height: 9px;
  border-radius: 3px;
  background: linear-gradient(135deg, transparent 46%, rgba(255, 255, 255, 0.22) 47%, rgba(255, 255, 255, 0.22) 53%, transparent 54%);
  opacity: 0;
  transition: opacity 0.16s ease;
}
.mwh-approval-island:hover .mwh-island-resize::after,
.mwh-approval-island.is-resizing .mwh-island-resize::after { opacity: 1; }
/* 键盘可见焦点：Muse 蓝 2px 环，只在 :focus-visible 时出现 */
.mwh-approval-island button:focus-visible,
.mwh-drawer button:focus-visible,
.mwh-subpanel button:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.72);
}
@media (prefers-reduced-motion: reduce) {
  /* 动效归零：这是 !important 的白名单用法（见 docs/DESIGN.md 4.8 红线 4）。 */
  .mwh-drawer,
  .mwh-drawer-backdrop,
  .mwh-subpanel,
  .mwh-toast,
  .mwh-confirm-card,
  .mwh-approval-island,
  .mwh-switch,
  .mwh-switch-dot,
  .mwh-switch-row,
  .mwh-btn,
  .mwh-icon-btn,
  .mwh-mode-card,
  .mwh-list-row,
  .mwh-subpanel-tab-btn,
  .mwh-input,
  .mwh-select,
  .mwh-disclosure {
    transition: none !important;
  }
  .mwh-approval-island.mwh-island-pop { animation: none; }
  .mwh-switch:active { transform: none; }
  /* .mwh-spin 属于"加载中"的功能反馈而非装饰动效，减少动效下保留旋转，
     否则界面会显示一个静止的环，看起来像卡死（WCAG 2.3.3 例外）。 */
}

/* 长按触发可拖动态的轻盈微弹提示。必须用 scale 属性：岛用 translate3d 定位，
   transform 动画会覆盖定位矩阵把岛拽回原点。 */
@keyframes mwh-island-pop {
  0% { scale: 1; }
  40% { scale: 1.02; }
  100% { scale: 1; }
}
.mwh-approval-island.mwh-island-pop {
  animation: mwh-island-pop 220ms cubic-bezier(0.22, 1, 0.36, 1) both;
  will-change: scale;
}

/* ---------- Toast ---------- */
.mwh-toast {
  position: fixed;
  left: 50%;
  bottom: 26px;
  transform: translateX(-50%) translateY(6px);
  max-width: min(420px, calc(100vw - 32px));
  background: var(--mwh-card);
  color: var(--mwh-text);
  border: none;
  border-radius: 12px;
  padding: 9px 14px;
  font-size: 11.5px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
  z-index: 100002;
  opacity: 0;
  pointer-events: none;
  transition:
    opacity var(--mwh-dur-base) var(--mwh-ease-spring),
    transform var(--mwh-dur-base) var(--mwh-ease-spring);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
.mwh-toast.open { opacity: 1; transform: translateX(-50%) translateY(0); }

/* ---------- Empty state ---------- */
.mwh-empty {
  border: 1px dashed var(--mwh-border);
  border-radius: 11px;
  padding: 14px;
  text-align: center;
  font-size: 11px;
  color: var(--mwh-muted);
  line-height: 1.6;
}

/* ---------- Spotlight Onboarding Tour (docs/DESIGN.md 4.9) ---------- */
.mwh-tour-overlay {
  position: fixed;
  inset: 0;
  z-index: 100020;
  pointer-events: none;
  opacity: 0;
  transition: opacity var(--mwh-dur-overlay) var(--mwh-ease-color);
}
.mwh-tour-overlay.open {
  opacity: 1;
  pointer-events: auto;
}
.mwh-tour-spotlight {
  position: fixed;
  border-radius: 14px;
  box-shadow: 0 0 0 9999px rgba(10, 11, 14, 0.62), 0 0 0 2px #6366F1;
  pointer-events: none;
  transition:
    top var(--mwh-dur-panel) var(--mwh-ease-standard),
    left var(--mwh-dur-panel) var(--mwh-ease-standard),
    width var(--mwh-dur-panel) var(--mwh-ease-standard),
    height var(--mwh-dur-panel) var(--mwh-ease-standard);
}
.mwh-tour-card {
  position: fixed;
  width: min(360px, calc(100vw - 32px));
  border-radius: 18px;
  background: var(--mwh-bg);
  color: var(--mwh-text);
  box-shadow: var(--mwh-shadow), 0 0 0 1px var(--mwh-border);
  padding: 16px 18px;
  z-index: 100025;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  transition:
    top var(--mwh-dur-panel) var(--mwh-ease-standard),
    left var(--mwh-dur-panel) var(--mwh-ease-standard);
}
.mwh-tour-step-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 9px;
  border-radius: 9999px;
  background: var(--mwh-accent-soft);
  color: var(--mwh-accent-text);
  font-size: 11px;
  font-weight: 600;
}
.mwh-tour-dots {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.mwh-tour-dot {
  width: 6px;
  height: 6px;
  border-radius: 9999px;
  background: var(--mwh-subtle);
  transition: width var(--mwh-dur-state) var(--mwh-ease-standard), background-color var(--mwh-dur-state) var(--mwh-ease-color);
}
.mwh-tour-dot.active {
  width: 18px;
  background: var(--mwh-accent-grad);
}
`;

function injectStyles() {
  if (document.getElementById('mwh-inject-styles')) return;
  const style = document.createElement('style');
  style.id = 'mwh-inject-styles';
  style.textContent = INJECT_STYLE;
  (document.head || document.documentElement).appendChild(style);
}

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

function emptyLiveTask() {
  return {
    id: '',
    status: 'IDLE',
    sourceAgent: 'Muse Cloud MCP',
    worktreeId: '',
    command: '',
    targetPath: '',
    summary: '',
    riskScore: 'LOW',
    stepLabel: '',
    stepIndex: 0,
    totalSteps: 0,
    stdoutLines: [],
    modifiedFilesCount: 0,
    testResultSummary: '',
    changeTracking: 'git-delta',
    snapshotId: '',
    startedAt: '',
  };
}

let cachedRealToken = '';
let isTokenPeeked = false;
let isEndpointPeeked = false;
let peekAutoHideTimer = null;
const PEEK_AUTO_HIDE_MS = 15000;

function clearPeekAutoHideTimer() {
  if (peekAutoHideTimer) {
    clearTimeout(peekAutoHideTimer);
    peekAutoHideTimer = null;
  }
}

function resetPrivacyPeeks() {
  clearPeekAutoHideTimer();
  isTokenPeeked = false;
  isEndpointPeeked = false;
}

function schedulePeekAutoHide() {
  clearPeekAutoHideTimer();
  if (!isTokenPeeked && !isEndpointPeeked) return;
  peekAutoHideTimer = setTimeout(function () {
    peekAutoHideTimer = null;
    if (isTokenPeeked || isEndpointPeeked) {
      isTokenPeeked = false;
      isEndpointPeeked = false;
      scheduleRender(true);
    }
  }, PEEK_AUTO_HIDE_MS);
}

function maskEndpointUrl(rawUrl) {
  const str = String(rawUrl || '').trim();
  if (!str || isEndpointPeeked) return str;
  if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(\/|$)/i.test(str)) {
    return str;
  }
  return str.replace(/^(https?:\/\/)([^/?#]+)(.*)$/i, function (_m, proto, hostPort, rest) {
    const parts = hostPort.split('.');
    if (parts.length >= 2) {
      const sub = parts[0];
      const maskedSub = sub.length <= 4 ? sub.slice(0, 1) + '••••' : sub.slice(0, 3) + '••••' + sub.slice(-2);
      return proto + [maskedSub].concat(parts.slice(1)).join('.') + rest;
    }
    return proto + hostPort.slice(0, 3) + '••••' + rest;
  });
}

const TOUR_STEPS = [
  {
    id: 'activity-entry',
    target: 'tour-activity-entry',
    title: '左栏入口与健康状态',
    body: '点击 Muse 左侧导航栏 MWH 紫蓝徽标随时呼出或收起控制抽屉；徽标右下角圆点实时反映宿主守护与公网隧道连通状态（冰川青蓝为就绪，赤陶珊瑚红为离线）。',
  },
  {
    id: 'permission-modes',
    target: 'tour-permission-modes',
    title: '四档权限与 2 小时自动降级',
    body: '按任务风险一键切换「计划模式（只读） / 变更前确认（默认） / 自主模式（自动快照） / 完全访问（跨盘放行）」。开启完全访问时支持 2 小时自动降级保护。',
  },
  {
    id: 'endpoints-credentials',
    target: 'tour-endpoints-credentials',
    title: '端点防窥脱敏与一键配对',
    body: '公网 MCP/REST 端点与 Bearer Token 默认自动脱敏防截屏泄露（点击眼睛图标可临时查看 15 秒）；点击「复制配对口令」或「复制 MCP JSON」即可一键填入 Muse 连接器。',
  },
  {
    id: 'advanced-center',
    target: 'tour-advanced-center',
    title: '四栏高级配置中心',
    body: '展开右侧伴随子面板，集中管理「连接与权限」、「工作区与代理（目录白名单与 ACP 引擎）」、「资源库（本机 MCP 与 Skill 原地开关）」及「审计日志（Git Shadow 写前快照单条回滚）」。',
  },
  {
    id: 'approval-island',
    target: 'tour-approval-island',
    title: '底部实时审批灵动岛',
    body: '当 Muse 请求修改文件或执行命令时，底部灵动岛会自动展开展示风险等级与目标路径，支持「允许一次 / 本工作区始终允许 / 拒绝」及运行中强杀中止。',
  },
];

async function fetchRealTokenIfNeeded() {
  if (!cachedRealToken) {
    try {
      const res = await invokeDaemon('mwh:get-runtime-token');
      if (res && res.ok && res.token) {
        cachedRealToken = String(res.token).trim();
      }
    } catch {}
    if (!cachedRealToken) {
      try {
        const loopbackRes = await fetch('http://127.0.0.1:19820/api/v1/tunnel/token', { method: 'GET' });
        if (loopbackRes.ok) {
          const json = await loopbackRes.json();
          if (json && json.bearerToken) cachedRealToken = String(json.bearerToken).trim();
        }
      } catch {}
    }
  }
  return cachedRealToken;
}

// Preload real token on script execution
setTimeout(function () {
  fetchRealTokenIfNeeded().catch(function () {});
}, 100);

const state = {
  settings: null,
  drawerOpen: false,
  activeSection: null,
  tourOpen: false,
  tourStepIndex: 0,
  themeDark: true,
  lastThemeSent: null,
  islandAutoExpandedTaskId: null,
  settingsLive: false,
  settingsError: '',
  ui: {
    loadingAction: null,
    snapshotSort: 'newest',
    perGroupLimit: 5,
    collapsedGroups: {},
    collapsedGroupsInitialized: false,
    expandedSnapshotGroups: {},
    selectedSnapshotIds: {},
    auditFilter: 'ALL',
    worktreePages: {},
    requestedSpawnMode: 'workspace-write',
    newWorkspaceInput: '',
    tunnelDraft: null,
    acp: {
      open: false,
      editingId: null,
      id: '',
      displayName: '',
      command: '',
      args: '',
      enabled: true,
      probe: null,
      saving: false,
    },
    resourceForm: {
      open: false,
      editingId: null,
      kind: 'mcp',
      transport: 'stdio',
      id: '',
      displayName: '',
      command: '',
      args: '',
      cwd: '',
      httpUrl: '',
      skillDir: '',
      readonly: false,
      enabled: false,
      probeResult: null,
      probing: false,
      saving: false,
    },
    resourceExpanded: {},
  },
  toastTimer: null,
};

function defaultResourceForm() {
  return {
    open: false,
    editingId: null,
    kind: 'mcp',
    transport: 'stdio',
    id: '',
    displayName: '',
    command: '',
    args: '',
    cwd: '',
    httpUrl: '',
    skillDir: '',
    readonly: false,
    enabled: false,
    probeResult: null,
    probing: false,
    saving: false,
  };
}

function defaultTunnelDraft(settings) {
  const t = settings.tunnel || {};
  return {
    cfNamedDomain: t.cfNamedDomain || '',
    cfNamedToken: '',
    tailscaleIp: t.tailscaleIp || '',
    tailscaleMagicDns: t.tailscaleMagicDns || '',
    customPublicUrl: t.customPublicUrl || '',
  };
}

function normalizeSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const tunnel = Object.assign(
    {
      activeDriver: 'cloudflare-quick',
      bearerToken: '',
      cfNamedDomain: '',
      cfNamedToken: '',
      cfQuickUrl: '',
      cfQuickRunning: false,
      tailscaleIp: '',
      tailscaleMagicDns: '',
      tailscaleFunnelEnabled: false,
      customPublicUrl: '',
      customTlsVerify: true,
    },
    s.tunnel || {}
  );
  const daemon = Object.assign(
    {
      connected: false,
      pid: 0,
      memoryMb: 0,
      createNoWindowActive: true,
      activeJobObjects: 0,
      uptimeSeconds: 0,
      lastWindowAction: null,
    },
    s.daemon || {}
  );
  const resources = Object.assign(
    {
      enabledCount: 0,
      entries: [],
      summary: { enabledCount: 0, mcp: [], skills: [] },
    },
    s.resources || {}
  );
  return {
    confinementMode: s.confinementMode || 'workspace-write',
    approvalPolicy: s.approvalPolicy || 'smart-risk',
    autoDowngradeTwoHours: s.autoDowngradeTwoHours === true,
    autoDowngradeRemainingSec: Number(s.autoDowngradeRemainingSec) || 0,
    workspaceRoots: Array.isArray(s.workspaceRoots) ? s.workspaceRoots.slice() : [],
    alwaysAllowedWorkspaces: Array.isArray(s.alwaysAllowedWorkspaces)
      ? s.alwaysAllowedWorkspaces.slice()
      : [],
    tunnel,
    daemon,
    resources,
    cliSubagents: Array.isArray(s.cliSubagents) ? s.cliSubagents : [],
    acpProfiles: Array.isArray(s.acpProfiles) ? s.acpProfiles : [],
    worktrees: Array.isArray(s.worktrees) ? s.worktrees : [],
    snapshots: Array.isArray(s.snapshots) ? s.snapshots : [],
    auditLogs: Array.isArray(s.auditLogs) ? s.auditLogs : [],
    liveTask: Object.assign(emptyLiveTask(), s.liveTask || {}),
  };
}

function mergePatch(patch) {
  if (!patch || typeof patch !== 'object') return;
  const current = state.settings || normalizeSettings({});
  const next = Object.assign({}, current);
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      current[key] &&
      typeof current[key] === 'object' &&
      !Array.isArray(current[key])
    ) {
      next[key] = Object.assign({}, current[key], value);
    } else {
      next[key] = value;
    }
  }
  state.settings = normalizeSettings(next);
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
    if (ch === '&') return '&amp;';
    if (ch === '<') return '&lt;';
    if (ch === '>') return '&gt;';
    if (ch === '"') return '&quot;';
    return '&#39;';
  });
}

function getSettings() {
  if (!state.settings) state.settings = normalizeSettings({});
  return state.settings;
}

function copyText(text, message) {
  let value = String(text == null ? '' : text);
  if (!value) return;
  if (value.includes('****') && cachedRealToken) {
    value = cachedRealToken;
  }
  try {
    const electron = require('electron');
    if (electron && electron.clipboard && typeof electron.clipboard.writeText === 'function') {
      electron.clipboard.writeText(value);
      showToast(message || '已复制到剪贴板');
      return;
    }
  } catch (_e) {}
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(value).then(
      function () {
        showToast(message || '已复制到剪贴板');
      },
      function () {
        showToast('复制失败，请重试');
      }
    );
  } else {
    showToast('当前环境不支持剪贴板');
  }
}

function showToast(message) {
  const node = document.getElementById('mwh-toast');
  if (!node) return;
  node.textContent = String(message || '');
  node.classList.add('open');
  if (state.toastTimer) clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(function () {
    node.classList.remove('open');
  }, 2200);
}

function remainingText(sec) {
  const total = Math.max(0, Number(sec) || 0);
  return String(Math.floor(total / 60)) + 'm ' + String(total % 60) + 's';
}

/* ------------------------------------------------------------------ *
 * Theme detection & sync
 * ------------------------------------------------------------------ */

/**
 * Parses an rgb()/rgba() string into an opaque luminance sample.
 * Fully transparent backgrounds (rgba(0, 0, 0, 0) / 'transparent') yield null
 * so they are NEVER mistaken for solid black during theme probing.
 */
function parseOpaqueRgb(bgStr) {
  const raw = String(bgStr || '').trim();
  if (!raw || raw === 'transparent') return null;
  const match = raw.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\s*\)/i);
  if (!match) return null;
  const alpha = match[4];
  if (alpha !== undefined && Number(alpha) < 0.08) return null;
  const r = Number(match[1]);
  const g = Number(match[2]);
  const b = Number(match[3]);
  return { r: r, g: g, b: b, lum: (r * 299 + g * 587 + b * 114) / 1000 };
}

function detectAndSyncTheme(forceSend) {
  const html = document.documentElement;
  const body = document.body;
  let dark = null;

  const hasClass = function (el, names) {
    if (!el || !el.classList) return false;
    return names.some(function (n) {
      return el.classList.contains(n);
    });
  };
  const htmlHasLight = hasClass(html, ['light', 'theme-light']);
  const bodyHasLight = hasClass(body, ['light', 'theme-light']);
  const htmlHasDark = hasClass(html, ['dark', 'theme-dark']);
  const bodyHasDark = hasClass(body, ['dark', 'theme-dark']);
  if (htmlHasLight || bodyHasLight) dark = false;
  else if (htmlHasDark || bodyHasDark) dark = true;

  if (dark === null && html) {
    const dt = String(html.dataset.theme || html.dataset.colorScheme || '').toLowerCase();
    if (dt === 'dark') dark = true;
    else if (dt === 'light') dark = false;
  }
  if (dark === null && body) {
    const dt = String(body.dataset.theme || body.dataset.colorScheme || '').toLowerCase();
    if (dt === 'dark') dark = true;
    else if (dt === 'light') dark = false;
  }
  if (dark === null && typeof getComputedStyle === 'function' && html) {
    const cs = String(getComputedStyle(html).colorScheme || '').toLowerCase();
    if (cs.indexOf('dark') !== -1 && cs.indexOf('light') === -1) dark = true;
    else if (cs.indexOf('light') !== -1 && cs.indexOf('dark') === -1) dark = false;
  }

  // Transparent-piercing probe: walk outward through the real host containers.
  if (dark === null && typeof getComputedStyle === 'function') {
    const candidates = [
      document.documentElement,
      document.body,
      document.getElementById('root'),
      document.getElementById('app'),
      document.querySelector('main'),
      document.querySelector('[class*="chat"], [class*="layout"], [class*="main"]'),
    ];
    if (document.body && document.body.children) {
      Array.from(document.body.children).forEach(function (el) {
        if (!el || !el.id && !el.className) return;
        if (el.id && String(el.id).startsWith('mwh-')) return;
        if (String(el.className || '').includes('mwh-')) return;
        candidates.push(el);
      });
    }
    for (const el of candidates) {
      if (!el) continue;
      const rgb = parseOpaqueRgb(getComputedStyle(el).backgroundColor);
      if (rgb) {
        dark = rgb.lum < 150;
        break;
      }
    }
  }

  // Last resort: infer from text colour (dark text implies a light surface).
  if (dark === null && typeof getComputedStyle === 'function') {
    const textNodes = [document.body, document.getElementById('root'), document.getElementById('app')];
    for (const el of textNodes) {
      if (!el) continue;
      const rgb = parseOpaqueRgb(getComputedStyle(el).color);
      if (rgb) {
        dark = rgb.lum >= 128;
        break;
      }
    }
  }

  if (dark === null) {
    if (state.lastThemeSent !== null && state.lastThemeSent !== undefined) dark = state.themeDark;
    else dark = !(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
  }

  const flipped = state.themeDark !== dark;
  state.themeDark = dark;
  applyThemeClass();

  if (forceSend || flipped || state.lastThemeSent !== dark) {
    state.lastThemeSent = dark;
    ipcRenderer.send('mwh:theme-sync', { dark: dark });
  }
}

function applyThemeClass() {
  const targets = [
    document.getElementById('mwh-drawer'),
    document.getElementById('mwh-subpanel'),
    document.getElementById('mwh-approval-island'),
    document.getElementById('mwh-toast'),
    document.getElementById('mwh-confirm-dialog'),
    document.getElementById('mwh-drawer-backdrop'),
    document.getElementById('mwh-activity-btn'),
    document.getElementById('mwh-tour-card'),
  ];
  for (const node of targets) {
    if (!node) continue;
    node.classList.toggle('mwh-light', !state.themeDark);
  }
}

/* ------------------------------------------------------------------ *
 * Rendering: drawer
 * ------------------------------------------------------------------ */

const ADVANCED_SECTIONS = [
  {
    id: 'connectors',
    title: '连接与权限',
    subtitle: '网络隧道与四档权限',
    icon: 'grid',
  },
  {
    id: 'daemon',
    title: '工作区与代理',
    subtitle: '目录白名单与 ACP 引擎',
    icon: 'monitor',
  },
  {
    id: 'resources',
    title: '资源库',
    subtitle: '本机 MCP 与 Skill',
    icon: 'folder',
  },
  {
    id: 'snapshots-audit',
    title: '审计日志',
    subtitle: '影子快照与审计日志',
    icon: 'audit',
  },
];

const DRIVER_LABELS = {
  'cloudflare-named': 'Cloudflare 固定域名',
  'cloudflare-quick': 'Cloudflare 临时隧道',
  'tailscale-funnel': 'Tailscale Funnel',
  'custom-tls': '自定义 TLS 反代',
};

function sectionBadge(id, settings) {
  if (id === 'connectors') return DRIVER_LABELS[settings.tunnel.activeDriver] || settings.tunnel.activeDriver;
  if (id === 'daemon') return settings.workspaceRoots.length + ' 工作区 · ' + settings.acpProfiles.length + ' 代理';
  if (id === 'resources') {
    const count = (settings.resources && settings.resources.summary && typeof settings.resources.summary.enabledCount === 'number')
      ? settings.resources.summary.enabledCount
      : 0;
    return count + ' 个已启用';
  }
  if (id === 'snapshots-audit') return settings.snapshots.length + ' 快照';
  return '';
}

function evaluateMuseConnection(settings) {
  if (!settings) return { connected: false, text: '无服务连接' };
  if (settings.museConnection && typeof settings.museConnection.connected === 'boolean') {
    return {
      connected: settings.museConnection.connected,
      text: settings.museConnection.summary || (settings.museConnection.connected ? '已连接' : '未连接')
    };
  }
  const tunnel = settings.tunnel || {};
  const isTunnelOnline = Boolean(
    (tunnel.cfQuickRunning && tunnel.cfQuickUrl) ||
    (tunnel.activeDriver === 'cloudflare-named' && tunnel.cfNamedDomain) ||
    (tunnel.activeDriver === 'tailscale-funnel' && tunnel.tailscaleFunnelEnabled)
  );
  return {
    connected: isTunnelOnline,
    text: isTunnelOnline ? '公网隧道在线' : '公网隧道未启动'
  };
}

function updatePcStatusDot(connected, statusText) {
  const isConnected = Boolean(connected);
  if (activityBtnEl) {
    activityBtnEl.classList.toggle('mwh-connected', isConnected);
    activityBtnEl.classList.toggle('mwh-disconnected', !isConnected);
    const tooltip = activityBtnEl.querySelector('.mwh-tooltip');
    if (tooltip) {
      tooltip.textContent = isConnected
        ? ('本地宿主 (MWH) · 已连接 PC' + (statusText ? ' · ' + statusText : ''))
        : ('本地宿主 (MWH) · 未连接 PC' + (statusText ? ' · ' + statusText : ''));
    }
  }
}

function attachPanelResize(el, handleSelector, storageKey, minW, maxWGetter) {
  if (!el) return;
  const handle = el.querySelector(handleSelector);
  if (!handle || handle.dataset.bound === '1') return;
  handle.dataset.bound = '1';

  try {
    const saved = localStorage.getItem(storageKey);
    if (saved && parseInt(saved, 10)) el.style.width = saved;
  } catch {}

  let startX = 0;
  let startW = 0;

  const onMouseMove = function (e) {
    const deltaX = e.clientX - startX;
    const maxW = typeof maxWGetter === 'function' ? maxWGetter() : maxWGetter;
    const newW = Math.min(maxW, Math.max(minW, startW + deltaX));
    el.style.width = newW + 'px';
  };

  const onMouseUp = function () {
    handle.classList.remove('active');
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    try {
      localStorage.setItem(storageKey, el.style.width);
    } catch {}
  };

  handle.addEventListener('mousedown', function (e) {
    e.preventDefault();
    e.stopPropagation();
    startX = e.clientX;
    startW = el.getBoundingClientRect().width;
    handle.classList.add('active');
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}

function renderDrawer() {
  const root = document.getElementById('mwh-drawer');
  if (!root) return;
  const settings = getSettings();
  const activeProfile = getPermissionProfileMeta(settings.confinementMode, settings.approvalPolicy);
  const baseUrl = getActiveBaseUrl(settings);
  const t = settings.tunnel || {};
  const isQuick = t.activeDriver === 'cloudflare-quick';
  const isTunnelActive = isQuick ? t.cfQuickRunning : Boolean(baseUrl && baseUrl !== 'http://127.0.0.1:19820');

  const pairing = generatePairingArtifacts(
    baseUrl,
    settings.confinementMode,
    settings.workspaceRoots,
    settings.approvalPolicy,
    cachedRealToken
  );

  const modeCards = PERMISSION_PROFILE_LIST.map(function (prof) {
    const active = activeProfile.id === prof.id;
    const danger = prof.id === 'full-access';
    const isLoading = state.ui.loadingAction === ('switch_mode_' + prof.id);
    return (
      '<button type="button" class="mwh-mode-card' +
      (active ? ' active' : '') +
      (danger ? ' danger' : '') +
      '" data-action="set-profile" data-profile="' +
      prof.id +
      '" title="' + esc(prof.title + '\n' + prof.subtitle) + '">' +
      '<div class="mwh-mode-name"><span>' +
      esc(prof.cleanTitle || prof.shortLabel) +
      '</span>' +
      (isLoading
        ? '<span class="mwh-spin-tag">' + ICON.spinner + '</span>'
        : (active ? '<span style="color:' + (danger ? '#F28B82' : '#A5B4FC') + '">' + ICON.check + '</span>' : '')) +
      '</div>' +
      '<div class="mwh-mode-desc">' +
      esc(prof.tagline || prof.subtitle.slice(0, 10)) +
      '</div>' +
      '</button>'
    );
  }).join('');

  const downgradeBadge = settings.autoDowngradeTwoHours
    ? '<span class="mwh-pill mwh-pill-green" data-countdown title="完全访问 2 小时后自动降级">' +
      ICON.shield +
      '<span>2h 降级 · ' +
      esc(remainingText(settings.autoDowngradeRemainingSec)) +
      '</span></span>'
    : '<span class="mwh-pill">2h 降级已关</span>';

  const daemon = settings.daemon;

  const displayToken = isTokenPeeked
    ? (cachedRealToken || '正在读取...')
    : (t.bearerToken || '未生成');
  const displayMcpEndpoint = state.settingsLive
    ? maskEndpointUrl(pairing.mcpEndpoint || '未拿到端点')
    : '未连接宿主';
  const displayRestEndpoint = state.settingsLive
    ? maskEndpointUrl(pairing.restEndpoint || '未拿到端点')
    : '未连接宿主';

  const tunnelStatusBadge = isTunnelActive
    ? '<span class="mwh-pill mwh-pill-green"><span class="mwh-dot" style="background:#38BDF8"></span><span>公网活跃</span></span>'
    : '<span class="mwh-pill"><span class="mwh-dot" style="background:#71717a"></span><span>仅本地</span></span>';

  const quickTunnelToggleBtn = isQuick
    ? (t.cfQuickRunning
      ? '<button type="button" class="mwh-btn mwh-btn-switch" data-action="stop-quick" title="停止临时隧道" style="font-size:11px">' +
        (state.ui.loadingAction === 'stop_quick' ? ICON.spinner + ' 停止中' : '停止隧道') +
        '</button>'
      : '<button type="button" class="mwh-btn mwh-btn-primary mwh-btn-switch" data-action="respawn-quick" style="font-size:11px">' +
        (state.ui.loadingAction === 'respawn_quick' ? ICON.spinner + ' 拉起中' : '拉起公网隧道') +
        '</button>')
    : '';

  const conn = evaluateMuseConnection(settings);

  root.innerHTML =
    '<div class="mwh-drawer-header">' +
    '<div class="mwh-drawer-title">' +
    SVG_LOGO +
    '<span>本地宿主引擎 (MWH)</span>' +
    '</div>' +
    '<div style="display:flex;align-items:center;gap:4px">' +
    '<button type="button" class="mwh-icon-btn" data-action="open-tour" title="功能使用引导" aria-label="功能使用引导">' +
    ICON.help +
    '</button>' +
    '<button type="button" class="mwh-icon-btn" data-action="close-drawer" title="关闭面板" aria-label="关闭面板">' +
    ICON.close +
    '</button>' +
    '</div>' +
    '</div>' +
    '<div class="mwh-drawer-body">' +
    '<div class="mwh-card" data-tour-id="tour-permission-modes">' +
    '<div class="mwh-section-title">' +
    ICON.shield +
    '<span>权限模式</span>' +
    '<span style="margin-left:auto">' +
    downgradeBadge +
    '</span>' +
    '</div>' +
    '<div class="mwh-mode-grid' + (state.ui.loadingAction ? ' mwh-is-loading' : '') + '">' +
    modeCards +
    '</div>' +
    '</div>' +
    '<div class="mwh-card" data-tour-id="tour-endpoints-credentials">' +
    '<div class="mwh-section-title">' +
    ICON.link +
    '<span>连接端点与凭据</span>' +
    '<span style="margin-left:auto;display:flex;align-items:center;gap:6px">' +
    '<button type="button" class="mwh-icon-btn" style="width:24px;height:24px" data-action="toggle-endpoint-peek" title="' +
    (isEndpointPeeked ? '隐藏完整端点域名' : '临时显示完整端点域名 (15s)') +
    '" aria-label="' +
    (isEndpointPeeked ? '隐藏完整端点域名' : '临时显示完整端点域名') +
    '">' +
    (isEndpointPeeked ? ICON.eyeOff : ICON.eye) +
    '</button>' +
    tunnelStatusBadge +
    quickTunnelToggleBtn +
    '</span>' +
    '</div>' +
    '<div class="mwh-endpoint-row"><span class="mwh-ep-label">MCP</span><span class="mwh-truncate mwh-mono" style="color:var(--mwh-muted)" title="' + esc(displayMcpEndpoint) + '">' +
    esc(displayMcpEndpoint) +
    '</span>' +
    '<button type="button" class="mwh-icon-btn" style="width:24px;height:24px" data-action="copy" data-copy="' +
    esc(pairing.mcpEndpoint) +
    '" title="复制完整 MCP URL">' +
    ICON.copy +
    '</button></div>' +
    '<div class="mwh-endpoint-row"><span class="mwh-ep-label">REST</span><span class="mwh-truncate mwh-mono" style="color:var(--mwh-muted)" title="' + esc(displayRestEndpoint) + '">' +
    esc(displayRestEndpoint) +
    '</span>' +
    '<button type="button" class="mwh-icon-btn" style="width:24px;height:24px" data-action="copy" data-copy="' +
    esc(pairing.restEndpoint) +
    '" title="复制完整 REST URL">' +
    ICON.copy +
    '</button></div>' +
    '<div class="mwh-endpoint-row"><span class="mwh-ep-label">Token</span><span class="mwh-truncate mwh-mono" style="cursor:pointer" data-action="copy-real-token" title="点击直接复制真实 Token">' +
    esc(displayToken) +
    '</span><span style="display:flex;align-items:center;gap:3px">' +
    '<button type="button" class="mwh-icon-btn" style="width:24px;height:24px" data-action="toggle-token-peek" title="' +
    (isTokenPeeked ? '隐藏明文' : '查看完整明文 (15s 自动隐藏)') +
    '">' +
    (isTokenPeeked ? ICON.eyeOff : ICON.eye) +
    '</button>' +
    '<button type="button" class="mwh-icon-btn" style="width:24px;height:24px" data-action="copy-real-token" title="复制完整真实 Token (用于请求头)">' +
    ICON.copy +
    '</button>' +
    '</span></div>' +
    '<div class="mwh-grid-2" style="margin-top:8px">' +
    '<button type="button" class="mwh-btn mwh-btn-primary" data-action="copy-pairing">' +
    ICON.copy +
    '<span>复制配对口令</span></button>' +
    '<button type="button" class="mwh-btn mwh-btn-ghost" data-action="copy-mcp-json">' +
    ICON.copy +
    '<span>复制 MCP JSON</span></button>' +
    '</div>' +
    '</div>' +
    '<div class="mwh-card mwh-adv-hero-card" data-tour-id="tour-advanced-center" data-action="open-advanced-modal" style="cursor:pointer;background:var(--mwh-card-2);border:none;margin-top:8px;transition:all 0.18s ease">' +
    '<div class="mwh-row">' +
    '<div style="display:flex;align-items:center;gap:10px">' +
    '<div class="mwh-adv-hero-icon" style="width:34px;height:34px;border-radius:10px;background:rgba(99,102,241,0.16);color:#A5B4FC;display:flex;align-items:center;justify-content:center">' +
    ICON.grid +
    '</div>' +
    '<div>' +
    '<div style="font-size:13px;font-weight:600;color:var(--mwh-text)">打开高级配置中心</div>' +
    '<div class="mwh-hint" style="font-size:11px;margin-top:2px">连接与权限 · 工作区与代理 · 资源库 · 审计日志</div>' +
    '</div></div>' +
    '<div style="display:flex;align-items:center;gap:6px">' +
    '<span class="mwh-pill" style="font-size:10px">4 个配置域</span>' +
    '<span style="color:var(--mwh-muted)">' +
    ICON.chevronRight +
    '</span>' +
    '</div></div></div>' +
    '</div>' +
    '<div class="mwh-drawer-footer" style="display:flex;flex-direction:column;gap:5px;padding:9px 14px;background:var(--mwh-card-2);border-top:1px solid rgba(255,255,255,0.04)">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;width:100%">' +
    '<span style="display:inline-flex;align-items:center;gap:6px">' +
    '<span class="mwh-pulse"></span><span>' +
    (state.settingsLive && daemon.connected ? '宿主守护就绪' : '宿主未连接') +
    '</span></span>' +
    '<span class="mwh-mono">' +
    (state.settingsLive
      ? 'PID ' +
        esc(daemon.pid || '--') +
        ' · ' +
        esc(typeof daemon.memoryMb === 'number' ? daemon.memoryMb : '--') +
        ' MB'
      : esc(state.settingsError || '一键启动未拉起宿主')) +
    '</span>' +
    '</div>' +
    '<div style="display:flex;align-items:center;justify-content:space-between;width:100%;font-size:11px;color:var(--mwh-muted)">' +
    '<span style="display:inline-flex;align-items:center;gap:6px">' +
    '<span style="width:7px;height:7px;border-radius:50%;background:' + (conn.connected ? '#38BDF8' : '#71717a') + ';display:inline-block;box-shadow:0 0 5px ' + (conn.connected ? 'rgba(56,189,248,0.8)' : 'rgba(113,113,122,0.4)') + '"></span>' +
    '<span>Muse 连通: ' + esc(conn.connected ? '已连通 Muse 连接器' : '待连接 / 未接入') + '</span></span>' +
    '<span class="mwh-mono">' + esc(conn.connected ? 'ONLINE' : 'OFFLINE') + '</span>' +
    '</div>' +
    '</div>';
}

/* ------------------------------------------------------------------ *
 * Rendering: sub-panel sections
 * ------------------------------------------------------------------ */

function renderConnectors(settings) {
  const baseUrl = getActiveBaseUrl(settings);
  const pairing = generatePairingArtifacts(
    baseUrl,
    settings.confinementMode,
    settings.workspaceRoots,
    settings.approvalPolicy,
    cachedRealToken
  );

  const t = settings.tunnel;
  const draft = state.ui.tunnelDraft || defaultTunnelDraft(settings);

  const displayToken = isTokenPeeked
    ? (cachedRealToken || '正在读取...')
    : (t.bearerToken || '未生成');
  const displayMcpEndpoint = maskEndpointUrl(pairing.mcpEndpoint);
  const displayRestEndpoint = maskEndpointUrl(pairing.restEndpoint);

  const drivers = [
    {
      id: 'cloudflare-named',
      title: 'Cloudflare 固定域名',
      sub: 'Named Tunnel · 推荐常驻免配对',
    },
    {
      id: 'cloudflare-quick',
      title: 'Cloudflare 临时隧道',
      sub: 'Quick Tunnel · 现场按需拉起',
    },
    {
      id: 'tailscale-funnel',
      title: 'Tailscale 私网 / Funnel',
      sub: '100.x.y.z 组网与 MagicDNS',
    },
    {
      id: 'custom-tls',
      title: '自定义 TLS / FRP 反代',
      sub: '自有云服务器 / Nginx / FRP 端点',
    },
  ];

  const driverCards = drivers
    .map(function (drv) {
      const active = t.activeDriver === drv.id;
      const isLoading = state.ui.loadingAction === ('set_driver_' + drv.id);
      return (
        '<button type="button" class="mwh-driver-card' +
        (active ? ' active' : '') +
        '" data-action="set-driver" data-driver="' +
        drv.id +
        '">' +
        '<div>' +
        '<div class="mwh-driver-title">' +
        esc(drv.title) +
        '</div>' +
        '<div class="mwh-driver-sub">' +
        esc(drv.sub) +
        '</div>' +
        '</div>' +
        (isLoading
          ? '<span class="mwh-spin-tag" style="margin-top:6px">' + ICON.spinner + ' 正在切换...</span>'
          : (active ? '<div class="mwh-pill mwh-pill-accent" style="margin-top:6px">当前生效</div>' : '')) +
        '</button>'
      );
    })
    .join('');

  let driverForm = '';
  if (t.activeDriver === 'cloudflare-named') {
    const isSaveLoading = state.ui.loadingAction === 'save_tunnel_config';
    driverForm =
      '<div class="mwh-card">' +
      '<div class="mwh-section-title">' +
      ICON.link +
      '<span>Cloudflare Named Tunnel 配置</span>' +
      '</div>' +
      '<div class="mwh-field" style="margin-bottom:7px"><span>固定公网域名 (指向 127.0.0.1:19820)</span>' +
      '<input class="mwh-input mwh-mono" id="mwh-tunnel-domain" data-bind="tunnel.cfNamedDomain" value="' +
      esc(draft.cfNamedDomain) +
      '" placeholder="mwh.example.com" /></div>' +
      '<div class="mwh-field" style="margin-bottom:7px"><span>Cloudflared Connector Token</span>' +
      '<input class="mwh-input mwh-mono" id="mwh-tunnel-token" data-bind="tunnel.cfNamedToken" value="' +
      esc(draft.cfNamedToken) +
      '" placeholder="留空则保持已保存的 Token 不变" /></div>' +
      '<button type="button" class="mwh-btn mwh-btn-primary" data-action="save-tunnel-config">' +
      (isSaveLoading ? ICON.spinner + ' <span>保存中...</span>' : '保存并应用') +
      '</button>' +
      '</div>';
  } else if (t.activeDriver === 'cloudflare-quick') {
    const isRespawnLoading = state.ui.loadingAction === 'respawn_quick';
    const isStopLoading = state.ui.loadingAction === 'stop_quick';
    driverForm =
      '<div class="mwh-card">' +
      '<div class="mwh-row" style="margin-bottom:8px">' +
      '<div><div style="font-size:12px;font-weight:600">Cloudflare Quick Tunnel (临时公网)</div>' +
      '<div class="mwh-hint" style="margin-top:2px">' +
      (t.cfQuickRunning ? '已拉起并转发至 127.0.0.1:19820' : '未拉起 (仅本地监听 127.0.0.1:19820)') +
      '</div></div>' +
      '<div style="display:flex;gap:6px">' +
      (t.cfQuickRunning
        ? '<button type="button" class="mwh-btn mwh-btn-switch" data-action="stop-quick">' +
          (isStopLoading ? ICON.spinner + ' 停止中' : '停止隧道') +
          '</button>'
        : '') +
      '<button type="button" class="mwh-btn mwh-btn-primary mwh-btn-switch" data-action="respawn-quick">' +
      (isRespawnLoading
        ? ICON.spinner + ' <span>拉起中...</span>'
        : (t.cfQuickRunning ? '重新拉起' : '启动临时隧道')) +
      '</button>' +
      '</div></div>' +
      '<div class="mwh-card-flat mwh-mono mwh-truncate">当前域名: ' +
      esc(t.cfQuickUrl || '未开启公网隧道 · 本地 127.0.0.1:19820') +
      '</div>' +
      '</div>';
  } else if (t.activeDriver === 'tailscale-funnel') {
    const isSaveLoading = state.ui.loadingAction === 'save_tunnel_config';
    driverForm =
      '<div class="mwh-card">' +
      '<div class="mwh-section-title">' +
      ICON.link +
      '<span>Tailscale 私网直连与 Funnel 网关</span>' +
      '</div>' +
      '<div class="mwh-grid-2" style="margin-bottom:7px">' +
      '<div class="mwh-field"><span>Tailscale 节点 IP</span>' +
      '<input class="mwh-input mwh-mono" data-bind="tunnel.tailscaleIp" value="' +
      esc(draft.tailscaleIp) +
      '" placeholder="100.x.y.z" /></div>' +
      '<div class="mwh-field"><span>MagicDNS 地址</span>' +
      '<input class="mwh-input mwh-mono" data-bind="tunnel.tailscaleMagicDns" value="' +
      esc(draft.tailscaleMagicDns) +
      '" placeholder="host.tailnet.ts.net" /></div>' +
      '</div>' +
      '<button type="button" class="mwh-btn mwh-btn-primary" data-action="save-tunnel-config">' +
      (isSaveLoading ? ICON.spinner + ' <span>保存中...</span>' : '保存并应用') +
      '</button>' +
      '</div>';
  } else {
    const isSaveLoading = state.ui.loadingAction === 'save_tunnel_config';
    driverForm =
      '<div class="mwh-card">' +
      '<div class="mwh-section-title">' +
      ICON.link +
      '<span>自定义 TLS / FRP 反向代理</span>' +
      '</div>' +
      '<div class="mwh-field" style="margin-bottom:7px"><span>公网 HTTPS 地址</span>' +
      '<input class="mwh-input mwh-mono" data-bind="tunnel.customPublicUrl" value="' +
      esc(draft.customPublicUrl) +
      '" placeholder="https://mwh.example.com" /></div>' +
      '<button type="button" class="mwh-btn mwh-btn-primary" data-action="save-tunnel-config">' +
      (isSaveLoading ? ICON.spinner + ' <span>保存中...</span>' : '保存并应用') +
      '</button>' +
      '</div>';
  }

  return (
    '<div class="mwh-card">' +
    '<div class="mwh-section-title">' +
    ICON.link +
    '<span>服务端点与认证密钥</span>' +
    '<span style="margin-left:auto">' +
    '<button type="button" class="mwh-btn" style="padding:3px 8px;font-size:11px" data-action="toggle-endpoint-peek" title="' +
    (isEndpointPeeked ? '隐藏端点完整域名' : '查看完整端点域名 (15s 自动恢复脱敏)') +
    '">' +
    (isEndpointPeeked ? ICON.eyeOff : ICON.eye) +
    ' <span>' +
    (isEndpointPeeked ? '隐藏端点域名' : '显示完整域名') +
    '</span></button>' +
    '</span>' +
    '</div>' +
    '<div class="mwh-list-row" style="margin-bottom:6px"><span class="mwh-mono mwh-truncate">MCP: ' +
    esc(displayMcpEndpoint) +
    '</span><button type="button" class="mwh-btn" data-action="copy" data-copy="' +
    esc(pairing.mcpEndpoint) +
    '">复制</button></div>' +
    '<div class="mwh-list-row" style="margin-bottom:6px"><span class="mwh-mono mwh-truncate">REST: ' +
    esc(displayRestEndpoint) +
    '</span><button type="button" class="mwh-btn" data-action="copy" data-copy="' +
    esc(pairing.restEndpoint) +
    '">复制</button></div>' +
    '<div class="mwh-list-row"><span class="mwh-mono mwh-truncate">Token: ' +
    esc(displayToken) +
    '</span><span style="display:flex;gap:4px">' +
    '<button type="button" class="mwh-btn" data-action="toggle-token-peek" title="' +
    (isTokenPeeked ? '隐藏明文' : '查看完整明文') +
    '">' +
    (isTokenPeeked ? ICON.eyeOff : ICON.eye) +
    ' <span>' +
    (isTokenPeeked ? '隐藏' : '查看') +
    '</span></button>' +
    '<button type="button" class="mwh-btn" data-action="copy-real-token" title="复制完整真实 Token">' +
    ICON.copy +
    ' <span>复制完整 Token</span></button>' +
    '<button type="button" class="mwh-btn mwh-btn-primary" data-action="rotate-token">' +
    (state.ui.loadingAction === 'rotate_token'
      ? ICON.spinner + ' <span>生成中...</span>'
      : ICON.refresh + ' <span>轮换密钥</span>') +
    '</button></span></div>' +
    '</div>' +
    '<div class="mwh-grid-2">' +
    driverCards +
    '</div>' +
    driverForm +
    '<details class="mwh-disclosure">' +
    '<summary><span>' +
    ICON.grid +
    ' <span style="margin-left:6px">查看 MCP JSON 模板与无密钥配对说明</span></span>' +
    ICON.chevronDown +
    '</summary>' +
    '<div class="mwh-disclosure-content">' +
    '<div class="mwh-hint" style="margin-bottom:10px;font-size:12px">包含宿主 MCP 端点协议规范与协同指引，可一键复制并填入 Muse 连接器</div>' +
    '<div class="mwh-grid-2">' +
    '<button type="button" class="mwh-btn mwh-btn-primary" data-action="copy-pairing">' +
    ICON.copy +
    '<span>复制配对口令</span></button>' +
    '<button type="button" class="mwh-btn mwh-btn-ghost" data-action="copy-mcp-json">' +
    ICON.copy +
    '<span>复制 MCP JSON (含 Token)</span></button>' +
    '</div>' +
    '</div>' +
    '</details>'
  );
}

function renderPermissions(settings) {
  const activeProfile = getPermissionProfileMeta(settings.confinementMode, settings.approvalPolicy);
  const cards = PERMISSION_PROFILE_LIST.map(function (prof) {
    const selected = activeProfile.id === prof.id;
    const danger = prof.id === 'full-access';
    return (
      '<button type="button" class="mwh-driver-card' +
      (selected ? ' active' : '') +
      (danger && selected ? ' danger' : '') +
      '" data-action="set-profile" data-profile="' +
      prof.id +
      '" title="' +
      esc(prof.title + '\n' + prof.subtitle) +
      '" style="' +
      (danger && selected ? 'border-color:#E06C60;background:rgba(224,108,96,0.14)' : '') +
      '">' +
      '<div class="mwh-row">' +
      '<div style="display:flex;align-items:center;gap:7px;min-width:0">' +
      '<span class="mwh-dot" style="background:' +
      prof.dotColor +
      '"></span>' +
      '<span style="font-size:12.5px;font-weight:600">' +
      esc(prof.cleanTitle || prof.shortLabel) +
      '</span></div>' +
      (selected
        ? '<span class="mwh-mono" style="font-size:10.5px;color:' +
          (danger ? '#F28B82' : '#A5B4FC') +
          '">当前生效</span>'
        : '') +
      '</div>' +
      '<div class="mwh-hint" style="margin-top:4px">' +
      esc(prof.tagline || prof.subtitle.slice(0, 12)) +
      '</div>' +
      '</button>'
    );
  }).join('');

  const protections = activeProfile.enforcedProtections
    .map(function (line) {
      return '<div class="mwh-protection-item">' + esc(line) + '</div>';
    })
    .join('');
  const boundaries = activeProfile.uncoveredBoundaries
    .map(function (line) {
      return '<div class="mwh-protection-item">' + esc(line) + '</div>';
    })
    .join('');

  return (
    '<div class="mwh-grid-2" role="radiogroup" aria-label="四档权限模式">' +
    cards +
    '</div>' +
    '<div class="mwh-card">' +
    '<div class="mwh-list-row">' +
    '<div><div style="font-size:12px;font-weight:600">「完全访问」2 小时自动降级</div>' +
    '<div class="mwh-mono mwh-hint" style="margin-top:2px" data-countdown>剩余计时: ' +
    esc(remainingText(settings.autoDowngradeRemainingSec)) +
    '</div></div>' +
    renderSwitchHtml({
      checked: settings.autoDowngradeTwoHours,
      action: 'toggle-auto-downgrade',
      label: '完全访问 2 小时自动降级',
      title: settings.autoDowngradeTwoHours ? '已开启，点击关闭' : '已关闭，点击开启'
    }) +
    '</div>' +
    '</div>' +
    '<details class="mwh-disclosure">' +
    '<summary><span>' +
    ICON.shield +
    ' <span style="margin-left:6px">安全机制与边界如实披露 (No Security Washing)</span></span>' +
    ICON.chevronDown +
    '</summary>' +
    '<div class="mwh-disclosure-content">' +
    '<div class="mwh-green-title" style="margin-bottom:4px">当前生效的保护机制：</div>' +
    '<div class="mwh-protection-list">' +
    protections +
    '</div>' +
    '<div class="mwh-amber-title" style="margin:8px 0 4px">未覆盖边界说明：</div>' +
    '<div class="mwh-protection-list">' +
    boundaries +
    '</div>' +
    '</div>' +
    '</details>'
  );
}

function renderDaemon(settings) {
  const d = settings.daemon;
  const roots = settings.workspaceRoots.length
    ? settings.workspaceRoots
        .map(function (rootPath) {
          return (
            '<div class="mwh-list-row" style="margin-bottom:6px">' +
            '<span class="mwh-mono mwh-truncate">' +
            esc(rootPath) +
            '</span>' +
            '<button type="button" class="mwh-icon-btn" style="color:#F28B82" data-action="workspace-remove" data-path="' +
            esc(rootPath) +
            '" title="移除工作区" aria-label="移除工作区">' +
            ICON.trash +
            '</button>' +
            '</div>'
          );
        })
        .join('')
    : '<div class="mwh-empty">尚未授权任何工作区目录</div>';

  return (
    '<div class="mwh-card">' +
    '<div class="mwh-row">' +
    '<span style="font-size:13px;font-weight:600">Windows 本地守护进程 (mwh-daemon.exe)</span>' +
    '<span class="mwh-mono" style="font-size:11px;color:' +
    (d.connected ? '#7DD3FC' : '#9A9BA4') +
    '">' +
    (d.connected ? '在线 (127.0.0.1:19820)' : '离线 · 未连接本地守护进程') +
    '</span>' +
    '</div>' +
    '<div class="mwh-grid-3" style="margin-top:9px">' +
    '<div class="mwh-card-flat"><div class="mwh-hint">进程 PID / 内存</div><div class="mwh-mono" style="font-size:12px;font-weight:600;margin-top:2px">#' +
    esc(d.pid || '--') +
    ' · ' +
    esc(d.memoryMb || 0) +
    ' MB</div></div>' +
    '<div class="mwh-card-flat"><div class="mwh-hint">静默无黑框标志</div><div class="mwh-mono" style="font-size:12px;font-weight:600;margin-top:2px">' +
    (d.createNoWindowActive ? 'CREATE_NO_WINDOW' : '未启用') +
    '</div></div>' +
    '<div class="mwh-card-flat"><div class="mwh-hint">活跃 Job Object 树</div><div class="mwh-mono" style="font-size:12px;font-weight:600;margin-top:2px">' +
    esc(d.activeJobObjects || 0) +
    ' 个受控句柄</div></div>' +
    '</div>' +
    '<button type="button" class="mwh-btn mwh-btn-danger" style="width:100%;margin-top:9px;padding:9px" data-action="emergency-kill">' +
    ICON.alert +
    '<span>全局急停（终止所有 Win32 Job Object 进程树）</span></button>' +
    '</div>' +
    '<div class="mwh-card">' +
    '<div class="mwh-section-title">' +
    ICON.folder +
    '<span>授权工作区目录白名单 (Workspace Roots)</span>' +
    '</div>' +
    '<div class="mwh-hint" style="margin-bottom:8px">计划模式 / 变更前确认 / 自主模式下仅允许写访问以下物理路径；完全访问下跨目录普通读写不额外标为高危</div>' +
    '<div style="display:flex;gap:6px;margin-bottom:8px">' +
    '<input class="mwh-input mwh-mono" id="mwh-new-workspace" data-bind="ws-input" value="' +
    esc(state.ui.newWorkspaceInput) +
    '" placeholder="输入本地绝对路径，例如 E:\\Workspace\\MyRustApp" aria-label="新增授权工作区路径" />' +
    '<button type="button" class="mwh-btn mwh-btn-primary" data-action="workspace-add">' +
    ICON.plus +
    '<span>添加目录</span></button>' +
    '</div>' +
    '<div>' +
    roots +
    '</div>' +
    '</div>'
  );
}

function renderSubagents(settings) {
  const acp = state.ui.acp;
  const acpRows = settings.acpProfiles.length
    ? settings.acpProfiles
        .map(function (profile) {
          const enabled = profile.enabled !== false;
          return (
            '<div class="mwh-list-row" style="margin-bottom:6px">' +
            '<div class="mwh-list-col">' +
            '<div class="mwh-list-title">' +
            esc(profile.display_name || profile.id) +
            '<span class="mwh-pill">' +
            esc(profile.id) +
            '</span>' +
            '<span class="mwh-mono" style="font-size:10px;color:' +
            (profile.detected ? '#7DD3FC' : '#EAB364') +
            '">' +
            (profile.detected ? '可执行文件就绪' : '未找到可执行文件') +
            '</span>' +
            (enabled ? '' : '<span class="mwh-pill">已停用</span>') +
            '</div>' +
            '<div class="mwh-list-sub mwh-mono">命令: ' +
            esc(profile.binaryPath || profile.command || '') +
            (profile.args && profile.args.length
              ? ' · 参数: ' + esc(profile.args.join(' '))
              : '') +
            '</div></div>' +
            '<div style="display:flex;gap:4px;align-items:center">' +
            renderSwitchHtml({
              checked: enabled,
              action: 'acp-toggle',
              id: profile.id,
              label: (enabled ? '停用 ' : '启用 ') + (profile.display_name || profile.id),
              title: enabled ? '已启用，点击停用' : '已停用，点击启用'
            }) +
            '<button type="button" class="mwh-icon-btn" data-action="acp-edit" data-id="' +
            esc(profile.id) +
            '" title="编辑 ACP 代理">' +
            ICON.edit +
            '</button>' +
            '<button type="button" class="mwh-icon-btn" style="color:#F28B82" data-action="acp-delete" data-id="' +
            esc(profile.id) +
            '" title="删除 ACP 代理">' +
            ICON.trash +
            '</button>' +
            '</div></div>'
          );
        })
        .join('')
    : '<div class="mwh-empty">暂无自定义 ACP 代理。添加后支持路径探测、按档案独立启停与 Worktree 隔离运行。</div>';

  let acpForm = '';
  if (acp.open) {
    let probeBlock = '';
    if (acp.probe && acp.probe.tested) {
      probeBlock = acp.probe.available
        ? '<div class="mwh-card-flat mwh-mono" style="margin-top:5px;color:#7DD3FC">可执行文件已就绪: ' +
          esc(acp.probe.path || '') +
          '</div>'
        : '<div class="mwh-card-flat mwh-mono" style="margin-top:5px;color:#EAB364">未找到可执行文件 (' +
          esc(acp.probe.error || '检查路径拼写') +
          ')</div>';
    }
    acpForm =
      '<div class="mwh-card" style="margin-top:8px">' +
      '<div class="mwh-row" style="margin-bottom:8px">' +
      '<div style="font-size:12.5px;font-weight:600">' +
      (acp.editingId ? '编辑 ACP 代理' : '添加自定义 ACP 代理') +
      '</div>' +
      '<button type="button" class="mwh-icon-btn" data-action="acp-cancel">' +
      ICON.close +
      '</button></div>' +
      '<div class="mwh-field" style="margin-bottom:6px"><span>代理标识 (ID)</span>' +
      '<input class="mwh-input mwh-mono" data-bind="acp.id" value="' +
      esc(acp.id) +
      '" placeholder="例如: codebuddy" ' +
      (acp.editingId ? 'disabled' : '') +
      ' /></div>' +
      '<div class="mwh-field" style="margin-bottom:6px"><span>显示名称 (Display Name)</span>' +
      '<input class="mwh-input" data-bind="acp.name" value="' +
      esc(acp.displayName) +
      '" placeholder="例如: CodeBuddy 助手" /></div>' +
      '<div class="mwh-field" style="margin-bottom:6px">' +
      '<div class="mwh-row"><span>可执行文件路径 (Command)</span>' +
      '<button type="button" class="mwh-btn" style="padding:2px 7px" data-action="acp-probe">探测路径</button></div>' +
      '<input class="mwh-input mwh-mono" data-bind="acp.command" value="' +
      esc(acp.command) +
      '" placeholder="例如: D:\\tools\\node.exe 或 node" />' +
      probeBlock +
      '</div>' +
      '<div class="mwh-field" style="margin-bottom:6px"><span>启动参数 (Args)</span>' +
      '<input class="mwh-input mwh-mono" data-bind="acp.args" value="' +
      esc(acp.args) +
      '" placeholder="以空格分隔，例如: C:\\path\\to\\agent.js --acp" /></div>' +
      '<div style="margin-bottom:8px">' +
      renderSwitchRow({
        bind: 'acp.enabled',
        checked: acp.enabled,
        label: '立即启用此代理',
        title: '保存后立即参与代理调度'
      }) +
      '</div>' +
      '<div class="mwh-row" style="justify-content:flex-end">' +
      '<button type="button" class="mwh-btn" data-action="acp-cancel">取消</button>' +
      '<button type="button" class="mwh-btn mwh-btn-primary" data-action="acp-save">' +
      (acp.saving ? '保存中...' : '保存并生效') +
      '</button></div>' +
      '</div>';
  }

  const worktreeRows = settings.worktrees.length
    ? settings.worktrees
        .map(function (wt) {
          const pages = Array.isArray(wt.stdoutPages) && wt.stdoutPages.length ? wt.stdoutPages : [[]];
          const pageIdx = state.ui.worktreePages[wt.id] || 0;
          const currentLines = pages[pageIdx] || pages[0] || [];
          const lines = currentLines
            .map(function (line) {
              return '<div class="mwh-truncate">' + esc(line) + '</div>';
            })
            .join('');
          const canMerge = wt.status !== 'MERGED' && wt.status !== 'MISSING';
          return (
            '<div class="mwh-card-flat" style="margin-bottom:7px">' +
            '<div class="mwh-row" style="flex-wrap:wrap;align-items:flex-start">' +
            '<div class="mwh-mono mwh-hint mwh-truncate" style="flex:1">' +
            '<span style="color:#A5B4FC;font-weight:600">' +
            esc(wt.id) +
            '</span> · ' +
            esc(wt.branchName || '') +
            ' · 代理: ' +
            esc(wt.agentId || '') +
            ' · 生效: ' +
            esc(wt.childMode || '') +
            '</div>' +
            '<div style="display:flex;gap:4px">' +
            (canMerge
              ? '<button type="button" class="mwh-btn mwh-btn-primary" data-action="worktree-merge" data-id="' +
                esc(wt.id) +
                '">' +
                ICON.merge +
                '<span>合并回主分支</span></button>'
              : '') +
            (wt.status === 'MISSING'
              ? '<span class="mwh-pill mwh-pill-amber">已清理 (MISSING)</span>'
              : '') +
            '<button type="button" class="mwh-btn mwh-btn-danger" data-action="worktree-remove" data-id="' +
            esc(wt.id) +
            '">清理分支</button>' +
            '</div></div>' +
            '<div class="mwh-card mwh-mono mwh-scroll" style="margin:6px 0 0;border-radius:8px;padding:6px 8px;font-size:10.5px;max-height:96px;overflow-y:auto">' +
            (lines || '<div class="mwh-muted">暂无输出</div>') +
            '</div>' +
            (pages.length > 1
              ? '<div class="mwh-row" style="justify-content:flex-end;margin-top:5px;font-size:10.5px" >' +
                '<span class="mwh-mono mwh-muted">输出流分页 ' +
                (pageIdx + 1) +
                '/' +
                pages.length +
                '</span>' +
                '<button type="button" class="mwh-btn" data-action="worktree-page" data-id="' +
                esc(wt.id) +
                '">切换分页</button></div>'
              : '') +
            '</div>'
          );
        })
        .join('')
    : '<div class="mwh-empty">暂无隔离 Worktree 分支</div>';

  return (
    '<div class="mwh-card">' +
    '<div class="mwh-row" style="margin-bottom:8px">' +
    '<div><div class="mwh-section-title" style="margin:0">' +
    ICON.bot +
    '<span>自定义 ACP 代理</span>' +
    '<span class="mwh-pill mwh-pill-accent">Agent Client Protocol</span></div>' +
    '<div class="mwh-hint" style="margin-top:3px">全局通用配置 (%USERPROFILE%\\.mwh\\acp-profiles.json) · 可按档案独立启停 · 实时热更新</div></div>' +
    '<button type="button" class="mwh-btn mwh-btn-primary" data-action="acp-open-create">' +
    ICON.plus +
    '<span>添加 ACP 代理</span></button>' +
    '</div>' +
    acpRows +
    acpForm +
    '</div>' +
    '<div class="mwh-card">' +
    '<div class="mwh-row" style="margin-bottom:9px;flex-wrap:wrap">' +
    '<div><div style="font-size:12.5px;font-weight:600">Git Worktree 并发隔离分支池 (代理权限 &lt;= 父权限)</div>' +
    '<div class="mwh-hint">当前父级档位：' +
    esc(getPermissionProfileMeta(settings.confinementMode, settings.approvalPolicy).shortLabel) +
    '</div></div>' +
    '<div style="display:flex;gap:6px;align-items:center">' +
    '<select class="mwh-select" id="mwh-worktree-mode" data-action-change="worktree-mode" aria-label="选择请求的代理模式">' +
    '<option value="read-only"' +
    (state.ui.requestedSpawnMode === 'read-only' ? ' selected' : '') +
    '>只读 (计划模式)</option>' +
    '<option value="workspace-write"' +
    (state.ui.requestedSpawnMode === 'workspace-write' ? ' selected' : '') +
    '>工作区读写 (变更前确认 / 自主)</option>' +
    '<option value="danger-full-access"' +
    (state.ui.requestedSpawnMode === 'danger-full-access' ? ' selected' : '') +
    '>完全访问</option>' +
    '</select>' +
    '<button type="button" class="mwh-btn mwh-btn-primary" data-action="worktree-spawn">新建隔离 Worktree</button>' +
    '</div></div>' +
    worktreeRows +
    '</div>'
  );
}

function renderSnapshotsAudit(settings) {
  try {
    const snapshots = settings.snapshots || [];
    const sortMode = state.ui.snapshotSort || 'newest';
    const perGroupLimit = state.ui.perGroupLimit || 5;
    const collapsed = state.ui.collapsedGroups || {};
    const selected = state.ui.selectedSnapshotIds || {};

  // Filter out temporary test directories so they don't pollute the snapshot tree
  const cleanSnapshots = snapshots.filter(function (snap) {
    const p = String(snap.workspacePath || '').toLowerCase();
    if (p.includes('\\appdata\\local\\temp') || p.includes('/appdata/local/temp')) return false;
    if (p.includes('mwh_ext_test_')) return false;
    return true;
  });
  const effectiveSnapshots = cleanSnapshots.length > 0 ? cleanSnapshots : snapshots;

  const indexed = effectiveSnapshots.map(function (snap, idx) {
    return { snap: snap, idx: idx };
  });
  indexed.sort(function (a, b) {
    if (sortMode === 'files-desc') {
      const diff = parseModifiedFileCount(b.snap.diffStat) - parseModifiedFileCount(a.snap.diffStat);
      if (diff !== 0) return diff;
    }
    const ta = Date.parse(a.snap.timestamp);
    const tb = Date.parse(b.snap.timestamp);
    if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb) {
      return sortMode === 'oldest' ? ta - tb : tb - ta;
    }
    return sortMode === 'oldest' ? b.idx - a.idx : a.idx - b.idx;
  });

  const groupMap = new Map();
  const groupOrder = [];
  for (const entry of indexed) {
    const info = normalizeWinPath(entry.snap.workspacePath);
    let group = groupMap.get(info.normKey);
    if (!group) {
      group = {
        normKey: info.normKey,
        displayPath: info.displayPath,
        parentPrefix: info.parentPrefix,
        folderName: info.folderName,
        items: [],
      };
      groupMap.set(info.normKey, group);
      groupOrder.push(group);
    }
    group.items.push(entry.snap);
  }

  // 首次渲染只展开最近活跃（排序后第一个）目录，其余折叠；之后尊重用户手动展开/折叠状态
  if (groupOrder.length > 0 && !state.ui.collapsedGroupsInitialized) {
    state.ui.collapsedGroupsInitialized = true;
    for (let i = 1; i < groupOrder.length; i += 1) {
      collapsed[groupOrder[i].normKey] = true;
    }
  }

  // 「当前可见」必须与真正渲染出来的行严格一致，否则「全选当前可见」会选中屏幕上不存在的记录
  const visibleIds = [];
  for (const group of groupOrder) {
    if (collapsed[group.normKey]) continue;
    for (const snap of snapshotVisibleItems(group)) visibleIds.push(snap.id);
  }
  const existingIds = new Set(effectiveSnapshots.map(function (s) { return s.id; }));
  const activeSelected = Object.keys(selected).filter(function (id) {
    return selected[id] && existingIds.has(id);
  });
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every(function (id) { return Boolean(selected[id]); });

  const allCollapsed =
    groupOrder.length > 0 &&
    groupOrder.every(function (group) {
      return Boolean(collapsed[group.normKey]);
    });

  const groupHtml = groupOrder.length
    ? groupOrder
        .map(function (group) {
          const isCollapsed = Boolean(collapsed[group.normKey]);
          const limitedItems = snapshotVisibleItems(group);
          const remainingCount = group.items.length - limitedItems.length;

          const rows = limitedItems
            .map(function (snap) {
              const checked = Boolean(selected[snap.id]);
              const shortHash = String(snap.treeHash || '').slice(0, 8);
              const compactTime = formatCompactTime(snap.timestamp);
              const isRollbackLoading = state.ui.loadingAction === ('rollback_' + snap.id);
              const fileCount = parseModifiedFileCount(snap.diffStat);
              return (
                '<div class="mwh-snap-card">' +
                '<div class="mwh-snap-card-top">' +
                '<div class="mwh-snap-card-main">' +
                '<input type="checkbox" class="mwh-check" data-action-change="snapshot-select" data-id="' +
                esc(snap.id) +
                '" ' +
                (checked ? 'checked' : '') +
                ' aria-label="选择快照 ' +
                esc(snap.id) +
                '" />' +
                '<span class="mwh-snap-reason mwh-truncate" title="' +
                esc(snap.triggerReason || '写入前快照') +
                '">' +
                esc(snap.triggerReason || '写入前快照') +
                '</span></div>' +
                '<div class="mwh-snap-card-actions">' +
                '<span class="mwh-snap-time">' +
                esc(compactTime) +
                '</span>' +
                '<button type="button" class="mwh-btn mwh-snap-rollback" data-action="snapshot-rollback" data-id="' +
                esc(snap.id) +
                '" style="' +
                (snap.rolledBack ? 'background:rgba(56,189,248,0.14);color:#7DD3FC' : '') +
                '">' +
                (isRollbackLoading
                  ? ICON.spinner + '<span>回滚中...</span>'
                  : (snap.rolledBack
                      ? ICON.checkCircle + '<span>已回滚</span>'
                      : ICON.rotate + '<span>回滚此快照</span>')) +
                '</button></div></div>' +
                '<div class="mwh-snap-card-sub">' +
                '<span class="mwh-snap-files" title="' +
                esc(snap.diffStat || '') +
                '">' +
                fileCount +
                ' 个文件变动</span>' +
                '<span class="mwh-snap-divider">·</span>' +
                '<span class="mwh-snap-hash" title="Git Tree Hash: ' +
                esc(snap.treeHash || '') +
                '">#' +
                esc(shortHash) +
                '</span>' +
                '<span class="mwh-snap-divider">·</span>' +
                '<span class="mwh-snap-id" title="' +
                esc(snap.id) +
                '">' +
                esc(snap.id) +
                '</span></div></div>'
              );
            })
            .join('');

          return (
            '<div class="mwh-snap-group">' +
            '<button type="button" class="mwh-snap-group-head" data-action="snapshot-toggle-group" data-key="' +
            esc(group.normKey) +
            '">' +
            '<div class="mwh-snap-group-head-left">' +
            '<span class="mwh-snap-caret">' +
            (isCollapsed ? ICON.chevronRight : ICON.chevronDown) +
            '</span>' +
            '<span class="mwh-snap-folder-ico">' +
            ICON.folder +
            '</span>' +
            '<span class="mwh-snap-folder mwh-truncate" title="' +
            esc(group.displayPath) +
            '">' +
            esc(group.folderName) +
            '</span>' +
            (group.parentPrefix
              ? '<span class="mwh-snap-parent mwh-truncate" title="' +
                esc(group.displayPath) +
                '">' +
                esc(group.parentPrefix) +
                '</span>'
              : '') +
            '</div>' +
            '<div class="mwh-snap-group-head-right">' +
            '<span class="mwh-snap-count">' +
            (perGroupLimit > 0 && limitedItems.length < group.items.length
              ? limitedItems.length + '/' + group.items.length + ' 条'
              : group.items.length + ' 条') +
            '</span></div></button>' +
            (isCollapsed
              ? ''
              : '<div class="mwh-snap-rows-container">' +
                rows +
                (remainingCount > 0
                  ? '<div class="mwh-snap-more-row"><button type="button" class="mwh-snap-more-btn" data-action="snapshot-show-all-group" data-key="' +
                    esc(group.normKey) +
                    '">查看该目录下其余 ' +
                    remainingCount +
                    ' 条快照...</button></div>'
                  : '') +
                '</div>') +
            '</div>'
          );
        })
        .join('')
    : '<div class="mwh-empty">暂无写前影子快照记录</div>';

  const auditFilter = state.ui.auditFilter;
  const auditRows = settings.auditLogs
    .filter(function (item) {
      return auditFilter === 'ALL' || item.decision === auditFilter;
    })
    .map(function (entry) {
      const isSecurity =
        entry.toolName === 'switch_mode' ||
        entry.toolName === 'auto_downgrade' ||
        entry.toolName === 'approval_policy';
      const decisionClass = 'mwh-audit-' + String(entry.decision || 'ALLOW');
      return (
        '<div class="mwh-audit-entry' +
        (isSecurity ? ' security' : '') +
        '">' +
        '<div class="mwh-audit-head">' +
        '<div class="mwh-audit-tags">' +
        '<span class="' +
        decisionClass +
        '">[' +
        esc(entry.decision || '') +
        ']</span>' +
        '<span style="font-weight:600">' +
        esc(entry.toolName || '') +
        '</span>' +
        (entry.toolName === 'switch_mode'
          ? '<span class="mwh-pill mwh-pill-amber">模式变更</span>'
          : '') +
        '<span class="mwh-pill">来源: ' +
        esc(entry.actor || '') +
        '</span></div>' +
        '<span class="mwh-hint mwh-mono">' +
        esc(formatCompactTime(entry.timestamp)) +
        '</span></div>' +
        '<div class="mwh-truncate">' +
        esc(entry.commandOrPath || '') +
        '</div>' +
        '<div class="mwh-hint mwh-truncate">' +
        esc(entry.reason || '') +
        '</div></div>'
      );
    })
    .join('');

  const limitOptions = [
    { value: 3, label: '每目录最近 3 次' },
    { value: 5, label: '每目录最近 5 次' },
    { value: 10, label: '每目录最近 10 次' },
    { value: 0, label: '显示全部 (' + snapshots.length + ')' },
  ]
    .map(function (opt) {
      return (
        '<option value="' +
        opt.value +
        '"' +
        (perGroupLimit === opt.value ? ' selected' : '') +
        '>' +
        esc(opt.label) +
        '</option>'
      );
    })
    .join('');

  const sortOptions = [
    { value: 'newest', label: '最新优先' },
    { value: 'oldest', label: '最早优先' },
    { value: 'files-desc', label: '按改动文件数' },
  ]
    .map(function (opt) {
      return (
        '<option value="' +
        opt.value +
        '"' +
        (sortMode === opt.value ? ' selected' : '') +
        '>' +
        esc(opt.label) +
        '</option>'
      );
    })
    .join('');

  const filterButtons = ['ALL', 'ALLOW', 'ASK', 'BLOCK']
    .map(function (flt) {
      return (
        '<button type="button" class="mwh-btn ' +
        (auditFilter === flt ? 'mwh-btn-primary' : '') +
        '" style="padding:3px 8px;border-radius:8px" data-action="audit-filter" data-filter="' +
        flt +
        '">' +
        flt +
        '</button>'
      );
    })
    .join('');

  return (
    '<div class="mwh-card">' +
    '<div class="mwh-row" style="flex-wrap:wrap;margin-bottom:8px">' +
    '<div><div style="font-size:13px;font-weight:600">写前影子快照</div>' +
    '<div class="mwh-hint">Muse 写入前自动保存的安全检查点，支持单条无损还原</div></div>' +
    '<div style="display:flex;gap:6px;align-items:center">' +
    '<select class="mwh-select" id="mwh-snapshot-sort" data-action-change="snapshot-sort" aria-label="快照排序方式">' +
    sortOptions +
    '</select>' +
    '<select class="mwh-select" id="mwh-snapshot-limit" data-action-change="snapshot-limit" aria-label="每组显示条数">' +
    limitOptions +
    '</select>' +
    '</div></div>' +
    '<div class="mwh-list-row" style="margin-bottom:8px;flex-wrap:wrap">' +
    '<div style="display:flex;align-items:center;gap:7px;min-width:0">' +
    '<button type="button" class="mwh-btn" data-action="snapshot-select-all" ' +
    (visibleIds.length === 0 ? 'disabled' : '') +
    '>' +
    (allVisibleSelected ? '取消全选' : '全选当前可见') +
    '</button>' +
    '<button type="button" class="mwh-btn" data-action="snapshot-toggle-all-groups" ' +
    (groupOrder.length === 0 ? 'disabled' : '') +
    '>' +
    (allCollapsed ? '全部展开' : '全部折叠') +
    '</button>' +
    '<span class="mwh-hint mwh-mono" data-selected-count>已选 ' +
    activeSelected.length +
    ' 条记录</span></div>' +
    '<div style="display:flex;gap:6px">' +
    '<button type="button" class="mwh-btn" data-action="snapshot-prune" ' +
    (snapshots.length === 0 ? 'disabled' : '') +
    ' title="按工作区仅保留最近 N 条快照记录，自动清理更早记录">磁盘瘦身：仅留 ' +
    (perGroupLimit > 0 ? perGroupLimit : 5) +
    ' 次</button>' +
    '<button type="button" class="mwh-btn mwh-btn-danger" data-action="snapshot-delete-selected" ' +
    (activeSelected.length === 0 ? 'disabled' : '') +
    '>' +
    ICON.trash +
    '<span data-delete-label>删除所选记录' +
    (activeSelected.length > 0 ? ' (' + activeSelected.length + ')' : '') +
    '</span></button>' +
    '</div></div>' +
    '<div class="mwh-scroll mwh-thin-scroll" style="display:flex;flex-direction:column;gap:7px;max-height:460px;overflow-y:auto;overscroll-behavior:contain;padding-right:2px">' +
    groupHtml +
    '</div></div>' +
    '<div class="mwh-card">' +
    '<div class="mwh-row" style="margin-bottom:8px">' +
    '<div style="font-size:12.5px;font-weight:600" class="mwh-truncate">本地审计日志 (.mwh/logs/audit.jsonl)</div>' +
    '<div style="display:flex;gap:3px;background:var(--mwh-card-2);border-radius:9px;padding:3px">' +
    filterButtons +
    '</div></div>' +
    '<div class="mwh-scroll mwh-thin-scroll" style="display:flex;flex-direction:column;gap:6px;max-height:min(38vh,320px);overflow-y:auto;padding-right:2px">' +
    (auditRows || '<div class="mwh-empty">暂无审计记录</div>') +
    '</div></div>'
  );
  } catch (err) {
    return (
      '<div class="mwh-card"><div class="mwh-empty">加载审计与快照失败: ' +
      esc(err && err.message ? err.message : String(err)) +
      '</div></div>'
    );
  }
}

const SECTION_HEADERS = {
  connectors: '连接器与权限模式',
  permissions: '连接器与权限模式',
  daemon: '工作区与代理引擎',
  subagents: '工作区与代理引擎',
  resources: '本机 MCP 与 Skill',
  'snapshots-audit': '影子快照与审计日志',
};

async function daemonHttp(method, path, body) {
  // Must go through the Electron main process. A page-origin fetch to
  // http://127.0.0.1:19820 is blocked by Chromium (private network / mixed
  // content) when this panel is injected into the Muse HTTPS page, and the
  // user only sees "Failed to fetch".
  const res = await ipcRenderer.invoke('mwh:daemon-http', { method: method, path: path, body: body });
  const failure = daemonFailure(res);
  if (failure) throw new Error(failure);
  return res;
}

function renderResources(settings) {
  const form = state.ui.resourceForm || defaultResourceForm();
  const resources = settings.resources || {
    enabledCount: 0,
    entries: [],
    summary: { enabledCount: 0, mcp: [], skills: [] },
  };
  const entries = Array.isArray(resources.entries) ? resources.entries : [];
  const mcpEntries = entries.filter(function (e) {
    return e.kind === 'mcp';
  });
  const skillEntries = entries.filter(function (e) {
    return e.kind === 'skill';
  });

  // 1. Header Banner
  let html =
    '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px">' +
    '<div>' +
    '<div style="font-size:16px;font-weight:700;color:var(--mwh-text)">本机 MCP 与 Skill</div>' +
    '<div class="mwh-hint" style="margin-top:4px;line-height:1.6">' +
    '<div style="color:var(--mwh-text)">打开即对 Muse 生效，默认全部关闭。</div>' +
    '<div>MCP 在你的 Windows 用户权限下运行，没有额外沙箱。退出或急停时会一并结束已拉起的子进程。</div>' +
    '</div></div>' +
    '<div style="display:flex;align-items:center;gap:8px;flex-shrink:0">' +
    '<button type="button" class="mwh-btn" data-action="resource-scan">' +
    ICON.refresh +
    '<span>' +
    (state.ui.loadingAction === 'resource_scan' ? '扫描中...' : '扫描本机') +
    '</span></button>' +
    '<button type="button" class="mwh-btn mwh-btn-primary" data-action="resource-open-add">' +
    ICON.plus +
    '<span>添加</span></button>' +
    '</div></div>';

  // 2. In-page Add / Edit Form
  if (form.open) {
    let probeBlock = '';
    if (form.probeResult) {
      if (form.probeResult.ok) {
        const toolCount = form.probeResult.tools ? form.probeResult.tools.length : 0;
        probeBlock =
          '<div class="mwh-card-flat mwh-mono" style="margin-top:5px;color:#7DD3FC">探测成功' +
          (toolCount > 0 ? ' (发现 ' + toolCount + ' 个工具)' : '') +
          '</div>';
      } else {
        probeBlock =
          '<div class="mwh-card-flat mwh-mono" style="margin-top:5px;color:#EAB364">探测失败: ' +
          esc(form.probeResult.error || form.probeResult.faultReason || '连接失败') +
          '</div>';
      }
    }

    let kindSelector = '';
    if (!form.editingId) {
      kindSelector =
        '<div class="mwh-field" style="margin-bottom:8px"><span>资源类型</span>' +
        '<div style="display:flex;gap:6px">' +
        '<button type="button" class="mwh-btn' +
        (form.kind === 'mcp' ? ' mwh-btn-primary' : '') +
        '" data-action="resource-set-kind" data-kind="mcp">本机 MCP</button>' +
        '<button type="button" class="mwh-btn' +
        (form.kind === 'skill' ? ' mwh-btn-primary' : '') +
        '" data-action="resource-set-kind" data-kind="skill">Skill</button>' +
        '</div></div>';
    }

    let fields = '';
    if (form.kind === 'mcp') {
      const isStdio = form.transport !== 'http';
      fields =
        '<div class="mwh-field" style="margin-bottom:8px"><span>传输协议</span>' +
        '<div style="display:flex;gap:6px">' +
        '<button type="button" class="mwh-btn' +
        (isStdio ? ' mwh-btn-primary' : '') +
        '" data-action="resource-set-transport" data-transport="stdio">stdio</button>' +
        '<button type="button" class="mwh-btn' +
        (!isStdio ? ' mwh-btn-primary' : '') +
        '" data-action="resource-set-transport" data-transport="http">Streamable HTTP</button>' +
        '</div></div>' +
        (isStdio
          ? '<div class="mwh-field" style="margin-bottom:8px"><span>执行命令 (Command)</span>' +
            '<input class="mwh-input mwh-mono" data-bind="resource.command" value="' +
            esc(form.command) +
            '" placeholder="例如: node 或 C:\\tools\\server.exe" /></div>' +
            '<div class="mwh-field" style="margin-bottom:8px"><span>启动参数 (Args)</span>' +
            '<input class="mwh-input mwh-mono" data-bind="resource.args" value="' +
            esc(form.args) +
            '" placeholder="以空格分隔，例如: dist/index.js --port 8080" /></div>' +
            '<div class="mwh-field" style="margin-bottom:8px"><span>工作目录 (CWD, 可选)</span>' +
            '<input class="mwh-input mwh-mono" data-bind="resource.cwd" value="' +
            esc(form.cwd) +
            '" placeholder="默认用户主目录" /></div>'
          : '<div class="mwh-field" style="margin-bottom:8px"><span>HTTP URL</span>' +
            '<input class="mwh-input mwh-mono" data-bind="resource.httpUrl" value="' +
            esc(form.httpUrl) +
            '" placeholder="例如: http://127.0.0.1:8000/mcp" /></div>');
    } else {
      fields =
        '<div class="mwh-field" style="margin-bottom:8px"><span>Skill 目录路径</span>' +
        '<input class="mwh-input mwh-mono" data-bind="resource.skillDir" value="' +
        esc(form.skillDir) +
        '" placeholder="需包含 SKILL.md 的本地目录" /></div>';
    }

    const editReadonly = form.editingId
      ? '<div style="margin-bottom:8px">' +
        renderSwitchRow({
          bind: 'resource.readonly',
          checked: form.readonly,
          label: '标记为只读（在计划模式下放行探查）',
          title: '只读资源在计划模式下仍可被探查'
        }) +
        '</div>'
      : '';

    const addImmediateEnable = !form.editingId
      ? '<div style="margin-bottom:8px">' +
        renderSwitchRow({
          bind: 'resource.enabled',
          checked: form.enabled,
          label: '立即启用（默认关闭）',
          title: '添加完成后立即对 Muse 生效'
        }) +
        '</div>'
      : '';

    html +=
      '<div class="mwh-card" style="margin-bottom:12px;border:1px solid rgba(99,102,241,0.28)">' +
      '<div class="mwh-row" style="margin-bottom:10px">' +
      '<div style="font-size:13px;font-weight:600;color:var(--mwh-text)">' +
      (form.editingId ? '编辑资源' : '添加本机资源') +
      '</div>' +
      '<button type="button" class="mwh-icon-btn" data-action="resource-cancel">' +
      ICON.close +
      '</button>' +
      '</div>' +
      kindSelector +
      '<div class="mwh-field" style="margin-bottom:8px"><span>显示名称 (Display Name)</span>' +
      '<input class="mwh-input" data-bind="resource.displayName" value="' +
      esc(form.displayName) +
      '" placeholder="例如: MyTools" /></div>' +
      fields +
      editReadonly +
      addImmediateEnable +
      '<div class="mwh-row" style="margin-top:10px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.06)">' +
      '<button type="button" class="mwh-btn" data-action="resource-probe">' +
      (form.probing ? ICON.spinner : ICON.refresh) +
      '<span>' +
      (form.probing ? '探测中...' : '探测连接') +
      '</span></button>' +
      '<div style="display:flex;gap:6px">' +
      '<button type="button" class="mwh-btn" data-action="resource-cancel">取消</button>' +
      '<button type="button" class="mwh-btn mwh-btn-primary" data-action="resource-save">' +
      (form.saving ? '保存中...' : '保存') +
      '</button>' +
      '</div></div>' +
      probeBlock +
      '</div>';
  }

  // 3. Card 1: 本机 MCP
  let mcpListHtml = '';
  if (mcpEntries.length === 0) {
    mcpListHtml =
      '<div class="mwh-empty">暂无已登记的本机 MCP 服务器，可通过上方「扫描本机」自动发现或「添加」手动配置。</div>';
  } else {
    mcpListHtml = mcpEntries
      .map(function (entry) {
        const isExpanded = Boolean(
          state.ui.resourceExpanded && state.ui.resourceExpanded[entry.id]
        );
        const isFault = Boolean(entry.faultReason || entry.runtimeStatus === 'fault');
        const isRunning = entry.runtimeStatus === 'running';

        let statusBadge = '<span class="mwh-pill">已关闭</span>';
        if (isFault) {
          statusBadge =
            '<span class="mwh-pill" style="background:rgba(234,179,100,0.16);color:#EAB364;font-weight:600">' +
            esc(entry.faultReason || '启动故障') +
            '</span>';
        } else if (isRunning) {
          statusBadge =
            '<span class="mwh-pill" style="background:rgba(56,189,248,0.14);color:#7DD3FC">运行正常</span>';
        }

        const readonlyBadge = entry.readonly
          ? '<span class="mwh-pill" style="font-size:10px;background:rgba(255,255,255,0.06);color:var(--mwh-muted)">只读</span>'
          : '';

        const toolCountText =
          (typeof entry.toolCount === 'number'
            ? entry.toolCount
            : entry.exposedToolNames
            ? entry.exposedToolNames.length
            : 0) + ' 个工具';

        let expandedBlock = '';
        if (isExpanded) {
          let toolsHtml = '<div class="mwh-hint">暂无工具（启用且运行正常后自动列出）</div>';
          if (entry.exposedToolNames && entry.exposedToolNames.length > 0) {
            toolsHtml =
              '<div style="display:flex;flex-wrap:wrap;gap:6px">' +
              entry.exposedToolNames
                .map(function (t) {
                  return (
                    '<span class="mwh-pill mwh-mono mwh-tool-chip" title="原名: ' +
                    esc(t.original) +
                    '">' +
                    esc(t.exposed) +
                    ' <span class="mwh-tool-orig">(' +
                    esc(t.original) +
                    ')</span>' +
                    '</span>'
                  );
                })
                .join('') +
              '</div>';
          }
          expandedBlock =
            '<div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.05)">' +
            '<div style="font-size:11.5px;font-weight:600;color:var(--mwh-muted);margin-bottom:6px">将出现在 Muse 的 tools/list</div>' +
            (isFault
              ? '<div style="color:#EAB364;font-size:11px;margin-bottom:6px">已暂时从 /mcp 撤下，修复后会自动恢复</div>'
              : '') +
            toolsHtml +
            '</div>';
        }

        return (
          '<div class="mwh-list-row" style="margin-bottom:6px;flex-direction:column;align-items:stretch">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;width:100%">' +
          '<div class="mwh-list-col" style="cursor:pointer" data-action="resource-toggle-expand" data-id="' +
          esc(entry.id) +
          '">' +
          '<div class="mwh-list-title">' +
          '<span style="color:var(--mwh-muted)">' +
          (isExpanded ? ICON.chevronDown : ICON.chevronRight) +
          '</span>' +
          '<span>' +
          esc(entry.displayName || entry.id) +
          '</span>' +
          '<span class="mwh-pill">' +
          esc(entry.sourceLabel || (entry.source === 'scan' ? '扫描发现' : '手动添加')) +
          '</span>' +
          statusBadge +
          readonlyBadge +
          '</div></div>' +
          '<div style="display:flex;align-items:center;gap:12px;flex-shrink:0;margin-left:12px">' +
          '<span class="mwh-tool-count">' +
          esc(toolCountText) +
          '</span>' +
          '<div style="display:flex;gap:5px;align-items:center">' +
          renderSwitchHtml({
            checked: entry.enabled,
            action: 'resource-toggle',
            id: entry.id,
            label: (entry.enabled ? '停用 ' : '启用 ') + (entry.displayName || entry.id),
            title: isFault
              ? entry.faultReason || '启动故障，开关保持启用由你决定是否关闭'
              : entry.enabled
              ? '已启用，点击停用'
              : '已停用，点击启用'
          }) +
          '<button type="button" class="mwh-icon-btn" data-action="resource-open-edit" data-id="' +
          esc(entry.id) +
          '" title="编辑">' +
          ICON.edit +
          '</button>' +
          '<button type="button" class="mwh-icon-btn" style="color:#F28B82" data-action="resource-delete" data-id="' +
          esc(entry.id) +
          '" title="删除">' +
          ICON.trash +
          '</button>' +
          '</div></div></div>' +
          expandedBlock +
          '</div>'
        );
      })
      .join('');
  }

  html +=
    '<div class="mwh-card" style="margin-bottom:12px">' +
    '<div class="mwh-section-title" style="margin-bottom:4px">' +
    ICON.folder +
    '<span>本机 MCP</span>' +
    '</div>' +
    '<div class="mwh-hint" style="margin-bottom:10px">启用后，工具会出现在 Muse 现有的 /mcp 里，直接调用即可。</div>' +
    mcpListHtml +
    '</div>';

  // 4. Card 2: Skill
  let skillListHtml = '';
  if (skillEntries.length === 0) {
    skillListHtml =
      '<div class="mwh-empty">暂无已登记的 Skill，可通过上方「扫描本机」自动发现或「添加」手动配置。</div>';
  } else {
    skillListHtml = skillEntries
      .map(function (entry) {
        const isExpanded = Boolean(
          state.ui.resourceExpanded && state.ui.resourceExpanded[entry.id]
        );
        // 故障（SKILL.md 缺失等）不能显示成绿色「已就绪」，否则就是谎报可用性。
        const skillFault = Boolean(entry.faultReason || entry.runtimeStatus === 'fault');
        const statusBadge = skillFault
          ? '<span class="mwh-pill" style="background:rgba(234,179,100,0.16);color:#EAB364;font-weight:600">' +
            esc(entry.faultReason || '不可用') +
            '</span>'
          : entry.enabled
          ? '<span class="mwh-pill" style="background:rgba(56,189,248,0.14);color:#7DD3FC">已就绪</span>'
          : '<span class="mwh-pill">已关闭</span>';

        let expandedBlock = '';
        if (isExpanded) {
          expandedBlock =
            '<div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.05);font-size:11.5px">' +
            '<div style="color:var(--mwh-text);margin-bottom:4px;line-height:1.5">' +
            esc(entry.skillDescription || '暂无说明') +
            '</div>' +
            '<div class="mwh-mono mwh-muted" style="font-size:10.5px">来源目录: ' +
            esc(entry.skillDirDisplay || '~') +
            '</div>' +
            '</div>';
        }

        return (
          '<div class="mwh-list-row" style="margin-bottom:6px;flex-direction:column;align-items:stretch">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;width:100%">' +
          '<div class="mwh-list-col" style="cursor:pointer" data-action="resource-toggle-expand" data-id="' +
          esc(entry.id) +
          '">' +
          '<div class="mwh-list-title">' +
          '<span style="color:var(--mwh-muted)">' +
          (isExpanded ? ICON.chevronDown : ICON.chevronRight) +
          '</span>' +
          '<span>' +
          esc(entry.displayName || entry.id) +
          '</span>' +
          '<span class="mwh-pill">' +
          esc(entry.sourceLabel || (entry.source === 'scan' ? '扫描发现' : '手动添加')) +
          '</span>' +
          statusBadge +
          '</div></div>' +
          '<div style="display:flex;gap:4px;align-items:center;flex-shrink:0">' +
          renderSwitchHtml({
            checked: entry.enabled,
            action: 'resource-toggle',
            id: entry.id,
            label: (entry.enabled ? '停用 ' : '启用 ') + (entry.displayName || entry.id),
            title: entry.enabled ? '已启用，点击停用' : '已停用，点击启用'
          }) +
          '<button type="button" class="mwh-icon-btn" data-action="resource-open-edit" data-id="' +
          esc(entry.id) +
          '" title="编辑">' +
          ICON.edit +
          '</button>' +
          '<button type="button" class="mwh-icon-btn" style="color:#F28B82" data-action="resource-delete" data-id="' +
          esc(entry.id) +
          '" title="删除">' +
          ICON.trash +
          '</button>' +
          '</div></div>' +
          expandedBlock +
          '</div>'
        );
      })
      .join('');
  }

  html +=
    '<div class="mwh-card">' +
    '<div class="mwh-section-title" style="margin-bottom:4px">' +
    ICON.folder +
    '<span>Skill</span>' +
    '</div>' +
    '<div class="mwh-hint" style="margin-bottom:10px">名称和简短说明会自动备好，需要全文时再读一次。</div>' +
    skillListHtml +
    '</div>';

  return html;
}

/** 开关过渡时长（与 CSS 的 --mwh-dur-state 同值，见 docs/DESIGN.md 4.8）。 */
const SWITCH_ANIM_MS = 180;

/**
 * 正在提交中的开关：key → 点击时刻。
 *
 * 一物两用：`has()` 拦截连点导致的相反双请求；`pendingSwitchMotionLeftMs()`
 * 用它算出"还有多久动画才播完"，供 renderSubpanel 推迟整块重绘。
 */
const pendingSwitchKeys = new Map();

/** 是否已经为当前这轮动画排过一次延迟重绘，避免每帧重复排。 */
let switchRenderDeferred = false;

/** 返回尚需等待的动画时长（ms）；没有开关在动时返回 0。 */
function pendingSwitchMotionLeftMs() {
  if (pendingSwitchKeys.size === 0) return 0;
  const now = Date.now();
  let left = 0;
  pendingSwitchKeys.forEach(function (startedAt) {
    const rest = SWITCH_ANIM_MS - (now - startedAt);
    if (rest > left) left = rest;
  });
  return left;
}

/**
 * 就地改开关外观：只写 class 与 aria-checked，不重建节点。
 *
 * 这是开关能动起来的前提——整块 innerHTML 重绘会让新节点一出生就是终点态，
 * 浏览器没有"旧态 → 新态"的样式变化可过渡（见 docs/DESIGN.md 4.8 红线 5）。
 */
function paintSwitch(node, on) {
  if (!node || !node.isConnected) return;
  node.classList.toggle('is-on', Boolean(on));
  node.setAttribute('aria-checked', on ? 'true' : 'false');
}

/** 动作目标可能是开关本身，也可能是包着它的整行。 */
function resolveSwitchNode(target) {
  if (!target) return null;
  if (target.getAttribute('role') === 'switch') return target;
  return target.querySelector('[role="switch"]');
}

/** 至少让过渡播完再重绘，最多补 SWITCH_ANIM_MS。 */
function holdSwitchMin(startedAt) {
  const left = SWITCH_ANIM_MS - (Date.now() - startedAt);
  if (left <= 0) return Promise.resolve();
  return new Promise(function (resolve) {
    setTimeout(resolve, left);
  });
}

/**
 * 渲染一枚 iOS 式开关。契约见 docs/DESIGN.md 4.1：
 * - 必须是 button，保证 Enter / Space 原生可用；
 * - role="switch" + aria-checked 必须随状态更新；
 * - 列表行走 data-action="resource-toggle" + data-id，表单走 data-action="switch-bind" + data-bind。
 */
function renderSwitchHtml(options) {
  const opts = options || {};
  const checked = Boolean(opts.checked);
  const action = opts.action || 'switch-bind';
  let html =
    '<button type="button" role="switch" aria-checked="' +
    (checked ? 'true' : 'false') +
    '" class="mwh-switch' +
    (checked ? ' is-on' : '') +
    (opts.className ? ' ' + opts.className : '') +
    '"';
  if (action) html += ' data-action="' + esc(action) + '"';
  if (opts.bind) html += ' data-bind="' + esc(opts.bind) + '"';
  if (opts.id) html += ' data-id="' + esc(opts.id) + '"';
  if (opts.title) html += ' title="' + esc(opts.title) + '"';
  if (opts.label) html += ' aria-label="' + esc(opts.label) + '"';
  if (opts.disabled) html += ' disabled aria-disabled="true"';
  html += '><span class="mwh-switch-dot"></span></button>';
  return html;
}

/** 表单里的布尔行：左侧标题 + 右侧开关，整行可点。 */
function renderSwitchRow(options) {
  const opts = options || {};
  return (
    '<div class="mwh-switch-row" data-action="switch-bind-row" data-bind="' +
    esc(opts.bind || '') +
    '">' +
    '<div style="min-width:0">' +
    '<div class="mwh-switch-row-label">' +
    esc(opts.label || '') +
    '</div>' +
    (opts.sub ? '<div class="mwh-switch-row-sub">' + esc(opts.sub) + '</div>' : '') +
    '</div>' +
    renderSwitchHtml({
      checked: opts.checked,
      bind: opts.bind,
      title: opts.title,
      label: opts.label
    }) +
    '</div>'
  );
}

function renderSubpanel(force) {
  const root = document.getElementById('mwh-subpanel');
  if (!root) return;
  if (!state.activeSection) {
    root.classList.remove('open');
    return;
  }
  const body = document.getElementById('mwh-subpanel-body');
  // 开关过渡期间推迟整块重绘。
  //
  // 服务端是"先广播 SSE 再回 200"，mwh:state-patch 会在请求返回前几十毫秒到达并
  // 触发重绘；节点一旦被替换，动画就停在中途。这里按剩余动画时长推迟一次，
  // 到点后强制重绘，拿到的仍是服务端真相（docs/DESIGN.md 4.8 红线 1/2）。
  const motionLeftMs = pendingSwitchMotionLeftMs();
  if (motionLeftMs > 0) {
    if (!switchRenderDeferred) {
      switchRenderDeferred = true;
      setTimeout(function () {
        switchRenderDeferred = false;
        scheduleRender(true);
      }, motionLeftMs + 16);
    }
    return;
  }
  if (!force && body && body.contains(document.activeElement)) {
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
      state.subpanelDirty = true;
      return;
    }
  }
  // 重绘会整体替换 body 的 DOM。先记住当前聚焦的是哪一枚开关，渲染后按
  // data-bind / data-id 原样还原，键盘连续操作与 SSE 触发的重绘都不会把
  // 焦点丢回 body。这里只比较属性值，不拼选择器，避免 id 里的引号破坏查询。
  let switchFocusAttr = null;
  let switchFocusKey = null;
  const activeBeforeRender = document.activeElement;
  if (body && activeBeforeRender && body.contains(activeBeforeRender) && activeBeforeRender.getAttribute) {
    if (activeBeforeRender.getAttribute('role') === 'switch') {
      if (activeBeforeRender.getAttribute('data-bind')) switchFocusAttr = 'data-bind';
      else if (activeBeforeRender.getAttribute('data-id')) switchFocusAttr = 'data-id';
      if (switchFocusAttr) switchFocusKey = activeBeforeRender.getAttribute(switchFocusAttr);
    }
  }
  const settings = getSettings();
  const scrollTop = body ? body.scrollTop : 0;
  let content = '';
  if (state.activeSection === 'connectors' || state.activeSection === 'permissions') {
    content =
      '<div style="font-size:13.5px;font-weight:600;color:var(--mwh-text);margin:4px 0 10px;display:flex;align-items:center;gap:6px">' +
      ICON.link +
      '<span>连接器</span></div>' +
      renderConnectors(settings) +
      '<div style="font-size:13.5px;font-weight:600;color:var(--mwh-text);margin:20px 0 10px;display:flex;align-items:center;gap:6px">' +
      ICON.shield +
      '<span>权限</span></div>' +
      renderPermissions(settings);
  } else if (state.activeSection === 'daemon' || state.activeSection === 'subagents') {
    content =
      '<div style="font-size:13.5px;font-weight:600;color:var(--mwh-text);margin:4px 0 10px;display:flex;align-items:center;gap:6px">' +
      ICON.folder +
      '<span>工作区</span></div>' +
      renderDaemon(settings) +
      '<div style="font-size:13.5px;font-weight:600;color:var(--mwh-text);margin:20px 0 10px;display:flex;align-items:center;gap:6px">' +
      ICON.bot +
      '<span>代理</span></div>' +
      renderSubagents(settings);
  } else if (state.activeSection === 'resources') {
    content = renderResources(settings);
  } else {
    content = renderSnapshotsAudit(settings);
  }

  const tabsHtml = ADVANCED_SECTIONS.map(function (sec) {
    const isActive = state.activeSection === sec.id;
    return (
      '<button type="button" class="mwh-subpanel-tab-btn' +
      (isActive ? ' active' : '') +
      '" data-action="switch-subpanel-tab" data-section="' +
      sec.id +
      '">' +
      (ICON[sec.icon] || ICON.grid) +
      '<span>' +
      esc(sec.title) +
      '</span>' +
      '</button>'
    );
  }).join('');

  root.innerHTML =
    '<div class="mwh-resize-handle" title="拖拽调整宽度"></div>' +
    '<div class="mwh-subpanel-header">' +
    '<div class="mwh-subpanel-top-row">' +
    '<div style="display:flex;align-items:center;gap:8px">' +
    '<div class="mwh-adv-hero-icon" style="width:24px;height:24px;border-radius:6px;background:rgba(99,102,241,0.16);color:#A5B4FC;display:flex;align-items:center;justify-content:center">' +
    ICON.grid +
    '</div>' +
    '<span style="font-size:13.5px;font-weight:600;color:var(--mwh-text)">高级配置中心</span>' +
    '</div>' +
    '<button type="button" class="mwh-icon-btn" data-action="close-subpanel" title="关闭高级配置" aria-label="关闭高级配置">' +
    ICON.close +
    '</button>' +
    '</div>' +
    '<div class="mwh-subpanel-tabs-bar">' +
    tabsHtml +
    '</div>' +
    '</div>' +
    '<div class="mwh-subpanel-body" id="mwh-subpanel-body">' +
    content +
    '</div>';
  root.classList.add('open');
  state.subpanelDirty = false;
  const nextBody = document.getElementById('mwh-subpanel-body');
  if (nextBody) nextBody.scrollTop = scrollTop;
  attachPanelResize(root, '.mwh-resize-handle', 'mwh_subpanel_width', 280, function () {
    const drawer = document.getElementById('mwh-drawer');
    const drawerW = drawer ? drawer.getBoundingClientRect().width : 320;
    return Math.max(280, window.innerWidth - 56 - drawerW - 32);
  });
  // 把焦点还给重绘前正在操作的那一枚开关。
  if (switchFocusAttr && switchFocusKey) {
    const switchNodes = root.querySelectorAll('[role="switch"]');
    for (let i = 0; i < switchNodes.length; i += 1) {
      if (switchNodes[i].getAttribute(switchFocusAttr) === switchFocusKey) {
        if (typeof switchNodes[i].focus === 'function') switchNodes[i].focus({ preventScroll: true });
        break;
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * Approval island layout: 拖动 / 缩放 / 胶囊 / 实时耗时
 * ------------------------------------------------------------------ */

const ISLAND_MIN_W = 432;
const ISLAND_MIN_H = 240;
const ISLAND_MAX_W = 864;
const ISLAND_MAX_H = 624;
const ISLAND_CAPSULE_W = 108;
const ISLAND_CAPSULE_H = 42;
const ISLAND_LONG_PRESS_MS = 90;
const ISLAND_MOVE_THRESHOLD = 4;
const ISLAND_STORE_KEY = 'mwh_island_layout_v2';
const ISLAND_COLLAPSE_BTN =
  '<button type="button" class="mwh-icon-btn" data-action="task-collapse" title="收起为胶囊" aria-label="收起为胶囊">' +
  ICON.chevronDown +
  '</button>';

let islandLayout = null;
let islandElapsedTimer = null;
let islandPress = null;
let islandDrag = null;
let islandResize = null;
let islandSuppressClick = false;
let islandLogStick = true;
// 上一次渲染的任务 id，用于判定“新任务到来”，配合 state.islandAutoExpandedTaskId 实现“待审批自动展开一次”。
let islandPrevTaskId = null;

function islandClamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

function defaultIslandLayout() {
  return { w: 624, h: 384, x: null, y: null, capsule: false };
}

/** 收起胶囊正文极简 2-3 个核心汉字，左右对齐居中，无多余噪点。 */
function islandCapsuleText(status, fallback) {
  if (status === 'WAITING_APPROVAL') return '待授权';
  if (status === 'RUNNING') return '运行中';
  if (status === 'COMPLETED') return '已完成';
  if (status === 'IDLE') return '待命';
  const str = String(fallback || status || '').trim();
  if (str.includes('授权') || str.includes('审批')) return '待授权';
  if (str.includes('执行') || str.includes('运行')) return '运行中';
  if (str.includes('完成') || str.includes('修改')) return '已完成';
  return str.length > 3 ? str.slice(0, 3) : str || '待命';
}

function loadIslandLayout() {
  if (islandLayout) return islandLayout;
  islandLayout = defaultIslandLayout();
  try {
    const raw = window.localStorage.getItem(ISLAND_STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) || {};
      islandLayout.w = islandClamp(Number(parsed.w) || 624, ISLAND_MIN_W, ISLAND_MAX_W);
      islandLayout.h = islandClamp(Number(parsed.h) || 384, ISLAND_MIN_H, ISLAND_MAX_H);
      islandLayout.x = typeof parsed.x === 'number' ? parsed.x : null;
      islandLayout.y = typeof parsed.y === 'number' ? parsed.y : null;
      islandLayout.capsule = Boolean(parsed.capsule);
    }
  } catch (err) {
    console.error('mwh: island layout read failed', err);
  }
  return islandLayout;
}

// 主进程 island-layout.json 镜像合并只做一次（启动早期）。
let islandLayoutMirrorMerged = false;

/**
 * 主进程文件镜像为最终事实源：localStorage 挂在 muse.ai 远站 origin 上，
 * 可能被站点脚本清空，且 app.exit() 强杀不保证 localStorage 落盘。
 * 启动早期异步读一次镜像并覆盖本地缓存，再回写 localStorage 让两端一致。
 */
function mergeIslandLayoutFromMirror() {
  if (islandLayoutMirrorMerged) return;
  islandLayoutMirrorMerged = true;
  ipcRenderer
    .invoke('mwh:island-layout-load')
    .then(function (raw) {
      if (!raw || typeof raw !== 'string') return;
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        return; // 解析失败：忽略镜像，保留 localStorage 现状
      }
      if (!parsed || typeof parsed !== 'object') return;
      if (islandDrag) return; // 用户已开始拖动，放弃本次合并避免竞态
      const layout = loadIslandLayout();
      if (typeof parsed.x === 'number' && isFinite(parsed.x)) layout.x = parsed.x;
      if (typeof parsed.y === 'number' && isFinite(parsed.y)) layout.y = parsed.y;
      if (typeof parsed.w === 'number' && parsed.w > 0) {
        layout.w = islandClamp(parsed.w, ISLAND_MIN_W, ISLAND_MAX_W);
      }
      if (typeof parsed.h === 'number' && parsed.h > 0) {
        layout.h = islandClamp(parsed.h, ISLAND_MIN_H, ISLAND_MAX_H);
      }
      if (typeof parsed.capsule === 'boolean') layout.capsule = parsed.capsule;
      saveIslandLayout(); // 回写 localStorage，让两端一致
      applyIslandLayout(); // 岛 DOM 已创建则就地生效；未创建由 ensureShell 渲染时自然生效
    })
    .catch(function (err) {
      console.error('mwh: island layout mirror read failed', err);
    });
}

function saveIslandLayout() {
  if (!islandLayout) return;
  const snapshot = JSON.stringify({
    w: islandLayout.w,
    h: islandLayout.h,
    x: islandLayout.x,
    y: islandLayout.y,
    capsule: islandLayout.capsule,
  });
  try {
    window.localStorage.setItem(ISLAND_STORE_KEY, snapshot);
  } catch (err) {
    console.error('mwh: island layout save failed', err);
  }
  // 同一份快照镜像到主进程文件：app.exit() 强杀路径下 localStorage 可能不落盘。
  try {
    ipcRenderer.send('mwh:island-layout-save', snapshot);
  } catch (err) {
    console.error('mwh: island layout mirror failed', err);
  }
}

function islandCurrentSize() {
  const layout = loadIslandLayout();
  if (layout.capsule) {
    return { w: ISLAND_CAPSULE_W, h: ISLAND_CAPSULE_H };
  }
  return { w: layout.w, h: layout.h };
}

function clampIslandPosition() {
  const layout = loadIslandLayout();
  const size = islandCurrentSize();
  layout.x = islandClamp(layout.x, 12, Math.max(12, window.innerWidth - size.w - 12));
  layout.y = islandClamp(layout.y, 12, Math.max(12, window.innerHeight - size.h - 12));
}

function applyIslandLayout() {
  const el = document.getElementById('mwh-approval-island');
  if (!el) return;
  const layout = loadIslandLayout();
  // 胶囊态宽度锁定 108px 绝对不变量，彻底根除 fit-content 视口右边界抖动反馈
  if (layout.capsule) {
    el.style.setProperty('--mwh-island-w', ISLAND_CAPSULE_W + 'px');
    el.style.setProperty('--mwh-island-h', ISLAND_CAPSULE_H + 'px');
  } else {
    el.style.setProperty('--mwh-island-w', layout.w + 'px');
    el.style.setProperty('--mwh-island-h', layout.h + 'px');
  }
  const w = layout.capsule ? ISLAND_CAPSULE_W : layout.w;
  const h = layout.capsule ? ISLAND_CAPSULE_H : layout.h;
  if (layout.x === null || layout.y === null) {
    // 默认停靠右下角，与页面输入区保持 24px 间距，不压住回复正文。
    layout.x = Math.max(12, window.innerWidth - w - 24);
    layout.y = Math.max(12, window.innerHeight - h - 96);
  }
  layout.x = islandClamp(layout.x, 12, Math.max(12, window.innerWidth - w - 12));
  layout.y = islandClamp(layout.y, 12, Math.max(12, window.innerHeight - h - 12));
  el.style.transform =
    'translate3d(' + Math.round(layout.x) + 'px,' + Math.round(layout.y) + 'px,0)';
  el.classList.toggle('is-capsule', layout.capsule);
}

function setIslandCapsule(next) {
  const layout = loadIslandLayout();
  if (layout.capsule === next) return;
  layout.capsule = next;
  applyIslandLayout();
  saveIslandLayout();
  renderApprovalIsland();
}

function formatIslandElapsed(totalSec) {
  const sec = Math.max(0, Math.floor(totalSec));
  return sec >= 60 ? Math.floor(sec / 60) + 'm ' + (sec % 60) + 's' : sec + 's';
}

function islandElapsedBase(clock) {
  const match = /^(\d{2}):(\d{2}):(\d{2})$/.exec(String(clock || '').trim());
  if (!match) return Date.now();
  const now = new Date();
  const started = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    Number(match[1]),
    Number(match[2]),
    Number(match[3])
  );
  const diff = now.getTime() - started.getTime();
  if (diff < 0 || diff >= 86400000) return Date.now();
  return started.getTime();
}

/** 耗时每秒真实走动：只改文本节点，不重建整块 DOM。 */
function startIslandElapsedTicker(task) {
  if (islandElapsedTimer) {
    window.clearInterval(islandElapsedTimer);
    islandElapsedTimer = null;
  }
  if (!task || task.status !== 'RUNNING') return;
  const base = islandElapsedBase(task.startedAt);
  const tick = function () {
    const label = document.getElementById('mwh-island-elapsed');
    if (!label) return;
    const text = formatIslandElapsed((Date.now() - base) / 1000);
    label.textContent = text;
    const capsuleLabel = document.getElementById('mwh-island-capsule-elapsed');
    if (capsuleLabel) capsuleLabel.textContent = ' · ' + text;
  };
  tick();
  islandElapsedTimer = window.setInterval(tick, 1000);
}

function scrollIslandLogToBottom(root) {
  if (!root || !islandLogStick) return;
  const log = root.querySelector('[data-island-log]');
  if (!log) return;
  log.scrollTop = log.scrollHeight;
}

function snapIslandToEdge() {
  const el = document.getElementById('mwh-approval-island');
  const layout = loadIslandLayout();
  // 自由拖动：彻底取消边缘 120px 强制吸附，仅做屏幕安全视口防出界保护
  clampIslandPosition();
  if (el) {
    el.style.transform =
      'translate3d(' + Math.round(layout.x) + 'px,' + Math.round(layout.y) + 'px,0)';
  }
}

function startIslandResize(event) {
  const el = document.getElementById('mwh-approval-island');
  if (!el) return;
  const layout = loadIslandLayout();
  if (layout.capsule) {
    layout.capsule = false;
    applyIslandLayout();
  }
  islandResize = { x: event.clientX, y: event.clientY, w: layout.w, h: layout.h };
  el.classList.add('is-resizing');
  try {
    el.setPointerCapture(event.pointerId);
  } catch (err) {
    /* 部分环境不支持 pointer capture，退化为 document 监听 */
  }
}

function onIslandPointerMove(event) {
  const el = document.getElementById('mwh-approval-island');
  if (!el || !islandLayout) return;
  if (islandResize) {
    islandLayout.w = Math.round(
      islandClamp(islandResize.w + (event.clientX - islandResize.x), ISLAND_MIN_W, ISLAND_MAX_W)
    );
    islandLayout.h = Math.round(
      islandClamp(islandResize.h + (event.clientY - islandResize.y), ISLAND_MIN_H, ISLAND_MAX_H)
    );
    applyIslandLayout();
    return;
  }
  if (islandPress && !islandPress.fired) {
    if (
      Math.abs(event.clientX - islandPress.x) > ISLAND_MOVE_THRESHOLD ||
      Math.abs(event.clientY - islandPress.y) > ISLAND_MOVE_THRESHOLD
    ) {
      window.clearTimeout(islandPress.timer);
      islandPress = null;
    }
    return;
  }
  if (!islandDrag) return;
  // 拖动期间边界 clamp：胶囊锁定 108px 绝对不变量宽度，展开用实测/持久化宽度。
  const w = islandLayout.capsule ? ISLAND_CAPSULE_W : islandDrag.w;
  const h = islandLayout.capsule ? ISLAND_CAPSULE_H : islandLayout.h;
  islandLayout.x = islandClamp(
    event.clientX - islandDrag.dx,
    12,
    Math.max(12, window.innerWidth - w - 12)
  );
  islandLayout.y = islandClamp(
    event.clientY - islandDrag.dy,
    12,
    Math.max(12, window.innerHeight - h - 12)
  );
  el.style.transform =
    'translate3d(' + Math.round(islandLayout.x) + 'px,' + Math.round(islandLayout.y) + 'px,0)';
}

function endIslandPointer(event) {
  const el = document.getElementById('mwh-approval-island');
  if (islandPress && islandPress.timer) window.clearTimeout(islandPress.timer);
  if (islandResize) {
    islandResize = null;
    if (el) el.classList.remove('is-resizing');
    saveIslandLayout();
  }
  try {
    delete document.body.dataset.mwhBadgeDragging;
  } catch (err) {}
  if (islandDrag) {
    islandDrag = null;
    if (el) {
      el.classList.remove('is-dragging');
      el.classList.remove('mwh-island-pop');
    }
    snapIslandToEdge();
    saveIslandLayout();
    islandSuppressClick = true;
    window.setTimeout(function () {
      islandSuppressClick = false;
    }, 60);
  }
  if (event && event.pointerId !== undefined && el) {
    const head = el.querySelector('.mwh-island-head');
    try {
      if (head && head.hasPointerCapture && head.hasPointerCapture(event.pointerId)) {
        head.releasePointerCapture(event.pointerId);
      }
    } catch (err) {}
    try {
      if (el.hasPointerCapture && el.hasPointerCapture(event.pointerId)) {
        el.releasePointerCapture(event.pointerId);
      }
    } catch (err) {}
  }
  islandPress = null;
}

/** 单击展开/收起，按住 90ms 进入拖动（触发瞬间整岛微弹一次）；右下角把手缩放。容器只绑定一次。 */
function bindIslandLayoutControls(island) {
  if (!island || island.dataset.layoutBound === '1') return;
  island.dataset.layoutBound = '1';
  applyIslandLayout();
  // 岛初始化时异步合并一次主进程文件镜像（最终事实源），只执行一次。
  mergeIslandLayoutFromMirror();

  island.addEventListener('pointerdown', function (event) {
    if (event.button !== 0) return;
    loadIslandLayout();
    if (event.target.closest('.mwh-island-resize')) {
      startIslandResize(event);
      return;
    }
    const head = event.target.closest('.mwh-island-head');
    if (!head) return;
    if (event.target.closest('button') || event.target.closest('[data-action]')) return;
    islandPress = { x: event.clientX, y: event.clientY, fired: false, timer: null };
    islandPress.timer = window.setTimeout(function () {
      if (!islandPress) return;
      islandPress.fired = true;
      const layout = loadIslandLayout();
      const currentW = layout.capsule ? ISLAND_CAPSULE_W : island.offsetWidth;
      islandDrag = {
        dx: islandPress.x - layout.x,
        dy: islandPress.y - layout.y,
        w: currentW,
      };
      island.classList.add('is-dragging');
      try {
        document.body.dataset.mwhBadgeDragging = 'true';
      } catch (err) {}
      var reduced =
        window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (!reduced) {
        island.classList.remove('mwh-island-pop');
        void island.offsetWidth;
        island.classList.add('mwh-island-pop');
        var clearPop = function () {
          island.classList.remove('mwh-island-pop');
        };
        island.addEventListener('animationend', clearPop, { once: true });
        window.setTimeout(clearPop, 240);
      }
    }, ISLAND_LONG_PRESS_MS);
    try {
      head.setPointerCapture(event.pointerId);
    } catch (err) {
      /* ignore */
    }
  });

  island.addEventListener('pointermove', onIslandPointerMove);
  island.addEventListener('pointerup', endIslandPointer);
  island.addEventListener('pointercancel', endIslandPointer);
  /* 捕获被抢走（重绘/系统手势）时同样收尾，避免拖动态标记残留抑制边缘缩放 */
  island.addEventListener('lostpointercapture', endIslandPointer);

  island.addEventListener('click', function (event) {
    if (islandSuppressClick) return;
    if (island.dataset.idle === '1') return;
    const head = event.target.closest('.mwh-island-head');
    if (!head) return;
    if (event.target.closest('button') || event.target.closest('[data-action]')) return;
    setIslandCapsule(!loadIslandLayout().capsule);
  });

  island.addEventListener(
    'scroll',
    function (event) {
      const node = event.target;
      if (!node || !node.getAttribute || !node.getAttribute('data-island-log')) return;
      islandLogStick = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
    },
    true
  );

  window.addEventListener('resize', function () {
    applyIslandLayout();
  });
}

/* ------------------------------------------------------------------ *
 * Rendering: approval island
 * ------------------------------------------------------------------ */

function renderApprovalIsland() {
  const root = document.getElementById('mwh-approval-island');
  if (!root) return;
  const settings = getSettings();
  const task = settings.liveTask || emptyLiveTask();
  const isIdle = !task.status || task.status === 'IDLE';
  // 记录上一次渲染的任务 id：只有新任务到来才允许自动展开一次（同任务不反复弹开）。
  const taskChanged = islandPrevTaskId !== (task.id || null);
  islandPrevTaskId = task.id || null;
  startIslandElapsedTicker(isIdle ? null : task);

  let inner = '';
  if (isIdle) {
    // 胶囊常驻：空闲也保留一颗胶囊，居中保留 2-3 字「待命」
    loadIslandLayout().capsule = true;
    inner =
      '<div class="mwh-island-head">' +
      '<span style="width:7px;height:7px;border-radius:50%;background:#8E909A;flex:0 0 auto"></span>' +
      '<span class="mwh-island-capsule-label">待命</span>' +
      '</div>';
  } else if (task.status === 'WAITING_APPROVAL') {
    // 待审批自动展开一次：同一任务只自动展开一次；用户手动收起后不反复弹开，下一个新任务才再次展开。
    const waitingLayout = loadIslandLayout();
    if (waitingLayout.capsule && taskChanged && state.islandAutoExpandedTaskId !== task.id) {
      state.islandAutoExpandedTaskId = task.id;
      waitingLayout.capsule = false;
      saveIslandLayout();
      applyIslandLayout();
    }
    if (loadIslandLayout().capsule) {
      inner =
        '<div class="mwh-island-head">' +
        '<span style="color:#EAB364;display:inline-flex;align-items:center">' +
        ICON.alert +
        '</span>' +
        '<span class="mwh-island-capsule-label">待授权</span>' +
        '</div>';
    } else {
      const waitingTitle = '等待本机执行授权 · ' + (task.sourceAgent || '');
      inner =
        '<div class="mwh-island-head">' +
        '<div class="mwh-island-title">' +
        '<span style="color:#EAB364">' +
        ICON.alert +
        '</span><span class="mwh-truncate">' +
        esc(waitingTitle) +
        '</span></div>' +
        '<div class="mwh-island-head-right">' +
        '<span class="mwh-island-meta">风险 ' +
        esc(task.riskScore || 'LOW') +
        (task.worktreeId ? ' · Worktree: ' + esc(task.worktreeId) : '') +
        '</span>' +
        ISLAND_COLLAPSE_BTN +
        '</div></div>' +
        '<div class="mwh-island-body">' +
        '<div class="mwh-hint">' +
        esc(task.summary || '') +
        '</div>' +
        '<div class="mwh-island-code">' +
        '<span class="mwh-island-line" title="' +
        esc(task.command || '') +
        '"><span class="mwh-muted">$ </span>' +
        esc(task.command || '') +
        '</span>' +
        '<span class="mwh-island-line mwh-muted" title="' +
        esc(task.targetPath || '') +
        '">目标路径: ' +
        esc(task.targetPath || '') +
        '</span></div></div>' +
        '<div class="mwh-island-foot">' +
        '<button type="button" class="mwh-btn" data-action="task-reject">' +
        ICON.close +
        '<span>拒绝</span></button>' +
        '<button type="button" class="mwh-btn" data-action="task-approve-workspace">' +
        ICON.pin +
        '<span>本工作区始终允许</span></button>' +
        '<button type="button" class="mwh-btn mwh-btn-primary" data-action="task-approve-once">' +
        ICON.check +
        '<span>允许一次</span></button>' +
        '</div>';
    }
  } else if (task.status === 'RUNNING') {
    if (loadIslandLayout().capsule) {
      inner =
        '<div class="mwh-island-head">' +
        '<span class="mwh-spin" style="color:#A5B4FC;display:inline-flex;align-items:center">' +
        ICON.spinner +
        '</span>' +
        '<span class="mwh-island-capsule-label">运行中</span>' +
        '</div>';
    } else {
      const stdout = (task.stdoutLines || [])
        .map(function (line) {
          return '<span class="mwh-island-line" title="' + esc(line) + '">' + esc(line) + '</span>';
        })
        .join('');
      const agentBadge =
        task.sourceAgent && task.sourceAgent !== 'Muse Cloud MCP'
          ? '<span class="mwh-island-badge mwh-mono" style="padding:1px 6px;border-radius:6px;font-size:11px;background:rgba(255,255,255,0.08);color:var(--mwh-text-2)">[' +
            esc(task.sourceAgent) +
            ']</span>'
          : '';
      const titleText = task.stepLabel || '本地任务执行中';
      inner =
        '<div class="mwh-island-head">' +
        '<div class="mwh-island-title">' +
        '<span class="mwh-spin" style="color:#A5B4FC;display:inline-flex">' +
        ICON.spinner +
        '</span>' +
        agentBadge +
        '<span class="mwh-island-capsule-label" title="' +
        esc(titleText) +
        '">' +
        esc(titleText) +
        '<span id="mwh-island-capsule-elapsed" class="mwh-island-meta"></span>' +
        '</span></div>' +
        '<div class="mwh-island-head-right">' +
        '<span class="mwh-island-meta">CREATE_NO_WINDOW · 耗时 ' +
        '<span id="mwh-island-elapsed">0s</span> · 步骤 ' +
        esc(task.stepIndex || 0) +
        '/' +
        esc(task.totalSteps || 0) +
        '</span>' +
        '<button type="button" class="mwh-btn mwh-btn-danger" data-action="task-kill" style="border-radius:9999px">' +
        ICON.stop +
        '<span>强杀中止</span></button>' +
        ISLAND_COLLAPSE_BTN +
        '</div></div>' +
        '<div class="mwh-island-body">' +
        '<div class="mwh-island-code" data-island-log>' +
        '<span class="mwh-island-line mwh-muted" title="' +
        esc(task.command || '') +
        '">' +
        ICON.terminal +
        ' ' +
        esc(task.command || '') +
        '</span>' +
        stdout +
        '</div></div>';
    }
  } else {
    const hasFiles = Number(task.modifiedFilesCount) > 0;
    const canRollback = hasFiles && Boolean(task.snapshotId);
    const matchingWt = task.worktreeId
      ? (settings.worktrees || []).find(function (w) { return w.id === task.worktreeId; })
      : null;
    const canMerge =
      hasFiles &&
      Boolean(task.worktreeId) &&
      (!matchingWt || (matchingWt.status !== 'MISSING' && matchingWt.status !== 'MERGED'));
    if (!canRollback && !canMerge && state.lastAutoDismissTaskId !== task.id) {
      state.lastAutoDismissTaskId = task.id;
      const doneId = task.id;
      setTimeout(function () {
        const cur = (state.settings && state.settings.liveTask) || null;
        if (cur && cur.id === doneId && cur.status === 'COMPLETED') {
          cur.status = 'IDLE';
          renderApprovalIsland();
        }
      }, 4000);
    }
    if (loadIslandLayout().capsule) {
      inner =
        '<div class="mwh-island-head">' +
        '<span style="color:#7DD3FC;display:inline-flex;align-items:center">' +
        ICON.checkCircle +
        '</span>' +
        '<span class="mwh-island-capsule-label">已完成</span>' +
        '</div>';
    } else {
      const completedText = hasFiles
        ? '本地任务执行完成 · 修改 ' + (task.modifiedFilesCount || 0) + ' 个文件'
        : task.changeTracking === 'unavailable'
          ? '执行完成 · 改动数未统计'
          : '执行完成 · 未检测到文件改动';
      inner =
        '<div class="mwh-island-head">' +
        '<div class="mwh-island-title">' +
        '<span style="color:#7DD3FC">' +
        ICON.checkCircle +
        '</span><span class="mwh-island-capsule-label">' +
        esc(completedText) +
        '</span></div>' +
        '<div class="mwh-island-head-right">' +
        (task.testResultSummary
          ? '<span class="mwh-island-meta">' + esc(task.testResultSummary) + '</span>'
          : '') +
        '<button type="button" class="mwh-icon-btn" data-action="task-dismiss" title="关闭任务提示" aria-label="关闭任务提示">' +
        ICON.close +
        '</button>' +
        ISLAND_COLLAPSE_BTN +
        '</div></div>' +
        '<div class="mwh-island-body">' +
        (canRollback || canMerge
          ? '<div class="mwh-island-code"><span class="mwh-island-line">' +
            (canRollback ? '写前影子快照: ' + esc(task.snapshotId) : '') +
            (canRollback && canMerge ? ' · ' : '') +
            (canMerge ? 'Worktree: ' + esc(task.worktreeId) : '') +
            '</span></div>'
          : '') +
        '</div>' +
        (canRollback || canMerge
          ? '<div class="mwh-island-foot">' +
            (canRollback
              ? '<button type="button" class="mwh-btn" data-action="task-rollback" data-id="' +
                esc(task.snapshotId) +
                '">' +
                ICON.rotate +
                '<span>一键回滚快照</span></button>'
              : '') +
            (canMerge
              ? '<button type="button" class="mwh-btn mwh-btn-primary" data-action="task-merge" data-id="' +
                esc(task.worktreeId) +
                '">' +
                ICON.merge +
                '<span>合并 Worktree</span></button>'
              : '') +
            '</div>'
          : '');
    }
  }

  root.innerHTML = inner;
  root.dataset.idle = isIdle ? '1' : '0';
  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'mwh-island-resize';
  root.appendChild(resizeHandle);
  root.classList.add('open');
  applyIslandLayout();
  scrollIslandLogToBottom(root);
}

/* ------------------------------------------------------------------ *
 * Render scheduler (SSE-safe, focus preserving)
 * ------------------------------------------------------------------ */

let renderScheduled = false;
let pendingForce = false;
let pendingDrawerOnly = false;

function scheduleRender(force) {
  if (force) pendingForce = true;
  if (renderScheduled) return;
  renderScheduled = true;
  const run = function () {
    renderScheduled = false;
    const forceNow = pendingForce;
    const drawerOnly = pendingDrawerOnly;
    pendingForce = false;
    pendingDrawerOnly = false;
    if (!drawerOnly) {
      renderDrawer();
      renderSubpanel(forceNow);
    }
    renderApprovalIsland();
    if (state.tourOpen) renderTour();
    applyThemeClass();
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else setTimeout(run, 16);
}

function renderAll(force) {
  state.subpanelDirty = false;
  renderDrawer();
  renderSubpanel(Boolean(force));
  renderApprovalIsland();
  if (state.tourOpen) renderTour();
  applyThemeClass();
}

/* ------------------------------------------------------------------ *
 * Spotlight Onboarding Tour (docs/DESIGN.md 4.9)
 * ------------------------------------------------------------------ */

function openTour() {
  ensureShell();
  if (!state.drawerOpen) {
    openDrawer();
  }
  state.tourOpen = true;
  state.tourStepIndex = 0;
  renderTour();
}

function closeTour() {
  if (!state.tourOpen) return;
  state.tourOpen = false;
  const overlay = document.getElementById('mwh-tour-overlay');
  if (overlay) {
    overlay.classList.remove('open');
    overlay.innerHTML = '';
  }
}

function stepTour(delta) {
  if (!state.tourOpen) return;
  const nextIdx = state.tourStepIndex + delta;
  if (nextIdx < 0) return;
  if (nextIdx >= TOUR_STEPS.length) {
    closeTour();
    return;
  }
  state.tourStepIndex = nextIdx;
  const step = TOUR_STEPS[state.tourStepIndex];
  if (step && step.id === 'advanced-center' && !state.activeSection) {
    state.activeSection = 'connectors';
    renderSubpanel(true);
  }
  renderTour();
}

function renderTour() {
  const overlay = document.getElementById('mwh-tour-overlay');
  if (!overlay) return;
  if (!state.tourOpen) {
    overlay.classList.remove('open');
    overlay.innerHTML = '';
    return;
  }
  const idx = Math.max(0, Math.min(TOUR_STEPS.length - 1, state.tourStepIndex || 0));
  const step = TOUR_STEPS[idx];
  let targetEl = document.querySelector('[data-tour-id="' + step.target + '"]');
  if (step.id === 'advanced-center' && state.activeSection) {
    const subpanelEl = document.getElementById('mwh-subpanel');
    if (subpanelEl && subpanelEl.classList.contains('open')) {
      targetEl = subpanelEl;
    }
  }

  const vw = Math.max(320, window.innerWidth || 1280);
  const vh = Math.max(240, window.innerHeight || 800);
  let spotTop = Math.round(vh * 0.25);
  let spotLeft = Math.round(vw * 0.25);
  let spotWidth = 280;
  let spotHeight = 120;

  if (targetEl && typeof targetEl.getBoundingClientRect === 'function') {
    const r = targetEl.getBoundingClientRect();
    if (r.width > 4 && r.height > 4) {
      const pad = 6;
      spotTop = Math.max(8, Math.round(r.top - pad));
      spotLeft = Math.max(8, Math.round(r.left - pad));
      spotWidth = Math.min(vw - spotLeft - 8, Math.round(r.width + pad * 2));
      spotHeight = Math.min(vh - spotTop - 8, Math.round(r.height + pad * 2));
    }
  }

  const cardW = Math.min(360, vw - 32);
  const cardH = 210;
  let cardLeft = spotLeft + spotWidth + 16;
  let cardTop = spotTop;
  if (cardLeft + cardW > vw - 16) {
    cardLeft = Math.max(16, spotLeft - cardW - 16);
  }
  if (cardLeft < 16 || (cardLeft + cardW > spotLeft && cardLeft < spotLeft + spotWidth)) {
    cardLeft = Math.max(16, Math.min(vw - cardW - 16, spotLeft));
    cardTop = spotTop + spotHeight + 14;
    if (cardTop + cardH > vh - 16) {
      cardTop = Math.max(16, spotTop - cardH - 14);
    }
  }
  cardTop = Math.max(16, Math.min(vh - cardH - 16, cardTop));

  const dotsHtml = TOUR_STEPS.map(function (s, i) {
    return '<span class="mwh-tour-dot' + (i === idx ? ' active' : '') + '" title="' + esc(s.title) + '"></span>';
  }).join('');

  const isFirst = idx === 0;
  const isLast = idx === TOUR_STEPS.length - 1;

  overlay.innerHTML =
    '<div class="mwh-tour-spotlight" style="top:' +
    spotTop +
    'px;left:' +
    spotLeft +
    'px;width:' +
    spotWidth +
    'px;height:' +
    spotHeight +
    'px"></div>' +
    '<div id="mwh-tour-card" class="mwh-tour-card' +
    (!state.themeDark ? ' mwh-light' : '') +
    '" role="dialog" aria-modal="true" aria-label="MWH 功能使用引导" style="top:' +
    cardTop +
    'px;left:' +
    cardLeft +
    'px">' +
    '<div class="mwh-row" style="margin-bottom:10px">' +
    '<span class="mwh-tour-step-badge">步骤 ' +
    (idx + 1) +
    ' / ' +
    TOUR_STEPS.length +
    '</span>' +
    '<div class="mwh-tour-dots">' +
    dotsHtml +
    '</div>' +
    '<button type="button" class="mwh-icon-btn" data-action="tour-close" title="结束引导 (Esc)" aria-label="结束引导">' +
    ICON.close +
    '</button>' +
    '</div>' +
    '<div style="font-size:14px;font-weight:600;color:var(--mwh-text);margin-bottom:6px">' +
    esc(step.title) +
    '</div>' +
    '<div class="mwh-hint" style="font-size:12px;line-height:1.6;margin-bottom:14px">' +
    esc(step.body) +
    '</div>' +
    '<div class="mwh-row" style="justify-content:space-between">' +
    '<button type="button" class="mwh-btn mwh-btn-ghost" data-action="tour-close" style="font-size:11.5px;padding:6px 10px">跳过引导</button>' +
    '<div style="display:flex;align-items:center;gap:6px">' +
    (!isFirst
      ? '<button type="button" class="mwh-btn" data-action="tour-prev" style="font-size:11.5px;padding:6px 12px">上一步</button>'
      : '') +
    '<button type="button" class="mwh-btn mwh-btn-primary" data-action="' +
    (isLast ? 'tour-close' : 'tour-next') +
    '" style="font-size:11.5px;padding:6px 14px">' +
    (isLast ? '完成引导' : '下一步') +
    '</button>' +
    '</div>' +
    '</div>' +
    '</div>';
  overlay.classList.add('open');
}

function setLoading(actionName) {
  state.ui.loadingAction = actionName;
  scheduleRender(false);
}

function clearLoading() {
  state.ui.loadingAction = null;
  scheduleRender(false);
}

let confirmResolver = null;

function showConfirmDialog(options) {
  return new Promise(function (resolve) {
    confirmResolver = resolve;
    let modalEl = document.getElementById('mwh-confirm-dialog');
    if (!modalEl) {
      modalEl = document.createElement('div');
      modalEl.id = 'mwh-confirm-dialog';
      modalEl.className = 'mwh-confirm-dialog-backdrop';
      document.body.appendChild(modalEl);
    }
    const danger = Boolean(options.danger);
    modalEl.innerHTML =
      '<div class="mwh-confirm-card">' +
      '<div class="mwh-confirm-icon' + (danger ? ' danger' : '') + '">' +
      (danger ? ICON.alert : ICON.shield) +
      '</div>' +
      '<div class="mwh-confirm-title">' + esc(options.title || '安全确认') + '</div>' +
      '<div class="mwh-confirm-message">' + esc(options.message || '') + '</div>' +
      '<div class="mwh-confirm-actions">' +
      '<button type="button" class="mwh-btn mwh-btn-ghost" id="mwh-confirm-cancel">' + esc(options.cancelText || '取消') + '</button>' +
      '<button type="button" class="mwh-btn ' + (danger ? 'mwh-btn-danger' : 'mwh-btn-primary') + '" id="mwh-confirm-ok">' + esc(options.confirmText || '确定') + '</button>' +
      '</div>' +
      '</div>';
    modalEl.classList.add('open');
    modalEl.querySelector('#mwh-confirm-cancel').onclick = function () {
      modalEl.classList.remove('open');
      if (confirmResolver) confirmResolver(false);
      confirmResolver = null;
    };
    modalEl.querySelector('#mwh-confirm-ok').onclick = function () {
      modalEl.classList.remove('open');
      if (confirmResolver) confirmResolver(true);
      confirmResolver = null;
    };
  });
}

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

/** daemonFetch 失败时返回 { ok:false }，ipc invoke 不抛。不检查的话按钮会弹出假成功。 */
function daemonFailure(res) {
  if (!res || typeof res !== 'object') return '宿主无响应';
  if (res.ok === false) {
    return String(res.error || res.message || res.reason || ('HTTP ' + (res.status || '失败')));
  }
  return '';
}

async function invokeDaemon(channel, payload) {
  const invoke = ipcRenderer.invoke.bind(ipcRenderer);
  const res = await invoke(channel, payload);
  const failure = daemonFailure(res);
  if (failure) throw new Error(failure);
  return res;
}

async function invokeSetProfile(profileId) {
  const prof = PERMISSION_PROFILE_MAP[profileId];
  if (!prof) return;
  if (profileId === 'full-access') {
    const ok = await showConfirmDialog({
      title: '高风险安全确认',
      message: '警告：完全访问模式将解除授权工作区围栏，跨盘普通文件读写与命令直接静默执行，仅格式化等极端破坏性操作保留拦截。是否确认切换？',
      danger: true,
      confirmText: '确认切换',
    });
    if (!ok) return;
  }
  setLoading('switch_mode_' + profileId);
  try {
    await invokeDaemon('mwh:set-mode', {
      profile: prof.id,
      mode: prof.confinementMode,
      approvalPolicy: prof.approvalPolicy,
    });
    await refreshSettings();
    showToast('已切换到「' + (prof.cleanTitle || prof.shortLabel || prof.id) + '」');
  } catch (err) {
    showToast('切换失败: ' + String((err && err.message) || err));
  } finally {
    clearLoading();
  }
}

async function refreshSettings() {
  try {
    const res = await invokeDaemon('mwh:get-settings');
    const looksLikeState = Boolean(res && (res.confinementMode || res.daemon || res.tunnel));
    if (!looksLikeState) throw new Error('宿主返回的不是控制面状态');
    state.settings = normalizeSettings(res);
    state.settingsLive = true;
    state.settingsError = '';
    const conn = evaluateMuseConnection(state.settings);
    updatePcStatusDot(conn.connected, conn.text);
  } catch (err) {
    state.settingsLive = false;
    state.settingsError = String((err && err.message) || err || '宿主未就绪');
    updatePcStatusDot(false, state.settingsError);
  }
  scheduleRender(false);
}

async function handleSubpanelAction(action, target) {
  const settings = getSettings();
  const draft = state.ui.tunnelDraft || defaultTunnelDraft(settings);

  if (action === 'close-subpanel') {
    closeSecondaryPanel();
    scheduleRender(false);
    return;
  }
  // 表单布尔项统一走开关（role="switch" 的 button）。点击不会触发 input/change
  // 监听，因此状态必须在这里翻转；焦点由 renderSubpanel 依据 activeElement 还原。
  if (action === 'switch-bind' || action === 'switch-bind-row') {
    const switchBind = target.getAttribute('data-bind') || '';
    if (!switchBind) return;
    const switchNode = resolveSwitchNode(target);
    // 这三个布尔值只影响开关外观与提交载荷，面板内没有第二处依赖它们，
    // 因此就地改 class 即可，**不重绘**——重绘会把节点换掉，过渡就没了。
    if (switchBind.indexOf('acp.') === 0 && switchBind.slice(4) === 'enabled') {
      state.ui.acp.enabled = !state.ui.acp.enabled;
      paintSwitch(switchNode, state.ui.acp.enabled);
      return;
    }
    if (switchBind.indexOf('resource.') === 0) {
      if (!state.ui.resourceForm) state.ui.resourceForm = defaultResourceForm();
      const switchKey = switchBind.slice(9);
      if (switchKey === 'enabled' || switchKey === 'readonly') {
        state.ui.resourceForm[switchKey] = !state.ui.resourceForm[switchKey];
        paintSwitch(switchNode, state.ui.resourceForm[switchKey]);
        return;
      }
    }
    return;
  }
  if (action === 'copy') {
    const copyVal = target.getAttribute('data-copy');
    if (copyVal && copyVal.includes('****')) {
      const realTok = await fetchRealTokenIfNeeded();
      copyText(realTok || copyVal, '已复制完整真实 Bearer Token');
      return;
    }
    copyText(copyVal, '已复制到剪贴板');
    return;
  }
  if (action === 'copy-real-token') {
    const realTok = await fetchRealTokenIfNeeded();
    if (realTok) {
      copyText(realTok, '已复制完整真实 Bearer Token 到剪贴板');
    } else {
      showToast('获取 Token 失败');
    }
    return;
  }
  if (action === 'toggle-token-peek') {
    isTokenPeeked = !isTokenPeeked;
    if (isTokenPeeked && !cachedRealToken) {
      await fetchRealTokenIfNeeded();
    }
    schedulePeekAutoHide();
    scheduleRender(true);
    return;
  }
  if (action === 'toggle-endpoint-peek') {
    isEndpointPeeked = !isEndpointPeeked;
    schedulePeekAutoHide();
    scheduleRender(true);
    return;
  }
  if (action === 'open-tour') {
    openTour();
    return;
  }
  if (action === 'tour-prev') {
    stepTour(-1);
    return;
  }
  if (action === 'tour-next') {
    stepTour(1);
    return;
  }
  if (action === 'tour-close') {
    closeTour();
    return;
  }
  if (action === 'copy-pairing') {
    // Never emit pairing instructions built from default/placeholder state:
    // a stale endpoint in the copied prompt looks "paired" but can never work.
    if (!state.settingsLive) {
      showToast('宿主未连接，无法生成配对信息；请先运行 MWH启动.cmd 并确认页脚显示「宿主守护就绪」');
      return;
    }
    await fetchRealTokenIfNeeded();
    const pairing = generatePairingArtifacts(
      getActiveBaseUrl(settings),
      settings.confinementMode,
      settings.workspaceRoots,
      settings.approvalPolicy,
      cachedRealToken
    );
    copyText(pairing.skillMarkdownPrompt, '已复制无密钥 SKILL.md 配对说明');
    return;
  }
  if (action === 'copy-mcp-json') {
    if (!state.settingsLive) {
      showToast('宿主未连接，无法生成 MCP JSON；请先运行 MWH启动.cmd 并确认页脚显示「宿主守护就绪」');
      return;
    }
    await fetchRealTokenIfNeeded();
    const pairing = generatePairingArtifacts(
      getActiveBaseUrl(settings),
      settings.confinementMode,
      settings.workspaceRoots,
      settings.approvalPolicy,
      cachedRealToken
    );
    copyText(pairing.mcpJsonConfig, '已复制 MCP JSON 配置 (含真实 Token)');
    return;
  }
  if (action === 'stop-quick') {
    setLoading('stop_quick');
    try {
      await invokeDaemon('mwh:set-tunnel-driver', {
        driver: 'cloudflare-quick',
        config: { stopQuick: true },
      });
      showToast('临时公网隧道已停止');
      await refreshSettings();
    } catch (e) {
      showToast('停止失败: ' + String((e && e.message) || e));
    } finally {
      clearLoading();
    }
    return;
  }
  if (action === 'switch-subpanel-tab') {
    const sec = target.getAttribute('data-section');
    if (sec) {
      state.activeSection = sec;
      renderSubpanel(true);
    }
    return;
  }
  if (action === 'open-advanced-modal' || action === 'open-advanced') {
    const sec =
      target.getAttribute('data-section') ||
      (target.closest('[data-section]') &&
        target.closest('[data-section]').getAttribute('data-section'));
    state.activeSection = sec || state.activeSection || 'connectors';
    renderSubpanel(true);
    return;
  }
  if (action === 'set-driver') {
    const driver = target.getAttribute('data-driver');
    if (!driver) return;
    setLoading('set_driver_' + driver);
    try {
      await invokeDaemon('mwh:set-tunnel-driver', { driver: driver, config: {} });
      await refreshSettings();
    } catch (err) {
      showToast('切换驱动失败: ' + String((err && err.message) || err));
    } finally {
      clearLoading();
    }
    return;
  }
  if (action === 'save-tunnel-config') {
    const driver = settings.tunnel.activeDriver;
    const config = {};
    if (driver === 'cloudflare-named') {
      config.cfNamedDomain = draft.cfNamedDomain;
      if (draft.cfNamedToken) config.cfNamedToken = draft.cfNamedToken;
    } else if (driver === 'tailscale-funnel') {
      config.tailscaleIp = draft.tailscaleIp;
      config.tailscaleMagicDns = draft.tailscaleMagicDns;
    } else if (driver === 'custom-tls') {
      config.customPublicUrl = draft.customPublicUrl;
    }
    setLoading('save_tunnel_config');
    try {
      const res = await invokeDaemon('mwh:set-tunnel-driver', { driver: driver, config: config });
      if (res && res.ok === false) showToast('保存失败: ' + String(res.error || '未知错误'));
      else showToast('隧道配置已保存');
      await refreshSettings();
    } finally {
      clearLoading();
    }
    return;
  }
  if (action === 'respawn-quick') {
    setLoading('respawn_quick');
    try {
      await invokeDaemon('mwh:set-tunnel-driver', {
        driver: 'cloudflare-quick',
        config: { spawnReal: true },
      });
      showToast('已请求重新拉起临时隧道');
      await refreshSettings();
    } finally {
      clearLoading();
    }
    return;
  }
  if (action === 'rotate-token') {
    const ok = await showConfirmDialog({
      title: '轮换重生成 Token',
      message: '轮换 Token 将生成全新密钥并使旧密钥立即失效，已连接的 Muse 客户端需更新。是否确认？',
      danger: true,
      confirmText: '确认轮换',
    });
    if (!ok) return;
    setLoading('rotate_token');
    try {
      const res = await invokeDaemon('mwh:rotate-token');
      if (res && res.ok && res.bearerToken) {
        cachedRealToken = res.bearerToken;
        copyText(res.bearerToken, '已轮换新 Token 并复制到剪贴板');
      } else {
        showToast('轮换失败: ' + String((res && res.error) || '未知错误'));
      }
      await refreshSettings();
    } finally {
      clearLoading();
    }
    return;
  }
  if (action === 'set-profile') {
    await invokeSetProfile(target.getAttribute('data-profile'));
    return;
  }
  if (action === 'toggle-auto-downgrade') {
    // 先按目标态上色让过渡立刻开始，等服务端确认后再重绘（重绘会换掉节点）。
    if (pendingSwitchKeys.has('auto-downgrade')) return;
    const downgradeOn = Boolean(settings.autoDowngradeTwoHours);
    const startedAt = Date.now();
    const switchEl = resolveSwitchNode(target);
    pendingSwitchKeys.set('auto-downgrade', startedAt);
    paintSwitch(switchEl, !downgradeOn);
    try {
      await invokeDaemon('mwh:toggle-auto-downgrade', { enabled: !downgradeOn });
      await holdSwitchMin(startedAt);
      await refreshSettings();
    } catch (err) {
      if (switchEl && switchEl.isConnected) paintSwitch(switchEl, downgradeOn);
      else scheduleRender(true);
      showToast('切换失败: ' + String((err && err.message) || err));
    } finally {
      pendingSwitchKeys.delete('auto-downgrade');
    }
    return;
  }
  if (action === 'emergency-kill') {
    const ok = await showConfirmDialog({
      title: '触发全局急停',
      message: '确认对所有受控 Win32 Job Object 进程树执行全局急停？',
      danger: true,
      confirmText: '立即急停',
    });
    if (!ok) return;
    setLoading('emergency_kill');
    try {
      await invokeDaemon('mwh:emergency-kill', {});
      showToast('已触发全局急停');
      await refreshSettings();
    } finally {
      clearLoading();
    }
    return;
  }
  if (action === 'workspace-add') {
    const value = String(state.ui.newWorkspaceInput || '').trim();
    if (!value) {
      showToast('请先输入本地绝对路径');
      return;
    }
    await invokeDaemon('mwh:workspace-add', { path: value });
    state.ui.newWorkspaceInput = '';
    await refreshSettings();
    return;
  }
  if (action === 'workspace-remove') {
    const path = target.getAttribute('data-path');
    if (!path) return;
    await invokeDaemon('mwh:workspace-remove', { path: path });
    await refreshSettings();
    return;
  }
  if (action === 'acp-open-create') {
    state.ui.acp = {
      open: true,
      editingId: null,
      id: '',
      displayName: '',
      command: '',
      args: '',
      enabled: true,
      probe: null,
      saving: false,
    };
    scheduleRender(true);
    return;
  }
  if (action === 'acp-edit') {
    const id = target.getAttribute('data-id');
    const profile = settings.acpProfiles.find(function (p) { return p.id === id; });
    if (!profile) return;
    state.ui.acp = {
      open: true,
      editingId: profile.id,
      id: profile.id,
      displayName: profile.display_name || profile.id,
      command: profile.command || '',
      args: (profile.args || []).join(' '),
      enabled: profile.enabled !== false,
      probe:
        profile.detected !== undefined
          ? { tested: true, available: profile.detected, path: profile.binaryPath, error: profile.error }
          : null,
      saving: false,
    };
    scheduleRender(true);
    return;
  }
  if (action === 'acp-cancel') {
    state.ui.acp.open = false;
    state.ui.acp.editingId = null;
    scheduleRender(true);
    return;
  }
  if (action === 'acp-probe') {
    const command = String(state.ui.acp.command || '').trim();
    if (!command) {
      showToast('请先填写可执行文件路径');
      return;
    }
    const res = await invokeDaemon('mwh:acp-probe', { command: command });
    state.ui.acp.probe = {
      tested: true,
      available: Boolean(res && res.available),
      path: res && res.path,
      error: res && res.error,
    };
    scheduleRender(true);
    return;
  }
  if (action === 'acp-save') {
    const acp = state.ui.acp;
    const id = String(acp.id || '').trim();
    const command = String(acp.command || '').trim();
    if (!id || !command) {
      showToast('代理标识与可执行文件路径不能为空');
      return;
    }
    acp.saving = true;
    scheduleRender(true);
    const args = String(acp.args || '')
      .split(/\s+/)
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
    const res = await invokeDaemon('mwh:acp-save', {
      id: id,
      display_name: String(acp.displayName || '').trim() || id,
      command: command,
      args: args,
      enabled: Boolean(acp.enabled),
      kind: 'custom',
    });
    acp.saving = false;
    if (res && res.ok === false) {
      showToast('保存失败: ' + String(res.error || '未知错误'));
      scheduleRender(true);
      return;
    }
    acp.open = false;
    showToast('ACP 代理已保存并热更新');
    await refreshSettings();
    return;
  }
  if (action === 'acp-toggle') {
    const id = target.getAttribute('data-id');
    const profile = settings.acpProfiles.find(function (p) { return p.id === id; });
    if (!profile) return;
    const pendingKey = 'acp:' + id;
    if (pendingSwitchKeys.has(pendingKey)) return;
    const acpWasOn = profile.enabled !== false;
    const startedAt = Date.now();
    const switchEl = resolveSwitchNode(target);
    pendingSwitchKeys.set(pendingKey, startedAt);
    paintSwitch(switchEl, !acpWasOn);
    try {
      await invokeDaemon('mwh:acp-toggle', { id: id, enabled: !acpWasOn });
      await holdSwitchMin(startedAt);
      await refreshSettings();
    } catch (err) {
      if (switchEl && switchEl.isConnected) paintSwitch(switchEl, acpWasOn);
      else scheduleRender(true);
      showToast('切换失败: ' + String((err && err.message) || err));
    } finally {
      pendingSwitchKeys.delete(pendingKey);
    }
    return;
  }
  if (action === 'acp-delete') {
    const id = target.getAttribute('data-id');
    if (!id) return;
    const ok = await showConfirmDialog({
      title: '删除自定义 ACP 代理',
      message: '确定要删除自定义 ACP 代理 "' + id + '" 吗？此操作将立即热更新移除。',
      danger: true,
      confirmText: '确认删除',
    });
    if (!ok) return;
    setLoading('acp_delete_' + id);
    try {
      await invokeDaemon('mwh:acp-delete', { id: id });
      await refreshSettings();
    } finally {
      clearLoading();
    }
    return;
  }
  if (action === 'resource-scan') {
    setLoading('resource_scan');
    try {
      const outcome = await daemonHttp('POST', '/api/v1/resources/scan');
      const addedCount = Array.isArray(outcome.added) ? outcome.added.length : 0;
      showToast('扫描完成：发现 ' + (outcome.discovered || 0) + ' 项，新添加 ' + addedCount + ' 项');
      await refreshSettings();
    } catch (err) {
      showToast('扫描失败: ' + String((err && err.message) || err));
    } finally {
      clearLoading();
    }
    return;
  }
  if (action === 'resource-open-add') {
    state.ui.resourceForm = defaultResourceForm();
    state.ui.resourceForm.open = true;
    scheduleRender(true);
    return;
  }
  if (action === 'resource-open-edit') {
    const id = target.getAttribute('data-id');
    const entries =
      settings.resources && Array.isArray(settings.resources.entries)
        ? settings.resources.entries
        : [];
    const entry = entries.find(function (e) {
      return e.id === id;
    });
    if (!entry) return;
    state.ui.resourceForm = {
      open: true,
      editingId: entry.id,
      kind: entry.kind || 'mcp',
      transport: entry.transport || 'stdio',
      id: entry.id,
      displayName: entry.displayName || '',
      command: entry.command || '',
      args: (entry.args || []).join(' '),
      cwd: entry.cwd || '',
      httpUrl: entry.httpUrl || '',
      skillDir: entry.skillDirDisplay || '',
      readonly: entry.readonly === true,
      enabled: entry.enabled === true,
      probeResult: null,
      probing: false,
      saving: false,
    };
    scheduleRender(true);
    return;
  }
  if (action === 'resource-cancel') {
    if (state.ui.resourceForm) state.ui.resourceForm.open = false;
    scheduleRender(true);
    return;
  }
  if (action === 'resource-set-kind') {
    if (!state.ui.resourceForm) state.ui.resourceForm = defaultResourceForm();
    state.ui.resourceForm.kind = target.getAttribute('data-kind');
    scheduleRender(true);
    return;
  }
  if (action === 'resource-set-transport') {
    if (!state.ui.resourceForm) state.ui.resourceForm = defaultResourceForm();
    state.ui.resourceForm.transport = target.getAttribute('data-transport');
    scheduleRender(true);
    return;
  }
  if (action === 'resource-probe') {
    const form = state.ui.resourceForm;
    if (!form) return;
    form.probing = true;
    scheduleRender(true);
    try {
      let params = {};
      if (form.kind === 'mcp') {
        if (form.transport === 'http') {
          params = { transport: 'http', httpUrl: String(form.httpUrl || '').trim() };
        } else {
          const args = String(form.args || '').split(/\s+/).filter(Boolean);
          params = {
            transport: 'stdio',
            command: String(form.command || '').trim(),
            args: args,
            cwd: String(form.cwd || '').trim() || undefined,
          };
        }
      } else {
        params = { kind: 'skill', skillDir: String(form.skillDir || '').trim() };
      }
      const res = await daemonHttp('POST', '/api/v1/resources/probe', params);
      form.probeResult = res;
    } catch (err) {
      form.probeResult = { ok: false, error: String((err && err.message) || err) };
    } finally {
      form.probing = false;
      scheduleRender(true);
    }
    return;
  }
  if (action === 'resource-save') {
    const form = state.ui.resourceForm;
    if (!form) return;
    const disp = String(form.displayName || '').trim();
    if (!disp && !form.editingId) {
      showToast('显示名称不能为空');
      return;
    }
    form.saving = true;
    scheduleRender(true);
    try {
      if (form.editingId) {
        const patch = {
          displayName: disp || form.editingId,
          command: String(form.command || '').trim(),
          args: String(form.args || '').split(/\s+/).filter(Boolean),
          cwd: String(form.cwd || '').trim() || undefined,
          httpUrl: String(form.httpUrl || '').trim() || undefined,
          // 后端契约（src/resources/manager.ts UpdateResourceInput）只认 skillDir
          skillDir: String(form.skillDir || '').trim() || undefined,
          readonly: Boolean(form.readonly),
        };
        await daemonHttp('POST', '/api/v1/resources/update', { id: form.editingId, ...patch });
      } else {
        const body = {
          id: form.id || disp,
          displayName: disp,
          kind: form.kind,
          transport: form.kind === 'mcp' ? form.transport : undefined,
          command: String(form.command || '').trim(),
          args: String(form.args || '').split(/\s+/).filter(Boolean),
          cwd: String(form.cwd || '').trim() || undefined,
          httpUrl: String(form.httpUrl || '').trim() || undefined,
          // 后端契约（src/resources/manager.ts AddResourceInput）：字段名是
          // skillDir 与 enable，写成 skillDirDisplay / enabled 会被静默丢弃。
          skillDir: String(form.skillDir || '').trim() || undefined,
          enable: Boolean(form.enabled),
          readonly: false,
        };
        await daemonHttp('POST', '/api/v1/resources', body);
      }
      form.open = false;
      showToast('资源已保存并生效');
      await refreshSettings();
    } catch (err) {
      showToast('保存失败: ' + String((err && err.message) || err));
    } finally {
      form.saving = false;
      scheduleRender(true);
    }
    return;
  }
  if (action === 'resource-toggle') {
    const id = target.getAttribute('data-id');
    const entries =
      settings.resources && Array.isArray(settings.resources.entries)
        ? settings.resources.entries
        : [];
    const entry = entries.find(function (e) {
      return e.id === id;
    });
    if (!entry) return;
    const pendingKey = 'res:' + id;
    if (pendingSwitchKeys.has(pendingKey)) return;
    const resWasOn = Boolean(entry.enabled);
    const startedAt = Date.now();
    const switchEl = resolveSwitchNode(target);
    pendingSwitchKeys.set(pendingKey, startedAt);
    paintSwitch(switchEl, !resWasOn);
    try {
      await daemonHttp('POST', '/api/v1/resources/toggle', { id: id, enabled: !resWasOn });
      await holdSwitchMin(startedAt);
      await refreshSettings();
    } catch (err) {
      if (switchEl && switchEl.isConnected) paintSwitch(switchEl, resWasOn);
      else scheduleRender(true);
      showToast('切换失败: ' + String((err && err.message) || err));
    } finally {
      pendingSwitchKeys.delete(pendingKey);
    }
    return;
  }
  if (action === 'resource-delete') {
    const id = target.getAttribute('data-id');
    if (!id) return;
    const ok = await showConfirmDialog({
      title: '删除资源',
      message: '确定要从资源库中移除 "' + id + '" 吗？此操作将立即生效。',
      danger: true,
      confirmText: '确认删除',
    });
    if (!ok) return;
    setLoading('resource_delete_' + id);
    try {
      await daemonHttp('DELETE', '/api/v1/resources', { id: id });
      showToast('已删除资源 ' + id);
      await refreshSettings();
    } catch (err) {
      showToast('删除失败: ' + String((err && err.message) || err));
    } finally {
      clearLoading();
    }
    return;
  }
  if (action === 'resource-toggle-expand') {
    const id = target.getAttribute('data-id');
    if (!id) return;
    if (!state.ui.resourceExpanded) state.ui.resourceExpanded = {};
    state.ui.resourceExpanded[id] = !state.ui.resourceExpanded[id];
    scheduleRender(true);
    return;
  }
  if (action === 'worktree-spawn') {
    const preferredAcp = ((settings.acpProfiles || []).find(function (p) {
      return p.enabled !== false;
    }) || {}).id;
    await invokeDaemon('mwh:worktree-spawn', {
      agentId: preferredAcp || 'builtin',
      requestedMode: state.ui.requestedSpawnMode,
    });
    await refreshSettings();
    return;
  }
  if (action === 'worktree-merge') {
    await invokeDaemon('mwh:worktree-merge', { id: target.getAttribute('data-id') });
    await refreshSettings();
    return;
  }
  if (action === 'worktree-remove') {
    await invokeDaemon('mwh:worktree-remove', { id: target.getAttribute('data-id') });
    await refreshSettings();
    return;
  }
  if (action === 'worktree-page') {
    const id = target.getAttribute('data-id');
    const wt = settings.worktrees.find(function (w) { return w.id === id; });
    const pages = wt && Array.isArray(wt.stdoutPages) && wt.stdoutPages.length ? wt.stdoutPages.length : 1;
    state.ui.worktreePages[id] = ((state.ui.worktreePages[id] || 0) + 1) % pages;
    scheduleRender(true);
    return;
  }
  if (action === 'snapshot-rollback') {
    const id = target.getAttribute('data-id');
    if (!id) return;
    const ok = await showConfirmDialog({
      title: '回滚影子快照',
      message: '确认将工作区回滚至快照 ' + id + '？回滚将严格覆盖当前工作区。',
      danger: false,
      confirmText: '确认回滚',
    });
    if (!ok) return;
    setLoading('rollback_' + id);
    try {
      await invokeDaemon('mwh:snapshot-rollback', { id: id });
      showToast('已回滚至快照 ' + id);
      await refreshSettings();
    } catch (err) {
      showToast('回滚失败: ' + String((err && err.message) || err));
    } finally {
      clearLoading();
    }
    return;
  }
  if (action === 'snapshot-toggle-group') {
    const key = target.getAttribute('data-key');
    if (!key) return;
    state.ui.collapsedGroups[key] = !state.ui.collapsedGroups[key];
    scheduleRender(true);
    return;
  }
  if (action === 'snapshot-toggle-all-groups') {
    const snapshots = settings.snapshots || [];
    const groups = groupSnapshotsForSelection(snapshots);
    const allCollapsed =
      groups.length > 0 &&
      groups.every(function (g) {
        return Boolean(state.ui.collapsedGroups[g.normKey]);
      });
    for (const g of groups) {
      state.ui.collapsedGroups[g.normKey] = !allCollapsed;
    }
    scheduleRender(true);
    return;
  }
  if (action === 'snapshot-show-all-group') {
    const key = target.getAttribute('data-key');
    if (!key) return;
    // 只放开该目录，不动全局「每组显示 N 条」，避免其他目录跟着一起铺满
    state.ui.expandedSnapshotGroups[key] = true;
    scheduleRender(true);
    return;
  }
  if (action === 'snapshot-select-all') {
    const snapshots = settings.snapshots;
    const ids = [];
    for (const group of groupSnapshotsForSelection(snapshots)) {
      if (state.ui.collapsedGroups[group.normKey]) continue;
      for (const snap of snapshotVisibleItems(group)) ids.push(snap.id);
    }
    const allSelected = ids.length > 0 && ids.every(function (id) { return state.ui.selectedSnapshotIds[id]; });
    if (allSelected) {
      for (const id of ids) delete state.ui.selectedSnapshotIds[id];
    } else {
      for (const id of ids) state.ui.selectedSnapshotIds[id] = true;
    }
    scheduleRender(true);
    return;
  }
  if (action === 'snapshot-delete-selected') {
    const snapshots = settings.snapshots;
    const existing = new Set(snapshots.map(function (s) { return s.id; }));
    const ids = Object.keys(state.ui.selectedSnapshotIds).filter(function (id) {
      return state.ui.selectedSnapshotIds[id] && existing.has(id);
    });
    if (ids.length === 0) return;
    const confirmed = await showConfirmDialog({
      title: '删除所选快照',
      message:
        '将永久删除已选 ' +
        ids.length +
        ' 条写前影子快照记录，磁盘会释放对应空间；删除后无法再回滚到这些检查点（你的代码不受影响）。是否确认？',
      danger: true,
      confirmText: '删除 ' + ids.length + ' 条',
    });
    if (!confirmed) return;
    await invokeDaemon('mwh:snapshot-delete', { ids: ids });
    state.ui.selectedSnapshotIds = {};
    await refreshSettings();
    return;
  }
  if (action === 'snapshot-prune') {
    const keep = state.ui.perGroupLimit > 0 ? state.ui.perGroupLimit : 5;
    const confirmed = await showConfirmDialog({
      title: '磁盘瘦身（清理旧快照）',
      message:
        '将按工作区仅保留最近 ' +
        keep +
        ' 条快照记录，更早的历史快照会被永久清除以释放磁盘空间。此操作只删快照、不改动你的代码。是否继续？',
      danger: true,
      confirmText: '清理旧快照',
    });
    if (!confirmed) return;
    await invokeDaemon('mwh:snapshot-prune', { keepRecent: keep });
    state.ui.selectedSnapshotIds = {};
    await refreshSettings();
    return;
  }
  if (action === 'audit-filter') {
    state.ui.auditFilter = target.getAttribute('data-filter') || 'ALL';
    scheduleRender(true);
    return;
  }
}

/**
 * 勾选/取消单条快照后就地同步批量操作栏的可用态，避免整面板重绘导致滚动位置丢失。
 * 计数、删除按钮 disabled 与数量、全选按钮文案三者必须跟 state 保持一致。
 */
function syncSnapshotSelectionControls() {
  const subpanel = document.getElementById('mwh-subpanel');
  if (!subpanel) return;
  const snapshots = (getSettings() || {}).snapshots || [];
  const existing = new Set(
    snapshots.map(function (s) {
      return s.id;
    }),
  );
  const selected = state.ui.selectedSnapshotIds || {};
  let count = 0;
  for (const key of Object.keys(selected)) {
    if (selected[key] && existing.has(key)) count += 1;
  }
  const counter = subpanel.querySelector('[data-selected-count]');
  if (counter) counter.textContent = '已选 ' + count + ' 条记录';

  const deleteBtn = subpanel.querySelector('[data-action="snapshot-delete-selected"]');
  if (deleteBtn) {
    deleteBtn.disabled = count === 0;
    const label = deleteBtn.querySelector('[data-delete-label]');
    if (label) label.textContent = count > 0 ? '删除所选记录 (' + count + ')' : '删除所选记录';
  }

  const selectAllBtn = subpanel.querySelector('[data-action="snapshot-select-all"]');
  if (selectAllBtn) {
    const visibleIds = [];
    for (const group of groupSnapshotsForSelection(snapshots)) {
      if (state.ui.collapsedGroups[group.normKey]) continue;
      for (const snap of snapshotVisibleItems(group)) visibleIds.push(snap.id);
    }
    const allSelected =
      visibleIds.length > 0 &&
      visibleIds.every(function (id) {
        return Boolean(selected[id]);
      });
    selectAllBtn.textContent = allSelected ? '取消全选' : '全选当前可见';
    selectAllBtn.disabled = visibleIds.length === 0;
  }
}

/** 某个分组当前真正渲染出来的条目：默认截前 N 条，用户点过「查看其余」则全量。 */
function snapshotVisibleItems(group) {
  if (!group || !Array.isArray(group.items)) return [];
  const expanded = state.ui.expandedSnapshotGroups || {};
  if (expanded[group.normKey]) return group.items;
  const limit = Number(state.ui.perGroupLimit) || 0;
  return limit > 0 ? group.items.slice(0, limit) : group.items;
}

function groupSnapshotsForSelection(snapshots) {
  const order = [];
  const map = new Map();
  const clean = (snapshots || []).filter(function (snap) {
    const p = String(snap.workspacePath || '').toLowerCase();
    if (p.includes('\\appdata\\local\\temp') || p.includes('/appdata/local/temp')) return false;
    if (p.includes('mwh_ext_test_')) return false;
    return true;
  });
  const effective = clean.length > 0 ? clean : snapshots;
  const sorted = effective.slice().sort(function (a, b) {
    const ta = Date.parse(a.timestamp);
    const tb = Date.parse(b.timestamp);
    if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb) {
      return state.ui.snapshotSort === 'oldest' ? ta - tb : tb - ta;
    }
    return 0;
  });
  for (const snap of sorted) {
    const info = normalizeWinPath(snap.workspacePath);
    let group = map.get(info.normKey);
    if (!group) {
      group = { normKey: info.normKey, items: [] };
      map.set(info.normKey, group);
      order.push(group);
    }
    group.items.push(snap);
  }
  return order;
}

async function handleIslandAction(action, target) {
  const settings = getSettings();
  const task = settings.liveTask || emptyLiveTask();
  const root = task.targetPath || settings.workspaceRoots[0];

  if (action === 'task-reject') {
    await invokeDaemon('mwh:task-reject', { id: task.id });
    await refreshSettings();
    return;
  }
  if (action === 'task-approve-once') {
    await invokeDaemon('mwh:task-approve', { id: task.id, scope: 'once', root: root });
    await refreshSettings();
    return;
  }
  if (action === 'task-approve-workspace') {
    await invokeDaemon('mwh:task-approve', { id: task.id, scope: 'workspace', root: root });
    await refreshSettings();
    return;
  }
  if (action === 'task-kill') {
    await invokeDaemon('mwh:task-kill', { id: task.id });
    await refreshSettings();
    return;
  }
  if (action === 'task-rollback') {
    const id = target.getAttribute('data-id');
    if (!id) return;
    await invokeDaemon('mwh:snapshot-rollback', { id: id });
    await refreshSettings();
    return;
  }
  if (action === 'task-merge') {
    const id = target.getAttribute('data-id');
    if (!id) return;
    await invokeDaemon('mwh:worktree-merge', { id: id });
    await refreshSettings();
    return;
  }
  if (action === 'task-collapse') {
    setIslandCapsule(true);
    return;
  }
  if (action === 'task-dismiss') {
    task.status = 'IDLE';
    state.settings.liveTask = task;
    renderApprovalIsland();
  }
}

async function handleDrawerAction(action, target) {
  if (action === 'close-drawer') {
    closeDrawer();
    return;
  }
  if (action === 'set-profile') {
    await invokeSetProfile(target.getAttribute('data-profile'));
    return;
  }
  await handleSubpanelAction(action, target);
}

/* ------------------------------------------------------------------ *
 * Bindings
 * ------------------------------------------------------------------ */

function bindBindings() {
  const subpanel = document.getElementById('mwh-subpanel');
  if (!subpanel || subpanel.dataset.bound === '1') return;
  subpanel.dataset.bound = '1';

  subpanel.addEventListener('click', function (event) {
    const target = event.target.closest('[data-action]');
    if (!target) return;
    event.stopPropagation();
    handleSubpanelAction(target.getAttribute('data-action'), target).catch(function (err) {
      showToast(String((err && err.message) || err || '操作失败'));
    });
  });

  subpanel.addEventListener('input', function (event) {
    const node = event.target;
    const bind = node.getAttribute('data-bind');
    if (!bind) return;
    const value = node.type === 'checkbox' ? node.checked : node.value;
    if (bind === 'ws-input') {
      state.ui.newWorkspaceInput = value;
      return;
    }
    if (bind.indexOf('tunnel.') === 0) {
      if (!state.ui.tunnelDraft) state.ui.tunnelDraft = defaultTunnelDraft(getSettings());
      state.ui.tunnelDraft[bind.slice(7)] = value;
      return;
    }
    if (bind.indexOf('acp.') === 0) {
      const key = bind.slice(4);
      if (key === 'enabled') state.ui.acp.enabled = Boolean(value);
      else if (key === 'name') state.ui.acp.displayName = value;
      else state.ui.acp[key] = value;
      return;
    }
    if (bind.indexOf('resource.') === 0) {
      if (!state.ui.resourceForm) state.ui.resourceForm = defaultResourceForm();
      const key = bind.slice(9);
      if (key === 'enabled' || key === 'readonly') state.ui.resourceForm[key] = Boolean(value);
      else state.ui.resourceForm[key] = value;
      return;
    }
  });

  subpanel.addEventListener('change', function (event) {
    const node = event.target;
    const bind = node.getAttribute('data-bind');
    if (bind && bind.indexOf('resource.') === 0 && node.type === 'checkbox') {
      if (!state.ui.resourceForm) state.ui.resourceForm = defaultResourceForm();
      const key = bind.slice(9);
      state.ui.resourceForm[key] = Boolean(node.checked);
      return;
    }
    const changeAction = node.getAttribute('data-action-change');
    if (!changeAction) return;
    if (changeAction === 'snapshot-select') {
      const id = node.getAttribute('data-id');
      if (!id) return;
      state.ui.selectedSnapshotIds[id] = node.checked;
      syncSnapshotSelectionControls();
      return;
    }
    if (changeAction === 'snapshot-sort') {
      state.ui.snapshotSort = node.value;
      scheduleRender(true);
      return;
    }
    if (changeAction === 'snapshot-limit') {
      state.ui.perGroupLimit = Number(node.value) || 0;
      scheduleRender(true);
      return;
    }
    if (changeAction === 'worktree-mode') {
      state.ui.requestedSpawnMode = node.value;
      return;
    }
  });

  subpanel.addEventListener('focusout', function () {
    if (!state.subpanelDirty) return;
    setTimeout(function () {
      const body = document.getElementById('mwh-subpanel-body');
      if (body && body.contains(document.activeElement)) return;
      renderSubpanel(true);
    }, 0);
  });
}

function closeSecondaryPanel() {
  state.activeSection = null;
  state.ui.acp.open = false;
  const root = document.getElementById('mwh-subpanel');
  if (root) {
    root.classList.remove('open');
    root.innerHTML = '';
  }
}

function openDrawer() {
  ensureShell();
  fetchRealTokenIfNeeded().catch(function () {});
  state.drawerOpen = true;
  const backdrop = document.getElementById('mwh-drawer-backdrop');
  if (backdrop) backdrop.classList.add('open');
  const drawer = document.getElementById('mwh-drawer');
  if (drawer) drawer.classList.add('open');
  if (activityBtnEl) activityBtnEl.classList.add('active');
  refreshSettings().then(function () {
    if (!state.ui.tunnelDraft) state.ui.tunnelDraft = defaultTunnelDraft(getSettings());
    renderAll(true);
  });
}

function closeDrawer() {
  state.drawerOpen = false;
  resetPrivacyPeeks();
  closeTour();
  const backdrop = document.getElementById('mwh-drawer-backdrop');
  if (backdrop) backdrop.classList.remove('open');
  const drawer = document.getElementById('mwh-drawer');
  if (drawer) drawer.classList.remove('open');
  if (activityBtnEl) activityBtnEl.classList.remove('active');
  closeSecondaryPanel();
}

function toggleDrawer() {
  if (state.drawerOpen) closeDrawer();
  else openDrawer();
}

/* ------------------------------------------------------------------ *
 * Shell construction (drawer + subpanel + island + toast)
 * ------------------------------------------------------------------ */

let activityBtnEl = null;
let shellReady = false;

function ensureShell() {
  if (shellReady) return;
  shellReady = true;
  if (!document.getElementById('mwh-drawer-backdrop')) {
    const backdrop = document.createElement('div');
    backdrop.id = 'mwh-drawer-backdrop';
    backdrop.className = 'mwh-drawer-backdrop';
    backdrop.addEventListener('click', function () {
      closeDrawer();
    });
    document.body.appendChild(backdrop);
  }
  if (!document.getElementById('mwh-drawer')) {
    const drawer = document.createElement('div');
    drawer.id = 'mwh-drawer';
    drawer.className = 'mwh-drawer';
    drawer.addEventListener('click', function (event) {
      const target = event.target.closest('[data-action]');
      if (!target) return;
      event.stopPropagation();
      handleDrawerAction(target.getAttribute('data-action'), target).catch(function (err) {
        showToast(String((err && err.message) || err || '操作失败'));
      });
    });
    document.body.appendChild(drawer);
  }
  if (!document.getElementById('mwh-subpanel')) {
    const subpanel = document.createElement('div');
    subpanel.id = 'mwh-subpanel';
    subpanel.className = 'mwh-subpanel';
    document.body.appendChild(subpanel);
  }
  if (!document.getElementById('mwh-approval-island')) {
    const island = document.createElement('div');
    island.id = 'mwh-approval-island';
    island.className = 'mwh-approval-island';
    island.setAttribute('role', 'region');
    island.setAttribute('aria-label', 'MWH 底部任务与审批面板');
    island.setAttribute('data-tour-id', 'tour-approval-island');
    island.addEventListener('click', function (event) {
      const target = event.target.closest('[data-action]');
      if (!target) return;
      event.stopPropagation();
      handleIslandAction(target.getAttribute('data-action'), target).catch(function (err) {
        showToast(String((err && err.message) || err || '操作失败'));
      });
    });
    document.body.appendChild(island);
    bindIslandLayoutControls(island);
  }
  if (!document.getElementById('mwh-toast')) {
    const toast = document.createElement('div');
    toast.id = 'mwh-toast';
    toast.className = 'mwh-toast';
    document.body.appendChild(toast);
  }
  if (!document.getElementById('mwh-tour-overlay')) {
    const tourOverlay = document.createElement('div');
    tourOverlay.id = 'mwh-tour-overlay';
    tourOverlay.className = 'mwh-tour-overlay';
    tourOverlay.addEventListener('click', function (event) {
      const target = event.target.closest('[data-action]');
      if (!target) {
        if (event.target === tourOverlay) closeTour();
        return;
      }
      event.stopPropagation();
      handleSubpanelAction(target.getAttribute('data-action'), target).catch(function () {});
    });
    document.body.appendChild(tourOverlay);
  }
  bindBindings();
  detectAndSyncTheme(true);
  renderAll(true);
}

/* ------------------------------------------------------------------ *
 * Activity Bar Injection
 * ------------------------------------------------------------------ */

function findActivityBar() {
  const candidates = Array.from(
    document.querySelectorAll('nav, aside, [role="navigation"], div')
  ).filter(function (el) {
    if (el.id === 'mwh-activity-slot' || el.closest('#mwh-activity-slot')) return false;
    const rect = el.getBoundingClientRect();
    return rect.left >= -2 && rect.left <= 20 && rect.width >= 32 && rect.width <= 92 && rect.height > 200;
  });

  if (candidates.length === 0) return null;

  // Prefer semantic navigation landmarks, then vertical (column) side rails.
  const isSemantic = function (el) {
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    return tag === 'nav' || tag === 'aside' || el.getAttribute('role') === 'navigation';
  };
  const isColumn = function (el) {
    try {
      return getComputedStyle(el).flexDirection === 'column';
    } catch (err) {
      return false;
    }
  };

  const semantics = candidates.filter(isSemantic);
  const columns = candidates.filter(isColumn);

  if (semantics.length > 0) {
    // Innermost (deepest) semantic rail wins (fewest nested semantic landmarks).
    semantics.sort(function (a, b) {
      return (
        a.querySelectorAll('nav, aside, [role="navigation"]').length -
        b.querySelectorAll('nav, aside, [role="navigation"]').length
      );
    });
    return semantics[0];
  }
  if (columns.length > 0) {
    // Innermost column container: the one with the fewest descendants.
    columns.sort(function (a, b) {
      return a.querySelectorAll('*').length - b.querySelectorAll('*').length;
    });
    return columns[0];
  }

  candidates.sort(function (a, b) {
    return (
      b.querySelectorAll('svg, button, [role="button"]').length -
      a.querySelectorAll('svg, button, [role="button"]').length
    );
  });
  return candidates[0];
}

function tryAttachToActivityBar() {
  const bar = findActivityBar();
  if (!bar) return;

  let btn = document.getElementById('mwh-activity-btn');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'mwh-activity-btn';
    btn.type = 'button';
    btn.className = 'mwh-activity-btn mwh-disconnected';
    btn.setAttribute('aria-label', 'MWH 本地宿主');
    btn.setAttribute('data-tour-id', 'tour-activity-entry');
    btn.innerHTML =
      SVG_LOGO + '<div class="mwh-tooltip">本地宿主 (MWH) · 未连接 PC</div>';

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      toggleDrawer();
    });
    activityBtnEl = btn;
  }
  const initConn = evaluateMuseConnection(state.settings);
  updatePcStatusDot(initConn.connected, initConn.text);

  let slot = document.getElementById('mwh-activity-slot');
  if (slot && bar.contains(slot) && slot.contains(btn)) {
    return; // Already mounted in a stable, centred slot inside bar — never thrash the DOM.
  }
  if (!slot) {
    slot = document.createElement('div');
    slot.id = 'mwh-activity-slot';
    slot.className = 'mwh-activity-slot';
  }
  if (btn.parentNode !== slot) slot.appendChild(btn);

  // Prefer the bottom action container of the activity bar (flex column layout);
  // otherwise insert before the last direct child so the logo sits above it.
  const actionContainer = bar.querySelector(
    '[class*="footer"], [class*="bottom"], [class*="actions"], [class*="settings"]'
  );
  if (actionContainer && actionContainer !== bar) {
    const lastAction = actionContainer.lastElementChild;
    if (lastAction && lastAction !== slot) actionContainer.insertBefore(slot, lastAction);
    else if (!lastAction) actionContainer.appendChild(slot);
    return;
  }
  const lastChild = bar.lastElementChild;
  if (lastChild && lastChild !== slot) bar.insertBefore(slot, lastChild);
  else if (!lastChild) bar.appendChild(slot);
}

/* ------------------------------------------------------------------ *
 * Fallback settings tab injection (untouched Muse settings dialog)
 * ------------------------------------------------------------------ */

function tryAttachToModal(modalEl) {
  if (modalEl.querySelector('.mwh-inject-tab')) return;

  const navContainer = modalEl.querySelector(
    'nav, [role="tablist"], ul, aside, [class*="sidebar"], [class*="nav"]'
  );
  if (!navContainer) return;

  let contentContainer = modalEl.querySelector(
    '[role="tabpanel"], [class*="content"], [class*="main"], [class*="body"]'
  );
  if (!contentContainer || contentContainer === navContainer) contentContainer = modalEl;

  const tab = document.createElement('div');
  tab.className = 'mwh-inject-tab';
  tab.innerHTML = SVG_LOGO + '<span>本地宿主 (MWH)</span>';
  tab.addEventListener('click', function (e) {
    e.stopPropagation();
    navContainer.querySelectorAll('.active').forEach(function (el) {
      el.classList.remove('active');
    });
    tab.classList.add('active');
    openDrawer();
  });

  navContainer.appendChild(tab);
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

function tickCountdown() {
  const settings = state.settings;
  if (!settings) return;
  if (settings.autoDowngradeTwoHours && settings.autoDowngradeRemainingSec > 0) {
    settings.autoDowngradeRemainingSec = Math.max(0, settings.autoDowngradeRemainingSec - 1);
    const nodes = document.querySelectorAll('[data-countdown]');
    nodes.forEach(function (node) {
      if (node.classList.contains('mwh-pill')) {
        node.innerHTML =
          ICON.shield + '<span>2h 自动降级 · ' + esc(remainingText(settings.autoDowngradeRemainingSec)) + '</span>';
      } else {
        node.textContent = '剩余计时: ' + remainingText(settings.autoDowngradeRemainingSec);
      }
    });
  }
}

function initObservers() {
  injectStyles();
  ensureShell();
  tryAttachToActivityBar();

  const observer = new MutationObserver(function () {
    tryAttachToActivityBar();
    const existingModal = document.querySelector('[role="dialog"], dialog, [class*="settings"]');
    if (existingModal) tryAttachToModal(existingModal);
  });
  observer.observe(document.body || document.documentElement, { childList: true, subtree: true });

  const themeObserver = new MutationObserver(function () {
    detectAndSyncTheme(false);
  });
  if (document.documentElement) {
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme', 'data-color-scheme'],
    });
  }
  if (document.body) {
    themeObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['class', 'data-theme', 'data-color-scheme'],
    });
  }

  window.addEventListener('keydown', function (e) {
    if (state.tourOpen) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeTour();
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        stepTour(1);
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        stepTour(-1);
        return;
      }
    }
    if (e.key === 'Escape') closeDrawer();
  });

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) detectAndSyncTheme(false);
  });

  ipcRenderer.on('mwh:open-drawer', function () {
    openDrawer();
  });

  ipcRenderer.on('mwh:state-patch', function (_event, patch) {
    mergePatch(patch);
    scheduleRender(false);
  });

  setInterval(tickCountdown, 1000);

  // Initial settings pull (the SSE stream will keep it fresh afterwards).
  refreshSettings().then(function () {
    if (!state.ui.tunnelDraft) state.ui.tunnelDraft = defaultTunnelDraft(getSettings());
    renderAll(true);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initObservers);
} else {
  initObservers();
}
