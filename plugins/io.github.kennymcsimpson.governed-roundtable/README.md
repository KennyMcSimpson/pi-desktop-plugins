# Governed Roundtable for PI-Desktop

Plugin id `io.github.kennymcsimpson.governed-roundtable` · version 0.1.0 · [中文](README.zh-CN.md)

> **Status: tested against a fake host that mirrors the upstream plugin SDK, and in the official
> PI-Desktop 0.16.1 portable build** with a stub model: Load dev plugin, the permission review, the
> command palette, the panel, the `Room` tool in a conversation, a full round with a hosted seat, and
> Install plugin package (see [What is verified](#what-is-verified-and-what-is-not)). Not tested
> yet: a real model, and external agents joining a room served in the real app. Two limits are by
> design, not open bugs:
> - **PI seats are not woken automatically.** No plugin API can wake a PI conversation from a
>   background service, so you tell the conversation to continue.
> - **Hosted seats are discussion-only.** They get one text-only `agent.complete` call per turn,
>   with no tools.

This plugin brings room-dev's governed room into upstream
[PI-Desktop](https://github.com/vastsa/PI-Desktop) using only the public plugin APIs. It needs no
change to the host or its core. The room engine is room-dev itself, vendored unchanged into the
plugin folder (`room-dev/`, with the commit recorded in `room-dev/VENDORED.json`). It runs inside the
plugin's own process.

## Why

room-dev is a local, Windows-first room in which coding agents you already run (Codex, Claude Code,
or any agent that can run one local command) take turns in one conversation; the room never
launches, configures or attaches to them. Because it owns none of the agents, its governance detects
and records instead of enforcing: relayed text carries source labels, a reviewer's verdict is checked
against hashes of the frozen artifacts and marked stale if they changed, and the user approves every
disclosure command. The only things the room enforces are turn order and attempt validity.

This plugin lets PI conversations sit in such a room next to external agents, and lets the user run
the room from a PI-Desktop panel. It is a plugin rather than a core change because upstream keeps
cross-session coordination in plugins (ADR 0165 withdrew the core agent-to-agent stack). What is
verified so far is listed below; in short: room-dev end to end with scripted seats and one real
seat kind (a Codex thread started with `codex exec`), and this plugin against a fake host only.
Whether the governance layer catches failures that manual forwarding misses has not been evaluated.

## What you get

| Part | Upstream API | What it does |
|---|---|---|
| **Room host** (resident service `room-host`) | `contributes.services`, `pi.services.register`, permission `background.service` | Runs room-dev's room service (`lib/api.mjs` `openRoom`) for each room you serve. It also serves the loopback room UI on `127.0.0.1` and keeps `service.lock` fresh. When the service stops, every room it served is closed and `service.lock` is removed. Rooms you were serving are served again when the service next starts. |
| **Room tool** (Agent tool `Room`, risk high) | `pi.agent.registerTool`, `agent.tool.register` | Lets a PI conversation `list` rooms, `create` a room, `join` a PI seat, and use **its own seat**: `wait`, `submit`, `pass`, `point`, `quote`, `misquoted`, `mark`, `verdict`, `disclose`, `assign`, `artifacts`, `status`, `leave`. |
| **Panel** and command `Governed Roundtable: Open panel` | `ui.panel`, `pi.commands.register`, `onPanelInvoke` | Your side of the room. Lists rooms with their seats and bindings. Serves or stops a room. Sets the task and starts a round. Sends a user message, and handles retry and skip. Approves or denies disclosures, accepts stale verdicts, closes the room, and releases a seat binding. A closed room is read-only there: no serve, stop or room-UI button, and its Release asks for a second click, because the conversation reads the farewell through its binding. |
| **Room UI in the browser** | `pi.shell.openExternal`, permission `shell.openExternal` | Opens room-dev's full room UI (`http://127.0.0.1:<port>/#<admin token>`) in your system browser. |
| **Hosted seats** (lane `pi-complete`) | `pi.agent.complete`, permission `agent.complete` | A text-only seat that speaks through a model you have configured in PI-Desktop: one completion per turn, with no tools. It plugs into room-dev as a `hostedProviders.lane` factory. |
| **Turn toast** | `pi.ui.showToast` (needs no permission) | When a seat that waits manually gets its turn, you get one toast per attempt, in the host's language (Chinese for any `zh` locale, else English): the plugin reads `pi.app.getLocale` again for each toast and follows `appearance:changed` on `pi.events`. |

A PI seat's packets describe only Room tool calls (the model sees `plugin_io_github_kennymcsimpson_governed_roundtable_Room`), never room-dev command lines; a hosted seat's packets describe only the ASCII markers it writes into its reply.

External agents (Codex, Claude Code, OpenCode, Gemini CLI, …) join exactly as they do with
room-dev: the room writes a `JOIN.md` for each seat, and the agent runs the vendored
`room-dev/room.mjs` (`wait`, `submit`, …) against the room folder. The plugin does not touch them.

## Permissions

Risk tier: **high** (background service, file writes, child processes, an agent tool).

| Permission | Why it is needed | Without it |
|---|---|---|
| `ui.panel` | The panel is where the user administers rooms (task, start, disclosure approval, stale acceptance, close, serve / stop, release a binding). | No panel: the command's `openPanel` fails with `PERMISSION_DENIED`. |
| `agent.tool.register` | The `Room` tool (risk high): a PI conversation lists, creates and joins rooms and acts for its own seat. | `registerTool` fails with `PERMISSION_DENIED`, so `onLoad` fails and the plugin does not load. |
| `background.service` | The room host must outlive single tool calls: it ticks the room, serves the loopback room UI and keeps `service.lock` fresh. | The service does not start; `create` and seat actions answer `SERVICE_NOT_RUNNING` and write nothing. |
| `agent.complete` | Text-only hosted seats speak through the model you configured in PI-Desktop; the host resolves credentials. | A hosted seat's turn fails as `seat_failed {class: denied}`; the round goes on. |
| `shell.openExternal` | "Open room UI in browser" opens `http://127.0.0.1:<port>/#<admin token>`. | That button answers `PERMISSION_DENIED`; the panel still works. |

Not requested: `desktop.control`, `net.fetch`, `fs.*`, `clipboard.*`, `agent.prompt.inject`,
`session.read`. The plugin never calls `pi.desktop.*` or `pi.net.*`.

## Capability and data-flow matrix

| Entry | Reads | Writes / sends to | Permission | User action | Bounds | Cleanup |
|---|---|---|---|---|---|---|
| Room tool `create` | tool input; `room.json` of existing rooms | a new room folder under `%USERPROFILE%\room-dev\rooms\<room>` (room, seat files, tokens, `JOIN.md`, `admin.token`, events) | `agent.tool.register` + running service | the Agent session's permission policy for a `risk: high` tool | room id `[A-Za-z0-9_-]{1,64}`, 1–8 seats, existing absolute seat folders, no `session*/token*/admin*` fields | a room whose seat creation fails is removed; existing rooms are refused (`ROOM_EXISTS`) |
| Room tool seat actions (`submit`, `pass`, `point`, …) | the calling conversation's binding (`ctx.sessionId`) | the seat's outbox `<seat folder>\.room-outbox\<seat>` and the room's event log | `agent.tool.register` | tool call | only the seat bound to this session; text ≤ 100,000 chars; current attempt only | — |
| Room tool `wait` | the packet file in the room | packet text to the calling conversation (tool output) | `agent.tool.register` | tool call | every block carries the packet nonce; other seats' words are `authority=none`, forged `[ROOM:` markers are escaped | — |
| Room tool `artifacts` | files the seat names inside its own working folder | hashes and snapshot copies inside the room folder; `git init -q` inside the snapshot copy | `agent.tool.register` | tool call | paths must resolve inside the seat folder (room-dev's guard); `.git` entries and symlinks are not collected; size cap | snapshot copies stay with the room |
| Room tool `disclose` | — | a request only | `agent.tool.register` | **the user approves or denies it** in the panel or room UI | argv ≤ 32 entries; the room denies any argv outside its disclosure allowlist or the task's exact acceptance commands; runs without a shell in the snapshot copy, with a timeout and a 1 MiB output cap | child process tree killed on timeout |
| Resident service `room-host` | rooms it serves | loopback HTTP server on `127.0.0.1` (random port), `service.lock` heartbeat, events | `background.service` | serve / stop in the panel | rooms the user stopped are never re-served by the tool | stop / unload closes every room, removes `service.lock` |
| Hosted seat (lane `pi-complete`) | its packet (task, other seats' words) | one `pi.agent.complete` call per turn to **your configured model** (uses your model quota) | `agent.complete` | the user starts the round | ≤ 200,000 chars per packet, system prompt ≤ 32 KiB, host rate limit 8 / 60 s, `tools: []`, no session context | — |
| Panel `roundtable/*` channels | room state | admin commands to the served room (allowlist `task, start, say, close, skip, retry, approve-disclose, deny-disclose, accept-stale`) | `ui.panel` | a click in the panel | unknown commands refused (`UNKNOWN_CMD`) | close stops serving the room |
| Panel "Open room UI" | the room's admin token | the system browser via `pi.shell.openExternal` | `shell.openExternal` | a click | loopback URL only; the token is in the URL fragment (local browser history may keep it) | — |
| Turn toast | seat and room id; the host language (`pi.app.getLocale`, `appearance:changed`) | `pi.ui.showToast` | none | — | one toast per attempt of a manually waiting seat | the `appearance:changed` listener is removed on unload |
| Plugin state | — | `roundtable.json` in `pi.plugin.getDataPath()` (seat bindings with session ids, rooms to serve again) | none | — | plugin-private | release a binding in the panel (on a closed room, with a second click) |
| Codex wake push (room-dev) | a room's registered wake | room-dev's `codex queue` child process | — | only for rooms whose seats registered a wake **outside** this plugin | the Room tool never registers a wake | — |
| Native-log audit and wake idle check (room-dev) | that agent's own session logs, read-only: Codex under `%USERPROFILE%\.codex`, Claude Code under `%USERPROFILE%\.claude\projects` | audit results into the room's event log | — | only for seats registered **outside** this plugin with an audit source or a Codex wake thread | read-only; seats created through the Room tool register neither | — |
| Reviewer verdict record (room-dev) | an authorized reviewer verdict | one appended line in `%USERPROFILE%\room-dev\adjudications.jsonl` (room id, reviewer agent kind, preset, verdict, artifact hash, annotation) | — | a reviewer seat's verdict | append-only, through room-dev's single-file guard | — |

Credentials: none read. The plugin passes `savedPiKey: false` to room-dev, so it never decrypts
room-dev's DPAPI-saved Pi key; the host gives the plugin process a minimal environment, so
`ROOM_PI_API_KEY` does not reach it either. A room made elsewhere with room-dev's built-in Pi seat
therefore gets no key here (that seat fails with `PI_NO_KEY`). No outbound network: the only socket
is the loopback room UI server.

## Authority: who may do what

- **Seat identity comes from the host, never from tool input.** PI-Desktop passes the calling
  conversation's `ctx.sessionId` to the tool. A `join` binds one free PI seat to that session id,
  and every seat command acts only on that seat. If the tool input has a field named like
  `session…`, `token…` or `admin…`, the call is refused with `IDENTITY_FROM_CONTEXT_ONLY`. Other
  refusals:
  - `NOT_YOUR_SEAT`: the call names someone else's seat.
  - `SEAT_TAKEN`: another conversation already holds that seat.
  - `NOT_A_PI_SEAT`: the seat is for an external agent.
  - `NO_SESSION`: the host gave no session id.
- **Administration is the user's.** The tool has no action to set the task, start a round, approve
  or deny a disclosure, accept a stale verdict, skip, retry, close a room or release a binding. If
  it is asked to, it answers `ADMIN_ONLY_IN_PANEL`. Those actions exist only as panel channels
  (`roundtable/admin` with an allowlist of `task, start, say, close, skip, retry, approve-disclose,
  deny-disclose, accept-stale`) and in the room UI.
- **Serving is the user's too.** Serve and stop live in the panel. A Room tool call serves a room
  only if the user has not stopped it: after **Stop serving**, every seat action that would need the
  room served answers `NOT_SERVED` (ask the user to serve it from the panel), and `join` binds the
  seat but reports `served: 'stopped'`. **Serve here** clears that.
- **The binding is a plugin rule, not a file-system boundary.** As in room-dev, any local process
  that can read a seat folder can run that seat's commands with its token. The binding decides which
  PI conversation the Room tool acts for. It does not sandbox other local software.
- **"Administration is the user's" holds for the Room tool only.** The room's admin token is a file,
  `%USERPROFILE%\room-dev\rooms\<room>\admin.token`. A PI conversation whose own file or shell
  tools can read that path can issue admin commands without the panel, through the room's
  `admin-queue` or the loopback `/api/admin`. To keep administration with you, deny those tools
  the rooms folder (or at least `admin.token`). Leaving `roomDir` and `roomsRoot` out of the tool's
  output would only hide the path; it would not protect the token.

## Decisions taken from the upstream source

They were read from the upstream clones at PI-Desktop `10e824ee12f8` and pi-desktop-plugins
`c35605a5ed31`. Paths are relative to those repositories.

1. **Waking a PI conversation: not implemented. PI seats use `waitMode manual`.**
   `session/collaboration/send` and `spawn` (through `pi.desktop.invoke`) refuse unless an Agent
   tool invocation is active (`apps/desktop/electron/main/services/session-collaboration.ts`
   107-114). A resident service is never inside one. A timer created during a tool call does
   inherit that call's invocation context (an `AsyncLocalStorage` store), but the invocation is
   dead once the call returns: every `pi.*` call made from it afterwards is rejected with
   `PLUGIN_TOOL_ABORTED` (`plugin-host-process.mjs` 54-69, 531-557), so send and spawn still
   refuse. Room-dev's waker contract (pushed by the service when a turn is issued) therefore cannot
   be met. The alternative, `desktop.control`
   `agent/prompt`, has no such check. But it would deliver the wake as an ordinary prompt with
   user authority, which contradicts room-dev's labelling, so it is not used. The plugin requests
   no `desktop.control`. What you get instead: a toast tells you whose turn it is. You tell that
   conversation to continue, and it calls `wait`, which never blocks.
2. **Hosted seats through `pi.agent.complete`: implemented for the discussion tier only.**
   `agent.complete` works only from a context that is not a finished tool invocation, and only
   when no session context is requested (`plugin-runtime.ts` 4089-4174, `plugin-host-process.mjs`
   54-69). A room served from inside a tool call (`create`, or a seat action that serves the room)
   would otherwise run its timers in that call's dead context, and every completion and turn toast
   would fail. So the plugin opens rooms, runs their timers and makes every `agent.complete` and
   `showToast` call in a context captured at `onLoad` and `service.start` (`AsyncResource.bind`),
   never inside a tool invocation. It is one-shot and text-only, with `tools: []` on the host
   side. That fits room-dev's discussion tier and nothing else, so `create` refuses a `complete`
   seat as executor. Limits from the host: 8 completions per plugin per rolling 60 s
   (`RATE_LIMITED`, recorded by the room as `seat_failed {class: rate_limited}`), 90 s timeout,
   system prompt ≤ 32 KiB, messages ≤ 200,000 characters. The plugin holds no API key, because the
   host resolves credentials.
3. **Panel: a minimal panel, with the room UI opened in the system browser.** The host loads
   panels as sandboxed `file://` pages and adds no CSP (`plugin-panel-host.ts` 500-560). But
   room-dev's own server forbids framing (`frame-ancestors 'none'`, `X-Frame-Options: DENY`) and
   accepts only same-origin API calls, and the marketplace audit blocks any
   `<iframe src="http…">`. So the panel talks to `main.js` through `pluginBridge.invoke` →
   `onPanelInvoke`, and "Open room UI in browser" uses `pi.shell.openExternal`. The panel polls,
   because a plugin has no channel to push to its own panel.
4. **Service lifetime.** `start` must return within 5 s (`plugin-runtime.ts` 560, 647). It
   returns at once and serves remembered rooms in the background. Stopping the service while those
   rooms are still opening waits for the openings and closes them, so nothing stays served after
   `stop`. A room closed from the room UI in the browser stops being served here (its HTTP server,
   heartbeat and `service.lock` are released) within one turn-watch interval. A crash restarts the whole
   plugin process (at most 5 attempts). A stale `service.lock` from a crashed process is taken
   over by room-dev's own rule (dead pid or heartbeat older than 120 s).
5. **Plan and Goal modes.** At this upstream commit, the plugin process forwards only
   `{name, description, risk, schema}` when a tool registers (`plugin-host-process.mjs` 285-292),
   so `planSafeActions` never reaches the broker. Plugin tools are therefore unavailable in Plan
   and Goal mode, and the Room tool works in Agent mode only.

## Where things are written

- Rooms: `%USERPROFILE%\room-dev\rooms\<room>` (room-dev's `defaultRoomsRoot()`, never AppData).
  The host gives plugin processes a minimal environment (`child-process-env.ts` 27-64), so
  `ROOM_DEV_HOME` does not reach the plugin and the default is what applies.
- Seat outboxes: `<seat folder>\.room-outbox\<seat>`, written by seat commands, for PI seats too.
  The room never creates a seat folder; `create` needs existing folders.
- Snapshot copies, packets, events: inside the room folder (room-dev's guard).
- Plugin state (seat bindings, rooms to serve again): `roundtable.json` in the folder returned by
  `pi.plugin.getDataPath()`.
- Reviewer verdict record: `%USERPROFILE%\room-dev\adjudications.jsonl`, room-dev's cross-room
  log, one appended line per authorized reviewer verdict.
- Read outside the rooms folder, read-only, and only for seats registered outside this plugin with
  a native-log audit or a Codex wake thread: that agent's own session logs (`%USERPROFILE%\.codex`,
  `%USERPROFILE%\.claude\projects`).
- Child processes: only room-dev's own. A disclosure command (the room's allowlist or a task
  acceptance command, no shell) runs inside a snapshot copy after you approve it; freezing artifacts
  runs `git init -q` inside the snapshot copy. For rooms whose seats registered a Codex wake thread
  elsewhere, room-dev's `codex queue` push also runs. The Room tool never registers a wake.

## Build, pack, audit

Nothing is downloaded or installed. Node ≥ 22.

```bat
node integrations\pi-desktop-plugin\build.mjs
:: -> dist\out\pi-desktop-plugin\io.github.kennymcsimpson.governed-roundtable\
::    (--source head, the default, takes every file from the HEAD commit; --source worktree copies the working tree)
node integrations\pi-desktop-plugin\pack.mjs --upstream <pi-desktop-plugins clone> --python <python.exe>
:: copies the upstream scripts\pack_plugin.py and scripts\security_audit.py unchanged into
:: dist\out\pi-desktop-plugin-pack\, packs the plugin there and runs the audit on the folder and on the .piplug
node --test "integrations/pi-desktop-plugin/test/*.test.mjs"
```

To install the package: in PI-Desktop, open **Plugins**, choose **Install plugin package**, pick
`dist\out\pi-desktop-plugin-pack\packages\io.github.kennymcsimpson.governed-roundtable-0.1.0.piplug`,
and review the five permissions (`ui.panel`, `agent.tool.register`, `background.service`,
`agent.complete`, `shell.openExternal`). This step has not been tried.

## Using it

1. In a PI conversation (Agent mode): "Create a room `demo`, preset discussion. Seat A is me (pi,
   lead, folder `C:\Users\<you>\room-seats\demo-A`). Seat B is Claude Code (participant, folder
   …). Seat H is complete with model `<providerId>/<modelId>`. Join as A." The tool answers with
   a JOIN.md sentence for each external agent.
2. Give each external agent its sentence ("Read `<…>\JOIN.md` and join").
3. Open the panel (command **Governed Roundtable: Open panel**), open the room's details, set the
   task and **Start round**.
4. When the toast says it is a PI seat's turn, tell that conversation to continue. It calls `wait`,
   reads the packet, works, and calls `submit` or `pass`. On `TURN_OVER` or `NOT_YOUR_TURN` it
   ends its turn.
5. Approve disclosures, accept stale verdicts and close the room from the panel (or the room UI).

## What is verified and what is not

Verified on the author's Windows 11 machine with Node 24.11.1, by
`integrations/pi-desktop-plugin/test/plugin.test.mjs` (16 tests), `test/panel.test.mjs` (25 tests),
`test/locale.test.mjs` (8 tests: the turn toast's language) and `test/manifest.test.mjs` (6 tests:
the marketplace manifest, panel and README requirements).
The fake host (`test/fake-pi-host.mjs`) reproduces the upstream `buildApi()` shapes, init order,
service start and stop, the tool context (the `ctx` fields, and the invocation scope: `execute` runs
in an `AsyncLocalStorage` invocation and a `pi.*` call from a finished invocation's context is
rejected with `PLUGIN_TOOL_ABORTED`), panel routing, permission checks, the `agent.complete`
limits, and host events with the boot order of the locale (`pi.events`; a plugin restored at boot
reads `en`, then the stored language is applied and `appearance:changed` is pushed), and cites the upstream lines for each. It runs in one Node process: the broker side of the
invocation check, cancellation messages and the real IPC are not modelled. With it, the tests check:

- `build.mjs --source head` copies the committed bytes and records the HEAD commit;
- the plugin loads and registers its tool, command and service; the service starts in under 5 s;
- `create` writes the room under the rooms root, and the service lock holds the plugin's pid;
- the creator is bound by `ctx.sessionId`; forged or foreign identities are refused;
- the tool cannot reach administration;
- a full discussion round runs: two PI seats use the tool, and a Claude Code seat runs the vendored
  `room.mjs` from its JOIN.md in a separate Node process;
- a hosted seat in a room created through the tool works through a fake `agent.complete`, with no
  completion or toast refused as coming from a finished invocation, including `RATE_LIMITED` →
  `seat_failed rate_limited`;
- the panel works: the room UI URL goes to `openExternal`, a binding is released, the room is
  closed and the farewell handed over;
- a pi-user seat without the Room tool surface (a room made by the 0.1.0 plugin) that a
  conversation already holds still shows in the panel as a PI seat with its binding and Release,
  gets the PI-conversation toast, and once released is not offered to a conversation again;
- a room the user stopped is not served again by a tool call (`NOT_SERVED`) until the panel serves
  it;
- with a rooms root whose path contains a space, `wait` hands over the packet and the farewell;
- a room closed through the room UI's `/api/admin` releases its HTTP server and `service.lock`;
- stopping the service while it is still reopening rooms leaves nothing served, and start-stop-start
  ends with the room served;
- stopping the service removes `service.lock`, starting it serves the room again, and unloading
  releases everything;
- a room with room-dev's built-in Pi seat, served by the plugin, never reads room-dev's saved Pi key
  (room-dev's own default, run as a control in the same test, does);
- the panel takes its language from the host's `app.getAppearance` (`zh-CN` → 开始一轮), falls
  back to `navigator.language`, and follows `appearance:changed`;
- the panel keeps polling while the user types: the detail is updated in place, so the focused
  control keeps its node, text, caret and IME composition, and typed text survives a rebuild; polls
  never stack, a late answer is dropped (Hide wins), a two-click confirm survives a poll, a failed
  poll's error clears while an action's error stays, and failed actions keep their text; a late
  rooms answer is dropped, and a room that closes drops its drafts and armed confirms (an armed
  Release stays); the fake document blurs a focused control that is detached and does not focus a
  detached or hidden one;
- a closed room in the panel has no serve, stop or room-UI button, a read-only detail, and a
  Release that asks twice; a room another app serves has no serve button; Start round is disabled
  while a round runs; the status line and phase names follow the language; serve, admin and
  open-ui on a closed room answer `ROOM_CLOSED`, and the panel shows `ROOM_CLOSED`, `SERVED_ELSEWHERE`
  and `NOT_SERVED_HERE` in its own language; a stopped room's hint names Serve here only while the
  service runs;
- the turn toast follows the host language: Chinese when the plugin was restored at boot under `en`
  and the stored `zh-CN` was applied afterwards; a later switch to English is followed; with no
  event, the per-toast `getLocale` read still finds the language; malformed `appearance:changed`
  payloads and a failing `getLocale` keep the last good language; the listener is removed on
  unload and when `onLoad` fails (and a registered tool with it), and neither the read nor the toast runs in a finished tool invocation.

The upstream marketplace scripts were run on the built folder and on the packed `.piplug`:
0 blockers, 58 manual-review signals (each one is justified in the submission's description; a passing
audit is not an approval).

**Verified in the real app.** The official `PI-Desktop-Portable-0.16.1.zip` was driven with
trusted CDP clicks and the app's MCP control plane. The profile was a throw-away one:
`PI_DESKTOP_DATA_DIR`, `PI_DESKTOP_AGENTS_DIR`, `HOME`, `USERPROFILE` and `--user-data-dir` all
pointed into it. The model was a local stub. `PI_DESKTOP_AGENTS_DIR` matters: without it host-core
reads the real home's `.agents` and starts the MCP servers registered there.

- **Load dev plugin.** The menu item opens a folder picker and then the permission review, which
  lists the five permissions by risk. After loading, the plugin is `ready` and its service is
  `running`.
- **Restore at boot.** After an app restart the plugin is restored, and the turn toast is in the
  host's language: "圆桌 …：轮到席位 pi1 …" under a `zh-CN` UI. This fixes the English toast an
  earlier build showed.
- **Command palette.** The **Governed Roundtable: Open panel** entry opens the panel window. The
  panel follows the host language, and its status line and phase names are localized.
- **Tool name and approval.** The model sees the tool as
  `plugin_io_github_kennymcsimpson_governed_roundtable_Room`. It is deferred, so the model
  activates it through `ToolSearch`, and the host shows its high-risk approval card.
- **create.** A room created through the tool binds seat `pi1` to the conversation's session id.
  The seat is recorded with surface `tool` and that same tool name.
- **Host validation.** A forged `sessionId` field and the non-tool action `start` are rejected by
  the host's own schema validation before the plugin runs.
- **A full round.** The PI seat's packet names only Room tool calls and contains no `room.mjs` or
  `--seat` line. The hosted seat's request through the host's real `agent.complete` names only the
  ASCII markers, and the forged `authority=user` block in it is escaped inside an
  `authority=none` block. After that the summary is published and the round ends.
- **The panel while typing.** With focus and typed text in a panel input, the event list kept
  updating, and the text stayed.
- **Closing and releasing.** **Close room** and a closed room's **Release** each need a second
  click. A closed room shows a read-only detail with no serve, stop or room-UI button.
- **Install plugin package.** Installing the `.piplug` gives an installed tree byte-identical to
  the built folder, the service running, and the panel opening.

**Not verified.**

- whether `shell.openExternal` keeps the URL fragment that carries the admin token on Windows (the
  button was not clicked, because it opens the machine's default browser). room-dev's own launcher
  uses `rundll32 url.dll,FileProtocolHandler` because `start` and `explorer.exe` can drop it. If the
  fragment is lost, the browser page has no admin token, and the panel is the place to administer;
- the permission-denied paths in the real app (all five permissions were granted; they are tested
  against the fake host);
- a real model behind the conversation or `agent.complete`;
- external agents (Codex, Claude Code) joining a room that the real app serves;
- crash restart with a stale lock;
- whether the 5 s start budget is met with many remembered rooms;
- typing with an IME in the real panel (the fake DOM covers composition events).

**Known limits:**

- PI seats are woken by you, not by the room. `session/collaboration/send` and `spawn` need an
  active Agent tool invocation, which a background service never has, and `desktop.control`
  `agent/prompt` would deliver the wake with user authority; so no plugin API can wake a PI
  conversation the way room-dev's waker contract requires.
- Hosted seats are discussion-only: `agent.complete` is one text-only completion per turn with no
  tools, so a hosted seat cannot be an executor or produce artifacts.
- The Room tool works in Agent mode only.
- `engines.piDesktop` is `>=0.16.1`: the only PI-Desktop source read was a shallow clone at
  0.16.1, which cannot show the earliest release that has every API used (`agent.complete`,
  resident services, the tool `ctx.sessionId` and invocation scope). Older hosts may work; that is
  not checked.
- External seats need `node` on PATH. Their `room.mjs` path points into the installed plugin
  folder, so reinstalling the plugin at another path breaks that seat's commands.
- Codex wake pushes, in rooms that have them, look for `codex.exe` with the plugin's minimal
  environment (`LOCALAPPDATA` and `CODEX_HOME` are not passed).
- A room already served by another program (the room-dev desktop app or CLI) is administered
  there.

**Marketplace readiness:** submitted as a draft pull request. The plugins repository's CONTRIBUTING asks
high-risk plugins (background services, process execution and file writes all count) for a
capability / data-flow matrix (above), negative-path tests and two independent maintainer
approvals. The negative-path tests for the submission live in that repository's
`tests/governed-roundtable.test.mjs`: forged session ids refused, administration unreachable from
the tool, undeclared or ungranted permissions failing cleanly, service stop releasing the room
lock, and packets keeping their provenance banners. The real-app test is described above. The
submission is a draft pull request.

## License

MIT, same as room-dev (`room-dev/LICENSE` in the plugin folder).
