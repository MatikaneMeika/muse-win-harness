# MWH 分支开发与实机隔离测试规范

> **核心原则**：分支测试严禁污染 `main` 分支。每次在独立分支上完成代码修改后，桌面外壳启动时自动读取当前 Git 分支并在窗口顶栏标注分支名称徽章；实机测试支持一键双击无缝启动。

---

## 一、 分支隔离与测试的标准机制

### 1. 本地指针切换隔离（默认且最轻量）
- **开发与测试方式**：
  在代码修改前创建独立分支：`git checkout -b <branch_name>`。
  由于 Git 是工作树指针切换，当前目录内的所有代码即为分支的独立代码，**未执行 `git merge` 前绝不会对 `main` 产生任何污染**。
- **启动测试**：
  直接双击根目录下的 [`MWH启动.cmd`](../MWH启动.cmd) 即可启动该分支的桌面外壳。

### 2. 独立工作树隔离（Git Worktree — 并行无干扰测试）
若用户希望在不切换主工作区目录、保持 `main` 随时可用的情况下测试分支：
```powershell
# 在同级目录创建该分支的独立工作树
git worktree add ../mwh-test-branch <branch_name>

# 进入独立目录双击启动或测试
cd ../mwh-test-branch
.\MWH启动.cmd

# 测试完成后安全卸载
git worktree remove ../mwh-test-branch
```

---

## 二、 自动化窗口分支标识（已落地代码）

为了防止用户混淆当前测试窗口是运行在 `main` 还是特定实验分支上：
1. **主进程自动检测**：[`shell/main.cjs`](../shell/main.cjs) 启动时自动执行 `git rev-parse --abbrev-ref HEAD` 提取当前分支。
2. **顶栏视觉标识**：
   - 若当前处于 `main` 分支：顶栏徽章显示标准的 `v0.1.0`；
   - 若当前处于任何特性/修复分支（如 `<feature-branch>`）：
     - 窗口标题自动标注为 `Muse-Win-Harness [<feature-branch>]`；
     - 顶栏 `#version-badge` 自动展示 `v0.1.0 · <feature-branch>`。

---

## 三、 每次分支修改后的标准双击测试流程

1. **直接双击根目录脚本**：
   [`MWH启动.cmd`](../MWH启动.cmd)
2. **脚本自闭环保证**：
   - 若检测到尚未编译 `dist\cli.js`，自动执行 `npm run build`；
   - 不会粗暴全局强杀系统内其他无关的 `electron.exe` 应用（如 VS Code 等）；
   - 自动拉起当前工作区的桌面外壳与后台守护进程，窗口顶栏自动带上当前版本与分支标记徽章。
