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
    dotColorClass: 'bg-emerald-500',
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
    dotColorClass: 'bg-sky-500',
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
    dotColorClass: 'bg-violet-500',
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
    dotColorClass: 'bg-red-500',
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
  policy: ApprovalPolicy
): PermissionProfileMetadata {
  return PERMISSION_PROFILE_MAP[resolvePermissionProfile(mode, policy)];
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
  tokenOverride?: string
): PairingArtifactOutput {
  const cleanUrl = baseUrl.trim().replace(/\/+$/, '');
  const mcpEndpoint = `${cleanUrl}/mcp`;
  const restEndpoint = `${cleanUrl}/api/v1`;
  const profileMeta = getPermissionProfileMeta(mode, policy);
  const workspaceDisplay =
    workspaceRoots.length > 0 ? workspaceRoots.join(', ') : '当前默认工作区';

  const authHeaderValue = tokenOverride ? `Bearer ${tokenOverride}` : 'Bearer <在设置-连接器页复制 Bearer Token>';

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

  const skillMarkdownPrompt = `[MWH 本地连接指引 · 不含密钥]
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
   - 按工作区查看快照、单条回滚或清理历史记录：设置 → 数据控制`;

  return {
    mcpEndpoint,
    restEndpoint,
    skillMarkdownPrompt,
    mcpJsonConfig,
  };
}
