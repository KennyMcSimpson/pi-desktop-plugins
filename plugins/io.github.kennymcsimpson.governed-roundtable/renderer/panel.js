// Governed Roundtable panel. Runs in PI-Desktop's sandboxed panel window (no Node); every action
// goes through window.pluginBridge.invoke to the plugin's onPanelInvoke. This is the user's side of
// the room: task, start, disclosure approval, stale acceptance, close and seat release live here
// and never in the agent tool. Text that came from seats (reasons, argv, seat names) is inserted
// with textContent only.
//
// Language: the host's, read through the panel bridge's app.getAppearance (the channel upstream
// panels use, plugin-runtime.ts 2184), falling back to navigator.language; index.html's lang="en" is
// only the placeholder until then. appearance:changed re-renders when the user switches language.
//
// Refresh: the panel polls (a plugin has no main-to-panel push channel), and typing never stops it.
// The room detail is a persistent shell: built once per room, mode (here / closed / stopped /
// elsewhere) and language, then updated in place, so a focused control is never detached and its
// value, caret, scroll and any IME composition survive a poll. Typed text is also kept in
// state.drafts, which refills the controls when the shell does have to be rebuilt. The rooms list
// is rebuilt only when what it shows changed. Two-click confirms are armed by key in state.armed,
// so a rebuild does not disarm them.
(function () {
  "use strict";
  var ZH = {
    title: "圆桌", refresh: "刷新", up: "后台服务运行中", down: "后台服务未运行（需要 background.service 权限）",
    root: "房间根目录：", none: "还没有房间。在 PI 对话里让 agent 用 Room 工具的 create 建房。",
    served: { here: "本插件在服务", elsewhere: "由别的程序服务", stopped: "未服务" },
    serve: "在此服务", stop: "停止服务", openUi: "在浏览器打开房间界面", details: "详情", hide: "收起",
    seat: "席位", role: "角色", kind: "类型", binding: "绑定", free: "空闲", release: "解除绑定",
    task: "任务", setTask: "设定任务", order: "发言顺序（可空，例如 A,B,A）", start: "开始一轮", say: "发一条用户消息（下一轮进入包）", send: "发送",
    disclosures: "待批准的披露", approve: "批准", deny: "拒绝", reason: "拒绝理由（必填）",
    stale: "复算出变化的产物", accept: "接受过期", accepted: "已接受",
    decision: "等待你决定的超时席位：", retry: "重试", skip: "跳过",
    close: "散会", confirm: "再点一次确认", recent: "最近事件", phase: "阶段", current: "当前",
    noTask: "（还没有任务）", joinPath: "入席文件：",
    round: "轮次", closed: "已散会", notAllowed: "（不在白名单）",
    phases: { idle: "空闲", assign: "分工", work: "干活", meet: "开会", summary: "汇总", done: "本轮结束", closed: "已散会" },
    hintStopped: "这个房间现在没有服务。点「在此服务」后就能在这里管理它。",
    hintStoppedDown: "这个房间现在没有服务。",
    hintElsewhere: "这个房间由别的程序服务，请到那里管理它。",
    releaseClosed: "房间已散会。解除绑定后，这个 PI 对话就读不到散会包了。",
    needTask: "请先填写任务。", needText: "请先填写要发的消息。", needReason: "请先填写拒绝理由。",
    refusals: {
      ROOM_CLOSED: "房间已散会，散会的房间不会再服务。",
      SERVED_ELSEWHERE: "这个房间由别的程序服务，请到那里管理它。",
      NOT_SERVED_HERE: "这个房间不在这里服务，请先点「在此服务」。"
    }
  };
  var EN = {
    title: "Governed Roundtable", refresh: "Refresh", up: "Background service running", down: "Background service not running (needs background.service)",
    root: "Rooms root: ", none: "No rooms yet. In a PI conversation, ask the agent to create one with the Room tool (action create).",
    served: { here: "served by this plugin", elsewhere: "served by another app", stopped: "not served" },
    serve: "Serve here", stop: "Stop serving", openUi: "Open room UI in browser", details: "Details", hide: "Hide",
    seat: "Seat", role: "Role", kind: "Kind", binding: "Bound to", free: "free", release: "Release",
    task: "Task", setTask: "Set task", order: "Order (optional, e.g. A,B,A)", start: "Start round", say: "Send a user message (enters the next round's packets)", send: "Send",
    disclosures: "Disclosures waiting for you", approve: "Approve", deny: "Deny", reason: "Reason for denying (required)",
    stale: "Artifacts that changed after freezing", accept: "Accept stale", accepted: "accepted",
    decision: "A seat ran out of time and waits for your decision: ", retry: "Retry", skip: "Skip",
    close: "Close room", confirm: "Click again to confirm", recent: "Recent events", phase: "Phase", current: "Current",
    noTask: "(no task yet)", joinPath: "JOIN file: ",
    round: "round", closed: "closed", notAllowed: " (not in allowlist)",
    phases: { idle: "idle", assign: "assign", work: "work", meet: "meet", summary: "summary", done: "round done", closed: "closed" },
    hintStopped: "This room is not served. Use Serve here to administer it.",
    hintStoppedDown: "This room is not served.",
    hintElsewhere: "Another app serves this room; administer it there.",
    releaseClosed: "The room is closed. Once released, this PI conversation can no longer read the farewell.",
    needTask: "Enter a task first.", needText: "Enter a message first.", needReason: "Enter a reason for denying first.",
    refusals: {
      ROOM_CLOSED: "The room is closed; a closed room is not served again.",
      SERVED_ELSEWHERE: "Another app serves this room; administer it there.",
      NOT_SERVED_HERE: "This room is not served here; use Serve here first."
    }
  };
  var T = EN;
  var locale = null;
  var POLL_MS = 4000;
  var CONFIRM_MS = 4000;
  // seq numbers each refresh: only the newest one paints. shell: the open detail's nodes. drafts:
  // typed text by field key (task:<room>, order:<room>, say:<room>, deny:<room>:<id>). armed: armed
  // confirms by key -> token; armNodes: the button currently drawn for each key.
  var state = {
    open: null, timer: null, seq: 0, rooms: null, roomsSig: null, shell: null, pending: null, composing: null,
    drafts: {}, armed: {}, armNodes: {}, armSeq: 0, errorSource: null
  };

  // "zh-CN" for any Chinese locale, else "en" (the two languages this panel has).
  function normalizeLocale(value) { return /^zh/i.test(String(value || "")) ? "zh-CN" : "en"; }
  function applyLocale(value) {
    var next = normalizeLocale(value);
    if (next === locale) return false;
    locale = next;
    T = locale === "zh-CN" ? ZH : EN;
    document.documentElement.lang = locale;
    document.getElementById("title").textContent = T.title;
    document.getElementById("refresh").textContent = T.refresh;
    return true;
  }

  function bridge(channel, payload) {
    if (!window.pluginBridge || typeof window.pluginBridge.invoke !== "function") return Promise.reject(new Error("pluginBridge missing"));
    return window.pluginBridge.invoke(channel, payload || {});
  }
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "text") n.textContent = attrs[k];
      else if (k === "class") n.className = attrs[k];
      else if (k === "on") Object.keys(attrs.on).forEach(function (ev) { n.addEventListener(ev, attrs.on[ev]); });
      else n.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }
  function setText(n, text) { if (n.textContent !== text) n.textContent = text; }

  // source: "refresh" or "act". A successful refresh clears only its own kind, so the refresh that
  // follows an action does not wipe the action's error, and a failed poll does not stay forever.
  function showError(msg, source) {
    var e = document.getElementById("error");
    e.textContent = msg || "";
    e.hidden = !msg;
    state.errorSource = msg ? source : null;
  }
  function clearError(source) { if (state.errorSource === source) showError(""); }
  // The plugin's own refusal codes are shown in the panel's language; any other code keeps the
  // message it came with.
  function refusal(r) {
    var code = (r && r.error) || "ERROR";
    var known = Object.prototype.hasOwnProperty.call(T.refusals, code) ? T.refusals[code] : null;
    return code + (known ? ": " + known : r && r.message ? ": " + r.message : "");
  }
  function succeeded(r) { return !(r && r.ok === false); }
  // Resolves to the bridge's answer ({ok: false} when the call itself failed), after the refresh
  // that follows it.
  function act(channel, payload) {
    showError("", "act");
    return bridge(channel, payload).then(function (r) {
      if (!succeeded(r)) showError(refusal(r), "act");
      return refresh().then(function () { return r; });
    }, function (err) {
      showError(String(err && err.message || err), "act");
      return { ok: false };
    });
  }
  // Two clicks for actions the user should not trigger by accident. The arm is kept by key, so it
  // survives the button being rebuilt, and only the timer of that same arm disarms it.
  function confirmButton(key, label, cls, fn, title) {
    var b = el("button", { type: "button", class: cls || "", text: state.armed[key] ? T.confirm : label });
    if (title) b.setAttribute("title", title);
    state.armNodes[key] = { b: b, label: label };
    b.addEventListener("click", function () {
      if (!state.armed[key]) {
        var token = ++state.armSeq;
        state.armed[key] = token;
        b.textContent = T.confirm;
        setTimeout(function disarm() {
          if (state.armed[key] !== token) return;
          delete state.armed[key];
          var n = state.armNodes[key];
          if (n) n.b.textContent = n.label;
        }, CONFIRM_MS);
        return;
      }
      delete state.armed[key];
      b.textContent = label;
      fn();
    });
    return b;
  }
  function admin(room, cmd, extra) {
    var p = { room: room, cmd: cmd };
    Object.keys(extra || {}).forEach(function (k) { p[k] = extra[k]; });
    return act("roundtable/admin", p);
  }

  // A text control of the detail. Its value is mirrored into state.drafts[key], so a rebuilt shell
  // gets it back; an IME composition in progress defers any rebuild until it ends.
  function field(shell, tag, key, attrs) {
    var n = el(tag, attrs);
    n.setAttribute("data-key", key);
    n.value = state.drafts[key] || "";
    function keep() { if (n.value) state.drafts[key] = n.value; else delete state.drafts[key]; }
    n.addEventListener("input", keep);
    n.addEventListener("compositionstart", function () { state.composing = n; });
    n.addEventListener("compositionend", function () {
      state.composing = null;
      keep();
      var d = state.pending;
      state.pending = null;
      if (d && d.room === state.open) renderDetail(d);
    });
    shell.fields[key] = n;
    return n;
  }
  // Cleared only once the action succeeded, and only if the text is still what was sent.
  function clearDraft(key, sent) {
    var n = state.shell && state.shell.fields[key];
    if (n && sent !== undefined && n.value !== sent) return;
    delete state.drafts[key];
    if (n) n.value = "";
  }
  function sendText(room, cmd, key, empty) {
    var n = state.shell && state.shell.fields[key];
    var text = n ? n.value : "";
    if (!text.trim()) { showError(empty, "act"); return; }
    admin(room, cmd, { text: text }).then(function (r) { if (succeeded(r)) clearDraft(key, text); });
  }
  // Drafts and arms of a room that closed: nothing in it can be administered any more. Release
  // stays armed: it lives on the room's card, not in the detail.
  function forgetRoom(room) {
    [state.drafts, state.armed, state.armNodes].forEach(function (m) {
      Object.keys(m).forEach(function (k) { var p = k.split(":"); if (p[0] !== "release" && p[1] === room) delete m[k]; });
    });
  }
  function forgetKey(key) { delete state.drafts[key]; delete state.armed[key]; delete state.armNodes[key]; }

  function phaseName(phase) { return T.phases[phase] || phase || "-"; }
  function statusText(room) {
    var parts = [T.phase + ": " + phaseName(room.phase), T.round + " " + room.roundId, T.current + ": " + (room.current || "-")];
    if (!room.closed) parts.push(T.served[room.served] || room.served);
    else if (room.phase !== "closed") parts.push(T.closed);
    return parts.join(" · ");
  }

  function seatTable(room) {
    var rows = room.seats.map(function (s) {
      var bound = s.kind === "pi" ? (s.boundTo ? s.boundTo : T.free) : "";
      var cell = el("td", null, [bound]);
      var release = function () { act("roundtable/unbind", { room: room.room, seat: s.seat }); };
      // Release stays on a closed room (it is how a binding record is deleted), but asks twice: the
      // conversation reads the farewell through its binding.
      if (s.kind === "pi" && s.boundTo) {
        cell.appendChild(room.closed
          ? confirmButton("release:" + room.room + ":" + s.seat, T.release, "ghost", release, T.releaseClosed)
          : el("button", { type: "button", class: "ghost", text: T.release, on: { click: release } }));
      }
      var kind = el("td", null, [s.kind + (s.model ? " (" + s.model + ")" : "")]);
      if (s.joinPath) kind.appendChild(el("div", { class: "muted", text: T.joinPath + s.joinPath }));
      return el("tr", null, [el("td", { text: s.seat + (room.current === s.seat ? " ◀" : "") }), el("td", { text: s.role }), kind, cell]);
    });
    return el("table", null, [el("tr", null, [el("th", { text: T.seat }), el("th", { text: T.role }), el("th", { text: T.kind }), el("th", { text: T.binding })])].concat(rows));
  }

  // A closed room is never served again and a room another app serves is administered there: neither
  // gets serve, stop or open buttons (the status line says why). Details stays for both.
  function roomCard(room, serviceRunning) {
    var buttons = [];
    if (!room.closed && room.served === "here") {
      buttons.push(el("button", { type: "button", class: "ghost", text: T.stop, on: { click: function () { act("roundtable/stop", { room: room.room }); } } }));
      buttons.push(el("button", { type: "button", class: "ghost", text: T.openUi, on: { click: function () { act("roundtable/open-ui", { room: room.room }); } } }));
    } else if (!room.closed && room.served === "stopped") {
      var serve = el("button", { type: "button", text: T.serve, on: { click: function () { act("roundtable/serve", { room: room.room }); } } });
      serve.disabled = !serviceRunning;
      buttons.push(serve);
    }
    var open = state.open === room.room;
    buttons.push(el("button", { type: "button", class: "ghost", text: open ? T.hide : T.details, on: { click: function () {
      state.open = state.open === room.room ? null : room.room;
      if (!state.open) clearDetail();
      refresh();
    } } }));
    return el("div", { class: "card" }, [
      el("h2", { text: room.room + (room.preset ? " · " + room.preset : "") }),
      el("div", { class: "muted", text: statusText(room) }),
      seatTable(room),
      el("div", { class: "row" }, buttons)
    ]);
  }
  // Rebuilt only when what it shows changed: the cards hold only buttons, and #rooms is an
  // aria-live region that would otherwise be announced again on every poll.
  function renderRooms(r) {
    var svc = document.getElementById("service");
    svc.textContent = r.serviceRunning ? T.up : T.down;
    svc.className = "pill " + (r.serviceRunning ? "on" : "off");
    document.getElementById("root").textContent = T.root + (r.roomsRoot || "");
    var rooms = r.rooms || [];
    var sig = JSON.stringify([locale, !!r.serviceRunning, r.roomsRoot || "", rooms, state.open]);
    if (sig === state.roomsSig) return;
    state.roomsSig = sig;
    var list = document.getElementById("rooms");
    list.textContent = "";
    if (!rooms.length) list.appendChild(el("p", { class: "muted", text: T.none }));
    rooms.forEach(function (room) { list.appendChild(roomCard(room, r.serviceRunning)); });
  }

  // ---------------------------------------------------------------- the detail shell
  function detailMode(d) { return d.closed ? "closed" : d.served; }
  function buildShell(d, key) {
    var room = d.room;
    var mode = detailMode(d);
    var s = { key: key, mode: mode, fields: {}, box: el("div", { class: "card" }, [el("h2", { text: room })]) };
    s.status = s.box.appendChild(el("div", { class: "muted" }));
    if (mode === "stopped" || mode === "elsewhere") {
      // A stopped room's hint follows the service (updateDetail): Serve here is disabled while it is down.
      s.hint = s.box.appendChild(el("p", { class: "muted", text: mode === "stopped" ? T.hintStopped : T.hintElsewhere }));
      return s;
    }
    s.box.appendChild(el("div", { class: "muted", text: T.task + ": " }));
    s.task = s.box.appendChild(el("div"));
    if (mode === "here") {
      s.box.appendChild(field(s, "textarea", "task:" + room, {}));
      var order = field(s, "input", "order:" + room, { type: "text", placeholder: T.order });
      s.start = el("button", { type: "button", text: T.start, on: { click: function () {
        var sent = order.value;
        admin(room, "start", sent.trim() ? { order: sent.trim() } : {}).then(function (r) { if (succeeded(r)) clearDraft("order:" + room, sent); });
      } } });
      s.box.appendChild(el("div", { class: "row" }, [
        el("button", { type: "button", text: T.setTask, on: { click: function () { sendText(room, "task", "task:" + room, T.needTask); } } }),
        order,
        s.start
      ]));
      s.box.appendChild(el("div", { class: "row" }, [
        field(s, "input", "say:" + room, { type: "text", placeholder: T.say }),
        el("button", { type: "button", class: "ghost", text: T.send, on: { click: function () { sendText(room, "say", "say:" + room, T.needText); } } })
      ]));
      s.decision = s.box.appendChild(el("div"));
      s.decisionSig = null;
      s.discHead = s.box.appendChild(el("h2", { text: T.disclosures }));
      s.discBox = s.box.appendChild(el("div"));
      s.disc = {};
      s.staleHead = s.box.appendChild(el("h2", { text: T.stale }));
      s.staleBox = s.box.appendChild(el("div"));
      s.stale = {};
    }
    s.box.appendChild(el("h2", { text: T.recent }));
    s.recent = s.box.appendChild(el("div", { class: "muted" }));
    if (mode === "here") s.box.appendChild(el("div", { class: "row" }, [confirmButton("close:" + room, T.close, "danger", function () { admin(room, "close"); })]));
    return s;
  }
  function disclosureCard(s, room, x) {
    var key = "deny:" + room + ":" + x.id;
    var reason = field(s, "input", key, { type: "text", placeholder: T.reason });
    return el("div", { class: "card" }, [
      el("div", null, [el("code", { text: JSON.stringify(x.argv) })]),
      el("div", { class: "muted", text: x.seatId + ": " + x.reason + (x.allowed ? "" : T.notAllowed) }),
      el("div", { class: "row" }, [
        confirmButton("approve:" + room + ":" + x.id, T.approve, "", function () { admin(room, "approve-disclose", { id: x.id }); }),
        reason,
        el("button", { type: "button", class: "danger", text: T.deny, on: { click: function () {
          var text = reason.value.trim();
          if (!text) { showError(T.needReason, "act"); return; }
          admin(room, "deny-disclose", { id: x.id, reason: text }).then(function (r) { if (succeeded(r)) clearDraft(key); });
        } } })
      ])
    ]);
  }
  function staleAction(room, entry) {
    if (entry.item.accepted) return el("div", { text: T.accepted });
    return confirmButton("accept:" + room + ":" + entry.item.manifestSha, T.accept, "", function () {
      admin(room, "accept-stale", { manifestSha: entry.item.manifestSha, changed: entry.item.changed });
    });
  }
  function staleCard(room, x) {
    var entry = { item: x, accepted: !!x.accepted };
    entry.changed = el("div", { class: "muted" });
    entry.action = staleAction(room, entry);
    entry.card = el("div", { class: "card" }, [el("code", { text: x.manifestSha }), entry.changed, entry.action]);
    return entry;
  }
  // Keeps the node of every item still listed (and with it a typed reason or an armed button),
  // appends new items and removes the ones that are gone.
  function reconcile(box, nodes, items, keyOf, make, gone) {
    var seen = {};
    items.forEach(function (x) {
      var k = keyOf(x);
      seen[k] = true;
      if (!nodes[k]) { nodes[k] = make(x); box.appendChild(nodes[k].card); }
    });
    Object.keys(nodes).forEach(function (k) {
      if (seen[k]) return;
      box.removeChild(nodes[k].card);
      delete nodes[k];
      gone(k);
    });
  }
  function updateDetail(s, d) {
    var room = d.room;
    setText(s.status, statusText(d));
    if (s.task) setText(s.task, d.task || T.noTask);
    if (s.recent) setText(s.recent, (d.recent || []).map(function (e) { return "#" + e.seq + " " + e.type + (e.seatId ? " " + e.seatId : ""); }).join(" · "));
    if (s.mode === "stopped") setText(s.hint, state.rooms && state.rooms.serviceRunning ? T.hintStopped : T.hintStoppedDown);
    if (s.mode !== "here") return;
    // The engine refuses start while a round runs (ROUND_IN_PROGRESS).
    s.start.disabled = !!d.roundActive;
    var sig = JSON.stringify(d.awaitingDecision || null);
    if (sig !== s.decisionSig) {
      s.decisionSig = sig;
      s.decision.textContent = "";
      var a = d.awaitingDecision;
      if (a) s.decision.appendChild(el("div", { class: "row" }, [
        el("span", { text: T.decision + a.seatId + " (" + phaseName(a.phase) + ")" }),
        el("button", { type: "button", text: T.retry, on: { click: function () { admin(room, "retry", { seatId: a.seatId }); } } }),
        el("button", { type: "button", class: "ghost", text: T.skip, on: { click: function () { admin(room, "skip", { seatId: a.seatId }); } } })
      ]));
    }
    var disclosures = d.disclosures || [];
    s.discHead.hidden = !disclosures.length;
    reconcile(s.discBox, s.disc, disclosures, function (x) { return x.id; },
      function (x) { return { card: disclosureCard(s, room, x) }; },
      function (id) { var k = "deny:" + room + ":" + id; delete s.fields[k]; forgetKey(k); forgetKey("approve:" + room + ":" + id); });
    var stale = d.stale || [];
    s.staleHead.hidden = !stale.length;
    reconcile(s.staleBox, s.stale, stale, function (x) { return x.manifestSha; },
      function (x) { return staleCard(room, x); },
      function (sha) { forgetKey("accept:" + room + ":" + sha); });
    stale.forEach(function (x) {
      var entry = s.stale[x.manifestSha];
      entry.item = x;
      setText(entry.changed, (x.seatId || "") + ": " + x.changed.join(", "));
      if (entry.accepted === !!x.accepted) return;
      entry.accepted = !!x.accepted;
      entry.card.removeChild(entry.action);
      entry.action = entry.card.appendChild(staleAction(room, entry));
    });
  }
  // A composition counts only while its control is still in the shell: a deny reason whose
  // disclosure went away may never see its compositionend, and must not hold rebuilds back.
  function composingInShell() {
    var n = state.composing;
    return !!(n && state.shell && state.shell.fields[n.getAttribute("data-key")] === n);
  }
  // The focused control of a shell about to be replaced, restored in the new one by its key.
  function captureFocus() {
    var a = document.activeElement;
    var key = a && typeof a.getAttribute === "function" ? a.getAttribute("data-key") : null;
    if (!key) return null;
    return { key: key, start: a.selectionStart, end: a.selectionEnd, dir: a.selectionDirection, top: a.scrollTop };
  }
  function restoreFocus(f) {
    var n = f && state.shell && state.shell.fields[f.key];
    if (!n) return;
    try {
      n.focus({ preventScroll: true });
      if (typeof n.setSelectionRange === "function" && typeof f.start === "number") n.setSelectionRange(f.start, f.end, f.dir || "none");
      n.scrollTop = f.top || 0;
    } catch (e) { /* best effort */ }
  }
  function renderDetail(d) {
    var det = document.getElementById("detail");
    var key = d.room + "|" + detailMode(d) + "|" + locale;
    if (!state.shell || state.shell.key !== key) {
      // Never swap the shell under an IME composition: the swap waits for compositionend.
      if (composingInShell()) { state.pending = d; return; }
      var focus = captureFocus();
      if (d.closed) forgetRoom(d.room);
      state.shell = buildShell(d, key);
      det.textContent = "";
      det.appendChild(state.shell.box);
      restoreFocus(focus);
    }
    state.pending = null;
    updateDetail(state.shell, d);
    det.hidden = false;
  }
  function clearDetail() {
    var det = document.getElementById("detail");
    det.hidden = true;
    det.textContent = "";
    state.shell = null;
    state.pending = null;
    state.composing = null;
  }

  // Each refresh is numbered: an answer that arrives after a newer refresh began is dropped, and a
  // detail answer also when the open room changed meanwhile (Hide, or another room's Details).
  function refresh() {
    var my = ++state.seq;
    return bridge("roundtable/rooms").then(function (r) {
      if (my !== state.seq) return;
      if (!r || r.ok === false) { showError(refusal(r), "refresh"); return; }
      state.rooms = r;
      renderRooms(r);
      var asked = state.open;
      if (!asked) { clearDetail(); clearError("refresh"); return; }
      return bridge("roundtable/room", { room: asked }).then(function (d) {
        if (my !== state.seq || state.open !== asked) return;
        if (d && d.ok !== false) renderDetail(d);
        else { state.open = null; clearDetail(); renderRooms(state.rooms); }
        clearError("refresh");
      });
    }).then(null, function (err) { if (my === state.seq) showError(String(err && err.message || err), "refresh"); });
  }

  // Polled while visible, also while the user types. The next poll is scheduled only when this one
  // has finished, so slow answers (the host allows an invoke 30 s) never stack.
  function schedule() { clearTimeout(state.timer); state.timer = setTimeout(loop, POLL_MS); }
  function loop() { (document.hidden ? Promise.resolve() : refresh()).then(schedule, schedule); }
  function onAppearance(appearance) {
    if (appearance && typeof appearance === "object" && appearance.locale && applyLocale(appearance.locale)) refresh();
  }
  function start(appearance) {
    applyLocale(appearance && appearance.locale ? appearance.locale : navigator.language);
    loop();
    if (typeof document.addEventListener === "function") document.addEventListener("visibilitychange", function () { if (!document.hidden) refresh(); });
    if (window.pluginBridge && typeof window.pluginBridge.on === "function") {
      try { window.pluginBridge.on("appearance:changed", onAppearance); } catch (e) { /* best effort */ }
    }
  }
  document.getElementById("refresh").addEventListener("click", function () { refresh(); });
  bridge("app.getAppearance").then(start, function () { start(null); });
})();
