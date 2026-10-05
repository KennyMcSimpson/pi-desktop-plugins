/* ui/app.js - room-dev browser UI. Plain ES2020 classic script, no build step, no framework.
 *
 * Data flow
 *   GET /api/state            every 2 s   -> base reducer state (INTERFACES section 4 / 8)
 *   GET /api/events?since=N   every 2 s   -> event tail; folded client side into `derived` (RoomUI.derive)
 *   POST /api/admin           per action  -> JSON body { token, cmd, ...params }
 *
 * The admin token is read from the URL fragment (#<token>) and kept in memory only. It is never placed
 * in a query string, a header or local storage. Every action maps to an admin command name that
 * INTERFACES names (sections 3 / 9 plus the P-1 admin commands) or that the room service implements
 * (lib/service.mjs ADMIN_COMMANDS: approve-disclose, deny-disclose, accept-stale, retry); see ACTIONS.
 * Verdicts show whether they came from the producer's resolved reviewer (authorized); only those
 * count, and 已验证 comes from summary_published.verified. A wake_pushed with `refused` pushed nothing
 * and is shown as 需用户唤醒, outside the wake counts. state.awaitingDecision (a governed room waiting
 * after a seat's turn ran out) is offered as retry / skip / reassign in the recovery view.
 * UI actions with no command anywhere (change cap, merge, seat package regenerate/revoke) are rendered
 * disabled with the reason, not faked. test/ui.test.mjs enforces this.
 *
 * Event field names follow INTERFACES section 4, except where INTERFACES writes `seq` for a message seq
 * that would collide with the event's own envelope `seq`: the service emits `quotedSeq` on
 * quote_submitted (the fold reads `quotedSeq` / `aboutSeq` first and falls back to `seq`) and `msgSeq`
 * on user_message_queued (the fold reads only `msgSeq`; the envelope seq is shown as the event number).
 *
 * Everything under `RoomUI` is DOM-free so it can be loaded in node (vm) by test/ui.test.mjs. The
 * browser boot runs only when a `document` exists. Missing data renders as 未知, never as a guess.
 */
(function () {
  'use strict';

  var UNKNOWN = '未知';

  // ---------------------------------------------------------------------------------------------
  // Pure helpers
  // ---------------------------------------------------------------------------------------------
  function isObj(v) { return v !== null && typeof v === 'object'; }
  function u(v) { return v === null || v === undefined || v === '' ? UNKNOWN : String(v); }
  function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
  function shortSha(s) { return typeof s === 'string' && s.length > 16 ? s.slice(0, 16) : u(s); }
  function fmtTs(ts) {
    if (!ts) return UNKNOWN;
    var d = new Date(ts);
    if (Number.isNaN(d.getTime())) return String(ts);
    var p = function (n) { return String(n).padStart(2, '0'); };
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function fmtArgv(argv) {
    if (!Array.isArray(argv)) return UNKNOWN;
    return argv.map(String).join(' ');
  }
  function fmtBytes(n) {
    n = num(n);
    if (n === null) return UNKNOWN;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  // /api/state may be the state itself or { state, room }. Room config may also sit inside the state.
  function unwrapState(payload) {
    if (!isObj(payload)) return { state: {}, room: null };
    var state = isObj(payload.state) ? payload.state : payload;
    var room = isObj(payload.room) ? payload.room : (isObj(state.room) ? state.room : (isObj(state.config) ? state.config : null));
    return { state: state, room: room };
  }
  // /api/events may be an array or { events | items | rows: [...] }.
  function unwrapEvents(payload) {
    if (Array.isArray(payload)) return payload;
    if (!isObj(payload)) return [];
    var arr = payload.events || payload.items || payload.rows;
    return Array.isArray(arr) ? arr : [];
  }

  // ---------------------------------------------------------------------------------------------
  // Event folding (client-side derived model over INTERFACES section 4 event types)
  // ---------------------------------------------------------------------------------------------
  var RECEIPT_BY_AUDIT = { present_in_native: 'present', header_only: 'header_only', unknown: 'unknown' };
  var TERMINAL = { submitted: 1, failed: 1, canceled: 1, expired: 1, work_partial: 1 };

  function emptyDerived() {
    return {
      lastSeq: 0,
      epoch: null,
      roundId: null,
      phase: null,
      roundKey: 0,                 // bumps on round_started / round_reopened; wakes count per key
      seatStatus: {},              // seatId -> { status, ts }
      task: null,                  // { text, sha256, ts }
      taskDraft: null,             // { seatId, attemptId, draft, ts, seq }
      taskConfirmed: null,         // { assignments, ts }
      phases: [],                  // phase_changed
      messages: {},                // msgSeq -> { seq, seatId, role, text, attemptId, ts, escaped }
      stream: [],                  // ordered stream entries { seq, ts, kind, ... }
      attempts: {},                // attemptId -> { attemptId, seatId, packetId, roundId, issuedAt, terminal, class, deadline }
      packets: {},                 // packetId -> { packetId, seatId, attemptId, ts, bytes, sha256, receipt, auditTs, superseded }
      attemptPacket: {},           // attemptId -> packetId
      artifacts: {},               // manifestSha -> { ... frozen fields, recomputed, staleAccepted, verdicts: [] }
      verdicts: [],                // verdict_recorded
      disclosures: {},             // id -> { id, seatId, attemptId, argv, reason, status, by, denyReason, exec }
      items: {},                   // itemId -> { itemId, seatId, attemptId, aboutSeq, text, mark }
      quotes: [],                  // quote_submitted
      misquoted: [],               // misquoted_declared
      summaries: [],               // summary_published
      supersededNotices: [],       // superseded_notice
      reversals: [],               // direction_reversed
      reconcile: {},               // attemptId -> { attemptId, seatId, status: 'needs_reconcile'|'reconciled', action, ts }
      userMessages: [],            // user_message_queued
      reopened: [],                // round_reopened
      failures: [],                // seat_failed
      usage: {},                   // seatId -> { attempts: { attemptId -> { input, output, cached, known, source } }, sources: {} }
      wakes: [],                   // wake_pushed that pushed { seatId, attemptId, ok, by, detail, ts, roundKey }
      wakeRefusals: [],            // wake_pushed with refused (nothing pushed; 需用户唤醒)
      noArtifact: [],              // work_no_artifact
      audits: [],                  // audit_observed
      rejected: [],                // submission_rejected
      skips: [],
      farewells: [],
      workPartial: [],
      counts: {}                   // event type -> count
    };
  }

  function pushStream(d, ev, entry) {
    entry.seq = ev.seq;
    entry.ts = ev.ts;
    d.stream.push(entry);
  }
  function ensureArtifact(d, sha) {
    if (!sha) return null;
    if (!d.artifacts[sha]) d.artifacts[sha] = { manifestSha: sha, verdicts: [], recomputed: null, staleAccepted: null };
    return d.artifacts[sha];
  }
  function markTerminal(d, attemptId, terminal, extra) {
    if (!attemptId) return;
    if (!d.attempts[attemptId]) d.attempts[attemptId] = { attemptId: attemptId, seatId: extra && extra.seatId || null };
    var a = d.attempts[attemptId];
    if (!a.terminal) { a.terminal = terminal; if (extra) Object.assign(a, extra); }
  }

  function fold(d, ev) {
    if (!isObj(ev) || typeof ev.type !== 'string') return d;
    if (num(ev.seq) !== null && ev.seq > d.lastSeq) d.lastSeq = ev.seq;
    d.counts[ev.type] = (d.counts[ev.type] || 0) + 1;
    switch (ev.type) {
      case 'seat_joined': d.seatStatus[ev.seatId] = { status: 'joined', ts: ev.ts }; break;
      case 'seat_left': d.seatStatus[ev.seatId] = { status: 'left', ts: ev.ts }; pushStream(d, ev, { kind: 'marker', tone: 'warn', text: '席位 ' + u(ev.seatId) + ' 退席' }); break;
      case 'task_set': d.task = { text: ev.text, sha256: ev.sha256, ts: ev.ts }; pushStream(d, ev, { kind: 'marker', tone: 'info', text: '用户任务已设置（sha ' + shortSha(ev.sha256) + '）' }); break;
      case 'round_started':
        d.roundId = num(ev.roundId); if (num(ev.epoch) !== null) d.epoch = ev.epoch; d.roundKey += 1;
        pushStream(d, ev, { kind: 'marker', tone: 'info', text: '第 ' + u(ev.roundId) + ' 轮开始，顺序 ' + (Array.isArray(ev.order) ? ev.order.join(',') : UNKNOWN) });
        break;
      case 'phase_changed': d.phase = ev.to; d.phases.push({ from: ev.from, to: ev.to, roundId: ev.roundId, ts: ev.ts }); pushStream(d, ev, { kind: 'marker', tone: 'info', text: '阶段 ' + u(ev.from) + ' → ' + u(ev.to) }); break;
      case 'packet_issued': {
        d.attempts[ev.attemptId] = Object.assign(d.attempts[ev.attemptId] || {}, { attemptId: ev.attemptId, seatId: ev.seatId, packetId: ev.packetId, issuedAt: ev.ts, deadline: ev.deadline, roundId: ev.roundId !== undefined ? ev.roundId : d.roundId, terminal: (d.attempts[ev.attemptId] || {}).terminal || null });
        // an earlier packet for the same seat is superseded by this one (receipt state machine, plan 7.2)
        Object.keys(d.packets).forEach(function (pid) { if (d.packets[pid].seatId === ev.seatId && !d.packets[pid].superseded) d.packets[pid].superseded = ev.packetId; });
        d.packets[ev.packetId] = { packetId: ev.packetId, seatId: ev.seatId, attemptId: ev.attemptId, ts: ev.ts, bytes: ev.bytes, sha256: ev.sha256, receipt: 'sent', auditTs: null, superseded: null };
        d.attemptPacket[ev.attemptId] = ev.packetId;
        break;
      }
      case 'packet_resent': {
        if (d.packets[ev.packetId]) Object.assign(d.packets[ev.packetId], { bytes: ev.bytes, sha256: ev.sha256, resend: ev.resend, resentAt: ev.ts });
        pushStream(d, ev, { kind: 'marker', tone: 'info', text: '包 ' + u(ev.packetId) + ' 回执未知，已重发（第 ' + u(ev.resend) + ' 次，附「若已收到请忽略」）' });
        break;
      }
      case 'submission_accepted': {
        var m = { seq: ev.msgSeq, seatId: ev.seatId, role: ev.role, text: ev.text, attemptId: ev.attemptId, ts: ev.ts, escaped: ev.escaped, sha256: ev.sha256, authority: 'none', annotation: ev.annotation || null, malformed: ev.malformed || null };
        if (num(ev.msgSeq) !== null) d.messages[ev.msgSeq] = m;
        markTerminal(d, ev.attemptId, 'submitted', { seatId: ev.seatId });
        pushStream(d, ev, { kind: 'message', msg: m });
        break;
      }
      case 'submission_rejected': d.rejected.push({ seatId: ev.seatId, attemptId: ev.attemptId, reason: ev.reason, ts: ev.ts }); pushStream(d, ev, { kind: 'marker', tone: 'warn', text: '席位 ' + u(ev.seatId) + ' 的提交被拒绝：' + u(ev.reason) }); break;
      case 'attempt_canceled': markTerminal(d, ev.attemptId, 'canceled', { seatId: ev.seatId, by: ev.by }); pushStream(d, ev, { kind: 'marker', tone: 'warn', text: '席位 ' + u(ev.seatId) + ' 的 attempt ' + u(ev.attemptId) + ' 已取消（' + u(ev.by) + '）' }); break;
      case 'attempt_expired': markTerminal(d, ev.attemptId, 'expired', { seatId: ev.seatId }); pushStream(d, ev, { kind: 'marker', tone: 'bad', text: '席位 ' + u(ev.seatId) + ' 的 attempt ' + u(ev.attemptId) + ' 超时未交卷' + (ev.hold ? '；房间等用户决定：重试 / 跳过 / 改派' : '') }); break;
      case 'seat_skipped': d.skips.push({ seatId: ev.seatId, attemptId: ev.attemptId, by: ev.by, ts: ev.ts }); if (ev.attemptId) markTerminal(d, ev.attemptId, 'canceled', { seatId: ev.seatId, by: 'skip' }); pushStream(d, ev, { kind: 'marker', tone: 'warn', text: '席位 ' + u(ev.seatId) + ' 被跳过（' + u(ev.by) + '）' }); break;
      case 'epoch_bumped': if (num(ev.epoch) !== null) d.epoch = ev.epoch; break;
      case 'round_done': pushStream(d, ev, { kind: 'marker', tone: 'info', text: '第 ' + u(ev.roundId) + ' 轮结束' }); break;
      case 'room_closed': d.phase = 'closed'; pushStream(d, ev, { kind: 'marker', tone: 'info', text: '房间已关闭' }); break;
      case 'wake_pushed': {
        var ok = ev.command_ok !== undefined ? ev.command_ok : ev.ok;
        // A refused wake (THREAD_BUSY / IDLE_UNKNOWN) pushed nothing: it is not a push and does not
        // count toward W; the seat needs the user to wake it (需用户唤醒).
        if (ev.refused) {
          d.wakeRefusals.push({ seatId: ev.seatId, attemptId: ev.attemptId, refused: ev.refused, detail: ev.detail, ts: ev.ts, roundKey: d.roundKey });
          pushStream(d, ev, { kind: 'marker', tone: 'warn', text: '席位 ' + u(ev.seatId) + ' 未推送唤醒（' + u(ev.refused) + '）：需用户唤醒' });
          break;
        }
        d.wakes.push({ seatId: ev.seatId, attemptId: ev.attemptId, ok: ok, by: ev.by, detail: ev.detail, ts: ev.ts, roundKey: d.roundKey });
        break;
      }
      case 'work_no_artifact':
        d.noArtifact.push({ seatId: ev.seatId, attemptId: ev.attemptId, roundId: ev.roundId, reason: ev.reason, manifestSha: ev.manifestSha || null, ts: ev.ts });
        pushStream(d, ev, { kind: 'marker', tone: 'bad', text: '席位 ' + u(ev.seatId) + ' 声称 Work 完成但' + (ev.reason === 'empty' ? '冻结的产物集为空' : '本轮没有冻结产物') + '：记 no_artifact' });
        break;
      case 'task_drafted': d.taskDraft = { seatId: ev.seatId, attemptId: ev.attemptId, draft: ev.draft, ts: ev.ts, seq: ev.seq }; d.taskConfirmed = null; pushStream(d, ev, { kind: 'marker', tone: 'info', text: '主力 ' + u(ev.seatId) + ' 起草了任务单，等待确认' }); break;
      case 'task_confirmed': d.taskConfirmed = { assignments: ev.assignments, by: ev.by, ts: ev.ts }; pushStream(d, ev, { kind: 'marker', tone: 'ok', text: '任务单已确认' }); break;
      case 'work_started': pushStream(d, ev, { kind: 'marker', tone: 'info', text: '执行阶段开始：' + (Array.isArray(ev.seats) ? ev.seats.join(',') : UNKNOWN) }); break;
      case 'work_partial': d.workPartial.push({ roundId: ev.roundId, seatId: ev.seatId, attemptId: ev.attemptId, ts: ev.ts }); markTerminal(d, ev.attemptId, 'work_partial', { seatId: ev.seatId }); pushStream(d, ev, { kind: 'marker', tone: 'warn', text: '席位 ' + u(ev.seatId) + ' 执行超时，记 work_partial' }); break;
      case 'artifacts_frozen': {
        var art = ensureArtifact(d, ev.manifestSha);
        if (art) Object.assign(art, { seatId: ev.seatId, roundId: ev.roundId, baseline: ev.baseline, fileCount: ev.fileCount, bytes: ev.bytes, excluded: ev.excluded, copyTorn: ev.copyTorn, frozenAt: ev.ts });
        break;
      }
      case 'artifacts_recomputed': {
        var art2 = ensureArtifact(d, ev.manifestSha);
        if (art2) { if (!art2.seatId) art2.seatId = ev.seatId; art2.recomputed = { changed: Array.isArray(ev.changed) ? ev.changed : [], stale: !!ev.stale, ts: ev.ts }; }
        if (ev.stale) pushStream(d, ev, { kind: 'marker', tone: 'warn', text: '产物 ' + shortSha(ev.manifestSha) + ' 复算后已过期（stale），汇总不含' });
        break;
      }
      case 'stale_accepted': { var art3 = ensureArtifact(d, ev.manifestSha); if (art3) art3.staleAccepted = { by: ev.by, changed: ev.changed, ts: ev.ts }; break; }
      case 'point_added': d.items[ev.itemId] = { itemId: ev.itemId, seatId: ev.seatId, attemptId: ev.attemptId, aboutSeq: ev.aboutSeq, text: ev.text, mark: null, ts: ev.ts }; break;
      case 'quote_submitted': {
        var qSeq = num(ev.quotedSeq) !== null ? ev.quotedSeq : (num(ev.aboutSeq) !== null ? ev.aboutSeq : ev.seq);
        d.quotes.push({ seatId: ev.seatId, attemptId: ev.attemptId, seq: qSeq, text: ev.text, verified: typeof ev.verified === 'boolean' ? ev.verified : null, ts: ev.ts });
        break;
      }
      case 'item_marked': { if (!d.items[ev.itemId]) d.items[ev.itemId] = { itemId: ev.itemId, mark: null }; d.items[ev.itemId].mark = { by: ev.by, status: ev.status, text: ev.text, ts: ev.ts }; break; }
      case 'misquoted_declared': d.misquoted.push({ seatId: ev.seatId, aboutSeq: ev.aboutSeq, text: ev.text, ts: ev.ts }); pushStream(d, ev, { kind: 'marker', tone: 'warn', text: '席位 ' + u(ev.seatId) + ' 声明 seq ' + u(ev.aboutSeq) + ' 误述了它' }); break;
      case 'verdict_recorded': {
        // authorized: the verdict came from the producer's resolved reviewer (only those bind);
        // tainted / annotations: the full annotation list, so a taint is never hidden by another mark.
        var v = {
          seatId: ev.seatId, attemptId: ev.attemptId, artifactSha: ev.artifactSha, verdict: ev.verdict, annotation: ev.annotation, evidence: ev.evidence, ts: ev.ts, seq: ev.seq,
          authorized: typeof ev.authorized === 'boolean' ? ev.authorized : null, tainted: !!ev.tainted || (Array.isArray(ev.annotations) && ev.annotations.indexOf('tainted') !== -1),
          annotations: Array.isArray(ev.annotations) ? ev.annotations.slice() : (ev.annotation ? [ev.annotation] : []), producer: ev.producer || null
        };
        d.verdicts.push(v);
        var art4 = ensureArtifact(d, ev.artifactSha); if (art4) art4.verdicts.push(v);
        break;
      }
      case 'disclose_requested': d.disclosures[ev.id] = { id: ev.id, seatId: ev.seatId, attemptId: ev.attemptId, argv: ev.argv, reason: ev.reason, status: 'requested', ts: ev.ts }; break;
      case 'disclose_approved': if (d.disclosures[ev.id]) { d.disclosures[ev.id].status = 'approved'; d.disclosures[ev.id].by = ev.by; } break;
      case 'disclose_denied': if (d.disclosures[ev.id]) { d.disclosures[ev.id].status = 'denied'; d.disclosures[ev.id].by = ev.by; d.disclosures[ev.id].denyReason = ev.reason; } break;
      case 'disclose_executed': if (d.disclosures[ev.id]) { d.disclosures[ev.id].status = 'executed'; d.disclosures[ev.id].exec = { manifestSha: ev.manifestSha, exitCode: ev.exitCode, outputSha256: ev.outputSha256, truncated: ev.truncated, privatePath: ev.privatePath, ts: ev.ts }; } break;
      case 'summary_published': {
        var s = {
          version: ev.version, seatId: ev.seatId, attemptId: ev.attemptId, unanswered: Array.isArray(ev.unanswered) ? ev.unanswered : [], supersedes: ev.supersedes === undefined ? null : ev.supersedes, ts: ev.ts, seq: ev.seq,
          verdicts: Array.isArray(ev.verdicts) ? ev.verdicts : [], excluded: Array.isArray(ev.excluded) ? ev.excluded : [],
          verified: Array.isArray(ev.verified) ? ev.verified : null, absent: Array.isArray(ev.absent) ? ev.absent : [], noArtifact: Array.isArray(ev.noArtifact) ? ev.noArtifact : []
        };
        d.summaries.push(s);
        pushStream(d, ev, { kind: 'summary', summary: s });
        break;
      }
      case 'superseded_notice': d.supersededNotices.push({ forSeat: ev.forSeat, oldVersion: ev.oldVersion, newVersion: ev.newVersion, packetId: ev.packetId, ts: ev.ts }); pushStream(d, ev, { kind: 'marker', tone: 'info', text: '取代通知 → 席位 ' + u(ev.forSeat) + '：汇总 v' + u(ev.oldVersion) + ' 已被 v' + u(ev.newVersion) + ' 取代（随包 ' + u(ev.packetId) + '）' }); break;
      case 'direction_reversed': if (num(ev.epoch) !== null) d.epoch = ev.epoch; d.reversals.push({ epoch: ev.epoch, before: ev.before, after: ev.after, ts: ev.ts }); pushStream(d, ev, { kind: 'marker', tone: 'info', text: '整体换向：epoch ' + u(ev.epoch) }); break;
      case 'needs_reconcile': d.reconcile[ev.attemptId] = { attemptId: ev.attemptId, seatId: ev.seatId, status: 'needs_reconcile', ts: ev.ts }; pushStream(d, ev, { kind: 'marker', tone: 'bad', text: '服务重启后发现未决 attempt ' + u(ev.attemptId) + '（席位 ' + u(ev.seatId) + '），待用户 reconcile' }); break;
      case 'reconciled': { var r = d.reconcile[ev.attemptId] || { attemptId: ev.attemptId }; r.status = 'reconciled'; r.action = ev.action; r.reconciledAt = ev.ts; d.reconcile[ev.attemptId] = r; if (ev.action === 'void') markTerminal(d, ev.attemptId, 'canceled', { by: 'void' }); pushStream(d, ev, { kind: 'marker', tone: 'info', text: 'attempt ' + u(ev.attemptId) + ' 已处理：' + (ev.action === 'replay' ? '重放' : ev.action === 'void' ? '作废' : u(ev.action)) }); break; }
      case 'user_message_queued': {
        // The message seq (what packets and `--seq N` use) is `msgSeq`; `ev.seq` is the event's own
        // envelope seq and is never shown as the message seq. Missing msgSeq renders as 未知.
        var umSeq = num(ev.msgSeq) !== null ? ev.msgSeq : null;
        d.userMessages.push({ seq: umSeq, eventSeq: ev.seq, text: ev.text, ts: ev.ts });
        pushStream(d, ev, { kind: 'user', text: ev.text, msgSeq: umSeq });
        break;
      }
      case 'round_reopened': if (num(ev.epoch) !== null) d.epoch = ev.epoch; d.roundKey += 1; d.reopened.push({ epoch: ev.epoch, supersededSeqs: ev.supersededSeqs, ts: ev.ts }); pushStream(d, ev, { kind: 'marker', tone: 'warn', text: '本轮已重开：epoch ' + u(ev.epoch) + '，作废 seq ' + (Array.isArray(ev.supersededSeqs) && ev.supersededSeqs.length ? ev.supersededSeqs.join(',') : '（无）') }); break;
      case 'seat_failed': d.failures.push({ seatId: ev.seatId, attemptId: ev.attemptId, class: ev.class, detail: ev.detail, ts: ev.ts }); markTerminal(d, ev.attemptId, 'failed', { seatId: ev.seatId, class: ev.class }); pushStream(d, ev, { kind: 'marker', tone: 'bad', text: '席位 ' + u(ev.seatId) + ' 失败：failed(' + u(ev.class) + ')' + (ev.detail ? ' · ' + ev.detail : '') }); break;
      case 'usage_reported': {
        // Same rule as lib/usage.mjs: a report is known only when input and output are both numbers;
        // unknown is never summed as 0; a later report for the same attempt replaces the earlier one.
        var sid = ev.seatId === undefined || ev.seatId === null ? 'unknown' : String(ev.seatId);
        var us = d.usage[sid] || (d.usage[sid] = { attempts: {}, sources: {} });
        var knownRep = num(ev.input) !== null && num(ev.output) !== null && ev.input >= 0 && ev.output >= 0;
        us.attempts[ev.attemptId ? String(ev.attemptId) : 'anon-' + u(ev.seq)] = { input: knownRep ? ev.input : null, output: knownRep ? ev.output : null, cached: knownRep && num(ev.cached) !== null ? ev.cached : null, known: knownRep, source: ev.source || null };
        if (ev.source) us.sources[ev.source] = (us.sources[ev.source] || 0) + 1;
        break;
      }
      case 'farewell_issued': d.farewells.push({ packetId: ev.packetId, seats: ev.seats, ts: ev.ts }); pushStream(d, ev, { kind: 'marker', tone: 'info', text: '散会声明已发：' + (Array.isArray(ev.seats) ? ev.seats.join(',') : UNKNOWN) }); break;
      case 'audit_observed': {
        var a = { seatId: ev.seatId, attemptId: ev.attemptId, status: ev.status, writes: Array.isArray(ev.writes) ? ev.writes : [], unknownCommands: Array.isArray(ev.unknownCommands) ? ev.unknownCommands : [], opened: Array.isArray(ev.opened) ? ev.opened : [], tainted: !!ev.tainted, ts: ev.ts };
        d.audits.push(a);
        var pid = d.attemptPacket[ev.attemptId];
        if (pid && d.packets[pid]) { d.packets[pid].receipt = RECEIPT_BY_AUDIT[ev.status] || 'unknown'; d.packets[pid].auditTs = ev.ts; }
        if (a.tainted) pushStream(d, ev, { kind: 'marker', tone: 'bad', text: '审计：席位 ' + u(ev.seatId) + ' 在回合 ' + u(ev.attemptId) + ' 里观测到写操作，标 tainted' });
        break;
      }
      default: break;
    }
    return d;
  }

  function derive(events) {
    var d = emptyDerived();
    (Array.isArray(events) ? events : []).forEach(function (ev) { fold(d, ev); });
    return d;
  }

  // ---------------------------------------------------------------------------------------------
  // View-model helpers (pure)
  // ---------------------------------------------------------------------------------------------
  function seatList(state, room, d) {
    var cfg = (room && Array.isArray(room.seats)) ? room.seats : (Array.isArray(state.seatConfigs) ? state.seatConfigs : []);
    var byId = {};
    cfg.forEach(function (s) { if (s && s.seatId) byId[s.seatId] = Object.assign({}, s); });
    var ids = Object.keys(byId);
    var extra = [].concat(Object.keys(isObj(state.seats) ? state.seats : {}), Object.keys(d.seatStatus), Array.isArray(state.order) ? state.order : []);
    extra.forEach(function (id) { if (id && !byId[id]) { byId[id] = { seatId: id }; ids.push(id); } });
    return ids.map(function (id) {
      var s = byId[id];
      var st = (isObj(state.seats) && isObj(state.seats[id])) ? state.seats[id] : {};
      var ds = d.seatStatus[id] || {};
      s.status = st.status || ds.status || null;
      s.retained = st.retained !== undefined ? st.retained : (s.retained !== undefined ? s.retained : null);
      s.isCurrent = state.currentSeat === id || (isObj(state.attempt) && state.attempt.seatId === id);
      return s;
    });
  }
  function seatForm(seat) { return isObj(seat.hosted) ? '托管' : (seat.hosted === null || seat.audit !== undefined || seat.cwd ? '嵌入式' : UNKNOWN); }
  // room.json records the agent kind given at add-seat (--agent); hosted seats name their runtime.
  function seatAgent(seat) {
    if (isObj(seat.hosted)) return u(seat.hosted.kind) + (seat.hosted.tier ? '/' + seat.hosted.tier : '');
    if (typeof seat.agent === 'string' && seat.agent) return seat.agent;
    if (isObj(seat.audit) && seat.audit.kind) return seat.audit.kind;
    return UNKNOWN;
  }
  function auditSource(seat) {
    if (!isObj(seat.audit)) return seat.audit === null ? '未登记' : UNKNOWN;
    var id = seat.audit.threadId || seat.audit.sessionId;
    return u(seat.audit.kind) + (id ? ' ' + id : ' （线程/会话未登记）');
  }
  function lastAuditFor(d, seatId) {
    for (var i = d.audits.length - 1; i >= 0; i--) if (d.audits[i].seatId === seatId) return d.audits[i];
    return null;
  }
  // Observation text: never "read-only", only "not observed".
  function auditObservation(seat, d) {
    var a = lastAuditFor(d, seat.seatId);
    if (!a) return { text: '未审计', tone: 'warn' };
    if (a.tainted) return { text: 'tainted（观测到 ' + a.writes.length + ' 次写、' + a.unknownCommands.length + ' 条未知命令）', tone: 'bad' };
    if (a.status === 'unknown') return { text: '未审计（日志未找到）', tone: 'warn' };
    if (a.writes.length) return { text: '观测到 ' + a.writes.length + ' 次写、' + a.unknownCommands.length + ' 条未知命令（非审查回合，不标 tainted）', tone: 'info' };
    if (a.unknownCommands.length) return { text: '未观测到写操作；' + a.unknownCommands.length + ' 条未知命令无法归类', tone: 'warn' };
    return { text: '在该方法下未观测到写操作', tone: 'ok' };
  }
  function wakesThisRound(d, seatId) { return d.wakes.filter(function (w) { return w.seatId === seatId && w.roundKey === d.roundKey; }).length; }
  function wakesTotal(d, seatId) { return d.wakes.filter(function (w) { return w.seatId === seatId; }).length; }

  function latestSummary(d) { return d.summaries.length ? d.summaries[d.summaries.length - 1] : null; }
  // 已验证 / 未验证 for one artifact, from the latest summary that lists it (summary_published.verified,
  // computed by the service from the resolved reviewer's binding verdict). null when no summary says.
  function verifiedFor(d, sha) {
    for (var i = d.summaries.length - 1; i >= 0; i--) {
      var list = d.summaries[i].verified;
      if (!Array.isArray(list)) continue;
      for (var j = 0; j < list.length; j++) if (list[j] && list[j].artifactSha === sha) return list[j];
    }
    return null;
  }
  // The seat whose turn ran out and now waits for the user (state.awaitingDecision), or null.
  function awaitingDecision(state) {
    var g = isObj(state) && isObj(state.awaitingDecision) ? state.awaitingDecision : null;
    return g && g.seatId ? g : null;
  }
  function wakeRefusalsFor(d, seatId) { return d.wakeRefusals.filter(function (w) { return w.seatId === seatId; }); }
  function itemStatus(item, d) {
    if (item.mark && item.mark.status) return item.mark.status;
    var s = latestSummary(d);
    if (s && s.unanswered.indexOf(item.itemId) !== -1) return 'unanswered';
    // A summary came after the item, yet the item is neither marked nor listed as unanswered: the
    // page is missing an event. Say so instead of guessing.
    if (s && item.ts && s.ts && item.ts <= s.ts) return 'unknown';
    return 'pending';
  }
  function itemMisquoted(item, d) { return d.misquoted.some(function (m) { return num(item.aboutSeq) !== null && m.aboutSeq === item.aboutSeq; }); }

  function attemptsNeedingReconcile(d, state) {
    var rows = Object.keys(d.reconcile).map(function (k) { return d.reconcile[k]; }).filter(function (r) { return r.status === 'needs_reconcile'; });
    var extra = Array.isArray(state.needsReconcile) ? state.needsReconcile : (isObj(state.reconcile) && Array.isArray(state.reconcile.pending) ? state.reconcile.pending : []);
    extra.forEach(function (x) { var id = isObj(x) ? x.attemptId : x; if (id && !d.reconcile[id]) rows.push({ attemptId: id, seatId: isObj(x) ? x.seatId : null, status: 'needs_reconcile' }); });
    return rows;
  }
  function sideEffectHint(row, d, seats) {
    var a = d.attempts[row.attemptId] || {};
    var seat = seats.filter(function (s) { return s.seatId === (row.seatId || a.seatId); })[0] || {};
    var art = Object.keys(d.artifacts).map(function (k) { return d.artifacts[k]; }).filter(function (x) { return x.seatId === seat.seatId && x.recomputed && x.recomputed.changed.length; });
    var hint = seat.role === 'executor' || (d.phase === 'work') ? '该席位可能已经改过文件；房间不替任何席位重做任何事，请去那个 agent 里自己处理。' : '非执行回合；副作用未知。';
    return { hint: hint, changed: art.length ? art[0].recomputed.changed : [] };
  }

  function mergeConflicts(state, d) {
    var fromState = Array.isArray(state.conflicts) ? state.conflicts : (isObj(state.merge) && Array.isArray(state.merge.conflicts) ? state.merge.conflicts : null);
    if (fromState) return fromState.map(function (c) { return { path: c.path, seats: c.seats, manifests: c.manifests, detail: c.detail || c.reason || null, source: 'state' }; });
    // Fallback: the same path changed under manifests of two different seats.
    var byPath = {};
    Object.keys(d.artifacts).forEach(function (sha) {
      var art = d.artifacts[sha];
      if (!art.recomputed) return;
      art.recomputed.changed.forEach(function (ch) {
        if (!ch || !ch.path) return;
        var row = byPath[ch.path] || (byPath[ch.path] = { path: ch.path, seats: [], manifests: [], source: 'derived' });
        if (row.seats.indexOf(art.seatId) === -1) row.seats.push(art.seatId);
        row.manifests.push({ manifestSha: sha, from: ch.from, to: ch.to });
      });
    });
    return Object.keys(byPath).map(function (p) { return byPath[p]; }).filter(function (r) { return r.seats.length >= 2; });
  }

  function receiptRows(d) {
    return Object.keys(d.packets).map(function (k) { return d.packets[k]; }).sort(function (a, b) { return (a.ts || '') < (b.ts || '') ? 1 : -1; });
  }

  // Per-seat usage. Event fold first; otherwise the service state in the lib/usage.mjs shape
  // (state.usage.bySeat[seatId] = { input, output, cached, knownReports, unknownReports }).
  // Returns null when nothing is known about the seat at all.
  function seatUsage(state, d, seatId) {
    var ev = d.usage[seatId];
    if (ev) {
      var r = { input: null, output: null, cached: null, knownReports: 0, unknownReports: 0, sources: Object.keys(ev.sources) };
      Object.keys(ev.attempts).sort().forEach(function (k) {
        var a = ev.attempts[k];
        if (!a.known) { r.unknownReports += 1; return; }
        r.knownReports += 1;
        r.input = (r.input || 0) + a.input; r.output = (r.output || 0) + a.output;
        if (a.cached !== null) r.cached = (r.cached || 0) + a.cached;
      });
      return r;
    }
    var us = isObj(state) && isObj(state.usage) ? state.usage : null;
    var row = us && isObj(us.bySeat) && isObj(us.bySeat[seatId]) ? us.bySeat[seatId] : (us && isObj(us.seats) && isObj(us.seats[seatId]) ? us.seats[seatId] : null);
    if (!row) return null;
    return {
      input: num(row.input), output: num(row.output), cached: num(row.cached),
      knownReports: num(row.knownReports) !== null ? row.knownReports : null,
      unknownReports: num(row.unknownReports) !== null ? row.unknownReports : null,
      sources: Array.isArray(row.sources) ? row.sources : (row.source ? [row.source] : [])
    };
  }

  // Room-level usage: known tokens (null = nothing known), the cap and the paused verdict.
  // paused comes from the service when it says so; otherwise it is computed exactly like
  // lib/usage.mjs budgetStatus (known tokens >= cap); without a cap or known usage it stays null/false.
  function usageSummary(state, room, d) {
    state = isObj(state) ? state : {};
    var us = isObj(state.usage) ? state.usage : {};
    var budget = isObj(state.budget) ? state.budget : (room && isObj(room.budget) ? room.budget : {});
    var maxTokens = num(us.maxTokens) !== null ? us.maxTokens : (budget.maxTokens === null ? null : num(budget.maxTokens));
    var capKnown = num(us.maxTokens) !== null || budget.maxTokens === null || num(budget.maxTokens) !== null;
    var known = null, unknownReports = 0;
    var seatIds = Object.keys(d.usage);
    if (seatIds.length) {
      seatIds.forEach(function (sid) {
        var r = seatUsage(state, d, sid);
        if (r.input !== null && r.output !== null) known = (known || 0) + r.input + r.output;
        unknownReports += r.unknownReports;
      });
    } else if (isObj(us.totals)) {
      known = num(us.totals.tokens) !== null ? us.totals.tokens : (num(us.totals.input) !== null && num(us.totals.output) !== null ? us.totals.input + us.totals.output : null);
      unknownReports = num(us.totals.unknownReports) || 0;
    }
    var paused = null;
    if (typeof us.paused === 'boolean') paused = us.paused;
    else if (typeof state.paused === 'boolean') paused = state.paused;
    else if (isObj(state.budgetStatus) && typeof state.budgetStatus.paused === 'boolean') paused = state.budgetStatus.paused;
    else if (capKnown && (maxTokens === null || maxTokens <= 0)) paused = false;
    else if (maxTokens !== null && known !== null) paused = known >= maxTokens;
    return { knownTokens: known, unknownReports: unknownReports, maxTokens: capKnown ? maxTokens : undefined, packetMaxBytes: num(budget.packetMaxBytes), paused: paused };
  }

  function projectedTurns(state) {
    if (num(state.projectedTurns) !== null) return state.projectedTurns;
    if (Array.isArray(state.order) && num(state.turnIndex) !== null) return Math.max(0, state.order.length - state.turnIndex);
    return null;
  }

  // ---------------------------------------------------------------------------------------------
  // Actions: every button maps to an admin command name. `cmd: null` = contract names no command.
  // ---------------------------------------------------------------------------------------------
  var ACTIONS = {
    'task': { cmd: 'task', label: '手填任务', build: function (p) { return { text: p.text }; }, needs: ['text'] },
    'start': { cmd: 'start', label: '继续 / 开轮', build: function (p) { return { order: String(p.order || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean) }; }, needs: ['order'] },
    'cancel': { cmd: 'cancel', label: '取消 attempt', confirm: '取消当前 attempt？该席位会在下一 tick 得到新的 attempt。' },
    'skip': { cmd: 'skip', label: '跳过', confirm: '跳过当前席位的回合？' },
    // After a seat's turn ran out in a governed room the room waits (state.awaitingDecision): retry
    // gives the same seat a fresh attempt for the same turn (room admin retry [--seat X]).
    'retry': { cmd: 'retry', label: '重试', build: function (p) { return p && p.seatId ? { seatId: p.seatId } : {}; }, confirm: '让同一席位重新领这一回合？会发一个新的 attempt。' },
    'wake': { cmd: 'wake', label: '唤醒', build: function (p) { return { seatId: p.seatId }; }, needs: ['seatId'] },
    'close': { cmd: 'close', label: '结束', confirm: '结束房间？会发散会声明包，之后席位命令得到 ROOM_CLOSED。' },
    'say': { cmd: 'say', label: '排队新消息', build: function (p) { return { text: p.text }; }, needs: ['text'] },
    'interrupt': { cmd: 'interrupt', label: '打断并重开', confirm: '打断并重开本轮？epoch 递增，当前 attempt 作废。', build: function (p) { return p.text ? { text: p.text } : {}; } },
    'confirm-task': { cmd: 'confirm-task', label: '确认任务单', confirm: '确认任务单？确认后进入执行阶段（或直接开会）。' },
    'reverse': { cmd: 'reverse', label: '整体换向', confirm: '整体换向？审方与执行者互换，epoch 递增。要求当前 attempt 已终态。' },
    'reconcile': { cmd: 'reconcile', label: '恢复', build: function (p) { return { attemptId: p.attemptId, action: p.action }; }, needs: ['attemptId', 'action'] },
    'reassign': { cmd: 'reassign', label: '改派', build: function (p) { return { seatId: p.seatId, toSeatId: p.toSeatId, text: p.text || '' }; }, needs: ['seatId', 'toSeatId'], confirm: '改派？epoch 递增，原席位的 attempt 作废。' },
    // Disclosure decisions and stale acceptance: the service implements these (lib/service.mjs
    // ADMIN_COMMANDS) with the same parameter shapes as the CLI (lib/admin.mjs): {id}, {id, reason}
    // with a non-empty reason, {manifestSha}. They emit disclose_approved / disclose_denied /
    // stale_accepted with by:'admin'.
    'approve-disclose': { cmd: 'approve-disclose', label: '批准披露', build: function (p) { return { id: p.id }; }, needs: ['id'], confirm: '批准该披露请求？服务会在冻结的产物快照里执行它申请的命令，输出只进私有层。' },
    'deny-disclose': { cmd: 'deny-disclose', label: '驳回披露', build: function (p) { return { id: p.id, reason: typeof p.reason === 'string' ? p.reason.trim() : '' }; }, needs: ['id', 'reason'], confirm: '驳回该披露请求？理由必填，会记进事件流。' },
    'accept-stale': { cmd: 'accept-stale', label: '接受 stale', build: function (p) { return { manifestSha: p.manifestSha }; }, needs: ['manifestSha'], confirm: '接受 stale？变更的文件按当前内容放行，不再要求重审。' },
    'change-cap': { cmd: null, label: '改上限', reason: '契约（INTERFACES）没有对应的 admin 命令。请停服务后改 room.json 的 budget.maxTokens 再起。' },
    'merge-apply': { cmd: null, label: '应用', reason: '契约（INTERFACES）没有对应的 admin 命令。冲突按方案 §6.8 停在这里，由用户去各自的 agent 里处理。' },
    'merge-discard': { cmd: null, label: '丢弃', reason: '契约（INTERFACES）没有对应的 admin 命令。' },
    'seat-regenerate': { cmd: null, label: '重新生成', reason: '契约（INTERFACES）没有对应的 admin 命令；席位包由终端里的 room admin add-seat 生成。' },
    'seat-revoke': { cmd: null, label: '吊销', reason: '契约（INTERFACES）没有对应的 admin 命令。' }
  };

  function buildCommand(actionKey, params) {
    var a = ACTIONS[actionKey];
    if (!a) throw new Error('unknown action ' + actionKey);
    if (!a.cmd) throw new Error(a.reason);
    var body = a.build ? a.build(params || {}) : {};
    (a.needs || []).forEach(function (k) {
      var v = body[k];
      if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) throw new Error('缺少参数 ' + k);
    });
    return Object.assign({ cmd: a.cmd }, body);
  }

  var RoomUI = {
    UNKNOWN: UNKNOWN, u: u, fmtTs: fmtTs, fmtBytes: fmtBytes, fmtArgv: fmtArgv, shortSha: shortSha,
    unwrapState: unwrapState, unwrapEvents: unwrapEvents, emptyDerived: emptyDerived, fold: fold, derive: derive,
    seatList: seatList, seatForm: seatForm, seatAgent: seatAgent, auditSource: auditSource, auditObservation: auditObservation,
    wakesThisRound: wakesThisRound, wakesTotal: wakesTotal, latestSummary: latestSummary, itemStatus: itemStatus, itemMisquoted: itemMisquoted,
    verifiedFor: verifiedFor, awaitingDecision: awaitingDecision, wakeRefusalsFor: wakeRefusalsFor,
    attemptsNeedingReconcile: attemptsNeedingReconcile, sideEffectHint: sideEffectHint, mergeConflicts: mergeConflicts, receiptRows: receiptRows,
    seatUsage: seatUsage, usageSummary: usageSummary,
    projectedTurns: projectedTurns, ACTIONS: ACTIONS, buildCommand: buildCommand, TERMINAL: TERMINAL
  };
  if (typeof globalThis !== 'undefined') globalThis.RoomUI = RoomUI;

  // ---------------------------------------------------------------------------------------------
  // Browser part
  // ---------------------------------------------------------------------------------------------
  if (typeof document === 'undefined') return;

  var POLL_MS = 2000;
  var app = {
    token: '', state: {}, room: null, derived: emptyDerived(), events: [], view: 'stream',
    online: null, lastRender: '', timer: null, inflight: false
  };

  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) appendChildren(el, arguments[i]);
    return el;
  }
  function appendChildren(el, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { appendChildren(el, x); }); return; }
    el.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
  }
  function badge(text, tone) { return h('span', { class: 'badge' + (tone ? ' ' + tone : ''), text: text }); }
  function kv(pairs) {
    var dl = h('dl', { class: 'kv' });
    pairs.forEach(function (p) { dl.appendChild(h('dt', { text: p[0] })); dl.appendChild(h('dd', null, p[1])); });
    return dl;
  }
  function empty(text) { return h('div', { class: 'empty', text: text || '（无）' }); }
  function table(headers, rows) {
    var t = h('table', { class: 'table' });
    t.appendChild(h('thead', null, h('tr', null, headers.map(function (x) { return h('th', { text: x }); }))));
    var tb = h('tbody');
    if (!rows.length) tb.appendChild(h('tr', null, h('td', { colspan: String(headers.length) }, empty())));
    rows.forEach(function (r) { tb.appendChild(r); });
    t.appendChild(tb);
    return t;
  }
  // td(attrs?, ...children): a leading plain object (not a DOM node, not an array) is the attribute map.
  function td() {
    var args = Array.prototype.slice.call(arguments);
    var attrs = args.length && isObj(args[0]) && !args[0].nodeType && !Array.isArray(args[0]) ? args.shift() : null;
    var el = h('td', attrs);
    args.forEach(function (c) { appendChildren(el, c); });
    return el;
  }
  function toneFor(status) {
    if (['submitted', 'accepted', 'present', 'pass', 'ok', 'joined', 'approved', 'executed', 'reconciled', 'confirmed'].indexOf(status) !== -1) return 'ok';
    if (['failed', 'expired', 'reject', 'rejected', 'tainted', 'denied', 'bad', 'needs_reconcile', 'left', 'unanswered', 'malformed', 'closed'].indexOf(status) !== -1) return 'bad';
    if (['canceled', 'work_partial', 'stale', 'header_only', 'unknown', 'deferred', 'disclose', 'requested', 'paused', 'pending', 'drafted'].indexOf(status) !== -1) return 'warn';
    return 'info';
  }

  function toast(text, tone) {
    var box = document.getElementById('toasts');
    var el = h('div', { class: 'toast ' + (tone || ''), text: text });
    box.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 6000);
  }

  // ---- token ----
  function readTokenFromFragment() {
    var frag = (location.hash || '').replace(/^#/, '').trim();
    if (!frag) return '';
    // Accept "#<token>" and "#token=<token>" (never a query string).
    var m = /^token=(.+)$/.exec(frag);
    return m ? m[1] : frag;
  }
  function setToken(t) {
    app.token = t || '';
    var el = document.getElementById('hdr-token');
    el.textContent = app.token ? '令牌：已载入（内存）' : '令牌：缺失';
    el.className = 'tok ' + (app.token ? 'tok-ok' : 'tok-missing');
    document.getElementById('token-bar').classList.toggle('hidden', !!app.token);
    document.querySelectorAll('[data-action]').forEach(function (el2) {
      var key = el2.getAttribute('data-action');
      var a = ACTIONS[key];
      if (!a) return;
      var ctl = el2.tagName === 'FORM' ? el2.querySelector('button[type=submit]') : el2;
      if (!a.cmd) { ctl.disabled = true; ctl.title = a.reason; if (!el2.querySelector('.unavailable')) el2.appendChild(h('span', { class: 'unavailable', text: a.reason })); return; }
      ctl.disabled = !app.token;
      ctl.title = app.token ? ('POST /api/admin cmd=' + a.cmd) : '没有 admin 令牌';
    });
  }

  // ---- network ----
  function fetchJson(url, opts) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var t = ctrl ? setTimeout(function () { ctrl.abort(); }, 8000) : null;
    var o = Object.assign({ cache: 'no-store', credentials: 'same-origin' }, opts || {});
    if (ctrl) o.signal = ctrl.signal;
    return fetch(url, o).then(function (res) {
      return res.text().then(function (txt) {
        var body = null;
        try { body = txt ? JSON.parse(txt) : null; } catch (e) { body = { error: 'NOT_JSON', raw: txt.slice(0, 200) }; }
        return { ok: res.ok, status: res.status, body: body };
      });
    }).finally(function () { if (t) clearTimeout(t); });
  }
  function setOnline(ok, detail) {
    app.online = ok;
    var el = document.getElementById('hdr-conn');
    el.textContent = '连接：' + (ok ? '在线 ' + fmtTs(new Date().toISOString()) : '离线' + (detail ? '（' + detail + '）' : ''));
    el.className = 'conn ' + (ok ? 'conn-ok' : 'conn-bad');
  }
  function poll() {
    if (app.inflight) return;
    app.inflight = true;
    var since = app.derived.lastSeq || 0;
    Promise.all([
      fetchJson('/api/state'),
      fetchJson('/api/events?since=' + encodeURIComponent(String(since)))
    ]).then(function (res) {
      var st = res[0], evs = res[1];
      if (!st.ok) { setOnline(false, 'state ' + st.status); return; }
      var un = unwrapState(st.body);
      app.state = un.state; if (un.room) app.room = un.room;
      if (num(app.state.lastSeq) !== null && since > 0 && app.state.lastSeq < since) {
        // The service's event log is shorter than what this page folded (new room in the same dir):
        // drop the client-side model; the next poll refetches from seq 0.
        app.derived = emptyDerived(); app.events = []; app.lastRender = '';
      } else if (evs.ok) {
        var list = unwrapEvents(evs.body).filter(function (e) { return isObj(e) && num(e.seq) !== null && e.seq > since; });
        list.sort(function (a, b) { return a.seq - b.seq; });
        list.forEach(function (e) { app.events.push(e); fold(app.derived, e); });
      }
      setOnline(true);
      render();
    }).catch(function (e) {
      setOnline(false, e && e.name === 'AbortError' ? '超时' : (e && e.message) || '网络错误');
    }).finally(function () { app.inflight = false; });
  }

  function runAction(key, params) {
    var a = ACTIONS[key];
    if (!a) return Promise.resolve();
    if (!a.cmd) { toast(a.reason, 'bad'); return Promise.resolve(); }
    if (!app.token) { toast('没有 admin 令牌，动作不可用。把 admin.token 的内容放进 URL 片段（#<token>）或粘贴到顶部。', 'bad'); return Promise.resolve(); }
    var body;
    try { body = buildCommand(key, params); } catch (e) { toast(e.message, 'bad'); return Promise.resolve(); }
    if (a.confirm && !window.confirm(a.confirm + '\n\n命令：' + a.cmd + ' ' + JSON.stringify(Object.assign({}, body, { cmd: undefined })))) return Promise.resolve();
    body.token = app.token; // body only; never a query string
    return fetchJson('/api/admin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(function (res) {
      if (res.ok && (!res.body || res.body.ok !== false)) {
        toast('已提交 ' + a.cmd + (res.body && res.body.queued ? ' → ' + res.body.queued : ''), 'ok');
        setTimeout(poll, 300);
      } else {
        var err = res.body && (res.body.error || res.body.reason || res.body.message);
        toast('动作 ' + a.cmd + ' 失败：HTTP ' + res.status + (err ? ' ' + err : ''), 'bad');
      }
    }).catch(function (e) { toast('动作 ' + a.cmd + ' 失败：' + ((e && e.message) || '网络错误'), 'bad'); });
  }
  function actionButton(key, params, label, extraClass) {
    var a = ACTIONS[key];
    var b = h('button', { class: 'btn-small ' + (extraClass || ''), type: 'button' }, label || a.label, ' ', a.cmd ? h('code', { text: a.cmd }) : null);
    if (!a.cmd) { b.disabled = true; b.title = a.reason; }
    else { b.disabled = !app.token; b.title = app.token ? 'POST /api/admin cmd=' + a.cmd : '没有 admin 令牌'; b.addEventListener('click', function () { var p = typeof params === 'function' ? params() : params; if (p !== null) runAction(key, p); }); }
    return b;
  }
  function formValues(form) {
    var o = {};
    Array.prototype.forEach.call(form.elements, function (el) { if (el.name) o[el.name] = el.value; });
    return o;
  }

  // ---- rendering ----
  function render() {
    var s = app.state, d = app.derived;
    var key = [d.lastSeq, s.updatedAt, s.phase, s.currentSeat, app.view, app.token ? 1 : 0].join('|');
    renderHeader();
    if (key === app.lastRender) return;
    app.lastRender = key;
    renderTabCounts();
    var fn = VIEWS[app.view];
    if (fn) fn();
  }
  function renderHeader() {
    var s = app.state, d = app.derived;
    var roomId = (app.room && app.room.id) || s.roomId || s.id;
    document.querySelector('#hdr-room b').textContent = u(roomId);
    var ph = document.querySelector('#hdr-phase b'); ph.textContent = u(s.phase || d.phase); ph.className = 'badge ' + toneFor(s.phase || d.phase);
    document.querySelector('#hdr-round').innerHTML = '';
    document.querySelector('#hdr-round').append('轮 ', h('b', { text: u(s.roundId !== undefined ? s.roundId : d.roundId) }), ' · epoch ', h('b', { text: u(s.epoch !== undefined ? s.epoch : d.epoch) }));
    var cur = s.currentSeat || (isObj(s.attempt) && s.attempt.seatId) || null;
    document.querySelector('#hdr-turn').innerHTML = '';
    document.querySelector('#hdr-turn').append('当前 ', h('b', { text: cur ? cur + (isObj(s.attempt) && s.attempt.attemptId ? ' / ' + s.attempt.attemptId : '') : '—' }));
    document.querySelector('#hdr-seq b').textContent = String(Math.max(d.lastSeq, num(s.lastSeq) || 0));
  }
  function renderTabCounts() {
    var d = app.derived, s = app.state;
    var counts = {
      stream: d.stream.length,
      task: d.taskDraft && !d.taskConfirmed ? 1 : 0,
      items: Object.keys(d.items).filter(function (k) { return itemStatus(d.items[k], d) === 'unanswered'; }).length,
      verdicts: Object.keys(d.disclosures).filter(function (k) { return d.disclosures[k].status === 'requested'; }).length,
      recovery: attemptsNeedingReconcile(d, s).length + (awaitingDecision(s) ? 1 : 0),
      merge: mergeConflicts(s, d).length
    };
    document.querySelectorAll('.tab').forEach(function (b) {
      var v = b.getAttribute('data-view');
      var c = b.querySelector('.count');
      if (counts[v]) { if (!c) { c = h('span', { class: 'count' }); b.appendChild(c); } c.textContent = String(counts[v]); }
      else if (c) b.removeChild(c);
    });
  }

  var VIEWS = {};

  VIEWS.stream = function () {
    var d = app.derived, s = app.state;
    var box = document.getElementById('task-box');
    box.innerHTML = '';
    var task = isObj(s.task) ? s.task : d.task;
    box.append(h('h4', null, badge('seq 1', 'user'), badge('authority=user', 'user'), ' 用户任务'), task && task.text ? h('pre', { text: task.text }) : empty('还没有任务。用「任务单」视图手填，或在终端 room admin task。'));
    var ol = document.getElementById('stream');
    ol.innerHTML = '';
    if (!d.stream.length) { ol.appendChild(h('li', { class: 'marker', text: '还没有事件。' })); return; }
    var msgs = isObj(s.messages) && Array.isArray(s.messages) ? s.messages : [];
    var quotesBySeat = {};
    d.quotes.forEach(function (q) { (quotesBySeat[q.attemptId] = quotesBySeat[q.attemptId] || []).push(q); });
    d.stream.forEach(function (e) {
      var li;
      if (e.kind === 'message') {
        var m = e.msg;
        var fromState = msgs.filter(function (x) { return x.seq === m.seq; })[0];
        var mm = fromState ? Object.assign({}, m, fromState) : m;
        var annot = mm.annotation && mm.annotation !== 'none' ? mm.annotation : (mm.malformed ? 'malformed: ' + mm.malformed : null);
        li = h('li', { class: 'message' },
          h('div', { class: 'head' }, badge('seq ' + u(mm.seq)), h('b', { text: '席位 ' + u(mm.seatId) }), badge(u(mm.role), 'info'), badge('authority=' + u(mm.authority || 'none')), badge('attempt ' + u(mm.attemptId)), annot ? badge(String(annot), toneFor(String(annot).split(':')[0])) : null, num(mm.escaped) ? badge('转义 ' + mm.escaped + ' 处', 'warn') : null, h('span', { text: fmtTs(mm.ts) })),
          h('div', { class: 'body', text: mm.text === undefined ? UNKNOWN : String(mm.text) }));
        var qs = quotesBySeat[mm.attemptId] || [];
        qs.forEach(function (q) {
          var orig = d.messages[q.seq] || msgs.filter(function (x) { return x.seq === q.seq; })[0];
          li.appendChild(h('div', { class: 'quote' }, badge('引用 seq ' + u(q.seq), q.verified === true ? 'ok' : q.verified === false ? 'bad' : 'warn'), ' ', q.verified === true ? '引文校验通过' : q.verified === false ? '引文校验失败：片段不在原文里' : '引文校验结果' + UNKNOWN, h('div', { class: 'orig', text: '引文：' + u(q.text) }), orig ? h('div', { class: 'orig', text: '原文：' + String(orig.text).slice(0, 600) + (String(orig.text).length > 600 ? ' …' : '') }) : h('div', { class: 'orig', text: '原文：' + UNKNOWN })));
        });
        var pts = Object.keys(d.items).map(function (k) { return d.items[k]; }).filter(function (it) { return it.attemptId === mm.attemptId; });
        if (pts.length) li.appendChild(h('div', { class: 'refs', text: '条目：' + pts.map(function (it) { return it.itemId + '（关于 seq ' + u(it.aboutSeq) + '）'; }).join('；') }));
        var vs = d.verdicts.filter(function (v) { return v.attemptId === mm.attemptId; });
        vs.forEach(function (v) { li.appendChild(h('div', { class: 'refs' }, 'verdict ', badge(u(v.verdict), toneFor(v.verdict)), ' 产物 ' + shortSha(v.artifactSha), v.annotation && v.annotation !== 'none' ? [' 标注 ', badge(String(v.annotation), toneFor(String(v.annotation)))] : null)); });
      } else if (e.kind === 'summary') {
        var sm = e.summary;
        li = h('li', { class: 'summary' },
          h('div', { class: 'head' }, badge('汇总 v' + u(sm.version), 'info'), h('b', { text: '主力 ' + u(sm.seatId) }), badge('attempt ' + u(sm.attemptId)), sm.supersedes !== null && sm.supersedes !== undefined ? badge('取代 v' + sm.supersedes, 'warn') : null, h('span', { text: fmtTs(sm.ts) })),
          h('div', { class: 'body' }, sm.unanswered.length ? [badge('未回应 ' + sm.unanswered.length + ' 条', 'bad'), ' ' + sm.unanswered.join('、')] : badge('全部条目已标注', 'ok')),
          sm.absent.length ? h('div', { class: 'refs' }, badge('缺席标记', 'warn'), ' ' + sm.absent.map(function (a) { return '席位 ' + u(a.seatId) + '（' + u(a.phase) + '，' + (a.by === 'admin' ? '用户跳过' : u(a.by)) + '）'; }).join('；')) : null,
          sm.noArtifact.length ? h('div', { class: 'refs' }, badge('no_artifact', 'bad'), ' ' + sm.noArtifact.map(function (n) { return '席位 ' + u(n.seatId) + '（' + (n.reason === 'empty' ? '产物集为空' : '没有冻结产物') + '）'; }).join('；')) : null,
          sm.verified ? h('div', { class: 'refs' }, sm.verified.map(function (x) { return [badge(x.verified ? '已验证' : '未验证', x.verified ? 'ok' : 'warn'), ' 产物 ' + shortSha(x.artifactSha) + (x.producer ? '（席位 ' + x.producer + '）' : '') + (x.verified ? '' : ' · ' + u(x.reason)), ' ']; })) : null);
      } else if (e.kind === 'user') {
        li = h('li', { class: 'user' }, h('div', { class: 'head' }, badge('用户新消息', 'user'), badge('seq ' + u(e.msgSeq)), h('span', { class: 'hint', text: '事件 #' + u(e.seq) }), ' ', h('span', { text: fmtTs(e.ts) })), h('div', { class: 'body', text: u(e.text) }));
      } else {
        li = h('li', { class: 'marker ' + (e.tone || '') }, badge('seq ' + u(e.seq)), ' ', e.text, ' ', h('span', { class: 'hint', text: fmtTs(e.ts) }));
      }
      ol.appendChild(li);
    });
  };

  VIEWS.seats = function () {
    var d = app.derived, s = app.state;
    var seats = seatList(s, app.room, d);
    var rows = seats.map(function (seat) {
      var obs = auditObservation(seat, d);
      var w = isObj(seat.wake) ? seat.wake : null;
      var maxPerTurn = w && num(w.maxPerTurn) !== null ? w.maxPerTurn : (w && w.enabled ? 1 : null);
      var tr = h('tr', { class: seat.isCurrent ? 'current' : '' });
      tr.append(
        td(h('b', { text: seat.seatId }), seat.name && seat.name !== seat.seatId ? ' ' + seat.name : ''),
        td(seatForm(seat)),
        td(seatAgent(seat)),
        td(badge(u(seat.role), 'info')),
        td(u(seat.waitMode), ' · 本回合唤醒 ', String(wakesThisRound(d, seat.seatId)), ' / W=', u(maxPerTurn), w && w.enabled === false ? badge('推送关', 'warn') : '',
          (function () { var rf = wakeRefusalsFor(d, seat.seatId).filter(function (x) { return x.roundKey === d.roundKey; }); return rf.length ? [' ', badge('需用户唤醒（' + rf[rf.length - 1].refused + '）', 'warn')] : ''; })()),
        td('声明 ', badge(u(seat.declaredTier)), ' · 观测 ', badge(obs.text, obs.tone)),
        td(h('span', { class: 'mono', text: auditSource(seat) })),
        td(badge(u(seat.status), toneFor(seat.status)), seat.isCurrent ? [' ', badge('当前回合', 'info')] : ''),
        td(seat.retained === null || seat.retained === undefined ? UNKNOWN : (typeof seat.retained === 'boolean' ? (seat.retained ? '是' : '否') : String(seat.retained))),
        td({ class: 'actions-cell' },
          actionButton('skip', {}, '跳过'),
          actionButton('reassign', function () { var to = window.prompt('改派给哪个席位？'); var text = to ? window.prompt('说明（可空）') : null; return { seatId: seat.seatId, toSeatId: to || '', text: text || '' }; }, '改派'),
          actionButton('cancel', {}, '取消 attempt'),
          actionButton('wake', { seatId: seat.seatId }, '唤醒'))
      );
      return tr;
    });
    var t = document.getElementById('seats-table');
    t.replaceWith(table(['席位', '形态', 'agent', '职责', '等待方式 / 唤醒', '声明档位 / 审计观测', '审计源', '状态', 'retained', '动作'], rows));
    document.querySelector('#view-seats .table').id = 'seats-table';
  };

  VIEWS.packets = function () {
    var d = app.derived, s = app.state;
    var seats = seatList(s, app.room, d);
    var list = document.getElementById('packets-list');
    list.innerHTML = '';
    if (!seats.length) { list.appendChild(empty('没有席位。')); return; }
    seats.forEach(function (seat) {
      var roomDir = seat.roomDir || s.roomDir || (app.room && app.room.dir) || null;
      var joinPath = roomDir ? roomDir.replace(/[\\/]+$/, '') + '/seats/' + seat.seatId + '/JOIN.md' : UNKNOWN;
      var w = isObj(seat.wake) ? seat.wake : null;
      var tokenState = seat.tokenState || (seat.token === null ? '已吊销' : (seat.joinSha256 ? '已签发（在席位包里）' : UNKNOWN));
      var card = h('div', { class: 'card' },
        h('h4', null, '席位 ' + seat.seatId, badge(u(seat.role), 'info'), badge(u(seat.status), toneFor(seat.status))),
        kv([
          ['JOIN.md', h('code', { text: joinPath })],
          ['JOIN sha256', h('code', { text: shortSha(seat.joinSha256) })],
          ['令牌状态', tokenState],
          ['传输', seat.transport ? String(seat.transport) : '文件式（默认）'],
          ['工作目录', h('code', { text: u(seat.cwd) })],
          ['发件箱', h('code', { text: u(seat.outbox) })],
          ['推送开关', w ? (w.enabled ? '开' : '关') : UNKNOWN],
          ['登记线程', w && w.thread ? h('code', { text: String(w.thread) + '（' + u(w.kind) + '）' }) : (w && w.enabled === false ? '未登记' : UNKNOWN)],
          ['每回合上限 W', w && num(w.maxPerTurn) !== null ? String(w.maxPerTurn) : (w && w.enabled ? '1（默认）' : UNKNOWN)],
          ['唤醒累计', String(wakesTotal(d, seat.seatId))]
        ]),
        h('div', { class: 'actions' }, actionButton('seat-regenerate', {}, '重新生成'), actionButton('seat-revoke', {}, '吊销'), h('span', { class: 'unavailable', text: ACTIONS['seat-regenerate'].reason }))
      );
      list.appendChild(card);
    });
  };

  VIEWS.task = function () {
    var d = app.derived, s = app.state;
    var box = document.getElementById('task-draft');
    box.innerHTML = '';
    var draft = d.taskDraft || (isObj(s.taskDraft) ? { draft: s.taskDraft, seatId: s.taskDraft.seatId } : null);
    var confirmed = d.taskConfirmed || (isObj(s.taskConfirmed) ? s.taskConfirmed : null);
    var status = confirmed ? 'confirmed' : (draft ? 'drafted' : 'none');
    box.append(h('h4', null, '任务单 ', badge(status === 'confirmed' ? '已确认' : status === 'drafted' ? '草案待确认' : '无草案', toneFor(status))));
    var assignments = (confirmed && Array.isArray(confirmed.assignments)) ? confirmed.assignments : (draft && isObj(draft.draft) && Array.isArray(draft.draft.assignments) ? draft.draft.assignments : []);
    if (draft) box.append(kv([['起草席位', u(draft.seatId)], ['attempt', u(draft.attemptId)], ['起草时间', fmtTs(draft.ts)]]));
    if (confirmed) box.append(kv([['确认时间', fmtTs(confirmed.ts)], ['确认人', u(confirmed.by)]]));
    if (assignments.length) {
      var rows = assignments.map(function (a) { return h('tr', null, td(h('b', { text: u(a.seatId) })), td(h('pre', { text: u(a.text) })), td(h('code', { text: Array.isArray(a.acceptance) ? a.acceptance.map(function (x) { return fmtArgv(x); }).join('\n') : UNKNOWN }))); });
      box.append(h('div', { class: 'scroll-x' }, table(['席位', '任务', '验收命令（自动加入披露白名单）'], rows)));
    } else box.append(empty('没有分派项。主力用 room assign --file 起草，或在下面手填。'));
    if (draft && isObj(draft.draft) && draft.draft.text) box.append(h('h4', { text: '草案正文' }), h('pre', { text: String(draft.draft.text) }));
    var btn = document.getElementById('btn-confirm-task');
    btn.disabled = !app.token || status !== 'drafted';
    btn.title = status !== 'drafted' ? '没有待确认的草案' : btn.title;
  };

  VIEWS.items = function () {
    var d = app.derived, s = app.state;
    // The service's own item table (whole-message items plus points, lead's summary marks applied) is
    // authoritative when /api/state carries it; the event fold only sees points and would miss the
    // whole-message items that plan §5.4 counts.
    var items = Array.isArray(s.items)
      ? s.items.map(function (x) {
        var marked = x.status && x.status !== 'open' ? { status: x.status, by: x.markedBy || x.by, text: x.markText } : null;
        return Object.assign({}, x, { aboutSeq: x.aboutSeq !== undefined ? x.aboutSeq : x.seq, mark: x.mark || marked });
      })
      : Object.keys(d.items).map(function (k) { return d.items[k]; });
    items.sort(function (a, b) { return (num(a.aboutSeq) || 0) - (num(b.aboutSeq) || 0) || String(a.itemId).localeCompare(String(b.itemId)); });
    var rows = items.map(function (it) {
      var st = itemStatus(it, d);
      var mis = itemMisquoted(it, d);
      var label = { accepted: '已接受', rejected: '已驳回', deferred: '已延后', unanswered: '未回应', pending: '待汇总', unknown: UNKNOWN }[st] || u(st);
      return h('tr', { class: st === 'unanswered' ? 'highlight' : '' },
        td(h('code', { text: u(it.itemId) })), td(u(it.seatId)), td('seq ' + u(it.aboutSeq), mis ? [' ', badge('被声明误述', 'warn')] : ''),
        td(h('pre', { text: u(it.text) })), td(badge(label, toneFor(st))), td(it.mark ? [u(it.mark.by), '：', u(it.mark.text)] : '—'));
    });
    var t = document.getElementById('items-table');
    t.replaceWith(table(['条目', '提出席位', '关于', '内容', '标注', '主力说明'], rows));
    document.querySelector('#view-items .table').id = 'items-table';
    var ul = document.getElementById('misquoted-list');
    ul.innerHTML = '';
    if (!d.misquoted.length) ul.appendChild(h('li', { class: 'empty', text: '没有被误述声明。' }));
    d.misquoted.forEach(function (m) { ul.appendChild(h('li', null, badge('席位 ' + u(m.seatId), 'warn'), ' 声明 seq ' + u(m.aboutSeq) + ' 误述了它：', h('span', { text: u(m.text) }), ' ', h('span', { class: 'hint', text: fmtTs(m.ts) }))); });
  };

  VIEWS.verdicts = function () {
    var d = app.derived, s = app.state;
    var list = document.getElementById('artifacts-list');
    list.innerHTML = '';
    var arts = Object.keys(d.artifacts).map(function (k) { return d.artifacts[k]; });
    if (!arts.length) list.appendChild(empty('还没有冻结的产物（执行席位用 room artifacts --declare）。'));
    arts.forEach(function (art) {
      var stale = art.recomputed && art.recomputed.stale;
      var card = h('div', { class: 'card' },
        h('h4', null, '产物 ', h('code', { text: shortSha(art.manifestSha) }), badge('席位 ' + u(art.seatId), 'info'), stale ? badge(art.staleAccepted ? 'accepted_stale' : 'stale', 'warn') : (art.recomputed ? badge('复算一致', 'ok') : badge('未复算')), art.copyTorn ? badge('copyTorn', 'bad') : null),
        kv([
          ['清单 sha', h('code', { text: u(art.manifestSha) })],
          ['轮', u(art.roundId)], ['基线', u(art.baseline)], ['文件数', u(art.fileCount)], ['字节', fmtBytes(art.bytes)],
          ['排除', Array.isArray(art.excluded) && art.excluded.length ? art.excluded.join(', ') : (Array.isArray(art.excluded) ? '（无）' : UNKNOWN)],
          ['冻结时间', fmtTs(art.frozenAt)],
          ['复算', art.recomputed ? fmtTs(art.recomputed.ts) + (stale ? '，已过期' : '，一致') : '未复算']
        ]));
      if (art.recomputed && art.recomputed.changed.length) {
        card.appendChild(h('h4', { text: 'stale 差异（' + art.recomputed.changed.length + ' 个文件）' }));
        card.appendChild(h('div', { class: 'diff' }, art.recomputed.changed.map(function (c) { return h('div', null, h('code', { text: u(c.path) }), ' ', h('span', { class: 'from', text: shortSha(c.from) }), ' → ', h('span', { class: 'to', text: shortSha(c.to) })); })));
      }
      if (art.staleAccepted) card.appendChild(h('div', { class: 'hint', text: '用户已接受 stale（' + fmtTs(art.staleAccepted.ts) + '）' }));
      card.appendChild(h('h4', { text: 'verdict（' + art.verdicts.length + '）' }));
      if (!art.verdicts.length) card.appendChild(empty('还没有 verdict。'));
      var ver = verifiedFor(d, art.manifestSha);
      card.appendChild(h('div', null, '验证：', ver ? badge(ver.verified ? '已验证' : '未验证', ver.verified ? 'ok' : 'warn') : badge('未验证（还没有汇总）', 'warn'), ver && !ver.verified && ver.reason ? ' ' + ver.reason : '', ver && ver.by ? ' · 依据审方 ' + ver.by : ''));
      art.verdicts.forEach(function (v) {
        var audit = d.audits.filter(function (a) { return a.attemptId === v.attemptId; }).pop();
        // Only the producer's resolved reviewer binds (authorized === true); anyone else's verdict is
        // shown as an opinion that does not count toward verification.
        var who = v.authorized === true ? [' 审方 ', h('b', { text: u(v.seatId) })] : [' ', badge('非审方意见（不计入验证）', 'warn'), ' 席位 ', h('b', { text: u(v.seatId) })];
        var anns = (v.annotations || []).filter(function (x) { return x && x !== v.annotation && x !== 'none'; });
        var row = h('div', { class: 'card' },
          h('div', null, badge(u(v.verdict), toneFor(v.verdict)), who, ' · attempt ', h('code', { text: u(v.attemptId) }), ' · 标注 ', badge(u(v.annotation), toneFor(String(v.annotation))), anns.map(function (x) { return [' ', badge(x, toneFor(x))]; }), v.tainted && v.annotation !== 'tainted' ? [' ', badge('tainted', 'bad')] : null, ' · ', fmtTs(v.ts)),
          v.evidence ? h('pre', { text: typeof v.evidence === 'string' ? v.evidence : JSON.stringify(v.evidence, null, 1) }) : null);
        if (audit && audit.tainted) {
          row.appendChild(h('div', null, badge('tainted 证据', 'bad'), ' 审查回合里观测到：'));
          row.appendChild(h('ul', { class: 'plain' }, audit.writes.map(function (w) { return h('li', null, h('code', { text: typeof w === 'string' ? w : (u(w.op) + ' ' + u(w.path)) })); }), audit.unknownCommands.map(function (c) { return h('li', null, '未知命令 ', h('code', { text: typeof c === 'string' ? c : fmtArgv(c.argv || c) })); })));
        } else if (!audit) row.appendChild(h('div', { class: 'hint', text: '该回合未审计。' }));
        card.appendChild(row);
      });
      card.appendChild(h('div', { class: 'actions' },
        actionButton('interrupt', { text: '重审产物 ' + art.manifestSha }, '重审'),
        stale && !art.staleAccepted ? actionButton('accept-stale', { manifestSha: art.manifestSha }, '接受 stale') : null));
      list.appendChild(card);
    });
    var dl = document.getElementById('disclosures-list');
    dl.innerHTML = '';
    var ds = Object.keys(d.disclosures).map(function (k) { return d.disclosures[k]; });
    if (!ds.length) dl.appendChild(empty('没有披露请求。'));
    ds.forEach(function (q) {
      var card = h('div', { class: 'card' },
        h('h4', null, '披露 ', h('code', { text: u(q.id) }), badge(u(q.status), toneFor(q.status)), badge('席位 ' + u(q.seatId), 'info')),
        kv([['argv', h('code', { text: fmtArgv(q.argv) })], ['理由', u(q.reason)], ['attempt', u(q.attemptId)], ['请求时间', fmtTs(q.ts)], ['处理', q.status === 'denied' ? '驳回' + (q.denyReason ? '：' + q.denyReason : '') : q.by ? '由 ' + q.by : '—']]));
      if (q.exec) card.appendChild(kv([['执行于清单', shortSha(q.exec.manifestSha)], ['退出码', u(q.exec.exitCode)], ['输出 sha256', shortSha(q.exec.outputSha256)], ['截断', q.exec.truncated ? '是' : '否'], ['原始输出', h('code', { text: u(q.exec.privatePath) })]]));
      if (q.status === 'requested') card.appendChild(h('div', { class: 'actions' }, actionButton('approve-disclose', { id: q.id }, '批准披露', 'primary'), actionButton('deny-disclose', function () { var why = window.prompt('驳回理由（必填）'); return why === null ? null : { id: q.id, reason: why }; }, '驳回披露', 'danger')));
      dl.appendChild(card);
    });
    var hint = document.getElementById('adjudication-hint');
    var adj = isObj(s.adjudications) ? s.adjudications : null;
    hint.textContent = adj ? ('驳回率：n=' + u(adj.n) + '，k=' + u(adj.k) + (adj.hint ? ' · ' + adj.hint : (num(adj.n) !== null && adj.n < 14 ? ' · 样本不足' : ''))) : '驳回率：未知（服务未提供 adjudications 统计）';
  };

  VIEWS.receipts = function () {
    var d = app.derived;
    var rows = receiptRows(d).map(function (p) {
      var a = d.attempts[p.attemptId] || {};
      var label = { sent: 'sent', header_only: 'header_only', present: 'present', unknown: 'unknown' }[p.receipt] || UNKNOWN;
      return h('tr', null,
        td(h('code', { text: u(p.packetId) })), td(u(p.seatId)), td(h('code', { text: u(p.attemptId) })), td(fmtTs(p.ts)), td(fmtBytes(p.bytes)),
        td(badge(label, toneFor(p.receipt)), p.superseded ? [' ', badge('已被 ' + p.superseded + ' 取代', 'warn')] : ''),
        td(p.auditTs ? fmtTs(p.auditTs) : '未审计'), td(badge(u(a.terminal || '未决'), toneFor(a.terminal || 'pending'))),
        td({ class: 'actions-cell' }, actionButton('wake', { seatId: p.seatId }, '重发')));
    });
    var t = document.getElementById('receipts-table');
    t.replaceWith(table(['包', '席位', 'attempt', '签发', '字节', '回执', '审计时间', 'attempt 终态', '动作'], rows));
    document.querySelector('#view-receipts .table').id = 'receipts-table';
  };

  VIEWS.usage = function () {
    var d = app.derived, s = app.state;
    var seats = seatList(s, app.room, d);
    var sum = usageSummary(s, app.room, d);
    var paused = sum.paused;
    var box = document.getElementById('usage-summary');
    box.innerHTML = '';
    box.append(h('h4', null, '用量 ', paused === null ? badge('paused ' + UNKNOWN) : badge(paused ? 'paused' : '运行中', paused ? 'warn' : 'ok')),
      paused ? h('div', { class: 'notice warn', text: '已知 token 累计已达上限：当前 attempt 终态后房间暂停发包。改上限后用「继续」恢复。' }) : null,
      kv([
        ['已知用量（输入+输出）', sum.knownTokens === null ? UNKNOWN : String(sum.knownTokens) + ' token（只含上报过的席位）'],
        ['用量未知的回合', String(sum.unknownReports)],
        ['token 上限', sum.maxTokens === undefined ? UNKNOWN : (sum.maxTokens === null ? '无上限' : String(sum.maxTokens))],
        ['包大小上限', sum.packetMaxBytes !== null ? fmtBytes(sum.packetMaxBytes) : UNKNOWN],
        ['预计剩余回合', u(projectedTurns(s))],
        ['唤醒累计', String(d.wakes.length)]
      ]));
    var rows = seats.map(function (seat) {
      var us = seatUsage(s, d, seat.seatId);
      var known = !!us && us.input !== null && us.output !== null;
      return h('tr', null,
        td(h('b', { text: seat.seatId })), td(seatForm(seat)),
        td(known ? String(us.input) : UNKNOWN), td(known ? String(us.output) : UNKNOWN), td(known && us.cached !== null ? String(us.cached) : UNKNOWN),
        td(us && us.sources.length ? us.sources.join(', ') + (us.unknownReports ? '（' + us.unknownReports + ' 个回合未知）' : '') : (isObj(seat.hosted) ? '托管席位，待上报' : '嵌入式席位，房间不可知')),
        td(String(wakesThisRound(d, seat.seatId)) + ' / ' + String(wakesTotal(d, seat.seatId))),
        td(d.failures.filter(function (f) { return f.seatId === seat.seatId; }).map(function (f) { return badge('failed(' + u(f.class) + ')', 'bad'); })));
    });
    var t = document.getElementById('usage-table');
    t.replaceWith(table(['席位', '形态', '输入', '输出', '缓存', '来源', '唤醒 本回合/累计', '失败'], rows));
    document.querySelector('#view-usage .table').id = 'usage-table';
    var orderInput = document.querySelector('#form-continue input[name=order]');
    if (orderInput && !orderInput.value && Array.isArray(s.order) && s.order.length) orderInput.placeholder = '顺序，默认沿用 ' + s.order.join(',');
  };

  VIEWS.recovery = function () {
    var d = app.derived, s = app.state;
    var seats = seatList(s, app.room, d);
    var list = document.getElementById('recovery-list');
    list.innerHTML = '';
    var g = awaitingDecision(s);
    if (g) {
      // A seat's turn ran out in a governed room: nothing moves until the user picks one of these.
      list.appendChild(h('div', { class: 'card' },
        h('h4', null, '等待用户决定 ', badge('超时', 'bad'), badge('席位 ' + u(g.seatId), 'info')),
        kv([['attempt', h('code', { text: u(g.attemptId) })], ['阶段', u(g.phase)], ['轮', u(g.roundId)], ['epoch', u(g.epoch)]]),
        h('div', { class: 'notice warn', text: '该席位这一回合超时未交卷。房间不自动跳过：重试（同一席位重新领这一回合）、跳过（记缺席标记）或改派给别的席位。' }),
        h('div', { class: 'actions' },
          actionButton('retry', { seatId: g.seatId }, '重试', 'primary'),
          actionButton('skip', {}, '跳过（记缺席）'),
          actionButton('reassign', function () { var to = window.prompt('改派给哪个席位？'); if (!to) return null; var text = window.prompt('说明（可空）'); return { seatId: g.seatId, toSeatId: to, text: text || '' }; }, '改派'))));
    }
    var rows = attemptsNeedingReconcile(d, s);
    if (!rows.length && !g) list.appendChild(empty('没有待恢复的 attempt。'));
    rows.forEach(function (r) {
      var a = d.attempts[r.attemptId] || {};
      var se = sideEffectHint(r, d, seats);
      var card = h('div', { class: 'card' },
        h('h4', null, 'attempt ', h('code', { text: u(r.attemptId) }), badge('needs_reconcile', 'bad'), badge('席位 ' + u(r.seatId || a.seatId), 'info')),
        kv([['包', u(a.packetId)], ['签发', fmtTs(a.issuedAt)], ['截止', fmtTs(a.deadline)], ['发现时间', fmtTs(r.ts)]]),
        h('div', { class: 'notice warn', text: se.hint }));
      if (se.changed.length) card.appendChild(h('div', { class: 'diff' }, h('div', { text: '冻结差异：' }), se.changed.map(function (c) { return h('div', null, h('code', { text: u(c.path) }), ' ', h('span', { class: 'from', text: shortSha(c.from) }), ' → ', h('span', { class: 'to', text: shortSha(c.to) })); })));
      card.appendChild(h('div', { class: 'actions' },
        actionButton('reconcile', { attemptId: r.attemptId, action: 'replay' }, '重放（席位可继续交卷）'),
        actionButton('reconcile', { attemptId: r.attemptId, action: 'void' }, '作废（epoch 递增）', 'danger')));
      list.appendChild(card);
    });
    var done = Object.keys(d.reconcile).map(function (k) { return d.reconcile[k]; }).filter(function (r) { return r.status === 'reconciled'; });
    if (done.length) list.appendChild(h('div', { class: 'card' }, h('h4', { text: '已处理' }), h('ul', { class: 'plain' }, done.map(function (r) { return h('li', null, h('code', { text: r.attemptId }), ' → ', badge(r.action === 'replay' ? '重放' : r.action === 'void' ? '作废' : u(r.action), 'ok'), ' ', h('span', { class: 'hint', text: fmtTs(r.reconciledAt) })); }))));
  };

  VIEWS.merge = function () {
    var d = app.derived, s = app.state;
    var conflicts = mergeConflicts(s, d);
    var rows = conflicts.map(function (c) {
      return h('tr', { class: 'highlight' },
        td(h('code', { text: u(c.path) })), td((Array.isArray(c.seats) ? c.seats : []).map(function (x) { return badge(u(x), 'info'); })),
        td(h('div', { class: 'diff' }, (Array.isArray(c.manifests) ? c.manifests : []).map(function (m) { return h('div', null, h('code', { text: shortSha(m.manifestSha) }), ' ', h('span', { class: 'from', text: shortSha(m.from) }), ' → ', h('span', { class: 'to', text: shortSha(m.to) })); }))),
        td(c.detail ? String(c.detail) : (c.source === 'derived' ? '由各席位清单复算差异推得' : '')),
        td({ class: 'actions-cell' }, actionButton('merge-apply', {}, '应用'), actionButton('merge-discard', {}, '丢弃'), h('div', { class: 'unavailable', text: ACTIONS['merge-apply'].reason })));
    });
    var t = document.getElementById('merge-table');
    t.replaceWith(table(['文件', '涉及席位', '清单与哈希', '说明', '动作'], rows));
    document.querySelector('#view-merge .table').id = 'merge-table';
  };

  VIEWS.contract = function () {
    var d = app.derived, s = app.state;
    var box = document.getElementById('contract-box');
    box.innerHTML = '';
    var c = isObj(s.contract) ? s.contract : {};
    var wl = isObj(c.writeLog) ? c.writeLog : (isObj(s.writeLog) ? s.writeLog : null);
    box.appendChild(h('div', { class: 'card' }, h('h4', { text: 'write-log 摘要（契约 1：只写自己的目录）' }),
      wl ? kv([['总写入', u(wl.total)], ['界外写入', h('span', null, badge(String(num(wl.outside) === null ? UNKNOWN : wl.outside), num(wl.outside) === 0 ? 'ok' : 'bad'))], ['按身份', isObj(wl.byWho) ? Object.keys(wl.byWho).map(function (k) { return k + '=' + wl.byWho[k]; }).join('，') : UNKNOWN], ['最近写入', fmtTs(wl.lastTs)]]) : empty('未知（服务未提供 contract.writeLog；用 contract/check-writes.mjs 核）'),
      h('p', { class: 'hint', text: '措辞：write-log 是房间自报的，只能说「在该方法下未观测到界外写入」。' })));
    var cr = isObj(c.controlRun) ? c.controlRun : null;
    box.appendChild(h('div', { class: 'card' }, h('h4', { text: '对照跑（契约 1：不开 agent 跑一整场，配置/记忆/hooks 零差异）' }),
      cr ? kv([['结果', badge(cr.ok === true ? '零差异' : cr.ok === false ? '有差异' : UNKNOWN, cr.ok === true ? 'ok' : cr.ok === false ? 'bad' : 'warn')], ['差异条目', u(cr.diffEntries)], ['跑于', fmtTs(cr.ranAt)], ['报告', h('code', { text: u(cr.reportPath) })]]) : empty('未知（服务未提供 contract.controlRun；用 contract/control-run.mjs 跑）')));
    var opened = Array.isArray(c.auditOpened) ? c.auditOpened : [];
    d.audits.forEach(function (a) { a.opened.forEach(function (f) { if (opened.indexOf(f) === -1) opened.push(f); }); });
    box.appendChild(h('div', { class: 'card' }, h('h4', { text: '审计器打开过的文件（契约 6：集合应 ⊆ 登记的线程/会话）' }),
      opened.length ? h('ul', { class: 'plain' }, opened.map(function (f) { return h('li', null, h('code', { text: typeof f === 'string' ? f : JSON.stringify(f) })); })) : empty('未知（没有 audit_observed.opened，也没有 contract.auditOpened）'),
      h('p', { class: 'hint', text: '审计次数 ' + d.audits.length + '，其中 tainted ' + d.audits.filter(function (a) { return a.tainted; }).length + '，unknown ' + d.audits.filter(function (a) { return a.status === 'unknown'; }).length + '。' })));
    var counts = Object.keys(d.counts).sort().map(function (k) { return k + '=' + d.counts[k]; }).join('，');
    box.appendChild(h('div', { class: 'card' }, h('h4', { text: '事件统计（本页已拉取）' }), h('div', { class: 'mono', text: counts || '（无）' })));
  };

  // ---- export (client side, no admin command) ----
  // In the desktop app (window.roomApp from app/preload.cjs) downloads are cancelled, so the JSON goes
  // through the app's save dialog and the toast reports only what really happened. In a browser it
  // is a blob download.
  function exportEvidence() {
    var inApp = typeof window !== 'undefined' && !!window.roomApp && window.roomApp.isApp === true && typeof window.roomApp.saveEvidence === 'function';
    var payload = { exportedAt: new Date().toISOString(), note: (inApp ? '由圆桌应用导出' : '由浏览器导出') + '：本页轮询到的 state 与 events；不含令牌。', state: app.state, room: app.room, events: app.events, derivedSummary: { lastSeq: app.derived.lastSeq, counts: app.derived.counts, audits: app.derived.audits, receipts: receiptRows(app.derived) } };
    var text = JSON.stringify(payload, null, 1);
    var name = 'room-evidence-' + ((app.room && app.room.id) || 'room') + '-' + Date.now() + '.json';
    if (inApp) {
      var fail = function (why) { toast('证据没有导出：' + (why || '未知错误'), 'bad'); };
      var p;
      try { p = window.roomApp.saveEvidence(name, text); } catch (e) { fail(e && e.message); return; }
      Promise.resolve(p).then(function (r) {
        if (r && r.saved === true) toast('已导出证据 JSON：' + r.path, 'ok');
        else if (r && r.canceled === true) toast('已取消导出证据，没有保存文件。', '');
        else fail(r && r.error);
      }, function (e) { fail(e && e.message); });
      return;
    }
    var blob = new Blob([text], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = h('a', { href: url, download: name });
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    toast('已导出证据 JSON', 'ok');
  }

  // ---- boot ----
  function boot() {
    setToken(readTokenFromFragment());
    window.addEventListener('hashchange', function () { setToken(readTokenFromFragment()); render(); });
    document.getElementById('token-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var v = document.getElementById('token-input').value.trim();
      document.getElementById('token-input').value = '';
      if (v) { history.replaceState(null, '', '#' + v); setToken(v); app.lastRender = ''; render(); }
    });
    document.getElementById('tabs').addEventListener('click', function (e) {
      var b = e.target.closest('.tab');
      if (!b) return;
      app.view = b.getAttribute('data-view');
      document.querySelectorAll('.tab').forEach(function (x) { x.classList.toggle('active', x === b); });
      document.querySelectorAll('.view').forEach(function (x) { x.classList.toggle('active', x.getAttribute('data-view') === app.view); });
      app.lastRender = '';
      render();
    });
    document.querySelectorAll('form[data-action]').forEach(function (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var key = form.getAttribute('data-action');
        var vals = formValues(form);
        if (key === 'start' && !vals.order && Array.isArray(app.state.order)) vals.order = app.state.order.join(',');
        if (key === 'interrupt' && form.id === 'form-deny-task' && !vals.text) vals.text = '任务单草案被驳回';
        runAction(key, vals).then(function () { if (key === 'say' || key === 'task') form.reset(); });
      });
    });
    document.querySelectorAll('button[data-action]').forEach(function (btn) {
      var key = btn.getAttribute('data-action');
      if (key === 'export-evidence') { btn.addEventListener('click', exportEvidence); return; }
      btn.addEventListener('click', function () { runAction(key, {}); });
    });
    poll();
    app.timer = setInterval(poll, POLL_MS);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
