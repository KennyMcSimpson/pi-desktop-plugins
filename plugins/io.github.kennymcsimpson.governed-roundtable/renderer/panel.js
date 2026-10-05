// Governed Roundtable panel. Runs in PI-Desktop's sandboxed panel window (no Node); every action
// goes through window.pluginBridge.invoke to the plugin's onPanelInvoke. This is the user's side of
// the room: task, start, disclosure approval, stale acceptance, close and seat release live here
// and never in the agent tool. Text that came from seats (reasons, argv, seat names) is inserted
// with textContent only.
//
// Language: the host's, read through the panel bridge's app.getAppearance (the channel upstream
// panels use, plugin-runtime.ts 2184), falling back to navigator.language; index.html's lang="en" is
// only the placeholder until then. appearance:changed re-renders when the user switches language.
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
    noTask: "（还没有任务）", joinPath: "入席文件："
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
    noTask: "(no task yet)", joinPath: "JOIN file: "
  };
  var T = EN;
  var locale = null;
  var state = { open: null, timer: null };

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
  function showError(msg) {
    var e = document.getElementById("error");
    e.textContent = msg || "";
    e.hidden = !msg;
  }
  function act(channel, payload) {
    showError("");
    return bridge(channel, payload).then(function (r) {
      if (r && r.ok === false) showError((r.error || "ERROR") + (r.message ? ": " + r.message : ""));
      return refresh();
    }, function (err) { showError(String(err && err.message || err)); });
  }
  // Two clicks for actions the user should not trigger by accident.
  function confirmButton(label, cls, fn) {
    var armed = false;
    var b = el("button", { type: "button", class: cls || "", text: label });
    b.addEventListener("click", function () {
      if (!armed) { armed = true; b.textContent = T.confirm; setTimeout(function () { armed = false; b.textContent = label; }, 4000); return; }
      armed = false; b.textContent = label; fn();
    });
    return b;
  }
  function admin(room, cmd, extra) {
    var p = { room: room, cmd: cmd };
    Object.keys(extra || {}).forEach(function (k) { p[k] = extra[k]; });
    return act("roundtable/admin", p);
  }

  function seatTable(room) {
    var rows = room.seats.map(function (s) {
      var bound = s.kind === "pi" ? (s.boundTo ? s.boundTo : T.free) : "";
      var cell = el("td", null, [bound]);
      if (s.kind === "pi" && s.boundTo) cell.appendChild(el("button", { type: "button", class: "ghost", text: T.release, on: { click: function () { act("roundtable/unbind", { room: room.room, seat: s.seat }); } } }));
      var kind = el("td", null, [s.kind + (s.model ? " (" + s.model + ")" : "")]);
      if (s.joinPath) kind.appendChild(el("div", { class: "muted", text: T.joinPath + s.joinPath }));
      return el("tr", null, [el("td", { text: s.seat + (room.current === s.seat ? " ◀" : "") }), el("td", { text: s.role }), kind, cell]);
    });
    return el("table", null, [el("tr", null, [el("th", { text: T.seat }), el("th", { text: T.role }), el("th", { text: T.kind }), el("th", { text: T.binding })])].concat(rows));
  }

  function roomCard(room) {
    var here = room.served === "here";
    var serveOrStop = here
      ? el("button", { type: "button", class: "ghost", text: T.stop, on: { click: function () { act("roundtable/stop", { room: room.room }); } } })
      : el("button", { type: "button", text: T.serve, on: { click: function () { act("roundtable/serve", { room: room.room }); } } });
    if (!here && (room.closed || room.served === "elsewhere")) serveOrStop.disabled = true;
    var buttons = el("div", { class: "row" }, [
      serveOrStop,
      here ? el("button", { type: "button", class: "ghost", text: T.openUi, on: { click: function () { act("roundtable/open-ui", { room: room.room }); } } }) : null,
      el("button", { type: "button", class: "ghost", text: state.open === room.room ? T.hide : T.details, on: { click: function () { state.open = state.open === room.room ? null : room.room; refresh(); } } })
    ]);
    return el("div", { class: "card" }, [
      el("h2", { text: room.room + (room.preset ? " · " + room.preset : "") }),
      el("div", { class: "muted", text: T.phase + ": " + room.phase + " · round " + room.roundId + " · " + T.current + ": " + (room.current || "-") + " · " + (room.closed ? "closed" : T.served[room.served]) }),
      seatTable(room),
      buttons
    ]);
  }

  function detailCard(d) {
    var box = el("div", { class: "card" }, [el("h2", { text: d.room })]);
    if (d.served !== "here") { box.appendChild(el("p", { class: "muted", text: T.served[d.served] })); return box; }
    var taskArea = el("textarea", {});
    taskArea.value = "";
    box.appendChild(el("div", { class: "muted", text: T.task + ": " }, []));
    box.appendChild(el("div", { text: d.task || T.noTask }));
    box.appendChild(taskArea);
    var order = el("input", { type: "text", placeholder: T.order });
    box.appendChild(el("div", { class: "row" }, [
      el("button", { type: "button", text: T.setTask, on: { click: function () { if (taskArea.value.trim()) admin(d.room, "task", { text: taskArea.value }); } } }),
      order,
      el("button", { type: "button", text: T.start, on: { click: function () { admin(d.room, "start", order.value.trim() ? { order: order.value.trim() } : {}); } } })
    ]));
    var sayArea = el("input", { type: "text", placeholder: T.say });
    box.appendChild(el("div", { class: "row" }, [sayArea, el("button", { type: "button", class: "ghost", text: T.send, on: { click: function () { if (sayArea.value.trim()) admin(d.room, "say", { text: sayArea.value }); } } })]));

    if (d.awaitingDecision) {
      box.appendChild(el("div", { class: "row" }, [
        el("span", { text: T.decision + d.awaitingDecision.seatId + " (" + d.awaitingDecision.phase + ")" }),
        el("button", { type: "button", text: T.retry, on: { click: function () { admin(d.room, "retry", { seatId: d.awaitingDecision.seatId }); } } }),
        el("button", { type: "button", class: "ghost", text: T.skip, on: { click: function () { admin(d.room, "skip", { seatId: d.awaitingDecision.seatId }); } } })
      ]));
    }
    if (d.disclosures.length) {
      box.appendChild(el("h2", { text: T.disclosures }));
      d.disclosures.forEach(function (x) {
        var reason = el("input", { type: "text", placeholder: T.reason });
        box.appendChild(el("div", { class: "card" }, [
          el("div", null, [el("code", { text: JSON.stringify(x.argv) })]),
          el("div", { class: "muted", text: x.seatId + ": " + x.reason + (x.allowed ? "" : " (not in allowlist)") }),
          el("div", { class: "row" }, [
            confirmButton(T.approve, "", function () { admin(d.room, "approve-disclose", { id: x.id }); }),
            reason,
            el("button", { type: "button", class: "danger", text: T.deny, on: { click: function () { if (reason.value.trim()) admin(d.room, "deny-disclose", { id: x.id, reason: reason.value.trim() }); } } })
          ])
        ]));
      });
    }
    if (d.stale.length) {
      box.appendChild(el("h2", { text: T.stale }));
      d.stale.forEach(function (x) {
        box.appendChild(el("div", { class: "card" }, [
          el("code", { text: x.manifestSha }),
          el("div", { class: "muted", text: (x.seatId || "") + ": " + x.changed.join(", ") }),
          x.accepted ? el("div", { text: T.accepted }) : confirmButton(T.accept, "", function () { admin(d.room, "accept-stale", { manifestSha: x.manifestSha, changed: x.changed }); })
        ]));
      });
    }
    box.appendChild(el("h2", { text: T.recent }));
    box.appendChild(el("div", { class: "muted", text: d.recent.map(function (e) { return "#" + e.seq + " " + e.type + (e.seatId ? " " + e.seatId : ""); }).join(" · ") }));
    box.appendChild(el("div", { class: "row" }, [confirmButton(T.close, "danger", function () { admin(d.room, "close"); })]));
    return box;
  }

  function refresh() {
    return bridge("roundtable/rooms").then(function (r) {
      var svc = document.getElementById("service");
      svc.textContent = r.serviceRunning ? T.up : T.down;
      svc.className = "pill " + (r.serviceRunning ? "on" : "off");
      document.getElementById("root").textContent = T.root + (r.roomsRoot || "");
      var list = document.getElementById("rooms");
      list.textContent = "";
      if (!r.rooms || !r.rooms.length) list.appendChild(el("p", { class: "muted", text: T.none }));
      (r.rooms || []).forEach(function (room) { list.appendChild(roomCard(room)); });
      var det = document.getElementById("detail");
      if (!state.open) { det.hidden = true; det.textContent = ""; return; }
      return bridge("roundtable/room", { room: state.open }).then(function (d) {
        det.textContent = "";
        if (d && d.ok !== false) { det.appendChild(detailCard(d)); det.hidden = false; }
        else { det.hidden = true; state.open = null; }
      });
    }, function (err) { showError(String(err && err.message || err)); });
  }

  // Poll only while visible. A plugin has no main-to-panel push channel.
  function loop() {
    var focused = document.activeElement;
    if (!document.hidden && !(focused && focused.matches && focused.matches("textarea, input"))) refresh();
    state.timer = setTimeout(loop, 4000);
  }
  function onAppearance(appearance) {
    if (appearance && typeof appearance === "object" && appearance.locale && applyLocale(appearance.locale)) refresh();
  }
  function start(appearance) {
    applyLocale(appearance && appearance.locale ? appearance.locale : navigator.language);
    refresh();
    state.timer = setTimeout(loop, 4000);
    if (window.pluginBridge && typeof window.pluginBridge.on === "function") {
      try { window.pluginBridge.on("appearance:changed", onAppearance); } catch (e) { /* best effort */ }
    }
  }
  document.getElementById("refresh").addEventListener("click", function () { refresh(); });
  bridge("app.getAppearance").then(start, function () { start(null); });
})();
