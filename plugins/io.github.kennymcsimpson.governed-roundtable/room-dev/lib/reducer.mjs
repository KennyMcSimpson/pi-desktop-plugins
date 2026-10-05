// The room reducer (INTERFACES §4): events.jsonl -> derived state. Pure: no disk, no clock, no
// process. `reduce(state, ev)` returns a new state and never mutates its input; `applyEvent` is the
// in-place form that `rebuildFromEvents` and the service use on a state object they own (a full
// clone per event would make rebuilding a long room quadratic). `rebuild(roomDir)` is the only
// function here that reads a file, and it only reads events.jsonl (a torn tail line is ignored).
//
// The state keeps the P-1 fields the seat command reads (phase, closed, order, turnIndex,
// currentSeat, attempt, task, messages, seats, epoch, roundId) with the same meaning. New fields:
//   attemptLog[attemptId] every attempt ever issued: {seatId, phase, roundId, epoch, status, ...}
//                         status: pending | needs_reconcile | submitted | failed | canceled | expired | work_partial
//   attempts[seatId]      the seat's open attempt record (same object as its attemptLog entry); the
//                         seat command reads this for concurrent Work (state.attempt stays the serial holder)
//   holding[seatId]       the seat's open attempt id
//   work                  the current Work phase: {roundId, seats, queue, startedAt, deadline}
//   stage                 per-round single-turn phases: {assign:{attemptId, done, status}, summary:{...}}
//   followUp              a malformed submission waiting for its one follow-up packet
//   points/marks/quotes/misquoted/artifacts/verdicts/disclosures/summaries/userMessages/...
import path from 'node:path';
import { ROOM_FILES as F, readJsonl } from './common.mjs';
import { accumulate, emptyUsage } from './usage.mjs';

export const STATE_SCHEMA_VERSION = 2;
export const TERMINAL_STATUSES = Object.freeze(['submitted', 'failed', 'canceled', 'expired', 'work_partial']);
const LIVE_STATUSES = new Set(['pending', 'needs_reconcile']);

export function initialState() {
  return {
    schema_version: STATE_SCHEMA_VERSION,
    epoch: 0, roundId: 0, phase: 'idle', phases: [], closed: false,
    order: [], turnIndex: 0, currentSeat: null, attempt: null,
    attemptLog: {}, attempts: {}, holding: {}, work: null, stage: {}, followUp: null,
    task: null, taskDraft: null, assignments: null, taskConfirmed: null,
    messages: [], nextMsgSeq: 2, userMessages: [],
    points: [], marks: {}, quotes: [], misquoted: [],
    artifacts: {}, verdicts: [], disclosures: {},
    summaries: [], summary: null,
    structured: {},
    seats: {}, processed: {},
    needsReconcile: [], reconciled: {},
    wakes: {}, audits: {},
    usage: emptyUsage(),
    roles: {}, reviews: {}, reversals: [],
    reopened: [], farewell: null, farewells: {},
    awaitingDecision: null, absent: [], noArtifact: [],
    lastSeq: 0, updatedAt: null,
  };
}

function seatRec(s, seatId) {
  if (!s.seats[seatId]) s.seats[seatId] = {};
  return s.seats[seatId];
}

function isLive(a) { return !!a && LIVE_STATUSES.has(a.status); }

// Moves an attempt to a terminal status. Only the first terminal counts (plan §6.1 dedupe rule):
// returns false, and changes nothing, when the attempt is unknown or already terminal.
function finishAttempt(s, attemptId, status, extra) {
  const a = attemptId ? s.attemptLog[attemptId] : null;
  if (!a || !isLive(a)) return false;
  a.status = status;
  a.terminalAt = extra && extra.ts ? extra.ts : null;
  if (extra && extra.by) a.terminalBy = extra.by;
  if (extra && extra.failureClass) a.failureClass = extra.failureClass;
  if (s.holding[a.seatId] === attemptId) delete s.holding[a.seatId];
  if (s.attempts[a.seatId] && s.attempts[a.seatId].attemptId === attemptId) delete s.attempts[a.seatId];
  if (s.attempt && s.attempt.attemptId === attemptId) { s.attempt = null; s.currentSeat = null; }
  s.needsReconcile = s.needsReconcile.filter((r) => r.attemptId !== attemptId);
  return true;
}

function stageDone(s, phase, attemptId, status) {
  const st = s.stage[phase];
  if (st && (!st.attemptId || st.attemptId === attemptId)) { st.done = true; st.status = status; }
}

// What a terminal event does to the turn order of the phase the attempt belonged to.
//   advance=true   the seat's turn is over (submitted, expired, skipped, failed)
//   advance=false  the same seat gets a fresh attempt (canceled, voided)
function afterTerminal(s, a, status, advance) {
  if (!a) return;
  if (a.phase === 'meet' && advance && s.phase === 'meet' && a.roundId === s.roundId) s.turnIndex += 1;
  if ((a.phase === 'summary' || a.phase === 'assign') && advance) stageDone(s, a.phase, a.attemptId, status);
  // A canceled Work attempt goes back to the front of the Work queue: the seat gets a fresh attempt.
  if (a.phase === 'work' && status === 'canceled' && s.work && s.work.roundId === a.roundId && !s.work.queue.includes(a.seatId)) s.work.queue.unshift(a.seatId);
  if (status === 'canceled' || status === 'expired') {
    seatRec(s, a.seatId).voided = a.attemptId;
    // What the seat recorded inside the voided attempt is not in the public record (plan §6.4, the
    // void notice says so): its points leave the item table, its quotes stop pinning messages. The
    // entries stay, flagged, so item ids are never reused.
    for (const p of s.points) if (p.attemptId === a.attemptId) p.voided = true;
    for (const q of s.quotes) if (q.attemptId === a.attemptId) q.voided = true;
  }
}

// A seat's activity after a wake push shows the pushed turn started (plan §3.3: no second push
// until a turn start is observed). Applies to every seat type, audited or not.
function observeTurn(s, seatId, by) {
  if (!seatId || !s.wakes) return;
  for (const list of Object.values(s.wakes)) {
    for (const x of list) {
      if (x.seatId === seatId && x.command_ok === true && x.turn_observed !== true) { x.turn_observed = true; x.observedBy = by; }
    }
  }
}

// Stale-acceptance coverage (plan §5.2): an acceptance covers exactly the change list the user saw.
// A later recompute whose changes are not all in that list is not covered.
function changeKey(c) { return c && typeof c === 'object' ? `${c.path}|${c.to == null ? '' : c.to}` : String(c); }
// A recompute that failed (error) is covered only when the user accepted that same failure.
export function staleCovered(changed, accepted, error = null) {
  if (!accepted || typeof accepted !== 'object') return false;
  const list = Array.isArray(changed) ? changed : [];
  const acc = Array.isArray(accepted.changed) ? accepted.changed : [];
  if (error && accepted.error !== error) return false;
  if (!list.length) return !!(error && accepted.error === error);
  const ok = new Set(acc.map(changeKey));
  return list.every((c) => ok.has(changeKey(c)));
}

function roundMessages(s) { return s.messages.filter((m) => m.roundId === s.roundId && m.epoch === s.epoch && !m.superseded); }

export function applyEvent(s, ev) {
  if (!ev || typeof ev !== 'object') return s;
  if (Number.isInteger(ev.seq)) s.lastSeq = ev.seq;
  if (ev.ts) s.updatedAt = ev.ts;
  // Any event naming an outbox file closes that file: it is never judged twice.
  if (ev.file && ev.seatId) s.processed[`${ev.seatId}/${ev.file}`] = true;
  switch (ev.type) {
    case 'room_created': if (ev.roomId) s.roomId = ev.roomId; break;
    case 'seat_joined': Object.assign(seatRec(s, ev.seatId), { status: 'joined', joinedAt: ev.ts }); break;
    case 'seat_left': Object.assign(seatRec(s, ev.seatId), { status: 'left', leftAt: ev.ts }); break;
    case 'task_set': s.task = { text: ev.text, sha256: ev.sha256, ts: ev.ts }; break;
    case 'round_started': {
      s.roundId = ev.roundId;
      s.order = Array.isArray(ev.order) ? ev.order.slice() : [];
      s.turnIndex = 0;
      s.phases = Array.isArray(ev.phases) && ev.phases.length ? ev.phases.slice() : ['meet'];
      s.phase = ev.phase || s.phases[0] || 'meet';
      s.attempt = null; s.currentSeat = null;
      if (Number.isInteger(ev.epoch)) s.epoch = ev.epoch;
      s.work = null; s.followUp = null;
      s.stage = { assign: { attemptId: null, done: false, status: null }, summary: { attemptId: null, done: false, status: null } };
      s.roundStartedAt = ev.ts;
      s.lead = ev.lead || null;
      s.awaitingDecision = null;
      break;
    }
    case 'phase_changed': {
      s.phase = ev.to;
      if (ev.to === 'meet') { s.turnIndex = 0; if (Array.isArray(ev.order)) s.order = ev.order.slice(); }
      s.attempt = null; s.currentSeat = null;
      break;
    }
    case 'packet_issued': {
      const a = {
        attemptId: ev.attemptId, seatId: ev.seatId, packetId: ev.packetId, nonce: ev.nonce, sha256: ev.sha256,
        bytes: ev.bytes, path: ev.path, issuedAt: ev.ts, deadline: ev.deadline, phase: ev.phase || s.phase,
        roundId: ev.roundId !== undefined ? ev.roundId : s.roundId, epoch: ev.epoch !== undefined ? ev.epoch : s.epoch,
        kind: ev.kind || 'turn', followUpOf: ev.followUpOf || null, status: 'pending', turnIndex: s.turnIndex,
        manifestPath: ev.manifestPath || null, summaryVersion: ev.summaryVersion == null ? null : ev.summaryVersion,
        requiredVerdicts: Array.isArray(ev.requiredVerdicts) ? ev.requiredVerdicts.slice() : [],
      };
      s.attemptLog[ev.attemptId] = a;
      s.holding[ev.seatId] = ev.attemptId;
      s.attempts[ev.seatId] = a;
      // seats[id].failed means "this seat's latest attempt failed". A new attempt supersedes it; the
      // record moves to lastFailure (history stays in attemptLog and the seat_failed event).
      {
        const rec = seatRec(s, ev.seatId);
        if (rec.failed && rec.failed.attemptId !== ev.attemptId) { rec.lastFailure = rec.failed; rec.failed = null; }
      }
      if (a.phase !== 'work') {
        s.currentSeat = ev.seatId;
        s.attempt = { attemptId: a.attemptId, packetId: a.packetId, nonce: a.nonce, sha256: a.sha256, path: a.path, issuedAt: a.issuedAt, deadline: a.deadline, seatId: a.seatId, phase: a.phase, epoch: a.epoch };
      }
      if ((a.phase === 'summary' || a.phase === 'assign') && s.stage[a.phase]) s.stage[a.phase].attemptId = a.attemptId;
      const seat = seatRec(s, ev.seatId);
      seat.lastPacketId = ev.packetId;
      if (ev.voidedAttemptId && seat.voided === ev.voidedAttemptId) seat.voided = null;
      if (ev.summaryVersion != null) seat.lastSummaryVersion = ev.summaryVersion;
      if (ev.followUpOf && s.followUp && s.followUp.forAttemptId === ev.followUpOf) s.followUp = { ...s.followUp, issued: ev.attemptId };
      if (Array.isArray(ev.deliveredUserSeqs)) for (const u of s.userMessages) if (ev.deliveredUserSeqs.includes(u.seq)) u.delivered = true;
      if (Array.isArray(ev.deliveredDisclosures)) for (const id of ev.deliveredDisclosures) if (s.disclosures[id]) s.disclosures[id].delivered = ev.packetId;
      if (Array.isArray(ev.reopenNotices)) for (const r of s.reopened) if (ev.reopenNotices.includes(r.epoch) && !r.notified.includes(ev.seatId)) r.notified.push(ev.seatId);
      if (a.phase === 'work' && s.work) s.work.queue = s.work.queue.filter((id) => id !== ev.seatId);
      // A fresh attempt for the seat the room was waiting on is the user's "wait / retry" choice.
      if (s.awaitingDecision && s.awaitingDecision.seatId === ev.seatId) s.awaitingDecision = null;
      break;
    }
    case 'packet_resent': {
      // Same attempt, new packet file (receipt unknown after a restart, plan §7.2 / #14).
      const a = s.attemptLog[ev.attemptId];
      if (!a || !isLive(a)) break;
      if (!a.originalPath) a.originalPath = a.path;
      Object.assign(a, { path: ev.path, sha256: ev.sha256, bytes: ev.bytes, resends: ev.resend, resentAt: ev.ts });
      if (ev.manifestPath) a.manifestPath = ev.manifestPath;
      if (s.attempt && s.attempt.attemptId === a.attemptId) Object.assign(s.attempt, { path: ev.path, sha256: ev.sha256 });
      break;
    }
    case 'submission_accepted': {
      const a = s.attemptLog[ev.attemptId];
      if (ev.text !== undefined && ev.text !== null) {
        s.messages.push({
          seq: ev.msgSeq, seatId: ev.seatId, role: ev.role, authority: 'none', text: ev.text, sha256: ev.sha256,
          attemptId: ev.attemptId, ts: ev.ts, escaped: ev.escaped, roundId: a ? a.roundId : s.roundId,
          epoch: a ? a.epoch : s.epoch, phase: a ? a.phase : s.phase, kind: ev.kind || 'speech', annotation: ev.annotation || 'none',
        });
        if (Number.isInteger(ev.msgSeq) && ev.msgSeq + 1 > s.nextMsgSeq) s.nextMsgSeq = ev.msgSeq + 1;
      }
      observeTurn(s, ev.seatId, 'submission');
      if (ev.terminal === false) break;
      const done = finishAttempt(s, ev.attemptId, 'submitted', { ts: ev.ts });
      if (a) {
        a.annotation = ev.annotation || 'none';
        if (ev.followUp) {
          s.followUp = { seatId: ev.seatId, forAttemptId: ev.attemptId, phase: a.phase, reasons: ev.reasons || [], issued: null };
        } else if (done) {
          if (s.followUp && s.followUp.issued === ev.attemptId) s.followUp = null;
          afterTerminal(s, a, 'submitted', true);
        }
      }
      break;
    }
    case 'submission_rejected': break;
    case 'structured_received': {
      observeTurn(s, ev.seatId, 'structured');
      if (!ev.attemptId) break;
      if (!s.structured[ev.attemptId]) s.structured[ev.attemptId] = [];
      s.structured[ev.attemptId].push({ ...(ev.payload || {}), kind: ev.kind, submissionId: ev.submissionId || null });
      break;
    }
    case 'attempt_canceled': {
      const a = s.attemptLog[ev.attemptId];
      if (finishAttempt(s, ev.attemptId, 'canceled', { ts: ev.ts, by: ev.by })) afterTerminal(s, a, 'canceled', false);
      break;
    }
    case 'attempt_expired': {
      const a = s.attemptLog[ev.attemptId];
      if (finishAttempt(s, ev.attemptId, 'expired', { ts: ev.ts })) {
        // A follow-up that expires closes the malformed chain with verdict none (recorded by the service).
        const followUp = !!(a.followUpOf || (s.followUp && s.followUp.issued === ev.attemptId));
        if (s.followUp && s.followUp.issued === ev.attemptId) s.followUp = null;
        // A seat that let its own turn run out is not dropped from the order on the room's say-so
        // (plan §4.3 rule 7, #6a): the turn holds until the user waits (retry), skips or reassigns.
        // Work keeps its own rule (work_partial); a follow-up's seat already spoke this turn. The
        // service says so on the event (hold: true, governed rooms); older logs keep advancing.
        const gate = ev.hold === true && !followUp && a.phase !== 'work' && a.roundId === s.roundId && s.phase === a.phase;
        afterTerminal(s, a, 'expired', !gate && a.phase !== 'work');
        if (gate) s.awaitingDecision = { seatId: a.seatId, attemptId: a.attemptId, phase: a.phase, roundId: a.roundId, epoch: s.epoch, ts: ev.ts };
      }
      break;
    }
    case 'seat_failed': {
      const a = s.attemptLog[ev.attemptId];
      seatRec(s, ev.seatId).failed = { class: ev.class, attemptId: ev.attemptId || null, ts: ev.ts };
      if (finishAttempt(s, ev.attemptId, 'failed', { ts: ev.ts, failureClass: ev.class })) {
        if (s.followUp && s.followUp.issued === ev.attemptId) s.followUp = null;
        afterTerminal(s, a, 'failed', a && a.phase !== 'work');
      }
      break;
    }
    case 'seat_skipped': {
      const a = ev.attemptId ? s.attemptLog[ev.attemptId] : null;
      if (a) finishAttempt(s, ev.attemptId, 'canceled', { ts: ev.ts, by: ev.by || 'skip' });
      if (s.followUp && (s.followUp.seatId === ev.seatId)) s.followUp = null;
      const phase = ev.phase || (a ? a.phase : s.phase);
      if (phase === 'meet' && s.phase === 'meet') s.turnIndex += 1;
      else if (phase === 'summary' || phase === 'assign') stageDone(s, phase, ev.attemptId || (s.stage[phase] && s.stage[phase].attemptId), 'skipped');
      else if (phase === 'work' && s.work) {
        s.work.queue = (s.work.queue || []).filter((id) => id !== ev.seatId);
        s.work.skipped = [...(s.work.skipped || []), ev.seatId];
      }
      if (s.awaitingDecision && s.awaitingDecision.seatId === ev.seatId) s.awaitingDecision = null;
      // An absence enters the summary only through an explicit skip, and always with a marker.
      if (!Array.isArray(s.absent)) s.absent = [];
      s.absent.push({ seatId: ev.seatId, roundId: s.roundId, epoch: s.epoch, phase, by: ev.by || 'skip', attemptId: ev.attemptId || null, ts: ev.ts });
      break;
    }
    case 'epoch_bumped': {
      if (Number.isInteger(ev.epoch)) s.epoch = ev.epoch;
      if (ev.reason === 'reassign' && ev.fromSeat && ev.toSeat) {
        s.order = s.order.map((id, i) => (i >= s.turnIndex && id === ev.fromSeat ? ev.toSeat : id));
        if (s.work) {
          s.work.seats = s.work.seats.map((id) => (id === ev.fromSeat ? ev.toSeat : id));
          s.work.queue = (s.work.queue || []).map((id) => (id === ev.fromSeat ? ev.toSeat : id));
          if (!s.work.queue.includes(ev.toSeat) && !s.holding[ev.toSeat]) s.work.queue.push(ev.toSeat);
        }
        if (Array.isArray(s.assignments)) s.assignments = s.assignments.map((x) => (x.seatId === ev.fromSeat ? { ...x, seatId: ev.toSeat, text: ev.text || x.text } : x));
        s.reassigned = [...(s.reassigned || []), { fromSeat: ev.fromSeat, toSeat: ev.toSeat, text: ev.text || '', epoch: ev.epoch, ts: ev.ts }];
        if (s.awaitingDecision && s.awaitingDecision.seatId === ev.fromSeat) s.awaitingDecision = null;
      }
      break;
    }
    case 'round_done': s.phase = 'done'; s.attempt = null; s.currentSeat = null; s.lastRoundDone = { roundId: ev.roundId, summary: ev.summary || null, ts: ev.ts }; break;
    case 'room_closed': s.phase = 'closed'; s.closed = true; s.attempt = null; s.currentSeat = null; break;
    case 'wake_pushed': {
      // Keyed by attempt for display; a push without an attempt (admin wake between turns) is keyed
      // per seat so two seats never share a slot. The service's rules scan every entry of a seat or
      // thread, not one key.
      const key = ev.attemptId || `seat:${ev.seatId}`;
      if (!s.wakes[key]) s.wakes[key] = [];
      s.wakes[key].push({
        seq: ev.seq, seatId: ev.seatId, thread: ev.thread || null, by: ev.by, command_ok: ev.command_ok !== undefined ? ev.command_ok : ev.ok, ts: ev.ts,
        turn_observed: null, roundId: ev.roundId !== undefined ? ev.roundId : s.roundId, turnKey: ev.turnKey || null, refused: ev.refused || null,
      });
      break;
    }
    case 'task_drafted': s.taskDraft = { seatId: ev.seatId, attemptId: ev.attemptId, draft: ev.draft, ts: ev.ts, errors: ev.errors || [] }; s.taskConfirmed = null; break;
    case 'task_confirmed': s.assignments = Array.isArray(ev.assignments) ? ev.assignments.map((x) => ({ ...x })) : []; s.taskConfirmed = { by: ev.by, ts: ev.ts, roundId: s.roundId }; break;
    case 'work_started': s.work = { roundId: ev.roundId, seats: (ev.seats || []).slice(), queue: (ev.seats || []).slice(), startedAt: ev.ts, deadline: ev.deadline || null, partial: [], skipped: [] }; break;
    case 'work_partial': {
      if (ev.attemptId) finishAttempt(s, ev.attemptId, 'work_partial', { ts: ev.ts });
      if (s.work) { s.work.partial.push(ev.seatId); s.work.queue = s.work.queue.filter((id) => id !== ev.seatId); }
      break;
    }
    case 'artifacts_frozen': {
      s.artifacts[ev.manifestSha] = {
        ...(s.artifacts[ev.manifestSha] || {}), seatId: ev.seatId, roundId: ev.roundId, manifestSha: ev.manifestSha, baseline: ev.baseline,
        fileCount: ev.fileCount, bytes: ev.bytes, excluded: ev.excluded || [], copyTorn: !!ev.copyTorn, frozenAt: ev.ts,
        attemptId: ev.attemptId || null, snapshotDir: ev.snapshotDir || null, manifestPath: ev.manifestPath || null,
        snapshotStale: !!ev.snapshotStale, snapshotChanged: Array.isArray(ev.snapshotChanged) ? ev.snapshotChanged : [],
        recomputed: (s.artifacts[ev.manifestSha] && s.artifacts[ev.manifestSha].recomputed) || null,
        staleAccepted: (s.artifacts[ev.manifestSha] && s.artifacts[ev.manifestSha].staleAccepted) || null,
      };
      seatRec(s, ev.seatId).latestManifest = ev.manifestSha;
      if (ev.attemptId) observeTurn(s, ev.seatId, 'artifacts');
      break;
    }
    case 'artifacts_recomputed': {
      const art = s.artifacts[ev.manifestSha] || (s.artifacts[ev.manifestSha] = { manifestSha: ev.manifestSha, seatId: ev.seatId });
      art.recomputed = { changed: Array.isArray(ev.changed) ? ev.changed : [], stale: !!ev.stale, error: ev.error || null, ts: ev.ts };
      break;
    }
    case 'stale_accepted': {
      const art = s.artifacts[ev.manifestSha] || (s.artifacts[ev.manifestSha] = { manifestSha: ev.manifestSha });
      art.staleAccepted = { by: ev.by, changed: ev.changed || [], error: ev.error || null, recomputedTs: ev.recomputedTs || null, ts: ev.ts };
      // Only verdicts whose own change list is inside what the user accepted are upgraded; the taint
      // and every other annotation stay (plan §5.3: a tainted verdict keeps its mark).
      for (const v of s.verdicts) {
        if (v.artifactSha !== ev.manifestSha || v.annotation === 'accepted_stale') continue;
        const anns = Array.isArray(v.annotations) ? v.annotations : [v.annotation];
        if (!anns.includes('stale')) continue;
        if (Array.isArray(v.changed) && !staleCovered(v.changed, art.staleAccepted, v.recomputeError || null)) continue;
        v.annotations = anns.map((x) => (x === 'stale' ? 'accepted_stale' : x));
        v.annotation = v.tainted || v.annotations.includes('tainted') ? 'tainted' : v.annotations.includes('audit_failed') ? 'audit_failed' : 'accepted_stale';
        v.entersSummary = true;
      }
      break;
    }
    case 'point_added': s.points.push({ itemId: ev.itemId, seatId: ev.seatId, attemptId: ev.attemptId, aboutSeq: ev.aboutSeq, text: ev.text, roundId: s.roundId, epoch: s.epoch, ts: ev.ts }); break;
    case 'quote_submitted': s.quotes.push({ seatId: ev.seatId, attemptId: ev.attemptId, quotedSeq: ev.quotedSeq, text: ev.text, verified: !!ev.verified, reason: ev.reason || null, roundId: s.roundId, epoch: s.epoch, ts: ev.ts }); break;
    case 'item_marked': s.marks[ev.itemId] = { itemId: ev.itemId, by: ev.by, status: ev.status, text: ev.text || '', ts: ev.ts, roundId: s.roundId, epoch: s.epoch, phase: ev.phase || s.phase }; break;
    case 'misquoted_declared': s.misquoted.push({ seatId: ev.seatId, aboutSeq: ev.aboutSeq, text: ev.text || '', ts: ev.ts }); break;
    case 'work_no_artifact': {
      if (!Array.isArray(s.noArtifact)) s.noArtifact = [];
      s.noArtifact.push({ seatId: ev.seatId, attemptId: ev.attemptId || null, roundId: ev.roundId !== undefined ? ev.roundId : s.roundId, epoch: s.epoch, reason: ev.reason || null, manifestSha: ev.manifestSha || null, ts: ev.ts });
      break;
    }
    case 'verdict_recorded': {
      s.verdicts.push({
        seatId: ev.seatId, attemptId: ev.attemptId, artifactSha: ev.artifactSha || null, verdict: ev.verdict, annotation: ev.annotation || 'none',
        annotations: ev.annotations || [ev.annotation || 'none'], entersSummary: !!ev.entersSummary, authorized: ev.authorized !== false,
        tainted: !!ev.tainted, producer: ev.producer || null, roundId: s.roundId, epoch: s.epoch, seq: ev.seq, ts: ev.ts,
        changed: ev.evidence && Array.isArray(ev.evidence.changed) ? ev.evidence.changed : null,
        recomputeError: (ev.evidence && ev.evidence.recomputeError) || null,
      });
      break;
    }
    case 'disclose_requested': s.disclosures[ev.id] = { id: ev.id, seatId: ev.seatId, attemptId: ev.attemptId, argv: ev.argv, reason: ev.reason, status: 'requested', manifestSha: ev.manifestSha || null, supersedes: ev.supersedes || null, ts: ev.ts, allowed: ev.allowed !== false, matched: Array.isArray(ev.matched) ? ev.matched : null, matchKind: ev.matchKind || null }; break;
    case 'disclose_approved': if (s.disclosures[ev.id]) Object.assign(s.disclosures[ev.id], { status: 'approved', approvedBy: ev.by, approvedAt: ev.ts }); break;
    case 'disclose_denied': if (s.disclosures[ev.id]) Object.assign(s.disclosures[ev.id], { status: 'denied', deniedBy: ev.by, denyReason: ev.reason || '', denyMessage: ev.message || null, deniedAt: ev.ts }); break;
    case 'disclose_executed': if (s.disclosures[ev.id]) Object.assign(s.disclosures[ev.id], { status: 'executed', exec: { manifestSha: ev.manifestSha, exitCode: ev.exitCode, outputSha256: ev.outputSha256, truncated: !!ev.truncated, privatePath: ev.privatePath, ts: ev.ts } }); break;
    case 'summary_published': {
      const msg = s.messages.find((m) => m.attemptId === ev.attemptId && m.seatId === ev.seatId);
      const rec = {
        version: ev.version, seatId: ev.seatId, attemptId: ev.attemptId, unanswered: ev.unanswered || [], supersedes: ev.supersedes == null ? null : ev.supersedes,
        verdicts: ev.verdicts || [], excluded: ev.excluded || [], verified: ev.verified || [], absent: ev.absent || [], noArtifact: ev.noArtifact || [],
        roundId: s.roundId, ts: ev.ts, seq: msg ? msg.seq : null,
        text: msg ? msg.text : '', sha256: msg ? msg.sha256 : null,
      };
      s.summaries.push(rec);
      s.summary = { version: rec.version, seatId: rec.seatId, seq: rec.seq, text: rec.text, sha256: rec.sha256 };
      if (s.stage.summary) s.stage.summary.published = ev.version;
      break;
    }
    case 'superseded_notice': { const seat = seatRec(s, ev.forSeat); seat.lastSummaryVersion = ev.newVersion; seat.supersededNotices = (seat.supersededNotices || 0) + 1; break; }
    case 'direction_reversed': {
      if (Number.isInteger(ev.epoch)) s.epoch = ev.epoch;
      if (ev.roles && typeof ev.roles === 'object') s.roles = { ...ev.roles };
      if (ev.reviews && typeof ev.reviews === 'object') s.reviews = { ...ev.reviews };
      if (ev.leadSeatId !== undefined) s.leadSeatId = ev.leadSeatId;
      s.reversals.push({ epoch: ev.epoch, before: ev.before, after: ev.after, ts: ev.ts });
      break;
    }
    case 'needs_reconcile': {
      const a = s.attemptLog[ev.attemptId];
      if (a && a.status === 'pending') a.status = 'needs_reconcile';
      if (!s.needsReconcile.some((r) => r.attemptId === ev.attemptId)) s.needsReconcile.push({ attemptId: ev.attemptId, seatId: ev.seatId, ts: ev.ts });
      break;
    }
    case 'reconciled': {
      const a = s.attemptLog[ev.attemptId];
      s.reconciled[ev.attemptId] = { action: ev.action, ts: ev.ts };
      s.needsReconcile = s.needsReconcile.filter((r) => r.attemptId !== ev.attemptId);
      if (!a) break;
      if (ev.action === 'replay' && a.status === 'needs_reconcile') {
        a.status = 'pending';
        if (ev.deadline) { a.deadline = ev.deadline; if (s.attempt && s.attempt.attemptId === a.attemptId) s.attempt.deadline = ev.deadline; }
      } else if (ev.action === 'void') {
        if (finishAttempt(s, ev.attemptId, 'canceled', { ts: ev.ts, by: 'reconcile' })) afterTerminal(s, a, 'canceled', false);
      }
      break;
    }
    case 'user_message_queued': {
      const seq = Number.isInteger(ev.msgSeq) ? ev.msgSeq : s.nextMsgSeq;
      s.userMessages.push({ seq, text: ev.text, sha256: ev.sha256 || null, ts: ev.ts, deliverFromRound: ev.deliverFromRound == null ? s.roundId + 1 : ev.deliverFromRound, immediate: !!ev.immediate, delivered: false });
      if (seq + 1 > s.nextMsgSeq) s.nextMsgSeq = seq + 1;
      break;
    }
    case 'round_reopened': {
      if (Number.isInteger(ev.epoch)) s.epoch = ev.epoch;
      const sup = new Set(ev.supersededSeqs || []);
      for (const m of s.messages) if (sup.has(m.seq)) m.superseded = true;
      // Everything recorded in this round before the interrupt is superseded with it: points about a
      // superseded message, and points / quotes a superseded turn made about older messages. They
      // stay in the list, voided, so item ids are never reused (same convention as afterTerminal).
      const reopenEpoch = Number.isInteger(ev.epoch) ? ev.epoch : s.epoch;
      const supAttempts = new Set(s.messages.filter((m) => sup.has(m.seq)).map((m) => m.attemptId).filter(Boolean));
      const before = (x) => x.roundId === s.roundId && Number.isInteger(x.epoch) && x.epoch < reopenEpoch;
      for (const p of s.points) if (sup.has(p.aboutSeq) || supAttempts.has(p.attemptId) || before(p)) p.voided = true;
      for (const q of s.quotes) if (supAttempts.has(q.attemptId) || before(q)) q.voided = true;
      s.turnIndex = 0;
      s.followUp = null;
      s.awaitingDecision = null;
      if (Array.isArray(ev.phases) && ev.phases.length) s.phases = ev.phases.slice();
      s.phase = ev.phase || s.phase;
      s.attempt = null; s.currentSeat = null;
      s.work = null;
      s.stage = { assign: { attemptId: null, done: false, status: null }, summary: { attemptId: null, done: false, status: null } };
      s.reopened.push({ epoch: ev.epoch, supersededSeqs: [...sup], roundId: s.roundId, ts: ev.ts, notified: [] });
      break;
    }
    case 'usage_reported': s.usage = accumulate(s.usage, ev); break;
    case 'farewell_issued': {
      s.farewell = { packetId: ev.packetId, seats: ev.seats || [], ts: ev.ts };
      if (!s.farewells) s.farewells = {};
      for (const id of ev.seats || []) s.farewells[id] = { packetId: ev.packetId, path: ev.path || null, sha256: ev.sha256 || null, ts: ev.ts };
      break;
    }
    case 'audit_observed': {
      s.audits[ev.attemptId] = { seatId: ev.seatId, status: ev.status, writes: (ev.writes || []).length, unknownCommands: (ev.unknownCommands || []).length, tainted: !!ev.tainted, annotation: ev.annotation || null, ts: ev.ts };
      // The wake's turn_observed is filled here: the audit found the packet in the seat's native log.
      // Every outstanding push to this seat counts, not only the one keyed by this attempt.
      if (ev.status === 'present_in_native' || ev.status === 'header_only') observeTurn(s, ev.seatId, 'audit');
      break;
    }
    default: break;
  }
  return s;
}

// Pure: returns a new state.
export function reduce(state, ev) {
  return applyEvent(structuredClone(state || initialState()), ev);
}

export function rebuildFromEvents(events) {
  const st = initialState();
  for (const ev of events || []) applyEvent(st, ev);
  return st;
}

// Reads events.jsonl (torn tail line ignored, plan §13.1 #19) and folds it.
export function rebuild(roomDir) {
  const events = readJsonl(path.join(roomDir, F.events));
  return { state: rebuildFromEvents(events), count: events.length, events };
}

// ---------------------------------------------------------------- derived views (pure)

export function pendingAttempts(state) {
  return Object.values(state.attemptLog || {}).filter(isLive);
}

export function currentRoundMessages(state) { return roundMessages(state); }

export function seatOrderRemaining(state) {
  return state.order.slice(state.turnIndex);
}
