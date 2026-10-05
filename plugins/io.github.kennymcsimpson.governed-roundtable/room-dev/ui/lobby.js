/* ui/lobby.js - the lobby page served by lib/lobby.mjs. Plain ES2020 classic script, no framework.
 *
 *   GET  /lobby/api/meta, /lobby/api/rooms, /lobby/api/seat-defaults?id=&seat=   (no token)
 *   POST /lobby/api/create | open | stop | task | start                          JSON {token, ...}
 *
 * The lobby token is read once from the URL fragment (#<token>) and the fragment is then removed from
 * the address bar with history.replaceState. It is kept in memory only and sent only inside POST
 * bodies (postJson); getJson never carries it, and no URL this page builds has it in a query string
 * (test/lobby.test.mjs checks this file statically). Text from the server is inserted as text nodes.
 */
(function () {
  'use strict';

  var ROLE_SHORT = { lead: '主力', executor: '执行者', reviewer: '审方', participant: '参与者' };
  var PHASE_LABEL = { idle: '空闲', work: '干活', meet: '开会', summary: '汇总', assign: '分工', done: '本轮结束', closed: '已散会' };
  var CODEX_AGENTS = { 'codex-desktop': 1, 'codex-cli': 1 };
  var HOSTED_PI = 'hosted-pi'; // pseudo-agent in the seat form: the room's built-in Pi
  var ID_RE = /^[A-Za-z0-9_-]+$/;

  var app = { token: '', meta: null, rooms: [], view: 'rooms', taskOpen: {}, pollTimer: null, seq: 0 };
  // Inside the desktop app (app/preload.cjs) window.roomApp offers a native folder picker and the
  // system clipboard; in a browser it is absent and the page behaves as before.
  var APP = (typeof window !== 'undefined' && window.roomApp && window.roomApp.isApp === true) ? window.roomApp : null;

  // ---- token: fragment once, then out of the address bar ----
  function takeTokenFromFragment() {
    var frag = (location.hash || '').replace(/^#/, '').trim();
    if (location.hash) {
      try { history.replaceState(null, '', location.pathname); } catch (e) { /* older browsers: leave it */ }
    }
    if (!frag) return '';
    var m = /^token=(.+)$/.exec(frag);
    return m ? m[1] : frag;
  }

  // ---- DOM helpers ----
  function $(id) { return document.getElementById(id); }
  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'text') el.textContent = String(v);
      else if (k === 'class') el.className = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else el.setAttribute(k, v === true ? '' : String(v));
    });
    (children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function toast(text, tone) {
    var box = $('toasts');
    var el = h('div', { class: 'toast ' + (tone || ''), text: text });
    box.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 8000);
  }

  // ---- network: GET without token, POST with the token in the body ----
  function getJson(path) {
    return fetch(path, { method: 'GET', cache: 'no-store', credentials: 'same-origin' }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { setConn(true); return { status: r.status, json: j || {} }; });
    }, function (e) { setConn(false); throw e; });
  }
  function postJson(path, body) {
    var payload = Object.assign({}, body || {}, { token: app.token });
    return fetch(path, { method: 'POST', cache: 'no-store', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { setConn(true); return { status: r.status, json: j || {} }; });
    }, function (e) { setConn(false); throw e; });
  }
  function errText(res) {
    var j = (res && res.json) || {};
    return j.message || j.error || ('HTTP ' + (res && res.status));
  }

  function setConn(ok) {
    var el = $('hdr-conn');
    el.textContent = ok ? '连接：正常' : '连接：断开（启动器窗口关了？）';
    el.className = 'conn ' + (ok ? 'conn-ok' : 'conn-bad');
  }
  function setToken(t) {
    app.token = t || '';
    var el = $('hdr-token');
    el.textContent = app.token ? '令牌：已载入' : '令牌：缺失';
    el.className = 'tok ' + (app.token ? 'tok-ok' : 'tok-missing');
    $('token-bar').classList.toggle('hidden', !!app.token);
    var btns = document.querySelectorAll('[data-needs-token]');
    for (var i = 0; i < btns.length; i++) btns[i].disabled = !app.token;
  }

  // ---- views ----
  function showView(name) {
    app.view = name;
    var tabs = document.querySelectorAll('#tabs .tab');
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('active', tabs[i].getAttribute('data-view') === name);
    var views = document.querySelectorAll('.view');
    for (var j = 0; j < views.length; j++) views[j].classList.toggle('active', views[j].getAttribute('data-view') === name);
    if (name === 'rooms') refreshRooms();
  }

  function agentLabel(id) {
    var a = app.meta && app.meta.agents ? app.meta.agents.filter(function (x) { return x.id === id; })[0] : null;
    return a ? a.label : (id || '未知');
  }
  function waitLabel(id) {
    var w = app.meta && app.meta.waitModes ? app.meta.waitModes.filter(function (x) { return x.id === id; })[0] : null;
    return w ? w.label : (id || '未知');
  }

  function copyText(text, btn) {
    function done(ok) {
      if (!btn) return;
      var old = btn.textContent;
      btn.textContent = ok ? '已复制' : '复制失败，请手动选中';
      setTimeout(function () { btn.textContent = old; }, 1600);
    }
    if (APP && typeof APP.copyText === 'function') {
      APP.copyText(text).then(function (ok) { done(ok !== false); }, function () { done(fallbackCopy(text)); });
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(fallbackCopy(text)); });
    } else done(fallbackCopy(text));
  }
  function fallbackCopy(text) {
    var ta = h('textarea', { value: text, readonly: true });
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  // One 入席 card: the sentence to say to the agent, a copy button, the agent-specific hint.
  function joinCard(seat) {
    var head = h('h5', {}, [
      '席位 ' + seat.seatId,
      h('span', { class: 'badge', text: ROLE_SHORT[seat.role] || seat.role }),
      h('span', { class: 'badge info', text: seat.hosted ? ('内置 ' + seat.hosted) : agentLabel(seat.agent) }),
    ]);
    var body = [head];
    if (seat.sentence) {
      var btn = h('button', { type: 'button', class: 'btn-small', text: '复制这句话' });
      btn.addEventListener('click', function () { copyText(seat.sentence, btn); });
      body.push(h('div', { class: 'hint', text: '把这句话发给这个席位的 agent：' }));
      body.push(h('div', { class: 'sentence' }, [h('code', { text: seat.sentence }), btn]));
    }
    if (seat.hint) body.push(h('div', { class: 'hint', text: seat.hint }));
    if (seat.notes && seat.notes.length) body.push(h('ul', {}, seat.notes.map(function (n) { return h('li', { text: n }); })));
    return h('div', { class: 'join-card' }, body);
  }

  // ---- room actions (shared by the list and the after-create view) ----
  function openRoomUi(id, btn) {
    if (!app.token) { toast('没有启动器令牌，不能打开房间。', 'bad'); return; }
    if (APP) { openRoomUiInApp(id, btn); return; }
    // Open the window inside the click (popup blockers allow that), then point it at the room UI.
    var w = null;
    try { w = window.open('about:blank', '_blank'); } catch (e) { w = null; }
    if (w) { try { w.opener = null; } catch (e) { /* ignore */ } }
    if (btn) btn.disabled = true;
    postJson('/lobby/api/open', { id: id }).then(function (res) {
      if (btn) btn.disabled = false;
      if (res.status !== 200 || !res.json.ok) { if (w) w.close(); toast('打开失败：' + errText(res), 'bad'); return; }
      var url = res.json.url;
      // Always leave a link: some browsers (embedded ones, strict popup settings) hand back a window
      // object yet never show the tab, so a returned `w` is no proof the user can see the room.
      if (w) { try { w.location.replace(url); } catch (e) { /* the link below still works */ } }
      showRoomLink(id, url, !w);
      toast(res.json.already ? '房间 ' + id + ' 已经开着。' : '房间 ' + id + ' 已打开。', 'ok');
      refreshRooms();
    }, function () { if (btn) btn.disabled = false; if (w) w.close(); toast('打开失败：连不上启动器。', 'bad'); });
  }
  // In the desktop app there is no popup blocker: ask the lobby first, then window.open the room UI;
  // the app turns that into a room window of its own (only for ports this lobby opened). The link
  // below stays as the fallback, as in the browser.
  function openRoomUiInApp(id, btn) {
    if (btn) btn.disabled = true;
    postJson('/lobby/api/open', { id: id }).then(function (res) {
      if (btn) btn.disabled = false;
      if (res.status !== 200 || !res.json.ok) { toast('打开失败：' + errText(res), 'bad'); return; }
      var url = res.json.url;
      try { window.open(url, '_blank'); } catch (e) { /* the link below still works */ }
      showRoomLink(id, url, false);
      toast(res.json.already ? '房间 ' + id + ' 已经开着。' : '房间 ' + id + ' 已打开。', 'ok');
      refreshRooms();
    }, function () { if (btn) btn.disabled = false; toast('打开失败：连不上启动器。', 'bad'); });
  }
  // The room id never goes into a selector: compare the attribute instead (an id read from someone's
  // room.json could contain quotes or brackets).
  function roomLinkBox(id) {
    var boxes = document.querySelectorAll('[data-room-link]');
    for (var i = 0; i < boxes.length; i++) if (boxes[i].getAttribute('data-room-link') === String(id)) return boxes[i];
    return null;
  }
  function showRoomLink(id, url, blocked) {
    var box = roomLinkBox(id);
    if (!box) { if (blocked) toast('浏览器拦住了新窗口；请允许本页弹窗后再点一次「打开房间界面」。', 'bad'); return; }
    clear(box);
    box.appendChild(h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: blocked ? '浏览器拦住了新窗口，点这里打开房间界面' : '没有自动打开的话，点这里打开房间界面' }));
  }
  function stopRoom(id, btn) {
    if (btn) btn.disabled = true;
    postJson('/lobby/api/stop', { id: id }).then(function (res) {
      if (btn) btn.disabled = false;
      if (res.status !== 200 || !res.json.ok) { toast('停止失败：' + errText(res), 'bad'); return; }
      toast('房间 ' + id + ' 的服务已停止。', 'ok');
      refreshRooms();
    }, function () { if (btn) btn.disabled = false; toast('停止失败：连不上启动器。', 'bad'); });
  }

  // 给任务并开始: task text, then start with the given order (opens the room first when needed).
  function taskForm(room) {
    var ta = h('textarea', { placeholder: '任务，例如：给 parser.mjs 加 --strict 开关，验收：node --test parser.test.mjs' });
    var lead = room.seats.filter(function (s) { return s.role === 'lead'; }).map(function (s) { return s.seatId; });
    var rest = room.seats.filter(function (s) { return s.role !== 'lead'; }).map(function (s) { return s.seatId; });
    var order = h('input', { type: 'text', value: lead.concat(rest).join(','), placeholder: 'A,B' });
    var go = h('button', { type: 'button', class: 'primary', text: '给任务并开始', 'data-needs-token': true, disabled: !app.token });
    var status = h('span', { class: 'hint' });
    go.addEventListener('click', function () {
      var text = ta.value.trim();
      if (!text) { toast('先写任务。', 'bad'); return; }
      var ids = order.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      for (var i = 0; i < ids.length; i++) if (!ID_RE.test(ids[i])) { toast('发言顺序里的「' + ids[i] + '」不是席位编号。', 'bad'); return; }
      go.disabled = true;
      status.textContent = '正在提交……';
      // open is idempotent: it starts the room's service when needed and otherwise answers `already`.
      postJson('/lobby/api/open', { id: room.id }).then(function (o) {
        if (o.status !== 200 || !o.json.ok) throw new Error('打开失败：' + errText(o));
        return postJson('/lobby/api/task', { id: room.id, text: text });
      }).then(function (t) {
        if (t.status !== 200 || !t.json.ok) throw new Error('任务没交上：' + errText(t));
        return postJson('/lobby/api/start', ids.length ? { id: room.id, order: ids } : { id: room.id });
      }).then(function (s) {
        if (s.status !== 200 || !s.json.ok) throw new Error('任务已交，但没能开始：' + errText(s));
        status.textContent = '已开始第 ' + (s.json.roundId || '?') + ' 轮。';
        toast('房间 ' + room.id + ' 已开始。到房间界面里看发言流。', 'ok');
        app.taskOpen[room.id] = false;
        refreshRooms();
      }).catch(function (e) {
        status.textContent = '';
        toast(e && e.message ? e.message : '提交失败：连不上启动器。', 'bad');
      }).then(function () { go.disabled = !app.token; });
    });
    return h('div', { class: 'task-form' }, [
      h('label', { class: 'hint', text: '任务（作为 admin task 交给房间）' }), ta,
      h('div', { class: 'inline-form' }, [h('span', { class: 'hint', text: '发言顺序（席位编号，逗号分隔）' }), order, go, status]),
      h('div', { class: 'hint', text: '房间服务还没启动时，提交会先在启动器里启动它（不弹出界面）。轮到哪个席位，就去提醒对应的 agent，或等唤醒推送。' }),
    ]);
  }

  function roomCard(room) {
    var running = room.openedHere ? h('span', { class: 'badge ok', text: '服务：在本启动器里运行' })
      : (room.serviceRunning ? h('span', { class: 'badge warn', text: '服务：在别处运行' }) : h('span', { class: 'badge', text: '服务：未运行' }));
    var head = h('h4', {}, [
      room.id,
      h('span', { class: 'badge info', text: room.preset || '无预设' }),
      h('span', { class: 'badge', text: '阶段 ' + (room.closed ? PHASE_LABEL.closed : (PHASE_LABEL[room.phase] || room.phase)) }),
      h('span', { class: 'badge', text: '第 ' + room.roundId + ' 轮' }),
      running,
    ]);
    var rows = room.seats.map(function (s) {
      return h('tr', {}, [
        h('td', { text: s.seatId }),
        h('td', { text: ROLE_SHORT[s.role] || s.role }),
        h('td', { text: s.hosted ? '内置 ' + s.hosted : agentLabel(s.agent) }),
        h('td', { text: waitLabel(s.waitMode) }),
        h('td', { text: s.wakeThread || '—' }),
        h('td', { class: 'mono', text: s.cwd }),
      ]);
    });
    var table = h('div', { class: 'table-wrap' }, [h('table', { class: 'table' }, [
      h('thead', {}, [h('tr', {}, ['席位', '职责', 'agent', '等待方式', 'Codex 线程名', '工作文件夹'].map(function (t) { return h('th', { text: t }); }))]),
      h('tbody', {}, rows.length ? rows : [h('tr', {}, [h('td', { colspan: '6', class: 'empty', text: '还没有席位' })])]),
    ])]);
    var joins = h('details', { class: 'seat-join' }, [h('summary', { text: '入席说明（每个 agent 一句话）' })].concat(room.seats.map(joinCard)));

    var openBtn = h('button', { type: 'button', class: 'primary', text: '打开房间界面', 'data-needs-token': true, disabled: !app.token || (room.serviceRunning && !room.openedHere) });
    openBtn.addEventListener('click', function () { openRoomUi(room.id, openBtn); });
    var stopBtn = h('button', { type: 'button', class: 'danger', text: '停止', 'data-needs-token': true, disabled: !app.token || !room.openedHere });
    stopBtn.addEventListener('click', function () { stopRoom(room.id, stopBtn); });
    var taskBtn = h('button', { type: 'button', text: app.taskOpen[room.id] ? '收起任务' : '给任务并开始', disabled: room.closed || (room.serviceRunning && !room.openedHere) });
    taskBtn.addEventListener('click', function () { app.taskOpen[room.id] = !app.taskOpen[room.id]; renderRooms(true); });
    var actions = h('div', { class: 'actions' }, [openBtn, stopBtn, taskBtn,
      room.serviceRunning && !room.openedHere ? h('span', { class: 'hint', text: '这个房间的服务在别的窗口里运行；到那里用它，或先关掉它。' }) : null,
      h('span', { 'data-room-link': room.id })]);
    var children = [head];
    if (room.idMismatch) children.push(h('div', { class: 'hint', text: '这个房间目录叫 ' + room.id + '，但 room.json 里写的房间编号是 ' + room.roomId + '；启动器按目录名操作它。' }));
    if (room.task) children.push(h('div', { class: 'hint', text: '当前任务：' + room.task }));
    children.push(table, joins, actions);
    if (app.taskOpen[room.id]) children.push(taskForm(room));
    return h('div', { class: 'card', 'data-room': room.id }, children);
  }

  // Re-rendering replaces the cards; skip it while the user is typing into a task form.
  function renderRooms(force) {
    var box = $('rooms');
    if (!force && box.contains(document.activeElement) && /^(TEXTAREA|INPUT)$/.test(document.activeElement.tagName)) return;
    clear(box);
    if (!app.rooms.length) {
      box.appendChild(h('div', { class: 'card' }, [h('p', { class: 'empty', text: '还没有房间。点「新建房间」开始。' })]));
      return;
    }
    app.rooms.forEach(function (r) { box.appendChild(roomCard(r)); });
  }
  function refreshRooms() {
    return getJson('/lobby/api/rooms').then(function (res) {
      if (res.status !== 200 || !res.json.ok) { toast('读房间列表失败：' + errText(res), 'bad'); return; }
      var key = JSON.stringify(res.json.rooms);
      app.rooms = res.json.rooms || [];
      if (key !== app.lastRooms) { app.lastRooms = key; renderRooms(false); }
    }, function () { /* connection badge already says so */ });
  }

  // ---- create form ----
  function fillSelect(sel, items, value) {
    clear(sel);
    items.forEach(function (it) { sel.appendChild(h('option', { value: it.id, text: it.label || it.id })); });
    if (value !== undefined) sel.value = value;
  }

  function seatRow(init) {
    init = init || {};
    var row = h('div', { class: 'seat-row' });
    var idIn = h('input', { type: 'text', class: 'seat-id', value: init.seatId || '', placeholder: '席位编号', 'aria-label': '席位编号' });
    var role = h('select', { 'aria-label': '职责' });
    fillSelect(role, (app.meta.roles || []).map(function (r) { return { id: r.id, label: r.label }; }), init.role || 'participant');
    var agent = h('select', { 'aria-label': 'agent' });
    var agentItems = (app.meta.agents || []).map(function (a) { return { id: a.id, label: a.label + '（' + a.id + '）' }; });
    if ((app.meta.hostedTiers || []).length) agentItems.push({ id: HOSTED_PI, label: '房间内置 Pi（不需要另开 agent）' });
    fillSelect(agent, agentItems, init.hosted ? HOSTED_PI : (init.agent || 'generic'));
    var tier = h('select', { 'aria-label': '内置 Pi 档位' });
    fillSelect(tier, (app.meta.hostedTiers || []).map(function (t) { return { id: t.id, label: t.label }; }), init.hosted && /^pi:/.test(init.hosted) ? init.hosted.slice(3) : 'discussion');
    var tierRow = [h('label', { text: '内置 Pi 档位' }), h('div', {}, [tier, h('div', { class: 'hint', text: '由房间自己托管，不需要发入席句子。启动房间前用 ROOM_PI_API_KEY 或 admin pi-key --save 准备好 key。' })])];
    var wait = h('select', { 'aria-label': '等待方式' });
    var waitRow = [h('label', { text: '等待方式' }), wait];
    var cwd = h('input', { type: 'text', value: init.cwd || '', placeholder: '工作文件夹的绝对路径', 'aria-label': '工作文件夹' });
    var create = h('input', { type: 'checkbox', checked: init.createCwd !== false });
    var thread = h('input', { type: 'text', value: '', placeholder: 'room-<房间编号>-A', 'aria-label': 'Codex 线程名' });
    var threadRow = [h('label', { text: 'Codex 线程名' }), h('div', {}, [thread, h('div', { class: 'hint', text: '把 Codex 里这个席位的线程重命名成这个名字（要和别的线程都不一样），轮到它时房间按名字找到线程并推送一句提醒。清空就不推送。' })])];
    var cwdNote = h('div', { class: 'hint' });
    var remove = h('button', { type: 'button', class: 'btn-small danger', text: '删掉这个席位' });
    row._touched = { cwd: !!init.cwd, thread: false };

    function isPi() { return agent.value === HOSTED_PI; }
    function refreshWait() {
      var a = (app.meta.agents || []).filter(function (x) { return x.id === agent.value; })[0];
      var items = [{ id: '', label: '按 agent 默认（' + waitLabel(a ? a.wait : 'manual') + '）' }].concat((app.meta.waitModes || []).map(function (w) { return { id: w.id, label: w.label }; }));
      var keep = wait.value;
      fillSelect(wait, items, keep || '');
      waitRow.forEach(function (el) { el.classList.toggle('hidden', isPi()); });
      tierRow.forEach(function (el) { el.classList.toggle('hidden', !isPi()); });
    }
    function refreshThread() {
      var codex = !!CODEX_AGENTS[agent.value];
      threadRow.forEach(function (el) { el.classList.toggle('hidden', !codex); });
      if (!row._touched.thread) thread.value = 'room-' + ($('room-id').value.trim() || 'demo') + '-' + (idIn.value.trim() || 'A');
    }
    // A typed or pasted path: ask the lobby (read-only) whether it exists, and tick 替我新建 only
    // when it does not, the same way the suggested folder is handled.
    function checkTypedCwd() {
      var v = cwd.value.trim();
      var mine = ++app.seq;
      row._seq = mine;
      if (!isAbsPath(v)) { cwdNote.textContent = v ? '要写完整的绝对路径（例如 C:\\Users\\你\\project）。' : ''; return; }
      getJson('/lobby/api/folder?path=' + encodeURIComponent(v)).then(function (res) {
        if (row._seq !== mine || res.status !== 200 || !res.json.ok) return;
        create.checked = !res.json.exists;
        cwdNote.textContent = !res.json.exists ? '这个文件夹还不存在；保持勾选，启动器替你新建一个空文件夹。'
          : (res.json.isDir ? '这个文件夹已经存在，会直接使用它（已取消勾选「替我新建」）。' : '这个路径是一个文件，不是文件夹。');
      }, function () {});
    }
    function refreshCwd() {
      if (row._touched.cwd) return;
      var rid = $('room-id').value.trim();
      var sid = idIn.value.trim();
      if (!ID_RE.test(rid) || !ID_RE.test(sid)) return;
      var mine = ++app.seq;
      row._seq = mine;
      getJson('/lobby/api/seat-defaults?id=' + encodeURIComponent(rid) + '&seat=' + encodeURIComponent(sid)).then(function (res) {
        if (row._seq !== mine || row._touched.cwd || res.status !== 200 || !res.json.ok) return;
        cwd.value = res.json.cwd;
        create.checked = !res.json.exists;
        cwdNote.textContent = res.json.exists ? '这个文件夹已经存在，会直接使用它。' : '建议的位置；勾选下面的框，启动器替你新建这个空文件夹。';
      }, function () {});
    }
    row._refreshCwd = refreshCwd;

    row._refreshThread = refreshThread;

    idIn.addEventListener('input', function () { refreshThread(); refreshCwd(); });
    agent.addEventListener('change', function () { refreshWait(); refreshThread(); });
    cwd.addEventListener('input', function () {
      row._touched.cwd = true;
      cwdNote.textContent = '正在查这个文件夹……';
      if (row._cwdTimer) clearTimeout(row._cwdTimer);
      row._cwdTimer = setTimeout(checkTypedCwd, 300);
    });
    thread.addEventListener('input', function () { row._touched.thread = true; });
    remove.addEventListener('click', function () { if (row.parentNode) row.parentNode.removeChild(row); });

    // 浏览…: the desktop app's native folder picker (it may also create a new folder there).
    var browse = null;
    if (APP && typeof APP.pickFolder === 'function') {
      browse = h('button', { type: 'button', class: 'btn-small', text: '浏览…' });
      browse.addEventListener('click', function () {
        browse.disabled = true;
        APP.pickFolder(cwd.value.trim() || null).then(function (picked) {
          browse.disabled = false;
          if (typeof picked !== 'string' || !picked) return;
          cwd.value = picked;
          row._touched.cwd = true;
          app.seatsEdited = true;
          cwdNote.textContent = '正在查这个文件夹……';
          checkTypedCwd();
        }, function () { browse.disabled = false; toast('没能打开文件夹选择框。', 'bad'); });
      });
    }

    row.appendChild(h('div', { class: 'row-head' }, [h('span', { class: 'hint', text: '席位' }), idIn, h('span', { class: 'spacer' }), remove]));
    row.appendChild(h('div', { class: 'row-grid' }, [
      h('label', { text: '职责' }), role,
      h('label', { text: 'agent' }), agent,
    ].concat(tierRow, waitRow, [
      h('label', { text: '工作文件夹' }), h('div', {}, [
        h('div', { class: 'cwd-line' }, [cwd, browse]),
        h('label', { class: 'check' }, [create, '替我新建这个空文件夹']),
        cwdNote,
      ]),
    ], threadRow)));
    refreshWait();
    refreshThread();
    if (init.wait) wait.value = init.wait;
    row._read = function () {
      var s = { seatId: idIn.value.trim(), role: role.value, cwd: cwd.value.trim(), createCwd: !!create.checked };
      // A built-in Pi seat: hosted 'pi:<tier>', no agent, wait mode or Codex thread.
      if (isPi()) { s.hosted = 'pi:' + tier.value; return s; }
      s.agent = agent.value;
      if (wait.value) s.wait = wait.value;
      if (CODEX_AGENTS[agent.value]) s.wakeThread = thread.value.trim();
      return s;
    };
    return row;
  }
  function isAbsPath(v) { return /^[A-Za-z]:[\\/]/.test(v) || /^\\\\[^\\]/.test(v) || /^\//.test(v); }

  // Seats each preset starts with. simplified: one agent of yours plus the room's built-in Pi.
  function presetSeats(preset) {
    if (preset === 'simplified') return [{ seatId: 'A', role: 'lead', agent: 'codex-desktop' }, { seatId: 'P', role: 'participant', hosted: 'pi:discussion' }];
    return [{ seatId: 'A', role: 'lead', agent: 'codex-desktop' }, { seatId: 'B', role: 'executor', agent: 'claude-code' }];
  }
  function defaultSeats() {
    var box = $('seat-rows');
    clear(box);
    presetSeats($('room-preset').value).forEach(function (s) { box.appendChild(seatRow(s)); });
    app.seatsEdited = false;
    refreshAllCwds();
  }
  function refreshAllCwds() {
    var rows = $('seat-rows').children;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i]._refreshCwd) rows[i]._refreshCwd();
      if (rows[i]._refreshThread) rows[i]._refreshThread();
    }
  }
  function nextSeatId() {
    var used = {};
    var rows = $('seat-rows').children;
    for (var i = 0; i < rows.length; i++) used[rows[i]._read().seatId] = 1;
    for (var c = 65; c < 91; c++) { var id = String.fromCharCode(c); if (!used[id]) return id; }
    return 'S' + rows.length;
  }

  function renderPresetDesc() {
    var sel = $('room-preset');
    var p = (app.meta.presets || []).filter(function (x) { return x.id === sel.value; })[0];
    $('preset-desc').textContent = p ? p.desc : '';
  }

  function submitCreate(ev) {
    ev.preventDefault();
    if (!app.token) { toast('没有启动器令牌，不能建房。', 'bad'); return; }
    var id = $('room-id').value.trim();
    if (!ID_RE.test(id)) { toast('房间编号只能用字母、数字、- 和 _。', 'bad'); return; }
    var rows = $('seat-rows').children;
    var seats = [];
    for (var i = 0; i < rows.length; i++) seats.push(rows[i]._read());
    if (!seats.length) { toast('至少要有一个席位。', 'bad'); return; }
    var btn = $('btn-create');
    btn.disabled = true;
    $('create-status').textContent = '正在建房……';
    postJson('/lobby/api/create', { id: id, preset: $('room-preset').value, seats: seats }).then(function (res) {
      btn.disabled = !app.token;
      if (res.status !== 200 || !res.json.ok) {
        $('create-status').textContent = '';
        $('create-status').appendChild(h('span', { class: 'error', text: '没建成：' + errText(res) }));
        toast('没建成：' + errText(res), 'bad');
        return;
      }
      $('create-status').textContent = '';
      renderCreated(res.json);
      refreshRooms();
    }, function () { btn.disabled = !app.token; $('create-status').textContent = ''; toast('建房失败：连不上启动器。', 'bad'); });
  }

  function renderCreated(r) {
    var box = $('created');
    clear(box);
    var room = { id: r.id, seats: r.seats, openedHere: false };
    var openBtn = h('button', { type: 'button', class: 'primary', text: '打开房间界面', 'data-needs-token': true });
    openBtn.addEventListener('click', function () { openRoomUi(r.id, openBtn); });
    box.appendChild(h('div', { class: 'card' }, [
      h('h4', {}, ['房间 ' + r.id + ' 建好了', h('span', { class: 'badge info', text: r.preset || '无预设' })]),
      h('p', { class: 'hint', text: '房间目录：' + r.roomDir }),
      h('p', {}, ['下一步：把每张卡片里的那句话发给对应的 agent（它会读 JOIN.md 自己入席），然后打开房间界面，给任务并开始。']),
      r.roomNotes && r.roomNotes.length ? h('div', { class: 'notice warn' }, [h('b', { text: '开始之前还要解决：' }), h('ul', {}, r.roomNotes.map(function (n) { return h('li', { text: n }); }))]) : null,
    ].concat(r.seats.map(joinCard)).concat([
      h('div', { class: 'actions' }, [openBtn, h('span', { 'data-room-link': r.id })]),
      taskForm(room),
    ])));
    box.classList.remove('hidden');
    $('form-create').classList.add('hidden');
    box.appendChild(h('div', { class: 'actions' }, [h('button', { type: 'button', text: '再建一个房间', onclick: function () { box.classList.add('hidden'); $('form-create').classList.remove('hidden'); $('room-id').value = ''; defaultSeats(); } })]));
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---- boot ----
  function boot() {
    setToken(takeTokenFromFragment());
    $('token-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var v = $('token-input').value.trim().replace(/^.*#/, '').replace(/^token=/, '');
      $('token-input').value = '';
      setToken(v);
      renderRooms(true);
    });
    var tabs = document.querySelectorAll('#tabs .tab');
    for (var i = 0; i < tabs.length; i++) tabs[i].addEventListener('click', function (ev) { showView(ev.currentTarget.getAttribute('data-view')); });
    $('btn-refresh').addEventListener('click', function () { app.lastRooms = ''; refreshRooms(); });
    $('btn-goto-create').addEventListener('click', function () { showView('create'); });
    getJson('/lobby/api/meta').then(function (res) {
      if (res.status !== 200 || !res.json.ok) { toast('读启动器信息失败：' + errText(res), 'bad'); return; }
      app.meta = res.json;
      $('hdr-root').lastChild.textContent = res.json.roomsRoot;
      $('room-dir-hint').textContent = res.json.roomsRoot;
      fillSelect($('room-preset'), res.json.presets.map(function (p) { return { id: p.id, label: p.id }; }), 'implement-review');
      $('room-preset').addEventListener('change', function () {
        renderPresetDesc();
        // Untouched seat rows follow the preset (simplified brings its built-in Pi seat).
        if (!app.seatsEdited) defaultSeats();
      });
      renderPresetDesc();
      $('seat-rows').addEventListener('input', function () { app.seatsEdited = true; });
      $('seat-rows').addEventListener('change', function () { app.seatsEdited = true; });
      var d = new Date();
      var p2 = function (n) { return String(n).padStart(2, '0'); };
      $('room-id').value = 'room-' + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' + p2(d.getHours()) + p2(d.getMinutes());
      $('room-id').addEventListener('input', refreshAllCwds);
      defaultSeats();
      $('btn-add-seat').addEventListener('click', function () { var row = seatRow({ seatId: nextSeatId(), role: 'participant', agent: 'generic' }); $('seat-rows').appendChild(row); row._refreshCwd(); });
      $('btn-template').addEventListener('click', defaultSeats);
      $('form-create').addEventListener('submit', submitCreate);
      refreshRooms();
    }, function () { toast('连不上启动器。', 'bad'); });
    app.pollTimer = setInterval(function () { if (app.view === 'rooms' && !document.hidden) refreshRooms(); }, 3000);
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }
})();
