# 圆桌 · PI-Desktop 插件

插件 id `io.github.kennymcsimpson.governed-roundtable` · 版本 0.1.0 · [English](README.md)

> **状态：已在仿照上游插件 SDK 写的假宿主上测过，也在官方 PI-Desktop 0.16.1 便携版里用 stub 模型测过。** 真实应用里测过的有：Load dev plugin、权限审阅、命令面板、面板、对话里使用 `Room` 工具、带托管席位的完整一轮，以及 Install plugin package（见「已验证 / 未验证」）。还没测的是真实模型，以及外部 agent 加入由真实应用服务的房间。
>
> 有两条限制是设计使然，不是待修的缺陷：
> - **PI 席位不会被自动唤醒。** 没有任何插件接口能从后台服务唤醒 PI 对话，需要你让那个对话继续。
> - **托管席位只做讨论。** 每回合只有一次纯文本 `agent.complete`，不带工具。

这个插件只用上游 [PI-Desktop](https://github.com/vastsa/PI-Desktop) 公开的插件接口，把 room-dev 的受治理房间带进 PI-Desktop，不改宿主、不改核心。房间引擎就是 room-dev 本身，原样内置在插件目录的 `room-dev/` 里（提交号记在 `room-dev/VENDORED.json`），在插件自己的进程里运行。

## 组成

| 部分 | 上游接口 | 做什么 |
|---|---|---|
| 房间宿主（常驻服务 `room-host`） | `contributes.services`、`pi.services.register`、权限 `background.service` | 为你服务的每个房间运行 room-dev 的房间服务（`lib/api.mjs` 的 `openRoom`），并在 `127.0.0.1` 上提供房间界面、维持 `service.lock` 心跳。服务停止时关闭它服务的所有房间并删除 `service.lock`；下次启动时重新服务之前在服务的房间。 |
| Room 工具（Agent 工具，风险 high） | `pi.agent.registerTool`、`agent.tool.register` | PI 对话可以 `list` 看房间、`create` 建房、`join` 认领一个 PI 席位，并且只操作**自己的席位**：`wait`、`submit`、`pass`、`point`、`quote`、`misquoted`、`mark`、`verdict`、`disclose`、`assign`、`artifacts`、`status`、`leave`。 |
| 面板与命令「Governed Roundtable: Open panel」 | `ui.panel`、`pi.commands.register`、`onPanelInvoke` | 你这一侧的操作：列出房间、席位与绑定；在此服务 / 停止服务；设任务、开始一轮；发用户消息；重试 / 跳过；批准 / 拒绝披露；接受过期；散会；解除席位绑定。已散会的房间在面板里只读：没有在此服务、停止服务和打开房间界面的按钮；它的「解除绑定」要点两次，因为对话要靠绑定读散会包。 |
| 浏览器里的房间界面 | `pi.shell.openExternal`，权限 `shell.openExternal` | 在系统浏览器里打开 room-dev 完整的房间界面（`http://127.0.0.1:<端口>/#<admin 令牌>`）。 |
| 托管席位（通道 `pi-complete`） | `pi.agent.complete`，权限 `agent.complete` | 只讨论档的席位，经你在 PI-Desktop 里配置的模型发言：每回合一次补全，不带工具。作为 room-dev 的 `hostedProviders.lane` 工厂接入。 |
| 轮次提示 | `pi.ui.showToast`（不需要权限） | 手动等待的席位轮到时，每个 attempt 给你弹一次提示，用宿主的语言（任何 `zh` 语言环境用中文，其余用英文）：每次弹提示前重新读 `pi.app.getLocale`，并经 `pi.events` 跟随 `appearance:changed`。 |

PI 席位的包只写 Room 工具的调用（模型看到的工具名是 `plugin_io_github_kennymcsimpson_governed_roundtable_Room`），从不写 room-dev 的命令行；托管席位的包只写它在回复里要写的 ASCII 标记。

外部 agent（Codex、Claude Code、OpenCode、Gemini CLI……）入席方式和 room-dev 完全一样：房间给每个席位写一份 `JOIN.md`，agent 自己对房间目录运行内置的 `room-dev/room.mjs`（`wait`、`submit`……）。插件不碰它们。

## 为什么做

room-dev 是一个本地、Windows 优先的「房间」，让你已经在用的 coding agent（Codex、Claude Code，或任何能跑一条本地命令的 agent）在同一个对话里按顺序发言；房间不启动、不配置、不附着任何 agent。因为它不拥有任何 agent，治理只做检测和记录、不做强制：转发的内容带来源标签，审方的结论要对照冻结产物的哈希复核、产物变了就标为过期，每条披露命令都要用户批准。房间唯一强制的是发言顺序和 attempt 是否有效。

这个插件让 PI 对话和外部 agent 坐进同一个房间，并让用户在 PI-Desktop 的面板里主持房间。做成插件而不是改核心，是因为上游把跨会话协调放在插件里（ADR 0165 撤回了核心里的 agent 间通信栈）。目前验证过的范围见下文；简言之：room-dev 端到端只在脚本席位和一种真实席位（由 `codex exec` 起的 Codex 线程）上验证过，本插件只在假宿主上测过。治理层能不能抓到手工转发漏掉的问题，还没有评估。

## 权限

风险等级：**高**（后台服务、写文件、子进程、Agent 工具）。

| 权限 | 为什么需要 | 没有它时 |
|---|---|---|
| `ui.panel` | 面板是你管理房间的地方（任务、开始、批准披露、接受过期、散会、服务 / 停止、解除绑定）。 | 没有面板：命令里的 `openPanel` 以 `PERMISSION_DENIED` 失败。 |
| `agent.tool.register` | `Room` 工具（风险 high）：PI 对话列出、创建、加入房间，并只替自己的席位行事。 | `registerTool` 以 `PERMISSION_DENIED` 失败，`onLoad` 随之失败，插件不加载。 |
| `background.service` | 房间宿主必须比单次工具调用活得久：推进房间、提供回环房间界面、维持 `service.lock` 心跳。 | 服务不启动；`create` 和席位动作回答 `SERVICE_NOT_RUNNING`，什么都不写。 |
| `agent.complete` | 纯文本托管席位经你在 PI-Desktop 里配置的模型发言，凭据由宿主解析。 | 托管席位的回合记为 `seat_failed {class: denied}`，这一轮照常进行。 |
| `shell.openExternal` | 「在浏览器打开房间界面」打开 `http://127.0.0.1:<端口>/#<admin 令牌>`。 | 这个按钮回答 `PERMISSION_DENIED`，面板其余功能照常。 |

不申请：`desktop.control`、`net.fetch`、`fs.*`、`clipboard.*`、`agent.prompt.inject`、`session.read`。插件从不调用 `pi.desktop.*` 或 `pi.net.*`。

## 能力与数据流矩阵

| 入口 | 读取 | 写入 / 发往 | 权限 | 用户动作 | 边界 | 清理 |
|---|---|---|---|---|---|---|
| Room 工具 `create` | 工具参数；已有房间的 `room.json` | `%USERPROFILE%\room-dev\rooms\<房间>` 下的新房间目录（房间、席位文件、令牌、`JOIN.md`、`admin.token`、事件） | `agent.tool.register` + 服务在运行 | Agent 会话对 `risk: high` 工具的权限策略 | 房间 id `[A-Za-z0-9_-]{1,64}`，1–8 个席位，席位文件夹须是已存在的绝对路径，不收 `session*/token*/admin*` 字段 | 席位创建失败时删除本次建的房间；已存在的房间拒绝（`ROOM_EXISTS`） |
| Room 工具席位动作（`submit`、`pass`、`point`……） | 调用对话的绑定（`ctx.sessionId`） | 席位发件箱 `<席位文件夹>\.room-outbox\<席位>` 和房间事件日志 | `agent.tool.register` | 工具调用 | 只作用于绑定到本会话的席位；文本 ≤ 100,000 字符；只认当前 attempt | — |
| Room 工具 `wait` | 房间里的包文件 | 包文本交给调用的对话（工具输出） | `agent.tool.register` | 工具调用 | 每个块带本包 nonce；其他席位的话是 `authority=none`；伪造的 `[ROOM:` 标记被转义 | — |
| Room 工具 `artifacts` | 席位在自己工作文件夹内点名的文件 | 房间目录里的哈希与快照副本；在快照副本里运行 `git init -q` | `agent.tool.register` | 工具调用 | 路径必须落在席位文件夹内（room-dev 的 guard）；不收 `.git` 和符号链接；有大小上限 | 快照副本随房间保留 |
| Room 工具 `disclose` | — | 只是一个请求 | `agent.tool.register` | **由你在面板或房间界面批准或拒绝** | argv ≤ 32 项；不在房间披露白名单、也不等于任务验收命令的 argv 由房间直接拒绝；在快照副本里无 shell 运行，有超时和 1 MiB 输出上限 | 超时时结束整个子进程树 |
| 常驻服务 `room-host` | 它服务的房间 | `127.0.0.1` 上的回环 HTTP 服务（随机端口）、`service.lock` 心跳、事件 | `background.service` | 在面板里服务 / 停止 | 用户停掉的房间不会被工具重新服务 | 停止 / 卸载时关闭所有房间并删除 `service.lock` |
| 托管席位（通道 `pi-complete`） | 它的包（任务、其他席位的话） | 每回合一次 `pi.agent.complete`，发往**你配置的模型**（消耗模型额度） | `agent.complete` | 你开始一轮 | 包 ≤ 200,000 字符，system ≤ 32 KiB，宿主限流 60 秒 8 次，`tools: []`，不要会话上下文 | — |
| 面板 `roundtable/*` 通道 | 房间状态 | 发往在服务房间的管理命令（白名单 `task, start, say, close, skip, retry, approve-disclose, deny-disclose, accept-stale`） | `ui.panel` | 在面板里点击 | 未知命令拒绝（`UNKNOWN_CMD`） | 散会即停止服务该房间 |
| 面板「打开房间界面」 | 房间的 admin 令牌 | 经 `pi.shell.openExternal` 交给系统浏览器 | `shell.openExternal` | 点击 | 只有回环地址；令牌在 URL 片段里（本机浏览器历史可能留下它） | — |
| 轮次提示 | 席位与房间 id；宿主语言（`pi.app.getLocale`、`appearance:changed`） | `pi.ui.showToast` | 无 | — | 手动等待的席位每个 attempt 一次 | 卸载时移除 `appearance:changed` 监听 |
| 插件状态 | — | `pi.plugin.getDataPath()` 下的 `roundtable.json`（含会话 id 的席位绑定、要重新服务的房间） | 无 | — | 插件私有 | 在面板里解除绑定（已散会的房间要点两次） |
| Codex 唤醒推送（room-dev） | 房间登记的唤醒 | room-dev 的 `codex queue` 子进程 | — | 只对在本插件**之外**登记了唤醒的房间 | Room 工具从不登记唤醒 | — |
| 原生日志审计与唤醒前的空闲检查（room-dev） | 该 agent 自己的会话日志，只读：Codex 在 `%USERPROFILE%\.codex`，Claude Code 在 `%USERPROFILE%\.claude\projects` | 审计结果写进房间事件日志 | — | 只对在本插件**之外**登记了审计源或 Codex 唤醒线程的席位 | 只读；经 Room 工具创建的席位两者都不登记 | — |
| 审方结论记录（room-dev） | 一条被认可的审方结论 | 在 `%USERPROFILE%\room-dev\adjudications.jsonl` 追加一行（房间 id、审方 agent 类型、预设、结论、产物哈希、标注） | — | 审方席位给出结论 | 只追加，经 room-dev 的单文件 guard | — |

凭据：一概不读。插件给 room-dev 传 `savedPiKey: false`，从不解密 room-dev 用 DPAPI 保存的 Pi key；宿主给插件进程的环境变量是精简的，`ROOM_PI_API_KEY` 也进不来。所以在别处建的、带 room-dev 内置 Pi 席位的房间，在这里拿不到 key（那个席位报 `PI_NO_KEY`）。没有出站网络：唯一的 socket 是回环上的房间界面服务。

## 权限划分

- **席位身份只来自宿主，从不来自工具参数。** PI-Desktop 把调用者对话的 `ctx.sessionId` 交给工具。`join` 把一个空闲的 PI 席位绑定到这个会话 id，之后每条席位命令都只作用于这个席位。参数里出现名字像 `session…`、`token…`、`admin…` 的字段，一律以 `IDENTITY_FROM_CONTEXT_ONLY` 拒绝。其他拒绝：
  - `NOT_YOUR_SEAT`：点名了别人的席位；
  - `SEAT_TAKEN`：席位已被别的对话占用；
  - `NOT_A_PI_SEAT`：这是外部 agent 的席位；
  - `NO_SESSION`：宿主没有给会话 id。
- **管理权归用户。** 工具没有设任务、开始一轮、批准或拒绝披露、接受过期、跳过、重试、散会、解除绑定这些动作；被要求时回答 `ADMIN_ONLY_IN_PANEL`。这些只在面板通道（`roundtable/admin`，白名单 `task, start, say, close, skip, retry, approve-disclose, deny-disclose, accept-stale`）和房间界面里有。
- **服务与否也归用户。** 在此服务 / 停止服务只在面板里。Room 工具调用只在用户没有停掉房间时才会服务它：点了「停止服务」之后，凡是需要房间在服务的席位动作都回答 `NOT_SERVED`（请用户在面板里重新服务），`join` 照样绑定席位但报告 `served: 'stopped'`。点「在此服务」即解除。
- **绑定是插件层的规则，不是文件系统边界。** 和 room-dev 一样，本机任何能读到席位目录的进程都能用其中的令牌运行该席位的命令。绑定决定的是 Room 工具替哪个 PI 对话行事，不给别的本地软件加沙箱。
- **「管理权归用户」只对 Room 工具成立。** 房间的 admin 令牌是一个文件：`%USERPROFILE%\room-dev\rooms\<房间>\admin.token`。如果 PI 对话自己的文件或 shell 工具读得到这个路径，它就能绕过面板，经房间的 `admin-queue` 或回环地址上的 `/api/admin` 发管理命令。要让管理权留在你手里，就不让这些工具碰房间目录（至少不让碰 `admin.token`）。把 `roomDir`、`roomsRoot` 从工具输出里去掉只能藏起路径，保护不了令牌。

## 依据上游源码做的决定

读的是上游克隆：PI-Desktop `10e824ee12f8`、pi-desktop-plugins `c35605a5ed31`。路径相对这两个仓库。

1. **不实现唤醒 PI 对话，PI 席位一律 `waitMode manual`。** `session/collaboration/send` 和 `spawn`（经 `pi.desktop.invoke`）要求当前有一个进行中的 Agent 工具调用，否则拒绝（`apps/desktop/electron/main/services/session-collaboration.ts` 107-114）。常驻服务永远不在工具调用之内。工具调用期间创建的定时器确实继承这次调用的上下文（一个 `AsyncLocalStorage` 存储），但调用一返回这个调用就失效了：之后从这个上下文发出的每个 `pi.*` 调用都会以 `PLUGIN_TOOL_ABORTED` 被拒绝（`plugin-host-process.mjs` 54-69、531-557），send / spawn 照样拒绝。所以满足不了 room-dev 的唤醒约定（发包时由服务推送）。另一条路 `desktop.control` 的 `agent/prompt` 没有这个检查，但它会把唤醒当成带用户权限的普通提示送进去，与 room-dev 的标签规则相违，所以不用。插件不申请 `desktop.control`。取而代之的是：弹一条提示告诉你轮到谁，由你让那个对话继续；它调用不会阻塞的 `wait`。
2. **托管席位经 `pi.agent.complete`：只做讨论档。** `agent.complete` 只能从不属于已结束工具调用的上下文里调用，而且不能要会话上下文（`plugin-runtime.ts` 4089-4174，`plugin-host-process.mjs` 54-69）。在工具调用里开始服务的房间（`create`，或会把房间服务起来的席位动作）本来会让定时器跑在这次调用失效的上下文里，补全和轮次提示就全部失败。所以插件开房间、跑房间的定时器、调用 `agent.complete` 和 `showToast`，都在 `onLoad` 和 `service.start` 时捕获的上下文里进行（`AsyncResource.bind`），从不在工具调用之内。它是一次性、纯文本的，宿主侧 `tools: []`，只适合 room-dev 的讨论档，所以 `create` 拒绝把 `complete` 席位设为执行者。宿主限制：每插件滚动 60 秒最多 8 次（`RATE_LIMITED`，房间记为 `seat_failed {class: rate_limited}`）、90 秒超时、system 不超过 32 KiB、messages 不超过 20 万字符。插件不持有任何 API key，凭据由宿主解析。
3. **面板：最小面板，房间界面在系统浏览器里打开。** 宿主把面板作为沙箱化的 `file://` 页面加载，不设 CSP（`plugin-panel-host.ts` 500-560）。但 room-dev 自己的服务禁止被嵌入（`frame-ancestors 'none'`、`X-Frame-Options: DENY`），API 只收同源请求；市场审计也会拦下任何 `<iframe src="http…">`。所以面板经 `pluginBridge.invoke` → `onPanelInvoke` 与 `main.js` 通信，「在浏览器打开房间界面」用 `pi.shell.openExternal`。插件没有向自己面板推送的通道，所以面板靠轮询。
4. **服务生命周期。** `start` 必须在 5 秒内返回（`plugin-runtime.ts` 560、647）。它立即返回，记住的房间在后台重新服务。这些房间还在打开时停止服务，会等打开结束并把它们关掉，`stop` 之后不留任何在服务的房间。在浏览器的房间界面里散会的房间，最多一个轮次检查间隔之后就不再在这里服务（释放 HTTP 服务、心跳和 `service.lock`）。崩溃时宿主重启整个插件进程（最多 5 次）。崩溃留下的过期 `service.lock` 按 room-dev 自己的规则接管（pid 不在，或心跳超过 120 秒）。
5. **Plan / Goal 模式。** 在这个上游提交里，工具注册时插件进程只转发 `{name, description, risk, schema}`（`plugin-host-process.mjs` 285-292），`planSafeActions` 到不了宿主，所以插件工具在 Plan / Goal 模式下不可用，Room 工具只能在 Agent 模式里用。

## 写入位置

- 房间：`%USERPROFILE%\room-dev\rooms\<房间>`（room-dev 的 `defaultRoomsRoot()`，从不放 AppData）。宿主给插件进程的环境变量是精简过的（`child-process-env.ts` 27-64），`ROOM_DEV_HOME` 传不进来，所以用的是默认位置。
- 席位发件箱：`<席位工作文件夹>\.room-outbox\<席位>`，由席位命令写入，PI 席位也一样。房间从不替你创建席位工作文件夹，`create` 要求文件夹已存在。
- 快照副本、包、事件：在房间目录内（经 room-dev 的 guard）。
- 插件状态（席位绑定、要重新服务的房间）：`pi.plugin.getDataPath()` 给出的目录下的 `roundtable.json`。
- 审方结论记录：`%USERPROFILE%\room-dev\adjudications.jsonl`，room-dev 跨房间的记录，每条被认可的审方结论追加一行。
- 房间目录之外的读取（只读，且只针对在本插件之外登记了原生日志审计或 Codex 唤醒线程的席位）：该 agent 自己的会话日志（`%USERPROFILE%\.codex`、`%USERPROFILE%\.claude\projects`）。
- 子进程：只有 room-dev 自己的。披露命令（房间白名单内的命令或任务验收命令，不经 shell）在你批准后于快照副本里执行；冻结产物时在快照副本里运行 `git init -q`；在别处登记过 Codex 唤醒线程的房间，还会执行 room-dev 的 `codex queue` 推送。Room 工具从不登记唤醒。

## 构建、打包、审计

不下载、不安装任何东西。需要 Node ≥ 22。

```bat
node integrations\pi-desktop-plugin\build.mjs
:: -> dist\out\pi-desktop-plugin\io.github.kennymcsimpson.governed-roundtable\
::    （默认 --source head：每个文件都取自 HEAD 提交；--source worktree 复制工作区）
node integrations\pi-desktop-plugin\pack.mjs --upstream <pi-desktop-plugins 克隆> --python <python.exe>
:: 把上游的 scripts\pack_plugin.py 和 scripts\security_audit.py 原样复制到 dist\out\pi-desktop-plugin-pack\，
:: 在那里打包，并对插件目录和打出的 .piplug 跑审计
node --test "integrations/pi-desktop-plugin/test/*.test.mjs"
```

安装：在 PI-Desktop 里打开 **Plugins**，选 **Install plugin package**，选
`dist\out\pi-desktop-plugin-pack\packages\io.github.kennymcsimpson.governed-roundtable-0.1.0.piplug`，确认五项权限（`ui.panel`、`agent.tool.register`、`background.service`、`agent.complete`、`shell.openExternal`）。这一步还没有实际做过。

## 使用

1. 在 PI 对话（Agent 模式）里说：「建房间 demo，预设 discussion；A 是我（pi，主力，文件夹 `C:\Users\<你>\room-seats\demo-A`），B 是 Claude Code（参与者，文件夹 …），H 是 complete，模型 `<providerId>/<modelId>`；以 A 入席。」工具会给出每个外部 agent 的 JOIN.md 入席句子。
2. 把入席句子分别发给对应的外部 agent（「读 `<…>\JOIN.md`，按它入席」）。
3. 打开面板（命令 **Governed Roundtable: Open panel**），展开房间详情，设任务，点「开始一轮」。
4. 提示说轮到某个 PI 席位时，让那个对话继续：它调用 `wait` 取包、读包、干活，再 `submit` 或 `pass`；收到 `TURN_OVER` 或 `NOT_YOUR_TURN` 时结束本回合。
5. 在面板（或房间界面）里批准披露、接受过期、散会。

## 已验证 / 未验证

在作者的 Windows 11 机器上用 Node 24.11.1 跑 `integrations/pi-desktop-plugin/test/plugin.test.mjs`（16 个测试）、`test/panel.test.mjs`（25 个测试）、`test/locale.test.mjs`（8 个测试，轮次提示的语言）和 `test/manifest.test.mjs`（6 个测试，检查市场对清单、面板和 README 的要求）验证。假宿主（`test/fake-pi-host.mjs`）复现了上游 `buildApi()` 的形状、初始化顺序、服务启停、工具上下文（`ctx` 各字段，以及调用作用域：`execute` 在一个 `AsyncLocalStorage` 调用里运行，从已结束调用的上下文发出的 `pi.*` 调用以 `PLUGIN_TOOL_ABORTED` 被拒绝）、面板路由、权限检查、`agent.complete` 的限制，以及宿主事件和语言的启动顺序（`pi.events`；开机时恢复的插件读到 `en`，之后才应用保存的语言并推送 `appearance:changed`），每一处都注明了上游行号。它在一个 Node 进程里运行，没有模拟这项检查在宿主一侧的部分、取消消息和真实的进程间通信。用它测了：

- `build.mjs --source head` 复制的是提交里的字节，并记下 HEAD 提交号；
- 插件加载，注册工具、命令和服务；服务启动不到 5 秒；
- `create` 把房间写在房间根目录下，服务锁里记的是插件进程的 pid；
- 建房者按 `ctx.sessionId` 绑定；伪造或冒用的身份被拒绝；
- 工具碰不到管理动作；
- 跑完一整轮讨论：两个 PI 席位经工具发言，Claude Code 席位在另一个 Node 进程里按 JOIN.md 运行内置的 `room.mjs`；
- 经工具建的房间里，托管席位经假的 `agent.complete` 发言，没有任何补全或提示因来自已结束的调用而被拒，包括 `RATE_LIMITED` → `seat_failed rate_limited`；
- 面板：房间界面地址交给 `openExternal`、解除绑定、散会并交出散会包；
- 没有 Room 工具交卷面的 pi-user 席位（0.1.0 版插件建的房间）已被对话占着时，面板里仍按 PI 席位显示它的绑定和「解除绑定」，轮次提示用对 PI 对话的说法；解除后不再让对话入座；
- 用户停掉的房间不会被工具调用重新服务（`NOT_SERVED`），直到面板重新服务它；
- 房间根目录路径里有空格时，`wait` 照样交出包和散会包；
- 经房间界面的 `/api/admin` 散会的房间会释放 HTTP 服务和 `service.lock`；
- 服务还在重新打开房间时就停止，不留任何在服务的房间；启动-停止-启动之后房间在服务；
- 停止服务删除 `service.lock`，再启动重新服务房间，卸载后全部释放；
- 带 room-dev 内置 Pi 席位的房间由插件服务时，不读 room-dev 保存的 Pi key（同一测试里作为对照的 room-dev 默认行为会读）；
- 面板的语言取自宿主的 `app.getAppearance`（`zh-CN` → 开始一轮），取不到时用 `navigator.language`，并跟随 `appearance:changed`；
- 面板在用户打字时照常轮询：详情原地更新，有焦点的控件保留节点、文字、光标和输入法组字，重建时也找回已输入的文字；轮询不叠加，迟到的回答被丢弃（收起优先），两次确认撑得过一次轮询，轮询失败的报错在下一次成功后清掉而操作的报错保留，操作失败时文字保留；迟到的房间列表回答被丢弃，房间散会时它的草稿和待确认的按钮被清掉（已点过一次的「解除绑定」保留）；假文档会让被摘下的有焦点控件失焦，也不会给已摘下或隐藏的控件焦点；
- 已散会的房间在面板里没有在此服务、停止服务和打开房间界面的按钮，详情只读，「解除绑定」要点两次；别的程序服务的房间没有在此服务按钮；一轮进行中「开始一轮」不可点；状态行和阶段名跟随语言；对已散会的房间，serve、admin 和 open-ui 回答 `ROOM_CLOSED`，面板用自己的语言显示 `ROOM_CLOSED`、`SERVED_ELSEWHERE` 和 `NOT_SERVED_HERE`；未服务房间的提示只在后台服务运行时才提「在此服务」；
- 轮次提示跟随宿主语言：插件在开机时以 `en` 恢复、随后应用保存的 `zh-CN` 时，提示是中文；之后切换到英文会跟着变；没有事件时，每次提示前的 `getLocale` 也能读到语言；格式不对的 `appearance:changed` 和失败的 `getLocale` 保留上一次有效的语言；卸载时以及 `onLoad` 失败时移除监听（已注册的工具一并撤下）；读语言和弹提示都不在已结束的工具调用里运行。

上游市场脚本对构建出的目录和打出的 `.piplug` 都跑过：0 个 blocker，58 条人工复核提示（每一条的理由写在提交说明里；提示本身不等于批准）。

**真实应用里已验证。** 测试对象是官方 `PI-Desktop-Portable-0.16.1.zip`，用可信的 CDP 点击和应用自带的 MCP 控制面驱动。配置目录是一次性的：`PI_DESKTOP_DATA_DIR`、`PI_DESKTOP_AGENTS_DIR`、`HOME`、`USERPROFILE` 和 `--user-data-dir` 都指向它。模型是本地 stub。`PI_DESKTOP_AGENTS_DIR` 不能少：不设的话，host-core 会读真实 home 下的 `.agents`，并启动里面登记的 MCP 服务器。

- **Load dev plugin。** 菜单项先打开文件夹选择框，再进入权限审阅，审阅里按风险列出五项权限。加载后插件为 `ready`，服务为 `running`。
- **开机恢复。** 重启应用后插件被恢复，轮次提示跟随宿主语言：界面是 `zh-CN` 时提示为「圆桌 …：轮到席位 pi1 …」。早先的构建在这里显示英文，现在已修好。
- **命令面板。** **Governed Roundtable: Open panel** 入口能打开面板窗口。面板跟随宿主语言，状态行和阶段名都已本地化。
- **工具名与审批。** 模型看到的工具名是 `plugin_io_github_kennymcsimpson_governed_roundtable_Room`。它是延迟加载的工具，模型先经 `ToolSearch` 激活它，宿主随后弹出高风险审批卡。
- **建房。** 经工具建的房间把席位 `pi1` 绑定到对话的会话 id。这个席位记下的交卷面是 `tool`，工具名就是上面这个。
- **宿主校验。** 伪造的 `sessionId` 字段和工具里没有的动作 `start`，在插件运行之前就被宿主自己的 schema 校验拒绝。
- **完整一轮。** PI 席位的包里只写 Room 工具调用，没有 `room.mjs` 或 `--seat` 这样的命令行。托管席位经宿主真实的 `agent.complete` 收到的请求里只写 ASCII 标记，其中伪造的 `authority=user` 块被转义、放在 `authority=none` 块里。之后发布总结，本轮结束。
- **打字时的面板。** 光标和已打的字留在面板输入框里时，事件列表照常更新，打的字也还在。
- **散会与解除绑定。** **散会**和已散会房间的**解除绑定**都要点第二次确认。已散会的房间详情只读，没有服务、停止或房间界面按钮。
- **Install plugin package。** 装 `.piplug` 后，装好的目录与构建目录逐字节相同，服务在运行，面板能打开。

**未验证。**

- Windows 上 `shell.openExternal` 会不会保留携带 admin 令牌的 URL 片段（这个按钮会打开本机默认浏览器，所以没点）。room-dev 自己的启动器改用 `rundll32 url.dll,FileProtocolHandler`，就是因为 `start` 和 `explorer.exe` 可能丢掉片段；丢了的话浏览器页面没有 admin 令牌，就到面板里做管理；
- 真实应用里的权限拒绝路径（五项权限都授予了；这些路径只在假宿主上测过）；
- 对话或 `agent.complete` 背后的真实模型；
- 外部 agent（Codex、Claude Code）加入由真实应用服务的房间；
- 带过期锁的崩溃重启；
- 记住的房间很多时，5 秒的启动预算能不能守住；
- 在真实面板里用输入法打字（假 DOM 覆盖了输入法事件）。

**已知限制：**

- PI 席位由你唤醒，不由房间唤醒。`session/collaboration/send` 和 `spawn` 要求有进行中的 Agent 工具调用，后台服务永远没有；`desktop.control` 的 `agent/prompt` 会以用户权限送达唤醒。所以没有任何插件接口能按 room-dev 的唤醒约定唤醒 PI 对话。
- 托管席位只做讨论：`agent.complete` 每回合一次纯文本补全、不带工具，所以托管席位不能当执行者，也产出不了产物。
- Room 工具只能在 Agent 模式下用。
- `engines.piDesktop` 写的是 `>=0.16.1`：读过的 PI-Desktop 源码只有 0.16.1 的浅克隆，看不出具备所有用到的接口（`agent.complete`、常驻服务、工具的 `ctx.sessionId` 与调用作用域）的最早版本。更早的宿主也许能用，没有核对。
- 外部席位需要 PATH 上有 `node`。它们的 `room.mjs` 路径指向已安装的插件目录，插件装到别的路径后，这些席位的命令会失效。
- 有 Codex 唤醒的房间，推送时在插件精简的环境变量里找 `codex.exe`（`LOCALAPPDATA`、`CODEX_HOME` 都传不进来）。
- 已由别的程序（room-dev 桌面应用或命令行）服务的房间，到那边去管理。

**上架准备：** 已作为草稿 PR 提交。插件仓库的 CONTRIBUTING 要求高风险插件（后台服务、执行进程、写文件都算）提供能力 / 数据流矩阵（见上）、负向路径测试和两位独立维护者批准。提交用的负向路径测试放在那个仓库的 `tests/governed-roundtable.test.mjs`：伪造的会话 id 被拒、工具碰不到管理动作、未声明或未授予的权限干净地失败、停止服务释放房间锁、包保留来源横幅。真实应用里的测试见上。

## 许可

MIT，与 room-dev 相同（插件目录里的 `room-dev/LICENSE`）。
