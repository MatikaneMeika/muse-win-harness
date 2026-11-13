import type { SupportedLocale } from '../i18n/types';

export type ConfinementMode =
  | 'read-only'
  | 'workspace-write'
  | 'workspace-acl-experimental'
  | 'danger-full-access';

export type ApprovalPolicy =
  | 'always-ask'
  | 'smart-risk'
  | 'auto-workspace'
  | 'unattended-yolo';

export type PermissionProfileId =
  | 'plan'
  | 'confirm'
  | 'autonomous'
  | 'full-access';

export type TunnelDriverType =
  | 'cloudflare-named'
  | 'cloudflare-quick'
  | 'tailscale-funnel'
  | 'custom-tls';

export type AuditDecision = 'ALLOW' | 'ASK' | 'BLOCK';

export interface PermissionProfileMetadata {
  id: PermissionProfileId;
  confinementMode: ConfinementMode;
  approvalPolicy: ApprovalPolicy;
  level: 1 | 2 | 3 | 4;
  shortLabel: string;
  pillText: string;
  dotColorClass: string;
  title: string;
  subtitle: string;
  enforcedProtections: string[];
  uncoveredBoundaries: string[];
}

export const PERMISSION_PROFILE_LIST: PermissionProfileMetadata[] = [
  {
    id: 'plan',
    confinementMode: 'read-only',
    approvalPolicy: 'smart-risk',
    level: 1,
    shortLabel: '计划模式',
    pillText: '本地 PC · 计划模式',
    dotColorClass: 'bg-[#38BDF8]',
    title: '计划模式（只读，先计划再改）',
    subtitle: '仅允许读取工作区文件、检索代码与只读状态查询，先制定方案再动手，拦截一切文件修改与写入命令。',
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
    level: 2,
    shortLabel: '变更前确认',
    pillText: '本地 PC · 变更前确认',
    dotColorClass: 'bg-[#6366F1]',
    title: '变更前确认（改文件前问 · 默认）',
    subtitle: '只读探针静默放行；每次修改文件、运行脚本或拉起代理前均在桌面浮岛询问确认。',
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
    level: 3,
    shortLabel: '自主模式',
    pillText: '本地 PC · 自主模式',
    dotColorClass: 'bg-[#8B5CF6]',
    title: '自主模式（有风险才问）',
    subtitle: '授权工作区内的常规文件读写自动创建写前快照并静默执行，仅高风险命令或破坏性操作询问确认。',
    enforcedProtections: [
      '保留完整工作区路径围栏 (realpath) 与敏感凭据路径黑名单拦截',
      '工作区内常规 fs_mutate 读写自动前置创建 Git Shadow 影子快照，无需逐次点击确认',
      '高风险命令、强制推送 (git push --force)、递归删除 (rm -rf / Remove-Item -Recurse) 与系统级指令仍强制要求人工确认',
      '所有子进程绑定 Win32 Job Object (JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) + CREATE_NO_WINDOW',
    ],
    uncoveredBoundaries: [
      '授权工作区内的常规代码修改会自动落盘，若需撤销请前往「设置 → 数据控制」单条回滚快照',
    ],
  },
  {
    id: 'full-access',
    confinementMode: 'danger-full-access',
    approvalPolicy: 'unattended-yolo',
    level: 4,
    shortLabel: '完全访问',
    pillText: '本地 PC · 完全访问',
    dotColorClass: 'bg-[#E06C60]',
    title: '完全访问（减少确认）',
    subtitle: '解除工作区目录围栏，跨盘普通文件读写直接执行；仅强制推送、递归删除、磁盘格式化及敏感凭据路径仍需确认。',
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

export const PERMISSION_PROFILE_MAP: Record<PermissionProfileId, PermissionProfileMetadata> = {
  plan: PERMISSION_PROFILE_LIST[0],
  confirm: PERMISSION_PROFILE_LIST[1],
  autonomous: PERMISSION_PROFILE_LIST[2],
  'full-access': PERMISSION_PROFILE_LIST[3],
};

type ProfileTextOverride = Pick<
  PermissionProfileMetadata,
  'shortLabel' | 'pillText' | 'title' | 'subtitle' | 'enforcedProtections' | 'uncoveredBoundaries'
>;

const PROFILE_TEXT_BY_LOCALE: Record<Exclude<SupportedLocale, 'zh-CN'>, Record<PermissionProfileId, ProfileTextOverride>> = {
  'zh-TW': {
    plan: {
      shortLabel: '計劃模式',
      pillText: '本機 PC · 計劃模式',
      title: '計劃模式（唯讀，先計劃再改）',
      subtitle: '僅允許讀取工作區檔案、檢索程式碼與唯讀狀態查詢，先制定方案再動手，攔截一切檔案修改與寫入指令。',
      enforcedProtections: [
        '攔截所有檔案寫入、編輯、重新命名與刪除呼叫 (fs_mutate)',
        '僅放行白名單唯讀探針指令 (git status / git log / git diff / rg / Get-ChildItem)',
        '強制校驗實體路徑 (realpathSync.native) 阻斷 NTFS Junction 與符號連結越界讀取',
      ],
      uncoveredBoundaries: [
        '授權工作區目錄內的非黑名單明文檔案仍可被讀取分析',
        '無法執行編譯、測試腳本或啟動寫檔代理',
      ],
    },
    confirm: {
      shortLabel: '變更前確認',
      pillText: '本機 PC · 變更前確認',
      title: '變更前確認（改檔前問 · 預設）',
      subtitle: '唯讀探針靜默放行；每次修改檔案、執行腳本或啟動代理前均在桌面浮島詢問確認。',
      enforcedProtections: [
        '嚴格校驗 realpath 實體路徑，阻斷 NTFS Junction 與符號連結越界寫入',
        '內建敏感路徑硬黑名單：攔截 .env*、~/.ssh、~/.aws、%APPDATA% 與瀏覽器憑證目錄',
        '寫檔或執行指令前於底部浮島彈出確認，核准後自動記錄無金鑰回執供 Muse 輪詢',
        '每次寫入操作前自動建立 Git Shadow 快照，支援依工作區單條一鍵還原',
      ],
      uncoveredBoundaries: [
        '經人工確認放行的工作區腳本在目前登入使用者權限下執行，無 OS 核心級虛擬化沙箱',
      ],
    },
    autonomous: {
      shortLabel: '自主模式',
      pillText: '本機 PC · 自主模式',
      title: '自主模式（有風險才問）',
      subtitle: '授權工作區內的常規檔案讀寫自動建立寫前快照並靜默執行，僅高風險指令或破壞性操作詢問確認。',
      enforcedProtections: [
        '保留完整工作區路徑圍欄 (realpath) 與敏感憑證路徑黑名單攔截',
        '工作區內常規 fs_mutate 讀寫自動前置建立 Git Shadow 影子快照，無需逐次點擊確認',
        '高風險指令、強制推送 (git push --force)、遞迴刪除 (rm -rf / Remove-Item -Recurse) 與系統級指令仍強制要求人工確認',
        '所有子進程繫結 Win32 Job Object (JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) + CREATE_NO_WINDOW',
      ],
      uncoveredBoundaries: [
        '授權工作區內的常規程式碼修改會自動落盤，若需復原請前往「設定 → 稽核日誌」單條還原快照',
      ],
    },
    'full-access': {
      shortLabel: '完全存取',
      pillText: '本機 PC · 完全存取',
      title: '完全存取（減少確認）',
      subtitle: '解除工作區目錄圍欄，跨磁碟一般檔案讀寫直接執行；僅強制推送、遞迴刪除、磁碟格式化及敏感憑證路徑仍需確認。',
      enforcedProtections: [
        '工作區外的一般檔案讀寫、重新命名、單檔刪除不再因「越界」單獨升為 critical，大幅減少打斷',
        '真正破壞性操作（強制推送、遞迴刪除、磁碟格式化、系統管理指令）及敏感憑證黑名單路徑仍強制要求人工確認',
        '保留 Win32 Job Object 進程樹控制代碼追蹤、全域急停、稽核日誌與 2 小時自動降級保護計時器',
        '左側活動列 MWH 狀態圖示與面板常亮紅環警示（不渲染全視窗邊框光暈）',
      ],
      uncoveredBoundaries: [
        '已解除工作區目錄邊界限制，模型可跨磁碟讀寫一般目錄檔案，請僅在受信任任務中開啟',
      ],
    },
  },
  ja: {
    plan: {
      shortLabel: 'プラン',
      pillText: 'ローカル PC · プラン',
      title: 'プラン（読取専用・計画優先）',
      subtitle: '作業領域内のファイル読取と検索のみを許可し、すべての変更・書込コマンドをブロックします。',
      enforcedProtections: [
        'すべてのファイル作成・編集・移動・削除 (fs_mutate) をブロック',
        '許可された読取専用コマンドのみ通過 (git status / git log / git diff / rg / Get-ChildItem)',
        '物理パス検証 (realpathSync.native) により NTFS Junction やシンボリックリンク越境を遮断',
      ],
      uncoveredBoundaries: [
        '許可作業領域内の非ブラックリスト平文ファイルは参照・解析可能',
        'ビルド・テスト実行や書込エージェントの起動は不可',
      ],
    },
    confirm: {
      shortLabel: '変更前に確認',
      pillText: 'ローカル PC · 変更前に確認',
      title: '変更前に確認（既定）',
      subtitle: '読取専用プローブは自動通過し、ファイル変更やコマンド実行の前にデスクトップアイランドで確認します。',
      enforcedProtections: [
        'realpath 物理パス検証により NTFS Junction やシンボリックリンク経由の越境書込を遮断',
        '機密パスブラックリスト：.env*、~/.ssh、~/.aws、%APPDATA%、ブラウザ認証情報を保護',
        '書込・実行前に下部アイランドで承認を要求し、承認後はキーなしレシートを自動記録',
        '各書込操作の前に Git Shadow スナップショットを自動作成（1 クリックで復元可能）',
      ],
      uncoveredBoundaries: [
        '承認されたスクリプトは現在の Windows ユーザー権限で実行されます（OS 仮想サンドボックスなし）',
      ],
    },
    autonomous: {
      shortLabel: '自律モード',
      pillText: 'ローカル PC · 自律モード',
      title: '自律モード（リスク時のみ確認）',
      subtitle: '許可作業領域内の通常書込はスナップショット保存後に自動実行し、高リスク・破壊的操作のみ確認を求めます。',
      enforcedProtections: [
        '作業領域パスフェンス (realpath) と機密パスブラックリストを完全維持',
        '作業領域内の通常 fs_mutate 書込は Git Shadow スナップショット作成後に自動実行',
        '高リスクコマンド、強制プッシュ (git push --force)、再帰削除 (rm -rf)、システムコマンドは必ず手動承認を要求',
        'すべての子プロセスを Win32 Job Object + CREATE_NO_WINDOW で管理',
      ],
      uncoveredBoundaries: [
        '許可作業領域内の通常変更は自動保存されます。戻す場合は「設定 → 監査ログ」から復元してください',
      ],
    },
    'full-access': {
      shortLabel: 'フルアクセス',
      pillText: 'ローカル PC · フルアクセス',
      title: 'フルアクセス（確認を最小化）',
      subtitle: '作業領域フェンスを解除しフォルダ横断の通常書込を直接実行。破壊的操作と機密パスのみ確認を求めます。',
      enforcedProtections: [
        '作業領域外の通常ファイル操作で都度停止せず、作業の中断を大幅に削減',
        '強制プッシュ、再帰削除、ディスク初期化、管理コマンド、機密ブラックリストパスは引き続き承認必須',
        'Win32 Job Object プロセス追跡、全体緊急停止、監査ログ、2 時間自動ダウングレードを維持',
        '左サイドバーの MWH アイコンとパネルに赤色インジケーターを表示',
      ],
      uncoveredBoundaries: [
        '作業領域のディレクトリ制限が解除されています。信頼できるタスクでのみ有効にしてください',
      ],
    },
  },
  en: {
    plan: {
      shortLabel: 'Plan',
      pillText: 'Local PC · Plan',
      title: 'Plan Mode (Read-Only)',
      subtitle: 'Allows workspace file reads and code search only; blocks all file edits and write commands.',
      enforcedProtections: [
        'Blocks all file writes, edits, renames, and deletes (fs_mutate)',
        'Permits allowlisted read-only probes only (git status / git log / git diff / rg / Get-ChildItem)',
        'Enforces realpathSync.native checks to block NTFS Junction and symlink escapes',
      ],
      uncoveredBoundaries: [
        'Non-blacklisted plaintext files inside allowed workspaces remain readable for analysis',
        'Cannot run build/test scripts or launch write-capable subagents',
      ],
    },
    confirm: {
      shortLabel: 'Confirm Edits',
      pillText: 'Local PC · Confirm Edits',
      title: 'Confirm Before Changes (Default)',
      subtitle: 'Read-only probes run silently; prompts on the desktop island before any file edit, script, or subagent.',
      enforcedProtections: [
        'Enforces physical realpath verification to block NTFS Junction and symlink writes',
        'Hard credential blacklist blocks .env*, ~/.ssh, ~/.aws, %APPDATA%, and browser credential stores',
        'Prompts on the floating island before writes/commands and records key-free receipts for Muse',
        'Captures a Git Shadow snapshot before every write for 1-click workspace rollback',
      ],
      uncoveredBoundaries: [
        'Approved scripts run under your current Windows user privileges without OS kernel virtualization',
      ],
    },
    autonomous: {
      shortLabel: 'Autonomous',
      pillText: 'Local PC · Autonomous',
      title: 'Autonomous (Ask on Risk)',
      subtitle: 'Auto-snapshots and runs routine workspace edits silently; prompts only for high-risk or destructive actions.',
      enforcedProtections: [
        'Preserves full workspace path fencing (realpath) and credential path blacklists',
        'Routine fs_mutate writes inside allowed workspaces auto-snapshot and execute without prompts',
        'High-risk commands, git push --force, recursive deletes, and admin commands still require approval',
        'Binds all child processes to Win32 Job Objects (KILL_ON_JOB_CLOSE) + CREATE_NO_WINDOW',
      ],
      uncoveredBoundaries: [
        'Routine edits in allowed workspaces write automatically; undo via Settings -> Audit Log',
      ],
    },
    'full-access': {
      shortLabel: 'Full Access',
      pillText: 'Local PC · Full Access',
      title: 'Full Access (Minimal Prompts)',
      subtitle: 'Lifts workspace folder fencing for normal cross-folder writes; still prompts for destructive actions and credential paths.',
      enforcedProtections: [
        'Routine cross-folder reads, writes, and renames are not escalated solely for crossing workspace bounds',
        'Destructive commands (force push, recursive delete, disk format, admin tools) and credential paths still prompt',
        'Retains Win32 Job Object tree tracking, global emergency stop, audit log, and 2h auto-downgrade timer',
        'Shows persistent red ring indicator on the sidebar icon and panel',
      ],
      uncoveredBoundaries: [
        'Workspace folder boundary is lifted; enable only for trusted tasks',
      ],
    },
  },
};

export function getPermissionProfileList(lang: SupportedLocale = 'zh-CN'): PermissionProfileMetadata[] {
  if (lang === 'zh-CN') return PERMISSION_PROFILE_LIST;
  const overrides = PROFILE_TEXT_BY_LOCALE[lang] || PROFILE_TEXT_BY_LOCALE.en;
  return PERMISSION_PROFILE_LIST.map((item) => ({
    ...item,
    ...overrides[item.id],
  }));
}

export function resolvePermissionProfile(
  mode: ConfinementMode,
  policy: ApprovalPolicy
): PermissionProfileId {
  if (mode === 'read-only') return 'plan';
  if (mode === 'danger-full-access') return 'full-access';
  if (policy === 'auto-workspace' || policy === 'unattended-yolo') {
    return 'autonomous';
  }
  return 'confirm';
}

export function getPermissionProfileMeta(
  mode: ConfinementMode,
  policy: ApprovalPolicy,
  lang: SupportedLocale = 'zh-CN'
): PermissionProfileMetadata {
  const id = resolvePermissionProfile(mode, policy);
  const list = getPermissionProfileList(lang);
  return list.find((item) => item.id === id) || PERMISSION_PROFILE_MAP[id];
}

export interface ModeMetadata {
  id: ConfinementMode;
  level: 1 | 2 | 3 | 4;
  shortLabel: string;
  pillText: string;
  dotColorClass: string;
  title: string;
  subtitle: string;
  enforcedProtections: string[];
  uncoveredBoundaries: string[];
}

export const MODE_METADATA_MAP: Record<ConfinementMode, ModeMetadata> = {
  'read-only': {
    id: 'read-only',
    level: 1,
    shortLabel: PERMISSION_PROFILE_MAP.plan.shortLabel,
    pillText: PERMISSION_PROFILE_MAP.plan.pillText,
    dotColorClass: PERMISSION_PROFILE_MAP.plan.dotColorClass,
    title: PERMISSION_PROFILE_MAP.plan.title,
    subtitle: PERMISSION_PROFILE_MAP.plan.subtitle,
    enforcedProtections: PERMISSION_PROFILE_MAP.plan.enforcedProtections,
    uncoveredBoundaries: PERMISSION_PROFILE_MAP.plan.uncoveredBoundaries,
  },
  'workspace-write': {
    id: 'workspace-write',
    level: 2,
    shortLabel: PERMISSION_PROFILE_MAP.confirm.shortLabel,
    pillText: PERMISSION_PROFILE_MAP.confirm.pillText,
    dotColorClass: PERMISSION_PROFILE_MAP.confirm.dotColorClass,
    title: PERMISSION_PROFILE_MAP.confirm.title,
    subtitle: PERMISSION_PROFILE_MAP.confirm.subtitle,
    enforcedProtections: PERMISSION_PROFILE_MAP.confirm.enforcedProtections,
    uncoveredBoundaries: PERMISSION_PROFILE_MAP.confirm.uncoveredBoundaries,
  },
  'workspace-acl-experimental': {
    id: 'workspace-acl-experimental',
    level: 3,
    shortLabel: PERMISSION_PROFILE_MAP.autonomous.shortLabel,
    pillText: PERMISSION_PROFILE_MAP.autonomous.pillText,
    dotColorClass: PERMISSION_PROFILE_MAP.autonomous.dotColorClass,
    title: PERMISSION_PROFILE_MAP.autonomous.title,
    subtitle: PERMISSION_PROFILE_MAP.autonomous.subtitle,
    enforcedProtections: PERMISSION_PROFILE_MAP.autonomous.enforcedProtections,
    uncoveredBoundaries: PERMISSION_PROFILE_MAP.autonomous.uncoveredBoundaries,
  },
  'danger-full-access': {
    id: 'danger-full-access',
    level: 4,
    shortLabel: PERMISSION_PROFILE_MAP['full-access'].shortLabel,
    pillText: PERMISSION_PROFILE_MAP['full-access'].pillText,
    dotColorClass: PERMISSION_PROFILE_MAP['full-access'].dotColorClass,
    title: PERMISSION_PROFILE_MAP['full-access'].title,
    subtitle: PERMISSION_PROFILE_MAP['full-access'].subtitle,
    enforcedProtections: PERMISSION_PROFILE_MAP['full-access'].enforcedProtections,
    uncoveredBoundaries: PERMISSION_PROFILE_MAP['full-access'].uncoveredBoundaries,
  },
};

export function getModeLevel(mode: ConfinementMode): 1 | 2 | 3 | 4 {
  return MODE_METADATA_MAP[mode].level;
}

export function clampChildMode(
  requestedChildMode: ConfinementMode,
  parentMode: ConfinementMode
): ConfinementMode {
  const parentLevel = getModeLevel(parentMode);
  const childLevel = getModeLevel(requestedChildMode);
  if (childLevel <= parentLevel) {
    return requestedChildMode;
  }
  return parentMode;
}

export function isChildModeCompliant(
  childMode: ConfinementMode,
  parentMode: ConfinementMode
): boolean {
  return getModeLevel(childMode) <= getModeLevel(parentMode);
}

export function normalizeWinPath(p: string): string {
  return p.trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

export function isPathInsideWorkspace(targetPath: string, workspaceRoots: string[]): boolean {
  const normTarget = normalizeWinPath(targetPath);
  return workspaceRoots.some((root) => {
    const normRoot = normalizeWinPath(root);
    return normTarget === normRoot || normTarget.startsWith(normRoot + '\\');
  });
}

export interface PairingArtifactOutput {
  mcpEndpoint: string;
  restEndpoint: string;
  skillMarkdownPrompt: string;
  mcpJsonConfig: string;
}

/**
 * Generates pairing prompt and MCP JSON template WITHOUT embedding any real
 * runtime Bearer token or secret literal.
 */
export function generatePairingArtifacts(
  baseUrl: string,
  mode: ConfinementMode,
  workspaceRoots: string[],
  policy: ApprovalPolicy = 'smart-risk',
  tokenOverride?: string,
  lang: SupportedLocale = 'zh-CN'
): PairingArtifactOutput {
  const cleanUrl = baseUrl.trim().replace(/\/+$/, '');
  const mcpEndpoint = `${cleanUrl}/mcp`;
  const restEndpoint = `${cleanUrl}/api/v1`;
  const profileMeta = getPermissionProfileMeta(mode, policy, lang);
  const emptyWsByLang: Record<SupportedLocale, string> = {
    'zh-CN': '当前默认工作区',
    'zh-TW': '目前預設工作區',
    ja: '現在の既定ワークスペース',
    en: 'Current default workspace',
  };
  const tokenHintByLang: Record<SupportedLocale, string> = {
    'zh-CN': '<在设置-连接器页复制 Bearer Token>',
    'zh-TW': '<於設定-連接器頁複製 Bearer Token>',
    ja: '<設定-コネクタ画面から Bearer Token をコピー>',
    en: '<Copy Bearer Token from Settings -> Connectors>',
  };
  const workspaceDisplay =
    workspaceRoots.length > 0 ? workspaceRoots.join(', ') : emptyWsByLang[lang] || emptyWsByLang.en;

  const authHeaderValue = tokenOverride
    ? `Bearer ${tokenOverride}`
    : `Bearer ${tokenHintByLang[lang] || tokenHintByLang.en}`;

  const mcpJsonConfig = JSON.stringify(
    {
      mcpServers: {
        'muse-windows-host': {
          type: 'streamable-http',
          url: mcpEndpoint,
          headers: {
            Authorization: authHeaderValue,
          },
          metadata: {
            platform: 'win32-x64',
            permissionProfile: profileMeta.id,
            workspaceRoots,
          },
        },
      },
    },
    null,
    2
  );

  const promptByLang: Record<SupportedLocale, string> = {
    'zh-CN': `[MWH 本地连接指引 · 不含密钥]
已接通本地 Windows 宿主守护进程 (Muse-Win-Harness)：
- Streamable HTTP MCP 端点: ${mcpEndpoint}
- REST API 端点: ${restEndpoint}
- 当前权限档位: ${profileMeta.shortLabel}（${profileMeta.title}）
- 授权工作区: ${workspaceDisplay}

调用与协同规范：
1. 请直接使用已接通的 MCP 连接器调用 \`pc_status\` 查看当前隧道状态、权限档位、工作区路径与最近一次审批回执等非秘密字段（切勿读取 .env、Cookie 或任何本地密钥文件）。
2. 当工具返回 \`CONFIRMATION_REQUIRED\`（含 \`approvalId\`）时，无需等待用户在聊天框回复「批了」；请在用户于桌面浮岛点击允许后直接调用 \`job_control(action="poll", approvalId="<approvalId>")\` 轮询 \`CONSUMED\` 完成回执与输出，且不要对已重命名或已删除的旧路径重复下发过期操作。
3. 如需用户查看或修改本地配置，请指引用户点击 Muse 左侧导航栏 MWH 图标打开抽屉面板：
   - 查看或复制连接器密钥：设置 → 连接器
   - 切换四档权限模式（计划模式 / 变更前确认 / 自主模式 / 完全访问）：设置 → 权限
   - 添加或移除授权工作区目录：设置 → 设备
   - 按工作区查看快照、单条回滚或清理历史记录：设置 → 数据控制`,
    'zh-TW': `[MWH 本機連線指引 · 不含金鑰]
已接通本機 Windows 宿主守護進程 (Muse-Win-Harness)：
- Streamable HTTP MCP 端點: ${mcpEndpoint}
- REST API 端點: ${restEndpoint}
- 目前權限檔位: ${profileMeta.shortLabel}（${profileMeta.title}）
- 授權工作區: ${workspaceDisplay}

呼叫與協同規範：
1. 請直接使用已接通的 MCP 連接器呼叫 \`pc_status\` 檢視目前隧道狀態、權限檔位、工作區路徑與最近一次審批回執等非秘密欄位（切勿讀取 .env、Cookie 或任何本機金鑰檔案）。
2. 當工具傳回 \`CONFIRMATION_REQUIRED\`（含 \`approvalId\`）時，無需等待使用者在對話框回覆「批了」；請於使用者在桌面浮島點擊允許後直接呼叫 \`job_control(action="poll", approvalId="<approvalId>")\` 輪詢 \`CONSUMED\` 完成回執與輸出，且不要對已重新命名或已刪除的舊路徑重複下發過期操作。
3. 如需使用者檢視或修改本機設定，請指引使用者點擊 Muse 左側導覽列 MWH 圖示開啟抽屜面板：
   - 檢視或複製連接器金鑰：設定 → 連接器
   - 切換四檔權限模式（計劃模式 / 變更前確認 / 自主模式 / 完全存取）：設定 → 權限
   - 新增或移除授權工作區目錄：設定 → 工作區
   - 依工作區檢視快照、單條還原或清理歷史記錄：設定 → 稽核日誌`,
    ja: `[MWH ローカル接続ガイド · キーなし]
ローカル Windows ホストデーモン (Muse-Win-Harness) に接続済みです：
- Streamable HTTP MCP エンドポイント: ${mcpEndpoint}
- REST API エンドポイント: ${restEndpoint}
- 現在の権限モード: ${profileMeta.shortLabel}（${profileMeta.title}）
- 許可ワークスペース: ${workspaceDisplay}

連携ルール：
1. 接続済みの MCP コネクタから \`pc_status\` を呼び出し、トンネル状態、権限モード、作業領域パス、直近の承認レシートなどの非機密フィールドを確認してください（.env、Cookie、ローカル認証ファイルは絶対に読み取らないでください）。
2. ツールが \`CONFIRMATION_REQUIRED\`（\`approvalId\` 付き）を返した場合、チャット欄で承認の返信を待つ必要はありません。ユーザーがデスクトップアイランドで許可をクリックした後に \`job_control(action="poll", approvalId="<approvalId>")\` を呼び出して \`CONSUMED\` を確認し、リネームや削除済みの古いパスへ再送しないでください。
3. ユーザーがローカル設定を確認・変更する場合は、Muse 左ナビゲーションの MWH アイコンからドロワーを開くよう案内してください：
   - コネクタキーの確認・コピー：設定 → コネクタ
   - 4 段階の権限モード切替（プラン / 変更前に確認 / 自律モード / フルアクセス）：設定 → 権限
   - 許可ワークスペースの追加・削除：設定 → 作業領域
   - スナップショット復元・履歴整理：設定 → 監査ログ`,
    en: `[MWH Local Connection Guide · Key-Free]
Connected to local Windows host daemon (Muse-Win-Harness):
- Streamable HTTP MCP Endpoint: ${mcpEndpoint}
- REST API Endpoint: ${restEndpoint}
- Active Permission Mode: ${profileMeta.shortLabel} (${profileMeta.title})
- Authorized Workspaces: ${workspaceDisplay}

Usage & Coordination Rules:
1. Call \`pc_status\` via the connected MCP connector to inspect tunnel state, permission mode, workspace paths, and the latest approval receipt (never read .env, cookies, or local credential files).
2. When a tool returns \`CONFIRMATION_REQUIRED\` (with \`approvalId\`), do not ask the user to type "approved" in chat; after they approve on the desktop island, poll \`job_control(action="poll", approvalId="<approvalId>")\` for \`CONSUMED\`, and never replay stale operations against renamed or deleted paths.
3. To adjust local settings, guide the user to click the MWH icon in Muse's left rail:
   - View or copy connector token: Settings -> Connectors
   - Switch permission mode (Plan / Confirm Edits / Autonomous / Full Access): Settings -> Permissions
   - Manage allowed workspace folders: Settings -> Workspaces
   - Roll back snapshots or prune history: Settings -> Audit Log`,
  };
  const skillMarkdownPrompt = promptByLang[lang] || promptByLang.en;

  return {
    mcpEndpoint,
    restEndpoint,
    skillMarkdownPrompt,
    mcpJsonConfig,
  };
}
