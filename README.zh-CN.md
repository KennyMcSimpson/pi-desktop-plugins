# PI-Desktop Plugins

[English](./README.md)

[PI-Desktop](https://github.com/vastsa/PI-Desktop) 的插件目录与可安装 `.piplug` 安装包仓库。

> **插件源码不再放在这里，也不再接受「新增插件源码」的 Pull Request。** 源码放在作者自己的仓库，所有发布都走插件中心 [plugins.aiuo.net](https://plugins.aiuo.net)（客户端默认目录源）。原来的 `plugins/` 目录已删除。要发布插件，看[发布插件](#发布插件)。

## 发布插件

### 1. 在自己的仓库里开发

在 PI-Desktop 里用模板起步：**插件 → ⋯ → 从模板新建插件**（`panel-basic`、`agent-tool-basic`、`skill-pack`、`full-demo`）。在 PI-Desktop 仓库里也可以用 devkit 命令行：

```bash
pnpm --filter @pi-desktop/plugin-devkit... build
pnpm pi-plugin init panel-basic ../my.plugin-id
pnpm pi-plugin check ../my.plugin-id     # 校验清单、权限、引用文件与体积
pnpm pi-plugin pack ../my.plugin-id      # dist/my.plugin-id-0.1.0.piplug 并打印 SHA-256
```

开发时用 **插件 → 加载开发插件** 加载目录，发布前用 **安装插件包** 装一次生成的 `.piplug`。完整的开发契约（manifest schema、宿主 API、权限、安全）见 PI-Desktop 仓库的 [`docs/plugin-development.md`](https://github.com/vastsa/PI-Desktop/blob/main/docs/plugin-development.md)。

### 2. 在插件中心发布

两条路，同一个后端：

- **控制台** — 登录 [plugins.aiuo.net](https://plugins.aiuo.net) → **我的插件** → **创建插件**：上传安装包、绑定插件所在的仓库、提交。后续版本在插件自己的页面提交。
- **AI 客户端** — 装上发布 skill，让 Agent 跑完整流程：

  ```text
  https://plugins.aiuo.net/skill.md
  ```

  skill 通过 MCP 地址 `https://plugins.aiuo.net/mcp` 调用，凭证是[控制台 → 令牌](https://plugins.aiuo.net/console/publish/tokens)生成的个人访问令牌，存放在 `~/.pi-desktop/plugin-center.token`。调用时要把本地 `manifest.json` 的字段连同源码文件一起提交——`ui`、`contributes`、`activationEvents`、`fs`、`net` 一个都不能漏，漏了装出来的插件是坏的。

一次发布需要三样东西：

1. **打好标签的源码仓库**：推送插件并给版本打标签（如 `v0.4.8`），标签或 commit SHA 就是源码审查读取的 `sourceRef`。
2. **已绑定的仓库**：插件通过控制台的「源码仓库」绑定到一个仓库（GitHub App 授权）。绑定是源码审查和目录 source pin 的依据，之后非管理员无法更换。
3. **一个没发布过的版本号**，并附发布说明。平台审查源码、管理员审批后，版本带着 SHA-256 与安装量上线。

`pi.`、`demo.` 是保留命名空间，发布需要管理员身份。

## 本仓库包含什么

| 路径 | 说明 |
|------|------|
| `catalog.json` | 本仓库对外提供的插件目录 |
| `packages/*.piplug` | 目录引用的已发布安装包 |
| `scripts/security_audit.py` | 对每个 `.piplug` 的失败即阻断式预检 |
| `scripts/sync_catalog.py` | 从插件中心同步 `catalog.json` + `packages/` |
| `tests/` | 上述脚本的 Python 测试 |
| `website/` | 可选的独立市场网站（读目录渲染） |

`plugins/` 已经不存在：源码不在本仓库托管、也不在本仓库审查；插件中心从作者仓库构建、审查、发布，并把结果同步到 [AIUO-Net/pi-desktop-plugins](https://github.com/AIUO-Net/pi-desktop-plugins) 作为 GitHub 备用源。

## 🎯 可用插件

插件中心才是实时列表：[plugins.aiuo.net](https://plugins.aiuo.net) 提供每个插件的最新版本，也包括作者在自己仓库发布的插件。下表是本目录收录的插件。

### 官方插件（PI-Desktop 团队维护）

| 插件 | 说明 | 作者 |
|------|------|------|
| **pi.todo** | 小清新待办：四象限矩阵 + 简单列表双布局，支持到期提醒与 AI 工具集成 | PI-Desktop |
| **pi.token-insights** | Token 用量分析仪表盘：追踪 PI-Desktop、Claude Code、Codex 等工具的 Token 消耗 | PI-Desktop |
| **pi.gitlens** | GitLens 风格的本地 Git 管理，停靠在右侧工作面板（仅人机 UI，无 Agent 工具） | PI-Desktop |
| **pi.ssh-manager** | 本地优先的 SSH 主机管理与 AI 远程命令工具，支持面板临时密码且不持久化凭据 | PI-Desktop |
| **pi.terminal** | 受 Otty 启发的交互式终端，只停靠在右侧工作面板；多标签、跨平台 shell | PI-Desktop |
| **pi.session-orchestrator** | 会话编排器：让 Agent 并行创建真实持久化 Worker Session，进行多轮督导并验收最终报告 | PI-Desktop |

### 社区插件

| 插件 | 说明 | 作者 |
|------|------|------|
| **pi.scratch-calc** | 草稿计算器：多行演算、历史记录、百分比/乘方/π/e 支持，暗色模式 | Tioit-Wang |
| **pi.super-domain-man** | 超级域名侠：多平台 DNS 记录管理与 SSL 证书监控/申请工具 | Tioit-Wang |
| **pi.markdown** | 本地 Markdown 笔记：所见即所得编辑、目录大纲、代码高亮、Mermaid / KaTeX | Tioit-Wang |
| **pi.clipboard-history** | 剪贴板历史：运行期间捕获文本，保留 30 天，一键还原 | Tioit-Wang |
| **pi.log-viewer** | 大日志查看器：流式分页、实时跟随、搜索高亮、多文件页签 | Tioit-Wang |
| **pi.file-manager** | 文件管理器：目录树、代码高亮编辑、Markdown 预览、图片音视频与 CSV/JSON 查看、SQLite 只读浏览与 SQL 查询、右键文件操作、按文件名搜索 | Tioit-Wang |
| **pi.bianqian** | Markdown 桌面便签：多便签、实时预览、任务列表、荧光笔与回收站 | ZY |
| **io.github.muzimu217.session-import** | 一体化会话导入与熔炉：导入 ZCode、WorkBuddy、Claude Code、Codex、OpenCode、Pi 的会话，再蒸馏成项目约定与可复用做法；源码在 [muzimu217/pi-desktop-session-import](https://github.com/muzimu217/pi-desktop-session-import) | muzimu217 |
| **io.github.muzimu217.deps-audit** | 依赖漏洞扫描：唤起 osv-scanner 扫描工作区，列出 OSV 依赖漏洞，让 Agent 给出升级或修复 patch | muzimu217 |
| **io.github.liushunqiu.pi-idea-git** | IDEA 风格 Git 工具窗口：暂存/未暂存分组、按代码块暂存与还原、提交、分支切换、图形化日志与储藏 | liushunqiu |
| **pi.workspace-file-guard** | C盘防垃圾：防止模型把测试、日志、缓存、临时文件写到系统盘、桌面、下载，垃圾只待在当前项目的 Temp 或 scratch | xingleiwu |
| **pi.goal-x** | 为 PI-Desktop 提供持久化工作区目标、任务证据与宿主完成审计 | Goal X contributors |
| **pi.parchment** | 羊皮纸主题：米色纸面背景配淡网格，墨色用户气泡，纸色助手卡片，等宽字体元信息行（纯样式） | pkmcenter |
| **pi.obsidian-theme** | 黑曜石主题：深蓝青全局主题，按实测参考图校准——分层表面阶梯、用 1px 发丝边框而非发光建立层级、实心青绿选中态、四档文字层级（纯样式） | ily55421 |

插件中心上由作者自有仓库发布：

| 插件 | 说明 | 作者 |
|------|------|------|
| **cc.mcii.session-notify** | 会话通知：监听全部会话状态变化，把标题和状态推到飞书、钉钉、企业微信、KOOK、Server酱、Telegram 或通用 Webhook；不读消息正文 | LectWolf |
| **cc.mcii.session-usage** | 会话用量：输入 `/usage` 查看当前会话的输入、输出、缓存命中、缓存创建与命中率 | LectWolf |
| **cn.star.computer-use** | 复刻 Codex 的操控功能，让 AI 直接操控电脑完成简单作业 | TheFalreStar |
| **cn.star.grok-enhance** | 给 Grok 加执行纪律，并在每轮第一请求直接激活 Grep / Glob（以及已装的 memory / skill_manage） | TheFalreStar |
| **cn.star.skill-learning** | 把做完的一件事沉淀成 SKILL，下次同类活直接复用；会话较长时在后台自行复盘 | TheFalreStar |
| **cn.star.user-profile** | 本地记录「用户是谁」和「这台机器怎么用」，每轮注入系统提示，Agent 用 `memory` 工具写入；不接远程记忆服务 | TheFalreStar |
| **io.github.catdford.color-picker** | 浏览 Tailwind / Material 全量色板，放大镜从图片取色，按和谐规则或让 AI 生成配色，检查 WCAG 对比度与色盲模拟，导出 CSS 变量 / Tailwind / JSON，也能装成 PI-Desktop 主题 | catdford |
| **local.pi-markdown** | 本地 Markdown 笔记：所见即所得编辑（Typora 风格 Milkdown Crepe）、米白/黑夜双主题、5 级目录与大纲、代码高亮、Mermaid 与 KaTeX、全局搜索、导出 Markdown/HTML/图像，以及只读预览 Agent 工具 preview_file | Tioit-Wang |
| **pi.theme.studio** | 主题工坊：内置 5 套配色，可视化调出属于自己的主题并一键应用，覆盖全部 56 个 `--ds-*` token，点预览区域即可编辑（整窗/左栏/中栏/右栏/标题栏/会话区/输入栏），带实时预览与 WCAG 对比度检查，另带 4 个 Agent 工具 | Tioit-Wang |

### 模板插件

原先的 `demo.*` 源码已从本仓库移除——新插件请用 PI-Desktop 内置模板（**插件 → ⋯ → 从模板新建插件**）起步。它们已发布的安装包仍可安装：

| 插件 | 说明 |
|------|------|
| **demo.hello** | 最小示例：面板 + 命令 + 工具注册 |
| **demo.workspace-summary** | 实用模板：扫描工作区并生成摘要 |
| **demo.workspace-notes** | 高风险能力演示：文件读写 + 网络请求 |

## 🚀 安装插件

1. 打开 PI-Desktop → **插件**
2. 进入 **市场** 页面
3. 点击 **刷新** 加载最新目录
4. 浏览并安装插件

默认源是插件中心：

```text
https://plugins.aiuo.net/catalog.json
```

同一页面还能切换到客户端内置的备用源——GitHub 镜像（`raw.githubusercontent.com/AIUO-Net/pi-desktop-plugins/main/catalog.json`）和 CNB 镜像，用于插件中心不可达的网络。

## 刷新本仓库的目录

`scripts/sync_catalog.py` 把插件中心已发布的目录与安装包同步进本仓库，失败即阻断：先在临时目录里暂存，空目录或归零目录会被拒绝，最后才替换 `catalog.json` 与 `packages/`。

```bash
python3 scripts/sync_catalog.py --dry-run   # 只报告会变什么
python3 scripts/sync_catalog.py             # 替换 catalog.json + packages/
python3 scripts/security_audit.py --check-packages
```

`catalog.json` 是生成物，不要手改。

## 插件目录结构

```text
<你的插件仓库>/
├── manifest.json      # 必需：插件元信息
├── main.js            # 必需：插件入口（CJS，导出 onLoad()/onUnload()）
├── renderer/          # 可选：面板 UI
│   ├── index.html
│   ├── style.css
│   └── script.js
├── README.md          # 推荐：插件说明文档
└── skills/            # 可选：AI Agent 工具定义
```

### manifest.json 关键字段

```json
{
  "schemaVersion": 1,
  "id": "my.plugin-id",
  "name": "My Plugin",
  "version": "0.1.0",
  "description": "插件功能描述",
  "i18n": {
    "en": { "name": "My Plugin", "description": "What it does", "safetyNotes": "What it can reach" },
    "zh-CN": { "name": "我的插件", "description": "插件功能描述", "safetyNotes": "能访问什么" }
  },
  "author": "your-name",
  "main": "main.js",
  "categories": ["productivity"],
  "permissions": ["ui.panel"],
  "engines": { "piDesktop": ">=0.2.0" }
}
```

`i18n` 必须同时有 `en` 与 `zh-CN` 的 `name`、`description`、`safetyNotes`；所有本地化槽位（`ui.title`、`contributes.views[].title`）都要双语——只翻译一半的标题会被宿主直接拒绝，插件中心的上传门禁也会拦下。

### 常用权限

| 权限 | 用途 |
|------|------|
| `ui.panel` | 打开隔离面板 |
| `ui.view` | 停靠到右侧工作面板 |
| `fs.read.workspace` | 读取工作区文件 |
| `fs.write.workspace` | 修改工作区文件 |
| `clipboard.read` / `clipboard.write` | 剪贴板读写 |
| `notify` | 本地通知 |
| `net.fetch` | 外部网络请求 |
| `shell.openExternal` | 打开外部链接 |
| `agent.tool.register` | 注册 AI Agent 工具 |
| `agent.prompt.inject` | 注入 skill 提示 |
| `background.service` | 保持插件进程常驻 |
| `usage.read` | 读取本地 Token 用量汇总 |

> **提示**：只申请所需的最小权限集。高风险权限会在安装时提示用户确认。

## 🔐 安全审查

插件审查是发布门禁，发生在插件中心，针对打标签的源码与打包产物。一票否决项、风险分级、安装包检查与漏洞报告流程见 [SECURITY.md](./SECURITY.md)。`packages/` 里的每个包都必须通过：

```bash
python3 scripts/security_audit.py --check-packages
```

## 📋 贡献流程

**本仓库不接受「新增插件源码」的 Pull Request。** 提了也会被关闭，并附上插件中心的入口——同样的审查会在你自己的仓库上进行。详见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

本仓库欢迎的贡献在分发侧：SHA-256 不对、`.piplug` 打不开、目录条目过期、网站问题、文档错误。

## 📦 打包约束

- 包根目录必须包含 `manifest.json`
- 不允许符号链接或路径穿越
- store-compressed 的 `.piplug` 格式（普通 zip 会被安装器拒绝）
- 最大包体积 50MB，最多 2000 个文件
- 不要期望宿主端 `npm install`，请自行打包依赖

## 📄 License

MIT
