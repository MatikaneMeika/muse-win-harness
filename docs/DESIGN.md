# MWH 视觉与组件规范（参数级）

本文是 MWH 注入式设置界面（抽屉 / 高级配置中心 / 审批浮岛）与浏览器调试面（`frontend/`）的**唯一视觉真源**。任何新增卡片、控件、状态徽章，必须先在本文找到对应规格再写代码；本文没有的规格，先补文档再加实现。

- 架构与交互流程见 [`UI.md`](./UI.md)，本文只规定"长什么样、多少像素"。
- 品牌素材与 Logo 见 `assets/brand/`。

---

## 0. 现状体检：有没有可复用组件库 / 规范文档？

**结论：截至本文新增前，没有。**

| 检查项 | 现状 |
| :--- | :--- |
| 参数级设计规范文档 | 无。`docs/UI.md` 是架构说明 + 人工巡检清单，不含尺寸与色值 |
| 共享组件库 | 无。`shell/muse-settings-preload.cjs` 用字符串拼 HTML，样式散落在同一文件的内嵌 CSS 里；`frontend/src/overlay/` 另用 Tailwind 内联 class 重写了一遍 |
| 单一 token 源 | 有一半。`shell/muse-settings-preload.cjs` 的 `.mwh-drawer/.mwh-subpanel/.mwh-approval-island` 块已定义 `--mwh-*` 变量并注释对齐 muse.ai 官方色阶；但 `frontend/` 全是硬编码 `bg-[#2B7FFF]`、`border-white/5`，两边不同步 |
| 尺度一致性 | 失控。同一文件内字号出现 **12 档**（9.5 / 10 / 10.5 / 11 / 11.5 / 12 / 12.5 / 13 / 13.5 / 14 / 15 / 16 px），圆角出现 **15 档**（2 / 3 / 5 / 6 / 8 / 9 / 10 / 11 / 12 / 13 / 14 / 18 / 20 / 24 / 9999 px） |

**有没有必要**：有，而且已经产生可观测的代价——
1. 同一种"卡片"在文件里同时存在 11 / 12 / 13 / 14 px 五种圆角，视觉上一眼看出"不是一个系统"；
2. 双实现面（preload + React）没有共同约束，改一处忘另一处是必然事件；
3. 每次新增面板都要重新决定字号、圆角、间距，决策成本重复支付，且倾向越做越"AI 味"（描边盒子 + 主题色填充）。

本文把"官方是什么样"从口口相传变成可核查的参数，并要求新代码只使用第 4 节列出的尺度档位。

---

## 1. 六条设计公理

对齐 muse.ai 官方设置界面的观感。每条都给出**反例**，反例一律禁止。

| # | 公理 | 做法 | 反例（禁止） |
| :--- | :--- | :--- | :--- |
| A1 | **极少用主题色** | 蓝色只承担"开启中 / 主行动 / 焦点"三种语义，全屏蓝色面积占比目标 < 2% | 蓝色大面积填充卡片底色、蓝色标题、蓝色渐变按钮 |
| A2 | **靠亮度分层，不靠描边** | 层级 = 页面底 → 卡片 → 内嵌卡片 三档亮度（暗色 `#1C1D20` → `#27282C` → `#1E1F23`） | 每张卡片都套 `1px solid rgba(255,255,255,0.08)` 描边 |
| A3 | **组件无边框** | 按钮、输入框、卡片、行一律 `border: none`；需要边界时用 inset 阴影（不超过 3% 白）或干脆用亮度差 | 圆角矩形 + 一圈灰线 + 内部再一层框 |
| A4 | **大而宽** | 面板宽度优先，行内边距不小于 12px，控件高度不小于 28px，宁可滚动也不要挤成密表 | 12px 字号 + 24px 行高 + 三列并排的密集表格 |
| A5 | **面板内部弱化边界** | 外框可用 7% 白细线；**内部**卡片一律去边，靠 `--mwh-card` / `--mwh-card-2` 两档区分 | 面板里再画分割线、再套 sub-card 边框 |
| A6 | **文案简洁** | 标题 4-8 字，说明 ≤ 2 行（≤ 60 字），只讲"做什么 + 何时生效" | 「本功能旨在为您提供……」「请放心使用……」等营销/说教句；面向 AI 的提示语 |

> 观感校验：把界面截图缩到 50% 看，若仍能一眼数出"很多个方框"，说明违反 A2/A3/A5。

---

## 2. 颜色令牌

三层结构：Primitive（原始值）→ Semantic（语义别名）→ Component（组件引用）。实现中**只允许引用 Semantic 层的 `--mwh-*`**，禁止在组件里写新 hex。

### 2.1 语义令牌（暗色，默认）

| 令牌 | 值 | 用途 |
| :--- | :--- | :--- |
| `--mwh-bg` | `#1C1D20` | 面板底（抽屉 / 子面板 / 浮岛） |
| `--mwh-card` | `#27282C` | 一级卡片（比面板更亮 = 更靠前） |
| `--mwh-card-2` | `#1E1F23` | 内嵌卡片 / 列表行 / 输入框底（比面板更暗 = 凹陷） |
| `--mwh-code` | `#141518` | 代码块 |
| `--mwh-text` | `#ECECEE` | 主文本 |
| `--mwh-text-2` | `#C4C5CC` | 次级文本（长段说明正文） |
| `--mwh-muted` | `#9E9FA6` | 弱化文本（hint / 元信息） |
| `--mwh-border` | `rgba(255,255,255,.07)` | **仅**面板外框与分割线 |
| `--mwh-subtle` | `rgba(255,255,255,.05)` | 徽章底、弱按钮底 |
| `--mwh-hover` | `rgba(255,255,255,.09)` | 默认按钮底、hover 面、**开关关闭态轨道** |
| `--mwh-accent` | `#2B7FFF` | 唯一主题色：开关开启、主按钮、焦点 |
| `--mwh-accent-soft` | `rgba(43,127,255,.15)` | 焦点环、选中态底、蓝色徽章底 |
| `--mwh-shadow` | `0 6px 20px 0 rgba(17,17,18,.45), 0 8px 36px 0 rgba(17,17,18,.35)` | 仅面板级浮层 |

### 2.2 语义令牌（亮色，`.mwh-light`）

| 令牌 | 值 |
| :--- | :--- |
| `--mwh-bg` | `#EFECE6`（纸感米白） |
| `--mwh-card` | `#F7F6F2` |
| `--mwh-card-2` | `#E6E4DE` |
| `--mwh-code` | `#F2F1EC` |
| `--mwh-text` | `#1D1D1F` |
| `--mwh-text-2` | `#4A4A4F` |
| `--mwh-muted` | `#63636A` |
| `--mwh-border` | `rgba(0,0,0,.06)` |
| `--mwh-subtle` | `rgba(0,0,0,.04)` |
| `--mwh-hover` | `rgba(0,0,0,.07)` |
| `--mwh-accent-soft` | `rgba(43,127,255,.12)` |
| `--mwh-shadow` | `0 4px 16px 0 rgba(17,17,18,.12), 0 6px 28px 0 rgba(17,17,18,.08)` |

### 2.3 功能色（状态语义，只用于徽章与图标，不做背景大面积填充）

| 语义 | 前景 | 徽章底 |
| :--- | :--- | :--- |
| 成功 / 就绪 | `#4ADE80`（深绿 `#22C55E` 仅用于圆点） | `rgba(34,197,94,.12)` |
| 警告 / 故障 | `#FBBF24`（深琥珀 `#F59E0B` 用于图标） | `rgba(245,158,11,.14)` |
| 危险 / 删除 | `#F87171` | `rgba(239,68,68,.14)` |
| 品牌蓝（深底上的蓝字） | `#8AB8FF` | `var(--mwh-accent-soft)` |
| 品牌蓝（亮底/主按钮 hover） | `#1B6FEF` | 同主按钮 |

> 三条品牌蓝 `#2B7FFF / #1B6FEF / #8AB8FF` 被 `scripts/test_ui_contract.mjs` 硬断言存在，删任何一个都会让门禁失败。

---

## 3. 尺度

### 3.1 圆角（只允许这 7 档）

| 档位 | 用途 |
| :--- | :--- |
| `24px` | 高级配置子面板 `#mwh-subpanel` |
| `20px` | 抽屉 `#mwh-drawer`、浮岛 |
| `14px` | 一级卡片 `.mwh-card` |
| `12px` | 内嵌卡片 / 预览块 `.mwh-card-flat` |
| `10px` | 列表行 `.mwh-list-row`、按钮 `.mwh-btn`、代码块 |
| `8px` | 输入框 / 下拉 / 图标按钮（`.mwh-input` 现为 9px，新代码用 8px） |
| `9999px` | 胶囊徽章 `.mwh-pill`、开关轨道与圆点 |

### 3.2 间距（4 基网格，允许 2px 修饰值）

`2 / 4 / 6 / 8 / 10 / 12 / 14 / 16 / 20 / 24`

| 场景 | 值 |
| :--- | :--- |
| 图标与文字 | `5-6px` |
| 行内元素组 | `8px` |
| 卡片内边距（一级） | `13px 15px` |
| 卡片内边距（内嵌） | `10px 12px` |
| 列表行内边距 | `8px 9px`（含开关的行建议 `8px 12px`） |
| 抽屉体 | `14px`，卡片间 `10px` |
| 子面板体 | `16-18px` |
| 抽屉与子面板间距 | `var(--mwh-gap)` = `16px`，左轨道 `var(--mwh-rail)` = `56px` |

### 3.3 字号字重

| 角色 | 字号 | 字重 | 行高 | 颜色 |
| :--- | :--- | :--- | :--- | :--- |
| 面板主标题 | `16px` | 600 | 1.3 | `--mwh-text` |
| 区块标题 / 行标题（强） | `13.5px` | 600 | 1.35 | `--mwh-text` |
| 行标题（列表内） | `11.5px` | 600 | 1.4 | `--mwh-text` |
| 正文 / 说明 | `12px` | 400 | 1.55 | `--mwh-muted` 或 `--mwh-text-2` |
| 元信息 / 徽章 | `10.5-11px` | 500 | 1.4 | `--mwh-muted` |
| 等宽（路径 / 端点 / Token） | `10.5-11.5px` | 400 | 1.55 | `--mwh-text-2` |

- 字体族：`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`；等宽 `ui-monospace, SFMono-Regular, Consolas, monospace`（数字用 `tabular-nums`）。
- 面板标题可加 `letter-spacing: -0.01em`；其余不加字距。
- **700 及以上字重仅用于品牌封面图**，界面内不使用。

### 3.4 时长与缓动令牌

动效和颜色一样是令牌，不是各组件自由发挥。**只有这五档时长、三种曲线**，新代码一律写 `var(--mwh-dur-*)` / `var(--mwh-ease-*)`，不写裸数值。

| 令牌 | 值 | 用途 | 判断标准 |
| :--- | :--- | :--- | :--- |
| `--mwh-dur-fast` | `80ms` | 按下反馈 | 手指/鼠标按下瞬间的形变，超过 100ms 会觉得迟钝 |
| `--mwh-dur-base` | `150ms` | 颜色微调 / Toast | hover、focus、行背景、Toast 进出 |
| `--mwh-dur-state` | `180ms` | 组件状态 | 开关、圆点位移、勾选、徽章换色等"状态真的变了" |
| `--mwh-dur-overlay` | `220ms` | 遮罩 / 轻浮层 | 抽屉遮罩、浮岛开合：要比面板先到半步 |
| `--mwh-dur-panel` | `240ms` | 容器进出 | 抽屉滑入、子面板展开、区块出现 |
| `--mwh-ease-color` | `ease` | 颜色 / 透明度 | `ease` 在短距离颜色过渡上比贝塞尔更"软" |
| `--mwh-ease-standard` | `cubic-bezier(0.16, 1, 0.3, 1)` | 位移 / 变换 | 快出慢收，iOS 原生手感；面板与圆点位移都用它 |
| `--mwh-ease-spring` | `cubic-bezier(0.22, 1, 0.36, 1)` | 轻弹 | 仅 Toast 进出、浮岛形变这类需要"落定感"的短动作 |

**选档规则**

1. 先问"这次变化是状态、位置还是出现/消失"：状态 → `--mwh-dur-state`；位置微调与颜色 → `--mwh-dur-base`；容器进出 → `--mwh-dur-panel`。
2. 状态类动画上限 `180ms`，容器类下限 `220ms`；两者不可交叉，否则同一屏会出现"重的比轻的还快"。
3. 同一屏内表达同一类动作只允许一种曲线：颜色一律 `--mwh-ease-color`，位移一律 `--mwh-ease-standard`。
4. 需要"弹一下"的场合才用 `--mwh-ease-spring`，且只作用在 `opacity` / `scale` 上，距 ≤ `8px`。

**与既有代码的对应关系**（历史字面量等价，改到哪行就把哪行换成令牌）：

| 历史写法 | 等价令牌 |
| :--- | :--- |
| `0.15s ease` | `var(--mwh-dur-base) var(--mwh-ease-color)` |
| `0.18s ease` | 近似 `var(--mwh-dur-state) var(--mwh-ease-color)` |
| `0.22s ease` | `var(--mwh-dur-overlay) var(--mwh-ease-color)` |
| `0.24s ease` | `var(--mwh-dur-panel) var(--mwh-ease-standard)` |
| `cubic-bezier(0.22, 1, 0.36, 1)` | `var(--mwh-ease-spring)` |

> 令牌挂在注入样式的 `:root` 上（`--mwh-` 前缀避免与 muse.ai 自身变量冲突），因此遮罩、左侧活动栏、浮岛等不在面板子树里的元素同样可用。已换成令牌的组件：`.mwh-switch` / `.mwh-switch-dot` / `.mwh-drawer-backdrop` / `.mwh-toast` / `.mwh-disclosure`。其余仍写裸值的历史规则按上表等价折算，改到哪行换哪行。

---

## 4. 组件规格

### 4.1 Switch 开关（布尔开关的唯一合法形态）

任何"开 / 关"语义必须用开关，不得用勾选框（`<input type=checkbox>` 仅保留给多选场景，如快照批量选择）。

**结构契约**

```html
<button type="button" role="switch" aria-checked="true" class="mwh-switch is-on" data-action="switch-bind" data-bind="resource.enabled">
  <span class="mwh-switch-dot"></span>
</button>
```

| 参数 | 值 |
| :--- | :--- |
| 轨道尺寸 | `46 × 28px`（长宽比 1.64，对齐官方截图的 51×31 观感） |
| 轨道圆角 | `9999px` |
| 内缩 | `3px` |
| 圆点尺寸 | `22 × 22px`，圆角 `9999px` |
| 圆点颜色 | `#FFFFFF`（明暗主题都用纯白，因轨道在两种主题下均为中性面） |
| 圆点投影 | `0 1px 2px rgba(0,0,0,.25)`（唯一允许的组件级阴影） |
| 圆点位移 | 关闭 `translateX(0)`；开启 `translateX(18px)`（= 46 − 3×2 − 22） |
| 开启轨道 | `background: var(--mwh-accent)` |
| 关闭轨道（暗） | `background: var(--mwh-hover)` = `rgba(255,255,255,.09)` |
| 关闭轨道（亮） | `background: rgba(0,0,0,.12)` |
| 过渡（轨道） | `background-color var(--mwh-dur-state) var(--mwh-ease-color), transform var(--mwh-dur-fast) var(--mwh-ease-color)` |
| 过渡（圆点） | `transform var(--mwh-dur-state) var(--mwh-ease-standard)` |
| 焦点环 | `box-shadow: 0 0 0 3px var(--mwh-accent-soft)`（`:focus-visible`） |
| 悬停 | 轨道亮度 +1 档：关闭态 暗 `rgba(255,255,255,.12)` / 亮 `rgba(0,0,0,.16)`；开启态 `#1B6FEF` |
| 按下 | `transform: scale(.97)`，`80ms` |
| 禁用 | 整体 `opacity: .45`；`cursor: not-allowed`；不响应键盘 |
| 故障态 | 开关**如实反映 `entry.enabled`**（故障只撤工具、不改启用登记，见 `src/resources/manager.ts`）；故障一律由琥珀色徽章与 `title` 说明原因。禁止用开关位置表达"是否可用"，也禁止把故障条目显示成绿色"已就绪" |
| 描边 | 无。任何情况下不加 border |

**行为契约**

- 点击只切换一次状态，并在**同一个 DOM 节点**上原地改 `is-on` + `aria-checked`，让过渡自然播放；禁止用整块 `innerHTML` 重绘驱动状态切换（新节点一出生就是终点态，过渡不会播放）。
- 需要服务端确认的开关：先按目标态上色播动画，请求失败再反向播放回滚，最多补足 180ms 后重绘；连点必须被拦截，不得发出两次相反请求。
- 键盘：`Tab` 可聚焦，`Enter` / `Space` 等价于点击。
- 无障碍：`role="switch"` + `aria-checked` 必须随状态更新；缺失视为缺陷。
- 系统开启"减少动效"时过渡归零，只保留状态跳变。

### 4.2 设置行（Switch Row）

官方设置面板的基本单元：一整行 = 一张无边框卡片，左文字右开关。

| 参数 | 值 |
| :--- | :--- |
| 容器 | `background: var(--mwh-card-2)`；`border-radius: 10px`；`border: none` |
| 高度 | 最小 `44px`（`8px` 上下内边距 + `28px` 开关） |
| 内边距 | `8px 12px` |
| 布局 | `display:flex; align-items:center; justify-content:space-between; gap:12px` |
| 左标题 | `12px / 500`，`--mwh-text`，单行省略 |
| 左副标题（可选） | `10.5px / 400`，`--mwh-muted`，单行省略 |
| 行间距 | `6px` |
| 悬停 | 仅当整行可点击时给 `background: var(--mwh-hover)`；纯设置行不响应悬停 |

### 4.3 卡片 Card

| 变体 | 背景 | 圆角 | 内边距 | 描边 |
| :--- | :--- | :--- | :--- | :--- |
| 一级 `.mwh-card` | `--mwh-card` | `14px` | `13px 15px` | 无 |
| 内嵌 `.mwh-card-flat` | `--mwh-card-2` | `12px` | `10px 12px` | 无 |
| 列表行 `.mwh-list-row` | `--mwh-card-2` | `10px` | `8px 9px` | 无 |
| 空态 `.mwh-empty` | 透明 | `12px` | `14px` | `1px dashed var(--mwh-border)`（空态是唯一允许虚线框的场景） |

卡片之间用 `--mwh-divider`（`1px` 高的 `--mwh-border` 色块）分隔，**不用** `border-top`。

### 4.4 按钮 Button

| 变体 | 背景 | 前景 | 用途 |
| :--- | :--- | :--- | :--- |
| 默认 `.mwh-btn` | `--mwh-hover` | `--mwh-text` | 次要操作 |
| 主 `.mwh-btn-primary` | `--mwh-accent` | `#FFFFFF`（hover `#1B6FEF`） | 每屏最多 1 个 |
| 幽灵 `.mwh-btn-ghost` | `--mwh-card-2` | `--mwh-text` | 并列次按钮 |
| 危险 `.mwh-btn-danger` | `rgba(239,68,68,.16)` | `#F87171` | 删除 |
| 图标 `.mwh-icon-btn` | 透明（hover `--mwh-hover`） | `--mwh-muted` | `28×28`，圆角 `8px` |

统一参数：圆角 `10px`（图标按钮 `8px`）、内边距 `7px 12px`、字号 `12px / 500`、图标 `13-14px`、间距 `5px`、过渡 `150ms ease`、禁用 `opacity .4`。全部 `border: 0`。

> `.mwh-btn-switch`（84×28 的文字态按钮）**不再用于布尔切换**：任何"开/关"一律改用 4.1 的 Switch。该 class 只留给"停止隧道 / 拉起隧道"这类带文字的动作按钮（动作会发起新请求，不是状态翻转）。

### 4.5 徽章 Pill

`font-size: 11px / 500`、`padding: 2.5px 8.5px`、`border-radius: 9999px`、`background: var(--mwh-subtle)`、`color: var(--mwh-muted)`。语义色见 2.3。徽章只表达状态，**不可点击**；可点击的一律用按钮。

### 4.6 输入框 Input

`background: var(--mwh-card-2)`、`border-radius: 8px`、`padding: 7px 9px`、`font-size: 11.5px`、`border: none`、常态 inset 描边 `0 0 0 1px rgba(255,255,255,.03)`；聚焦 `0 0 0 1px rgba(43,127,255,.42), 0 0 0 4px rgba(43,127,255,.14)`。等宽输入加 `.mwh-mono`。

### 4.7 面板 Panel

| 面板 | 圆角 | 背景 | 阴影 | 描边 |
| :--- | :--- | :--- | :--- | :--- |
| 抽屉 `#mwh-drawer` | `20px` | `--mwh-bg` | `--mwh-shadow` | 无 |
| 子面板 `#mwh-subpanel` | `24px` | `--mwh-bg` | `--mwh-shadow` | 无 |
| 审批浮岛 `#mwh-approval-island` | `20px` | `--mwh-bg` | `--mwh-shadow` | 无 |
| 确认弹窗 `#mwh-confirm-dialog` | `18px` | `--mwh-card` | `--mwh-shadow` | 无 |

面板外框如需边界，只允许 `1px solid var(--mwh-border)`（7% 白 / 6% 黑），且**仅限最外层**。抽屉宽 `min(clamp(280px, 25vw, 420px), 剩余视口)`，子面板 `min(640px, 剩余视口)`——这两个值被门禁断言，不可随意改。

### 4.8 动效与过渡（分组件参数表）

三条硬规则：

1. **只动这六个属性**：`transform` / `opacity` / `background-color` / `border-color` / `box-shadow` / `color`。动 `width` / `height` / `top` / `left` / `margin` / `padding` 会触发重排，一律禁止——折叠区用 `<details>` 原生开合，不要自己补高度动画（唯一例外见本节末尾的浮岛尺寸形变）。
2. **时长与曲线只能取 3.4 的令牌**，同一组件内不得出现两种曲线表达同一类动作。
3. **动画期间不得产生布局位移**：起止两帧的 `getBoundingClientRect()` 必须一致，允许变的只有颜色、透明度与 `transform`。

| 组件 | 触发 | 动画属性 | 时长 | 曲线 |
| :--- | :--- | :--- | :--- | :--- |
| Switch 轨道 | 状态翻转 | `background-color` | `--mwh-dur-state` | `--mwh-ease-color` |
| Switch 圆点 | 状态翻转 | `transform: translateX` | `--mwh-dur-state` | `--mwh-ease-standard` |
| Switch 按下 | `:active` | `transform: scale(.97)` | `--mwh-dur-fast` | `--mwh-ease-color` |
| 按钮 / 图标按钮 | hover、focus | `background-color`、`color` | `--mwh-dur-base` | `--mwh-ease-color` |
| 设置行 / 列表行 | hover（仅可点击行） | `background-color` | `--mwh-dur-base` | `--mwh-ease-color` |
| Tab 切换 | 选中态变化 | `background-color`、`color` | `--mwh-dur-base` | `--mwh-ease-color` |
| 折叠 `details` | 展开 / 收起 | 原生开合 + `background-color` | `--mwh-dur-base` | `--mwh-ease-color` |
| 抽屉 | 开 / 合 | `transform: translateX` | `--mwh-dur-panel` | `--mwh-ease-standard` |
| 抽屉 | 开 / 合 | `opacity` | `200ms` | `--mwh-ease-color` |
| 抽屉遮罩 | 开 / 合 | `opacity` | `--mwh-dur-overlay` | `--mwh-ease-color` |
| 子面板 | 开 / 合 | `transform` | `--mwh-dur-panel` | `--mwh-ease-standard` |
| 子面板 | 开 / 合 | `opacity` | `200ms` | `--mwh-ease-color` |
| Toast | 进入 / 退出 | `opacity` + `translateY(6px)` | `--mwh-dur-base` | `--mwh-ease-spring` |
| 审批浮岛开合 | 胶囊 ↔ 面板 | `width`、`height`、`border-radius` | `--mwh-dur-panel` | `--mwh-ease-spring` |
| 审批浮岛开合 | 胶囊 ↔ 面板 | `box-shadow` | `--mwh-dur-panel` | `--mwh-ease-color` |
| 审批浮岛开合 | 胶囊 ↔ 面板 | `opacity` | `--mwh-dur-state` | `--mwh-ease-color` |
| 审批浮岛弹动 | 长按进入拖动态 | `scale`（220ms） | `--mwh-dur-overlay` | `--mwh-ease-spring` |
| 审批浮岛拖拽 / 缩放 / 松手吸附 | 进行中 | 无 | `0` | `none`（必须跟手，`.is-dragging` / `.is-resizing` 强制关闭） |
| 加载指示 `.mwh-spin` | 持续 | `rotate` | `0.75s` | `linear`，无限循环 |

> **唯一允许动尺寸的地方**：审批浮岛在胶囊 ↔ 面板之间切换时动画 `width` / `height` / `border-radius`。它是整块悬浮层的尺寸形变（`position: fixed`，不参与任何父级布局），不会引起周围重排；其余所有组件一律禁止动尺寸。

**实施红线**

1. 过渡必须写在**会被保留的节点**上。凡是用整块 `innerHTML` 重绘来切状态的，动画一定不播放——要么原地改 class（推荐），要么推迟重绘直到动画播完。
2. 请求驱动的开关走"乐观上色 → 等服务端 → 补足动画时间 → 重绘"；失败则反向播放回滚，不允许硬跳。**注意 SSE 先于 HTTP 响应到达**：状态广播触发的重绘也必须让路给正在播放的过渡，否则动画照样停在中途。
3. 同一个开关在动画未完成前忽略重复点击（连点锁），避免发出两次相反请求。
4. `prefers-reduced-motion: reduce` 下所有过渡必须为 `none !important`（这是 `!important` 的白名单用法），且不保留按下缩放。唯一例外是加载指示 `.mwh-spin`：它属于功能反馈，停转会让界面看起来卡死（WCAG 2.3.3 例外）。
5. 新代码禁止 `transition: all`；只列真正会变的属性。
6. 动画不得作为状态的唯一表达：禁用/故障/加载都必须有不依赖动画的静态文案或徽章。

---

## 5. 状态矩阵

| 组件 | 默认 | 悬停 | 按下 | 聚焦 | 禁用 | 故障 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| Switch | 见 4.1 | 轨道亮度 +1 档 | `scale(.97)`（80ms） | 3px accent-soft 环 | `opacity .45` | 位置如实反映 enabled，琥珀徽章说明故障 |
| 主按钮 | `--mwh-accent` | `#1B6FEF` | `scale(.98)` | accent-soft 环 | `opacity .4` | 动作失败回滚，不改配色 |
| 次按钮 | `--mwh-hover` | `--mwh-subtle` | `scale(.98)` | accent-soft 环 | `opacity .4` | 同上 |
| 输入框 | inset 3% 白 | 同默认 | — | 1px 蓝 + 4px 光晕 | `opacity .5` | 错误用 1px `#F87171` 环 |
| 列表行 | `--mwh-card-2` | 可点击才加 `--mwh-hover` | — | 随内部控件 | `opacity .45` | 左侧琥珀点 + 徽章 |

**故障与谎报**：任何"看起来开着但实际挂了"的展示都是缺陷。状态真源是注册表 `entry.enabled` + `runtimeStatus`；UI 必须同时表达"是否启用"与"是否可用"两个维度。

---

## 6. 文案规范

1. 标题 4-8 字，名词化（"连接器"、"权限"、"资源库"），不加句号。
2. 说明 ≤ 2 行、≤ 60 字，句式「做什么 + 何时生效」。
3. 禁止感叹号、营销词（"强大"、"极致"、"一键搞定"）、拟人化安慰（"别担心"）。
4. 禁止面向 AI 的提示语（"请助手注意…"、"你应当…"）。设置界面的人类受众由 `scripts/test_ui_contract.mjs` 第 10 条门禁强制。
5. 必须如实披露的既有文案不可删改：`打开即对 Muse 生效，默认全部关闭。`、`MCP 在你的 Windows 用户权限下运行，没有额外沙箱。`
6. 数字与单位用半角（`2 小时`、`30 天`、`640 MB`），中文与英文之间留一个空格。

---

## 7. 禁止清单（反例总表）

| 禁止 | 原因 |
| :--- | :--- |
| 紫色（`#A855F7` / `#8B5CF6` / `#9333EA` / `#C084FC` 及其 rgba） | 非 Muse 品牌色，门禁硬失败 |
| 组件加 `border: 1px solid` | 违反 A2/A3；这是"AI 味"的主要来源 |
| 蓝色大面积填充（> 单屏面积 10%） | 违反 A1 |
| 渐变按钮 / 渐变卡片底 | 违反 A1，官方全平涂 |
| emoji 图标 | 门禁硬失败；图标一律用内联 SVG |
| 圆角不在 3.1 七档内 | 视觉碎片化 |
| 字号不在 3.3 六档内 | 视觉碎片化 |
| `<input type=checkbox>` 表达开/关 | 违反 4.1；仅多选场景可用 |
| 面板内部再套 sub-card 边框 | 违反 A5 |
| 700+ 字重用于界面文字 | 违反 3.3 |
| 新代码写 `transition: all` | 会连带动画不该动的东西（布局、阴影、字体），违反 4.8 规则 1 |
| 过渡里出现裸时长 / 裸曲线（如 `0.2s ease-in-out`） | 必须用 3.4 令牌，否则同一动作在不同组件会不同速 |
| 动画 `width` / `height` / `top` / `left` / `margin` | 触发重排，违反 4.8 规则 1 |
| 用整块 `innerHTML` 重绘驱动状态动画 | 节点被替换，过渡不会播放（4.8 红线 1） |
| 缺少 `prefers-reduced-motion` 兜底 | 违反 4.8 红线 4，无障碍缺陷 |
| 面向 AI 的提示语、退役概念（`agentask` / `dsh` / `codex` / `opencode` / `grok`） | 门禁硬失败 |

---

## 8. 双实现面落地约定

| 实现面 | 位置 | 落地方式 |
| :--- | :--- | :--- |
| 注入面（桌面壳） | `shell/muse-settings-preload.cjs` | 优先复用本文已有的 `.mwh-*` class；新增 class 必须在此登记规格；禁止内联 `style` 写新色值（历史内联样式见一次改一次，不再新增） |
| 调试面（浏览器） | `frontend/src/overlay/*.tsx` | 色值走 `var(--mwh-*)` 或 Tailwind 任意值引用同一 hex；布尔控件统一用 `MwhSwitch.tsx`；不得直接写 `border border-white/5` |

两处行为必须一致：同一开关在 preload 与 React 面点击后，发往守护进程的请求、状态真源、故障表达完全相同。

**动效也必须一致**：preload 用 `var(--mwh-dur-*)` / `var(--mwh-ease-*)`，React 面无法读 CSS 变量到 Tailwind 类，需以字面量镜像同一组数值（`180ms ease` / `180ms cubic-bezier(0.16,1,0.3,1)` / `80ms ease`），并在 `MwhSwitch.tsx` 注释里标注对应令牌名。改了 preload 的令牌，必须同步改 React 字面量，反之亦然。

---

## 9. 新增组件检查表

提交前逐条自查：

1. 用到的字号、圆角、间距是否都在第 3 节档位内？
2. 有没有新增 hex？能否改成 `--mwh-*`？
3. 有没有 `border`？（除面板外框、空态虚线、输入框 inset）
4. 蓝色面积是否只出现在"开启 / 主行动 / 焦点"？
5. 明暗两套主题下是否都表达正确？关闭态在亮色主题是否看得见？
6. 布尔开关是否有 `role="switch"` + `aria-checked` + 键盘可达？
7. 禁用态、故障态是否都定义？
8. 文案是否 ≤ 2 行、无感叹号、无 AI 提示语？
9. 动效是否只用了 3.4 的时长/曲线令牌，且只动 4.8 白名单里的属性？
10. 状态切换是否原地绘制（不靠整块 `innerHTML` 重绘）？开着"减少动效"时是否还有动画残留？
11. `npm run test:ui-contract` 是否通过？
