# MWH 视觉与组件规范（参数级）

本文是 MWH 注入式设置界面（抽屉 / 高级配置中心 / 审批浮岛 / 分步功能引导）与浏览器调试面（`frontend/`）的**唯一视觉真源**。任何新增卡片、控件、状态徽章、引导步骤，必须先在本文找到对应规格再写代码；本文没有的规格，先补文档再加实现。

- 架构与交互流程见 [`UI.md`](./UI.md)，本文只规定"长什么样、多少像素、用什么令牌"。
- 品牌素材与 Logo 见 `assets/brand/` 与 `frontend/public/favicon.svg`（对齐任务栏 `shell/resources/app-icon-256.png` 紫蓝渐变）。

---

## 0. 视觉体系演进与核心治理目标

| 维度 | 规范要求 |
| :--- | :--- |
| **品牌标识与主题色统一** | 全面对齐桌面任务栏/托盘图标的**紫蓝渐变（`#8B5CF6 → #6366F1 → #3B82F6`）**，消除此前任务栏紫蓝渐变与界面纯蓝之间的视觉割裂 |
| **muse.ai 官方静态观感对齐** | 遵循温润克制的暗夜灰（`#1C1D20`）与纸感米白（`#EFECE6`）三层亮度阶梯，去描边、靠表面明度分层 |
| **低饱和状态色令牌化** | 摒弃刺眼的高饱和红绿（如裸 `emerald-400`、`red-600`）；将"就绪/在线"收敛为**低饱和冰川青蓝**（与紫蓝品牌色解耦），将"危险/急停"收敛为**低饱和暖陶土橙红**，将"警告/待授权"收敛为**暖沙金** |
| **端点与凭据防窥保护** | 公网端点 URL 与 Bearer Token 默认脱敏展示；显式点击查看明文后 **15 秒自动回掩**，关闭面板立即重置脱敏 |
| **抗缩放溢出弹性布局** | 建立容器收缩（`min-width: 0`）与按钮组自适应折行（`flex-wrap: wrap` / `auto-fit`）契约，根除 125%–150% DPI 缩放或窄抽屉下按钮右缘截断 |
| **主功能分步引导与门禁联动** | 抽屉与设置中心常驻 `?` 引导入口，提供 6 步聚光灯（Spotlight）实景引导，并由 `scripts/test_ui_contract.mjs` 强制校验锚点同步 |

---

## 1. 六条设计公理

对齐 muse.ai 官方界面的静态源码级观感。每条都给出**反例**，反例一律禁止。

| # | 公理 | 做法 | 反例（禁止） |
| :--- | :--- | :--- | :--- |
| A1 | **克制使用品牌渐变色** | 紫蓝渐变（`--mwh-accent-grad`）与品牌主色（`--mwh-accent`）只承担"品牌标识 / 开关开启 / 主行动按钮 / 焦点"四种语义，全屏占比目标 < 3% | 大面积渐变填充卡片底色、正文标题刷成亮紫或亮蓝 |
| A2 | **靠亮度分层，不靠描边** | 层级 = 页面底 → 一级卡片 → 内嵌凹陷面 三档亮度（暗色 `#1C1D20` → `#27282C` → `#1E1F23`；亮色 `#EFECE6` → `#F7F6F2` → `#E6E4DE`） | 每张卡片都套 `1px solid rgba(255,255,255,0.08)` 描边 |
| A3 | **组件无边框** | 按钮、输入框、卡片、列表行一律 `border: none`；需要边界时用 inset 微阴影（不超过 3% 白）或亮度差 | 圆角矩形 + 一圈灰线 + 内部再套一层框 |
| A4 | **大而宽且弹性防溢出** | 面板宽度优先，行内边距不小于 12px，控件高度不小于 28px；所有横向 Flex/Grid 必须声明 `min-width: 0` 与折行兜底 | 窄容器内强制 `nowrap` 不换行导致右侧按钮被裁切 |
| A5 | **面板内部弱化边界** | 最外层面板可用 7% 白细线；**内部**卡片一律去边，靠 `--mwh-card` / `--mwh-card-2` 区分 | 面板内部层层画分割线与子卡片描边 |
| A6 | **文案简洁克制** | 标题 4–8 字，说明 ≤ 2 行（≤ 60 字），只讲"做什么 + 何时生效" | 感叹号、营销词、面向 AI 的说教提示语 |

---

## 2. 颜色令牌

三层结构：Primitive（原始值）→ Semantic（语义别名）→ Component（组件引用）。实现中**优先引用 `--mwh-*` 语义令牌**，React 面使用同一套色值常量。

### 2.1 语义令牌（暗色，默认）

| 令牌 | 值 | 用途 |
| :--- | :--- | :--- |
| `--mwh-bg` | `#1C1D20` | 面板底（抽屉 / 子面板 / 浮岛 / 引导卡） |
| `--mwh-card` | `#27282C` | 一级卡片（比面板更亮 = 视觉靠前） |
| `--mwh-card-2` | `#1E1F23` | 内嵌卡片 / 列表行 / 输入框底（凹陷面） |
| `--mwh-code` | `#141518` | 代码块与终端输出区 |
| `--mwh-text` | `#ECECEE` | 主文本 |
| `--mwh-text-2` | `#C4C5CC` | 次级文本（说明正文） |
| `--mwh-muted` | `#9E9FA6` | 弱化文本（hint / 元信息） |
| `--mwh-border` | `rgba(255,255,255,.07)` | **仅**面板外框与分割线 |
| `--mwh-subtle` | `rgba(255,255,255,.05)` | 徽章底、弱按钮底 |
| `--mwh-hover` | `rgba(255,255,255,.09)` | 默认按钮底、hover 面、**开关关闭态轨道** |
| `--mwh-accent-start` | `#8B5CF6` | 品牌紫蓝渐变起点（对齐任务栏图标右上角） |
| `--mwh-accent` | `#6366F1` | 品牌主色基准（靛紫蓝）：焦点环、单色图标、选中指示 |
| `--mwh-accent-end` | `#3B82F6` | 品牌紫蓝渐变终点（对齐任务栏图标左下角） |
| `--mwh-accent-grad` | `linear-gradient(135deg, #8B5CF6 0%, #6366F1 50%, #3B82F6 100%)` | 唯一品牌渐变：Logo、开关开启态轨道、主按钮、左栏活动指示条、分支徽章 |
| `--mwh-accent-grad-hover` | `linear-gradient(135deg, #7C3AED 0%, #4F46E5 50%, #2563EB 100%)` | 开关开启态与主按钮悬停加深 1 档 |
| `--mwh-accent-soft` | `rgba(99,102,241,.16)` | 焦点环、选中态底、品牌徽章底 |
| `--mwh-accent-text` | `#A5B4FC` | 深底上的品牌高亮文字与链接色 |
| `--mwh-shadow` | `0 6px 20px 0 rgba(17,17,18,.45), 0 8px 36px 0 rgba(17,17,18,.35)` | 仅面板级浮层 |

### 2.2 语义令牌（亮色，`.mwh-light`）

| 令牌 | 值 |
| :--- | :--- |
| `--mwh-bg` | `#EFECE6`（muse.ai 纸感米白） |
| `--mwh-card` | `#F7F6F2` |
| `--mwh-card-2` | `#E6E4DE` |
| `--mwh-code` | `#F2F1EC` |
| `--mwh-text` | `#1D1D1F` |
| `--mwh-text-2` | `#4A4A4F` |
| `--mwh-muted` | `#63636A` |
| `--mwh-border` | `rgba(0,0,0,.06)` |
| `--mwh-subtle` | `rgba(0,0,0,.04)` |
| `--mwh-hover` | `rgba(0,0,0,.07)` |
| `--mwh-accent-soft` | `rgba(99,102,241,.12)` |
| `--mwh-accent-text` | `#4F46E5` |
| `--mwh-shadow` | `0 4px 16px 0 rgba(17,17,18,.12), 0 6px 28px 0 rgba(17,17,18,.08)` |

### 2.3 低饱和功能状态色（告别刺眼红绿，与紫蓝品牌色语义解耦）

为避免高饱和纯绿（`#22C55E`）与纯红（`#EF4444`）在暗色/米白界面产生视觉刺痛，同时避免"就绪态"与"紫蓝渐变开启态"混淆，状态色统一采用以下低饱和度令牌：

| 状态语义 | 令牌名 | 暗色前景 / 亮色前景 | 实心点 / 强调色 | 徽章与弱背景 (`*-bg`) | 适用场景 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **就绪 / 在线 / ALLOW**（低饱和冰川青蓝） | `--mwh-status-ok-*` | `#7DD3FC` / `#0284C7` | `#38BDF8` | `rgba(56,189,248,.12)` | 隧道活跃、守护在线、探测就绪、已回滚、审计 ALLOW、计划模式圆点 |
| **警告 / 待授权 / ASK**（低饱和暖沙金） | `--mwh-status-warn-*` | `#EAB364` / `#B45309` | `#D99B43` | `rgba(234,179,100,.14)` | 待审批提示、资源启动故障、路径未找到、审计 ASK、2h 降级提示 |
| **危险 / 拦截 / BLOCK**（低饱和暖陶土橙红） | `--mwh-status-danger-*` | `#F28B82` / `#C2410C` | `#E06C60`（hover `#D05A4E`） | `rgba(224,108,96,.15)` | 全局急停、强杀中止、删除按钮、完全访问警示、审计 BLOCK |
| **品牌高亮**（柔和靛紫蓝） | `--mwh-accent-*` | `#A5B4FC` / `#4F46E5` | `#6366F1` | `var(--mwh-accent-soft)` | 选中项徽章、代码变动文件数、展开更多链接、自主模式圆点 |

> 门禁契约：`#8B5CF6 / #6366F1 / #3B82F6 / #A5B4FC`（紫蓝渐变品牌色阶）与 `#38BDF8 / #7DD3FC / #E06C60 / #F28B82 / #EAB364`（低饱和状态色阶）由 `scripts/test_ui_contract.mjs` 硬断言守护；禁止在 UI 组件中回退使用高饱和 `emerald-400/500`、`red-500/600/700`、`rose-400/500`。

---

## 3. 尺度与防溢出布局

### 3.1 圆角（只允许这 7 档）

| 档位 | 用途 |
| :--- | :--- |
| `24px` | 高级配置子面板 `#mwh-subpanel`、React 设置模态框 |
| `20px` | 抽屉 `#mwh-drawer`、审批浮岛 `#mwh-approval-island` |
| `16px` | 功能引导浮层卡 `.mwh-tour-card`、确认弹窗 `.mwh-confirm-card` |
| `14px` | 一级卡片 `.mwh-card` |
| `12px` | 内嵌卡片 / 预览块 `.mwh-card-flat`、模式选择卡 `.mwh-mode-card` |
| `10px` | 列表行 `.mwh-list-row`、按钮 `.mwh-btn`、代码块 |
| `8px` | 输入框 `.mwh-input`、下拉 `.mwh-select`、图标按钮 `.mwh-icon-btn` |
| `9999px` | 胶囊徽章 `.mwh-pill`、开关轨道与圆点 |

### 3.2 间距（4 基网格，允许 2px 修饰值）

`2 / 4 / 6 / 8 / 10 / 12 / 14 / 16 / 20 / 24`

| 场景 | 值 |
| :--- | :--- |
| 图标与文字 | `5–6px` |
| 行内元素组 | `6–8px` |
| 卡片内边距（一级） | `13px 15px` |
| 卡片内边距（内嵌） | `10px 12px` |
| 列表行内边距 | `8px 9px`（含开关的行 `8px 12px`） |
| 抽屉体 | `14px`，卡片间 `10px` |
| 子面板体 | `16–18px` |
| 抽屉与子面板间距 | `var(--mwh-gap)` = `16px`，左轨道 `var(--mwh-rail)` = `56px` |

### 3.3 字号字重

| 角色 | 字号 | 字重 | 行高 | 颜色 |
| :--- | :--- | :--- | :--- | :--- |
| 面板主标题 | `16px` | 600 | 1.3 | `--mwh-text` |
| 区块标题 / 行标题（强） | `13.5px` | 600 | 1.35 | `--mwh-text` |
| 行标题（列表内） | `11.5–12px` | 600 | 1.4 | `--mwh-text` |
| 正文 / 说明 | `12px` | 400 | 1.55 | `--mwh-muted` 或 `--mwh-text-2` |
| 元信息 / 徽章 | `10.5–11px` | 500 | 1.4 | `--mwh-muted` |
| 等宽（路径 / 端点 / Token） | `10.5–11.5px` | 400 | 1.55 | `--mwh-text-2` |

### 3.4 时长与缓动令牌

| 令牌 | 值 | 用途 |
| :--- | :--- | :--- |
| `--mwh-dur-fast` | `80ms` | 按下瞬间的形变反馈 |
| `--mwh-dur-base` | `150ms` | hover、focus、行背景、Toast 进出 |
| `--mwh-dur-state` | `180ms` | 开关翻转、圆点位移、徽章换色 |
| `--mwh-dur-overlay` | `220ms` | 遮罩、引导聚光灯位移 |
| `--mwh-dur-panel` | `240ms` | 抽屉滑入、子面板展开、浮岛形变 |
| `--mwh-ease-color` | `ease` | 颜色与不透明度过渡 |
| `--mwh-ease-standard` | `cubic-bezier(0.16, 1, 0.3, 1)` | 面板、开关圆点、聚光灯位移 |
| `--mwh-ease-spring` | `cubic-bezier(0.22, 1, 0.36, 1)` | Toast 进出与浮岛形变 |

### 3.5 容器收缩、最小宽度与防溢出契约（Anti-Overflow Specification）

针对 Windows 125% / 150% DPI 缩放及抽屉最小宽度（`280px`）下的组件截断问题，所有布局容器必须遵守以下 4 条硬性规则：

1. **Flex 子项收缩锁（`min-width: 0`）**：凡包含路径、URL、Token、动态标题或并排按钮的 Flex 容器及其文本子容器，必须显式设置 `min-width: 0`（Tailwind `min-w-0`），严禁让内部 `nowrap` 文本把父卡片撑出水平滚动条或截断右侧按钮。
2. **并排按钮组自适应折行（Wrap-First Action Bar）**：
   - 卡片内的操作按钮行（如「复制配对口令 + 复制 MCP JSON」、「Token 查看 + 复制 + 轮换」、「快照批量操作栏」）外层与内层按钮组均必须声明 `flex-wrap: wrap`（React 面 `flex flex-wrap items-center gap-2 min-w-0`）。
   - 双列按钮网格 `.mwh-grid-2` 采用 `grid-template-columns: repeat(auto-fit, minmax(118px, 1fr))`，当单列可用宽度不足 `118px` 时自动退化为上下堆叠，确保按钮右缘绝不超出父卡片。
3. **按钮自身防撑破**：`.mwh-btn` 设置 `max-width: 100%; min-width: 0; overflow: hidden; text-overflow: ellipsis;`，图标 `flex-shrink: 0`，文字在极限窄宽下优雅省略而非撑破容器。
4. **端点行三段式弹性分配**：`.mwh-endpoint-row` 采用 `[固定标签 flex-shrink:0] + [路径文本 flex:1 min-width:0 truncate] + [操作图标组 flex-shrink:0]`，确保右侧复制与显隐按钮永远固定在卡片右内边距内。

---

## 4. 组件规格

### 4.1 Switch 开关（布尔开关的唯一合法形态）

```html
<button type="button" role="switch" aria-checked="true" class="mwh-switch is-on" data-action="switch-bind" data-bind="resource.enabled">
  <span class="mwh-switch-dot"></span>
</button>
```

| 参数 | 值 |
| :--- | :--- |
| 轨道尺寸 | `46 × 28px`，圆角 `9999px`，内缩 `3px` |
| 圆点尺寸 | `22 × 22px`，圆角 `9999px`，纯白 `#FFFFFF`，微投影 `0 1px 2px rgba(0,0,0,.25)` |
| 圆点位移 | 关闭 `translateX(0)`；开启 `translateX(18px)` |
| 开启轨道 | `background: var(--mwh-accent-grad)`（紫蓝渐变 `#8B5CF6 → #6366F1 → #3B82F6`，对齐任务栏标识） |
| 开启悬停 | `background: var(--mwh-accent-grad-hover)` |
| 关闭轨道 | 暗色 `rgba(255,255,255,.09)`（hover `.12`）；亮色 `rgba(0,0,0,.12)`（hover `.16`） |
| 过渡 | 轨道 `background-color var(--mwh-dur-state) var(--mwh-ease-color), transform var(--mwh-dur-fast) var(--mwh-ease-color)`；圆点 `transform var(--mwh-dur-state) var(--mwh-ease-standard)` |
| 焦点环 | `box-shadow: 0 0 0 3px var(--mwh-accent-soft)` |
| 行为契约 | 原地修改 `is-on` 与 `aria-checked`（`paintSwitch`），连点锁 `pendingSwitchKeys`，乐观上色 + `holdSwitchMin` 动画保底 |

### 4.2 设置行（Switch Row）与卡片（Card）

- `.mwh-switch-row`：`background: var(--mwh-card-2)`，圆角 `10px`，`padding: 8px 12px`，`min-height: 44px`，无边框。
- `.mwh-card`：`background: var(--mwh-card)`，圆角 `14px`，`padding: 13px 15px`，无边框。
- `.mwh-card-flat`：`background: var(--mwh-card-2)`，圆角 `12px`，`padding: 10px 12px`，无边框。

### 4.3 按钮 Button

| 变体 | 背景 | 前景 | 用途 |
| :--- | :--- | :--- | :--- |
| 默认 `.mwh-btn` | `--mwh-hover` | `--mwh-text` | 次要操作 |
| 主 `.mwh-btn-primary` | `--mwh-accent-grad` | `#FFFFFF`（hover `--mwh-accent-grad-hover`） | 主行动按钮 |
| 幽灵 `.mwh-btn-ghost` | `--mwh-card-2` | `--mwh-text` | 并列次按钮 |
| 危险 `.mwh-btn-danger` | `var(--mwh-status-danger-bg)` | `var(--mwh-status-danger-text)` | 删除 / 终止 / 急停 |
| 图标 `.mwh-icon-btn` | 透明（hover `--mwh-hover`） | `--mwh-muted` | `28×28`，圆角 `8px` |

### 4.4 徽章 Pill 与输入框 Input

- `.mwh-pill`：`11px / 500`，`padding: 2.5px 8.5px`，圆角 `9999px`。语义变体：`.mwh-pill-accent`（紫蓝底 `--mwh-accent-soft` + `#A5B4FC`）、`.mwh-pill-green`（就绪青蓝底 `--mwh-status-ok-bg` + `--mwh-status-ok-text`）、`.mwh-pill-amber`（警告沙金底 `--mwh-status-warn-bg` + `--mwh-status-warn-text`）、`.mwh-pill-red`（危险橙红底 `--mwh-status-danger-bg` + `--mwh-status-danger-text`）。
- `.mwh-input`：`background: var(--mwh-card-2)`，圆角 `8px`，聚焦环 `0 0 0 1px rgba(99,102,241,.48), 0 0 0 4px rgba(99,102,241,.16)`。

### 4.5 面板 Panel 与动效规则

- 抽屉宽 `min(clamp(280px, 25vw, 420px), 剩余视口)`，圆角 `20px`；子面板宽 `min(640px, 剩余视口)`，圆角 `24px`；审批浮岛圆角 `20px`（收起态胶囊固定 `108 × 42px`）。
- 动效仅允许作用于 `transform` / `opacity` / `background-color` / `border-color` / `box-shadow` / `color`（浮岛胶囊切换除外），且在 `prefers-reduced-motion: reduce` 下归零（`.mwh-spin` 除外）。

### 4.9 主功能使用引导（Spotlight Tour）与强制同步更新契约

为降低首次接入与日常操作的心智负担，设置抽屉与 React 调试弹窗均内置**数据驱动的 6 步聚光灯引导（Spotlight Tour）**：

1. **常驻入口**：
   - 抽屉顶栏标题右侧（关闭按钮左侧）与 React 设置中心导航栏底部常驻 `?` 引导按钮（`data-action="open-tour"`，`aria-label="功能使用引导"`）。
2. **视觉形态（Muse 极简风）**：
   - 全屏遮罩 `.mwh-tour-backdrop` + 目标锚点高亮框 `.mwh-tour-spotlight`（`border-radius: 14px`，`box-shadow: 0 0 0 9999px rgba(10, 10, 14, 0.62), 0 0 0 2px var(--mwh-accent)`）+ 浮动说明卡 `.mwh-tour-card`（宽 `min(320px, calc(100vw - 32px))`，圆角 `16px`，背景 `var(--mwh-card)`，无边框，带步骤进度点、`上一步`/`下一步`/`完成` 与 `Esc` 关闭）。
3. **标准 6 步引导路径（`TOUR_STEPS` 真源清单）**：

| 步骤序号 | Step ID (`id`) | 绑定锚点 (`data-tour-id`) | 标题 | 核心说明覆盖域 |
| :--- | :--- | :--- | :--- | :--- |
| 1 | `activity-entry` | `tour-activity-entry` | 宿主入口与连通状态 | 左侧活动栏 MWH 紫蓝图标与状态点，一键开合抽屉并观察本机守护与 Muse 连接状态 |
| 2 | `permission-modes` | `tour-permission-modes` | 四档权限与自动降级 | 计划只读 / 变更前确认 / 自主模式 / 完全访问四档即时切换，完全访问支持 2 小时自动降级保护 |
| 3 | `endpoints-credentials` | `tour-endpoints-credentials` | 防窥端点与一键配对 | 公网 MCP/REST 端点与 Token 默认脱敏防截屏泄露（展开 15 秒自动回掩），支持一键复制配对口令与 MCP JSON |
| 4 | `advanced-center` | `tour-advanced-center` | 四栏高级配置中心 | 展开连接与权限、工作区与 ACP 代理、本机 MCP 与 Skill 资源库、Git Shadow 快照回滚与审计日志 |
| 5 | `approval-island` | `tour-approval-island` | 底部实时审批灵动岛 | 写操作或高危命令触发时自动从胶囊展开，支持允许一次、本工作区始终允许、进程树强杀与快照回滚 |
| 6 | `desktop-hands` | `tour-desktop-hands` | 原生桌面操控与防抢占护栏 | 默认关闭，开启后支持窗口枚举、UIA 控件树、脱敏截图与后台优先操控，前台回退遇人工键鼠自动暂停 |

4. **功能变更时强制同步更新机制（Engineering Sync Gate）**：
   - **双向静态门禁（`scripts/test_ui_contract.mjs` Gate 15）**：门禁脚本自动解析 `docs/DESIGN.md`、`shell/muse-settings-preload.cjs` 与 `frontend/src/overlay/MwhSettingsModal.tsx` 中的 `TOUR_STEPS` 定义及 DOM `data-tour-id` 锚点，并交叉校验四大高级配置域（`连接与权限`、`工作区与代理`、`资源库`、`审计日志`）与四档权限模式是否全部被引导步骤覆盖。
   - **硬性约束**：后续任何新增/修改主功能模块、增删高级配置 Tab 或调整核心卡片结构时，**必须同步更新 `docs/DESIGN.md` §4.9、`shell/muse-settings-preload.cjs` 与 `MwhSettingsModal.tsx` 的 `TOUR_STEPS` 及 `data-tour-id`**，否则 `npm run test:ui-contract` 直接判定失败。

### 4.10 连接端点与凭据防窥脱敏契约（Endpoint & Token Privacy Hardening）

基于本机单用户高频**截屏提问、录屏分享、旁人窥屏**的真实威胁模型，端点与凭据展示执行以下三层保护：

1. **公网端点 URL 默认中段掩码（`maskEndpointUrl`）**：
   - 本地回环地址（`127.0.0.1` / `localhost`）直接显示；
   - 非回环公网隧道地址（如 `https://random-words-here.trycloudflare.com/mcp`）默认脱敏显示为 `https://rand••••.trycloudflare.com/mcp`（保留协议、域名前 4 字符、顶级域名后缀与路径 `/mcp` 或 `/api/v1`），防止截屏暴露公网隧道入口。
2. **显式点击揭示 + 15 秒自动回掩（`PEEK_AUTO_HIDE_MS = 15000`）**：
   - 用户点击眼睛图标（`toggle-token-peek` / `toggle-endpoint-peek`）可临时查看完整明文；
   - 展开明文后立即启动 **15 秒自动回掩定时器**，超时或关闭抽屉/弹窗时自动恢复掩码态（`isTokenPeeked = false; isEndpointPeeked = false`）。
3. **零摩擦一键复制**：
   - 无论当前处于掩码态还是明文态，点击「复制」按钮始终将完整真实的 URL 或 Bearer Token 写入系统剪贴板，兼顾防窥安全与开箱即用体验。

---

## 5. 状态矩阵与禁止清单

| 禁止项 | 原因 |
| :--- | :--- |
| 高饱和刺眼红绿（裸 `emerald-400/500`、`#22C55E`、`red-500/600/700`、`#EF4444`、`rose-400/500`） | 违反 2.3 低饱和状态色规范，视觉刺眼 |
| 旧版纯蓝硬编码（`#2B7FFF` / `#1B6FEF`）散落于开关或主按钮 | 违反 2.1，必须统一使用任务栏同款紫蓝渐变 `--mwh-accent-grad` / `#6366F1` |
| 组件加 `border: 1px solid`（除面板最外框与空态虚线框） | 违反 A2/A3 |
| 横向按钮组或端点行缺少 `flex-wrap` / `min-width: 0` | 违反 3.5，缩放或窄抽屉下会裁切按钮 |
| 公网端点 URL 常驻无掩码裸露，或 Token 明文展开后不自动回掩 | 违反 4.10，存在截屏/录屏泄露风险 |
| 修改主功能却未同步更新 `TOUR_STEPS` 与 `data-tour-id` | 违反 4.9，会被 `test:ui-contract` Gate 15 阻断 |
| emoji 图标、面向 AI 的说教提示语、退役 CLI 标识符 | 门禁硬失败 |
