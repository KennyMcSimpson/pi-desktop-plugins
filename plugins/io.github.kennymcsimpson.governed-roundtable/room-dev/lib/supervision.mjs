// Supervision layer (plan §4.1, §4.7, §5.3): room-topology validation, direction reversal,
// verdict/manifest binding, the disclosure request state machine with argv-prefix allowlist
// matching, the cross-room adjudications log with its reject-rate signal, and the taint rule
// for reviewer turns. Everything here is a pure function except appendAdjudication, whose single
// disk write goes through lib/guard.mjs. Protocol tokens (roles, statuses, error codes) are ASCII;
// user-facing messages are Chinese.
import path from 'node:path';
import { createGuard } from './guard.mjs';
import { readJsonl, nowIso, normPath, randomHex, appRoot } from './common.mjs';

export const ROLES = Object.freeze(['lead', 'reviewer', 'executor', 'participant']);
export const VERDICTS = Object.freeze(['pass', 'reject', 'disclose']);
export const DISCLOSURE_STATES = Object.freeze(['requested', 'approved', 'denied', 'executed']);
export const DEFAULT_ALLOWLIST = Object.freeze([Object.freeze(['git', 'diff']), Object.freeze(['git', 'status'])]);

function err(code, message, extra) { return { code, message, ...(extra || {}) }; }
function seatsOf(room) { return Array.isArray(room && room.seats) ? room.seats : []; }
function isNonEmptyString(v) { return typeof v === 'string' && v.length > 0; }
function isArgv(v) { return Array.isArray(v) && v.length > 0 && v.every(isNonEmptyString); }

// ---------------------------------------------------------------------------------------------
// Role helpers
// ---------------------------------------------------------------------------------------------

// A seat "takes Work" when it is an executor, or when it is explicitly marked as a Work taker
// (hosted exec tier, takesWork flag, or an assignment naming it). Role alone is the declaration;
// the flags are how a misconfigured room says "this lead also works", which is exactly what the
// validator must refuse.
export function takesWork(seat, assignments) {
  if (!seat) return false;
  if (seat.role === 'executor') return true;
  if (seat.takesWork === true) return true;
  if (seat.hosted && seat.hosted.tier === 'exec') return true;
  if (Array.isArray(assignments) && assignments.some((a) => a && a.seatId === seat.seatId)) return true;
  return false;
}

export function isLead(seat, room) {
  if (!seat) return false;
  if (seat.role === 'lead' || seat.lead === true) return true;
  if (room && room.leadSeatId && room.leadSeatId === seat.seatId) return true;
  return false;
}

// Reviewers are the seats that can hold a review edge: role reviewer, or a lead doubling as
// reviewer (plan §4.1: 主力可以兼审方).
export function isReviewer(seat, room) {
  if (!seat) return false;
  if (seat.role === 'reviewer') return true;
  if (seat.hosted && seat.hosted.tier === 'reviewer') return true;
  if (isLead(seat, room) && Array.isArray(seat.reviews) && seat.reviews.length > 0) return true;
  return false;
}

// The agent kind a reviewer's verdicts are filed under in adjudications.jsonl (the reject-rate
// signal is per agent kind). The service and `admin show` both use this, so they agree.
export function reviewerAgentOf(seat) {
  if (!seat) return 'unknown';
  return seat.agent || (seat.hosted ? `pi-${seat.hosted.tier}` : (seat.audit && seat.audit.kind) || 'unknown');
}

// Seats that judge someone's artifacts: explicit reviewers plus every seat resolveReviewers() makes
// the reviewer of a producer (the lead is the default reviewer, plan §4.7).
export function reviewerSeats(room) {
  const seats = seatsOf(room);
  let resolved = {};
  try { resolved = resolveReviewers(room).reviewerOf; } catch { resolved = {}; }
  const ids = new Set(Object.values(resolved));
  return seats.filter((s) => isReviewer(s, room) || ids.has(s.seatId));
}

// Artifact-producing seats are the ones a verdict can be about: executors, seats that declared
// they produce artifacts (report preset: 带产物的席位), and hosted exec seats.
export function producesArtifacts(seat) {
  if (!seat) return false;
  if (seat.role === 'executor') return true;
  if (seat.producesArtifacts === true) return true;
  if (seat.hosted && seat.hosted.tier === 'exec') return true;
  return false;
}

// ---------------------------------------------------------------------------------------------
// Review graph
// ---------------------------------------------------------------------------------------------

// Builds the explicit review edges and finds any cycle. Edges: reviewer -> reviewed.
export function reviewGraph(room) {
  const seats = seatsOf(room);
  const ids = new Set(seats.map((s) => s.seatId));
  const edges = [];
  const errors = [];
  for (const s of seats) {
    if (s.reviews === undefined || s.reviews === null) continue;
    if (!Array.isArray(s.reviews)) { errors.push(err('REVIEWS_NOT_ARRAY', `席位 ${s.seatId} 的 reviews 必须是席位 id 数组`, { seatId: s.seatId })); continue; }
    for (const target of s.reviews) {
      if (!ids.has(target)) { errors.push(err('REVIEW_TARGET_UNKNOWN', `席位 ${s.seatId} 声明审查不存在的席位 ${target}`, { seatId: s.seatId, target })); continue; }
      if (target === s.seatId) { errors.push(err('REVIEW_SELF', `席位 ${s.seatId} 不能审查自己`, { seatId: s.seatId })); continue; }
      edges.push([s.seatId, target]);
    }
  }
  const cycle = findCycle(edges);
  if (cycle) errors.push(err('REVIEW_CYCLE', `审查边成环：${cycle.join(' -> ')}`, { cycle }));
  return { edges, cycle, errors };
}

function findCycle(edges) {
  const adj = new Map();
  for (const [a, b] of edges) { if (!adj.has(a)) adj.set(a, []); adj.get(a).push(b); }
  const state = new Map(); // 0 unvisited, 1 on stack, 2 done
  const stack = [];
  let found = null;
  function visit(n) {
    if (found) return;
    state.set(n, 1); stack.push(n);
    for (const m of adj.get(n) || []) {
      const st = state.get(m) || 0;
      if (st === 1) { found = stack.slice(stack.indexOf(m)).concat(m); return; }
      if (st === 0) visit(m);
      if (found) return;
    }
    stack.pop(); state.set(n, 2);
  }
  for (const n of adj.keys()) if ((state.get(n) || 0) === 0) visit(n);
  return found;
}

// Resolves which seat reviews each artifact-producing seat. Explicit edge wins; otherwise the lead
// (plan §4.7: 每份产物有唯一审方，默认是 A). Returns {reviewerOf, errors}.
export function resolveReviewers(room) {
  const seats = seatsOf(room);
  const lead = seats.find((s) => isLead(s, room)) || null;
  const { edges, errors: graphErrors } = reviewGraph(room);
  const errors = [...graphErrors];
  const reviewerOf = {};
  for (const s of seats) {
    if (!producesArtifacts(s)) continue;
    const reviewers = edges.filter(([, t]) => t === s.seatId).map(([r]) => r);
    if (reviewers.length > 1) { errors.push(err('MULTIPLE_REVIEWERS', `席位 ${s.seatId} 的产物有 ${reviewers.length} 个审方（${reviewers.join('、')}），必须唯一`, { seatId: s.seatId, reviewers })); continue; }
    if (reviewers.length === 1) { reviewerOf[s.seatId] = reviewers[0]; continue; }
    if (lead && lead.seatId !== s.seatId) { reviewerOf[s.seatId] = lead.seatId; continue; }
    errors.push(err('NO_REVIEWER', `席位 ${s.seatId} 的产物没有审方，也没有可作默认审方的主力`, { seatId: s.seatId }));
  }
  return { reviewerOf, errors };
}

export function reviewerFor(room, seatId) {
  const { reviewerOf } = resolveReviewers(room);
  return reviewerOf[seatId] || null;
}

// ---------------------------------------------------------------------------------------------
// Room validation (plan §4.1 / §4.7, test #27)
// ---------------------------------------------------------------------------------------------

// validateRoom(room, {assignments}) -> {ok, errors, warnings, reviewerOf}
// Errors (ok=false): invalid roles / duplicate ids, lead or reviewer taking Work, executor as lead,
// review cycle, bad review targets, a produced artifact with zero or several reviewers, no lead
// when the preset needs one. Warnings never block: a lead/reviewer declaring a write-capable tier.
export function validateRoom(room, opts = {}) {
  const errors = [];
  const warnings = [];
  if (!room || typeof room !== 'object') return { ok: false, errors: [err('ROOM_INVALID', '房间配置不是对象')], warnings, reviewerOf: {} };
  const seats = seatsOf(room);
  if (!seats.length) errors.push(err('NO_SEATS', '房间没有席位'));
  const assignments = Array.isArray(opts.assignments) ? opts.assignments : (Array.isArray(room.assignments) ? room.assignments : []);

  const seen = new Set();
  for (const s of seats) {
    if (!s || !isNonEmptyString(s.seatId)) { errors.push(err('SEAT_ID_MISSING', '席位缺少 seatId')); continue; }
    if (seen.has(s.seatId)) errors.push(err('SEAT_ID_DUPLICATE', `席位 id 重复：${s.seatId}`, { seatId: s.seatId }));
    seen.add(s.seatId);
    if (!ROLES.includes(s.role)) errors.push(err('ROLE_INVALID', `席位 ${s.seatId} 的职责 ${String(s.role)} 不在 ${ROLES.join('|')} 之内`, { seatId: s.seatId }));
  }
  if (errors.length) return { ok: false, errors, warnings, reviewerOf: {} };

  const leads = seats.filter((s) => isLead(s, room));
  if (leads.length > 1) errors.push(err('MULTIPLE_LEADS', `主力只能有一个，现有 ${leads.map((s) => s.seatId).join('、')}`, { seats: leads.map((s) => s.seatId) }));
  if (leads.length === 0 && room.preset) errors.push(err('NO_LEAD', `预设 ${room.preset} 需要一个主力席位`));
  if (room.leadSeatId && !seats.some((s) => s.seatId === room.leadSeatId)) errors.push(err('LEAD_UNKNOWN', `leadSeatId ${room.leadSeatId} 不是房间里的席位`));

  for (const s of seats) {
    const lead = isLead(s, room);
    if (s.role === 'executor' && lead) errors.push(err('EXECUTOR_IS_LEAD', `执行席位 ${s.seatId} 不能兼主力`, { seatId: s.seatId }));
    if (s.role === 'lead' && takesWork(s, assignments)) errors.push(err('LEAD_TAKES_WORK', `主力 ${s.seatId} 不领 Work 任务`, { seatId: s.seatId }));
    if (s.role === 'reviewer' && takesWork(s, assignments)) errors.push(err('REVIEWER_TAKES_WORK', `审方 ${s.seatId} 不领 Work 任务`, { seatId: s.seatId }));
    if (s.role === 'participant' && lead) errors.push(err('PARTICIPANT_IS_LEAD', `参与者 ${s.seatId} 不能兼主力`, { seatId: s.seatId }));
    if ((s.role === 'lead' || s.role === 'reviewer') && ['workspace', 'full'].includes(s.declaredTier)) {
      warnings.push(err('REVIEWER_WRITE_TIER', `席位 ${s.seatId}（${s.role}）声明了可写档位 ${s.declaredTier}；审查回合观测到写操作会标 tainted`, { seatId: s.seatId }));
    }
    if (s.role === 'executor' && Array.isArray(s.reviews) && s.reviews.length) {
      warnings.push(err('EXECUTOR_REVIEWS', `执行席位 ${s.seatId} 持有审查边；它对他人产物的 verdict 不改变「已验证」状态`, { seatId: s.seatId }));
    }
  }

  const { reviewerOf, errors: reviewErrors } = resolveReviewers(room);
  errors.push(...reviewErrors);
  return { ok: errors.length === 0, errors, warnings, reviewerOf };
}

// validateDivisionRound(room, assignments) -> {ok, errors, warnings, cwdBySeat, acceptance}
// For 分工后开会 (plan §4.7): every assignment names an existing Work-taking seat, at most one per
// seat, acceptance commands are argv arrays; two seats declaring the same cwd is a warning that the
// caller must surface for confirmation (test #32), not an error.
export function validateDivisionRound(room, assignments) {
  const errors = [];
  const warnings = [];
  const seats = seatsOf(room);
  const byId = new Map(seats.map((s) => [s.seatId, s]));
  if (!Array.isArray(assignments) || !assignments.length) {
    return { ok: false, errors: [err('NO_ASSIGNMENTS', '任务单为空')], warnings, cwdBySeat: {}, acceptance: [] };
  }
  const assigned = new Set();
  const cwdBySeat = {};
  const acceptance = [];
  for (const a of assignments) {
    if (!a || !isNonEmptyString(a.seatId)) { errors.push(err('ASSIGNMENT_SEAT_MISSING', '任务单里有一项没有席位 id')); continue; }
    const seat = byId.get(a.seatId);
    if (!seat) { errors.push(err('ASSIGNMENT_SEAT_UNKNOWN', `任务单指向不存在的席位 ${a.seatId}`, { seatId: a.seatId })); continue; }
    if (assigned.has(a.seatId)) errors.push(err('ASSIGNMENT_DUPLICATE', `席位 ${a.seatId} 在任务单里出现多次`, { seatId: a.seatId }));
    assigned.add(a.seatId);
    if (seat.role === 'lead' || isLead(seat, room)) errors.push(err('LEAD_TAKES_WORK', `主力 ${a.seatId} 不领 Work 任务`, { seatId: a.seatId }));
    else if (seat.role === 'reviewer') errors.push(err('REVIEWER_TAKES_WORK', `审方 ${a.seatId} 不领 Work 任务`, { seatId: a.seatId }));
    else if (seat.role === 'participant') errors.push(err('PARTICIPANT_TAKES_WORK', `参与者 ${a.seatId} 没有 Work 阶段`, { seatId: a.seatId }));
    if (!isNonEmptyString(a.text)) errors.push(err('ASSIGNMENT_TEXT_MISSING', `席位 ${a.seatId} 的任务没有正文`, { seatId: a.seatId }));
    const acc = a.acceptance === undefined || a.acceptance === null ? [] : a.acceptance;
    if (!Array.isArray(acc)) errors.push(err('ACCEPTANCE_NOT_ARRAY', `席位 ${a.seatId} 的验收命令必须是 argv 数组的列表`, { seatId: a.seatId }));
    else for (const argv of acc) { if (!isArgv(argv)) errors.push(err('ACCEPTANCE_ARGV_INVALID', `席位 ${a.seatId} 的验收命令不是非空字符串 argv：${JSON.stringify(argv)}`, { seatId: a.seatId })); else acceptance.push({ seatId: a.seatId, argv: argv.slice() }); }
    const cwd = isNonEmptyString(a.cwd) ? a.cwd : seat.cwd;
    if (isNonEmptyString(cwd)) cwdBySeat[a.seatId] = cwd;
  }
  // Same working directory declared by two seats -> warning + confirmation required.
  const byCwd = new Map();
  for (const [seatId, cwd] of Object.entries(cwdBySeat)) {
    const key = normPath(cwd);
    if (!byCwd.has(key)) byCwd.set(key, []);
    byCwd.get(key).push(seatId);
  }
  for (const [, ids] of byCwd) {
    if (ids.length > 1) warnings.push(err('SAME_CWD', `席位 ${ids.join('、')} 声明了同一个工作目录；两席位改同一文件时房间不自动合并，需要用户确认后才进入 Work`, { seats: ids, requiresConfirm: true }));
  }
  return { ok: errors.length === 0, errors, warnings, cwdBySeat, acceptance };
}

// ---------------------------------------------------------------------------------------------
// Direction reversal (plan §4.1, test #35)
// ---------------------------------------------------------------------------------------------

// canReverse(state) -> {ok, reason}. Preconditions: the current attempt is terminal (no pending
// attempt in state), nothing is in the Work phase, and the room is open. Several state shapes are
// tolerated so the reducer can evolve: `attempt` (P-1), `attempts` map/array of pending attempts,
// `work.attempts` for concurrent Work holders.
export function canReverse(state) {
  if (!state || typeof state !== 'object') return { ok: false, reason: 'NO_STATE', message: '没有房间状态' };
  if (state.closed || state.phase === 'closed') return { ok: false, reason: 'ROOM_CLOSED', message: '房间已关闭' };
  if (state.attempt) return { ok: false, reason: 'ATTEMPT_PENDING', message: `当前 attempt ${state.attempt.attemptId || ''} 未终态`.trim(), attemptId: state.attempt.attemptId || null };
  const pending = pendingAttempts(state);
  if (pending.length) return { ok: false, reason: 'ATTEMPT_PENDING', message: `有 ${pending.length} 个 attempt 未终态`, attemptIds: pending };
  if (state.phase === 'work') return { ok: false, reason: 'WORK_IN_PROGRESS', message: 'Work 阶段进行中' };
  return { ok: true, reason: null };
}

function pendingAttempts(state) {
  const ids = [];
  const collect = (v) => {
    if (!v) return;
    const list = Array.isArray(v) ? v : Object.values(v);
    for (const a of list) if (a && typeof a === 'object' && (a.status === undefined || a.status === 'pending' || a.status === 'issued')) ids.push(a.attemptId || '?');
  };
  collect(state.attempts);
  if (state.work) collect(state.work.attempts);
  return ids;
}

// reverse(room, state) -> {ok, roles, reviews, redeclare, event} | {ok:false, reason, ...}
// Reviewers and executors swap; the lead moves with the reviewer side (the new reviewer that was
// reviewed by the old lead becomes lead); review edges invert; both sides' declared tiers are
// reset so the user re-declares them after re-joining (plan §4.1). The result is validated with
// validateRoom; an unreversible topology (e.g. one lead reviewing two executors) is refused.
export function reverse(room, state) {
  const pre = canReverse(state);
  if (!pre.ok) return { ok: false, reason: pre.reason, message: pre.message };
  const seats = seatsOf(room);
  const before = validateRoom(room);
  if (!before.ok) return { ok: false, reason: 'ROOM_INVALID', message: '换向前的房间配置本身不合法', errors: before.errors };

  // The reviewer side: explicit reviewers plus whoever is the resolved (possibly default) reviewer
  // of a producing seat, so a lead without explicit edges still swaps with its executor.
  const resolvedReviewerIds = new Set(Object.values(before.reviewerOf));
  const reviewers = seats.filter((s) => isReviewer(s, room) || resolvedReviewerIds.has(s.seatId));
  const executors = seats.filter((s) => s.role === 'executor');
  if (!reviewers.length || !executors.length) return { ok: false, reason: 'NOTHING_TO_REVERSE', message: '没有可互换的审方与执行者' };

  const oldLead = seats.find((s) => isLead(s, room)) || null;
  const { edges } = reviewGraph(room);
  const roles = {};
  const reviews = {};
  for (const s of seats) { roles[s.seatId] = s.role; reviews[s.seatId] = []; }
  for (const s of executors) roles[s.seatId] = 'reviewer';
  for (const s of reviewers) roles[s.seatId] = 'executor';
  for (const [r, t] of edges) if (!reviews[t].includes(r)) reviews[t].push(r);
  // Edges that only existed by default (lead reviewing an executor without an explicit edge) are
  // inverted too, so the new reviewer explicitly reviews the old lead.
  for (const [producer, reviewer] of Object.entries(before.reviewerOf)) {
    if (!edges.some(([r, t]) => r === reviewer && t === producer) && !reviews[producer].includes(reviewer)) reviews[producer].push(reviewer);
  }
  // Lead follows the reviewer side: the seat that was reviewed by the old lead (first in seat
  // order) becomes lead; with no old lead, the first new reviewer does.
  let newLead = null;
  if (oldLead) {
    const reviewedByLead = seats.filter((s) => before.reviewerOf[s.seatId] === oldLead.seatId && roles[s.seatId] === 'reviewer');
    newLead = reviewedByLead[0] || seats.find((s) => roles[s.seatId] === 'reviewer') || null;
  } else {
    newLead = seats.find((s) => roles[s.seatId] === 'reviewer') || null;
  }
  if (newLead) roles[newLead.seatId] = 'lead';

  const afterRoom = {
    ...room,
    leadSeatId: newLead ? newLead.seatId : undefined,
    seats: seats.map((s) => ({ ...s, role: roles[s.seatId], lead: undefined, reviews: reviews[s.seatId], declaredTier: null })),
  };
  const after = validateRoom(afterRoom);
  if (!after.ok) return { ok: false, reason: 'INVALID_AFTER_REVERSE', message: '换向后的拓扑不合法，未执行', errors: after.errors };

  const sideBefore = { reviewer: reviewers.map((s) => s.seatId), executor: executors.map((s) => s.seatId), lead: oldLead ? oldLead.seatId : null };
  const sideAfter = {
    reviewer: seats.filter((s) => roles[s.seatId] === 'reviewer' || (roles[s.seatId] === 'lead' && reviews[s.seatId].length)).map((s) => s.seatId),
    executor: seats.filter((s) => roles[s.seatId] === 'executor').map((s) => s.seatId),
    lead: newLead ? newLead.seatId : null,
  };
  const epoch = (Number(state.epoch) || 0) + 1;
  return {
    ok: true,
    roles,
    reviews,
    redeclare: [...reviewers, ...executors].map((s) => s.seatId),
    room: afterRoom,
    event: { type: 'direction_reversed', epoch, before: sideBefore, after: sideAfter },
    epochEvent: { type: 'epoch_bumped', epoch, reason: 'reverse' },
  };
}

// ---------------------------------------------------------------------------------------------
// Verdict binding (plan §5.2 / §5.3, tests #16a, #16b, #36)
// ---------------------------------------------------------------------------------------------

function manifestShaOf(manifest) {
  if (!manifest || typeof manifest !== 'object') return null;
  return manifest.manifestSha || manifest.sha256 || manifest.sha || null;
}

// Does a stale acceptance {changed:[{path, to}], error?} cover this recompute? Every changed entry
// must be in the accepted list (same path and same new hash); a recompute error must be the one
// accepted. An acceptance without a change list covers nothing that changed.
function changeKeyOf(c) { return c && typeof c === 'object' ? `${c.path}|${c.to == null ? '' : c.to}` : String(c); }
function acceptanceCovers(accepted, changed, error) {
  const acc = Array.isArray(accepted.changed) ? accepted.changed : [];
  if (error && accepted.error !== error) return false;
  if (!changed.length) return !!(error && accepted.error === error);
  const ok = new Set(acc.map(changeKeyOf));
  return changed.every((c) => ok.has(changeKeyOf(c)));
}

// bindVerdict({verdict, manifest, recompute, staleAccepted}) -> {verdict, annotation, entersSummary, reason}
// annotation 'stale' when the recompute shows changed files, when the verdict names a different
// manifest than the frozen one, or when there is no frozen manifest at all; 'accepted_stale' when
// the user explicitly accepted that stale manifest; otherwise 'none'. Only 'none' and
// 'accepted_stale' enter the summary. The verdict value itself is never changed here.
export function bindVerdict({ verdict, manifest, recompute, staleAccepted } = {}) {
  if (!verdict || typeof verdict !== 'object') return { verdict: null, annotation: 'stale', entersSummary: false, reason: 'NO_VERDICT' };
  const bound = { ...verdict };
  if (!VERDICTS.includes(bound.verdict)) return { verdict: bound, annotation: 'stale', entersSummary: false, reason: 'VERDICT_INVALID' };
  const frozen = manifestShaOf(manifest);
  const named = bound.artifactSha || bound.manifestSha || null;
  if (!frozen) return { verdict: bound, annotation: 'stale', entersSummary: false, reason: 'NO_MANIFEST' };
  if (named && named !== frozen) return { verdict: bound, annotation: 'stale', entersSummary: false, reason: 'MANIFEST_MISMATCH', frozen, named };
  bound.artifactSha = frozen;
  const changed = recompute && Array.isArray(recompute.changed) ? recompute.changed : [];
  const stale = Boolean(recompute && (recompute.stale === true || changed.length > 0));
  if (stale) {
    // An acceptance covers exactly the change list (and recompute error) the user saw, for this
    // manifest (plan §5.2; same rule as lib/reducer.mjs staleCovered). `true` is not an acceptance.
    const forThis = Boolean(staleAccepted && typeof staleAccepted === 'object' && staleAccepted.manifestSha === frozen);
    if (forThis && acceptanceCovers(staleAccepted, changed, recompute && recompute.error ? recompute.error : null)) {
      return { verdict: bound, annotation: 'accepted_stale', entersSummary: true, reason: 'STALE_ACCEPTED_BY_USER', changed };
    }
    return { verdict: bound, annotation: 'stale', entersSummary: false, reason: forThis ? 'STALE_CHANGED_SINCE_ACCEPT' : 'ARTIFACTS_CHANGED', changed };
  }
  return { verdict: bound, annotation: 'none', entersSummary: true, reason: null };
}

// authorizedVerdict(room, verdict, producerSeatId) -> boolean: only the resolved reviewer of the
// producing seat issues a binding verdict. Executors passing each other (test #36) are not.
export function authorizedVerdict(room, verdict, producerSeatId) {
  if (!verdict || !producerSeatId) return false;
  const reviewer = reviewerFor(room, producerSeatId);
  return Boolean(reviewer && reviewer === verdict.seatId);
}

// verifiedStatus({verdict, annotation, authorized, tainted}) -> {verified, reason}
// "已验证" only on an authorized pass with annotation none (or accepted_stale) and no taint.
export function verifiedStatus({ verdict, annotation = 'none', authorized = true, tainted: isTainted = false } = {}) {
  const v = verdict && typeof verdict === 'object' ? verdict.verdict : verdict;
  if (!authorized) return { verified: false, reason: 'NOT_REVIEWER' };
  if (isTainted) return { verified: false, reason: 'TAINTED' };
  if (v !== 'pass') return { verified: false, reason: v === 'reject' ? 'REJECTED' : v === 'disclose' ? 'DISCLOSURE_PENDING' : 'NO_PASS' };
  if (annotation !== 'none' && annotation !== 'accepted_stale') return { verified: false, reason: `ANNOTATION_${String(annotation).toUpperCase()}` };
  return { verified: true, reason: null };
}

// ---------------------------------------------------------------------------------------------
// Taint (plan §5.3, test #9)
// ---------------------------------------------------------------------------------------------

// tainted(auditObserved) -> boolean. A reviewer turn is tainted when the read-only audit observed
// a write or a command outside the read-only allowlist. An unaudited turn is not tainted; it is
// "未审计" (see auditLabel). We never say "只读", only "未观测到".
export function tainted(auditObserved) {
  if (!auditObserved || typeof auditObserved !== 'object') return false;
  if (auditObserved.tainted === true) return true;
  const writes = Array.isArray(auditObserved.writes) ? auditObserved.writes : [];
  const unknown = Array.isArray(auditObserved.unknownCommands) ? auditObserved.unknownCommands : [];
  return writes.length > 0 || unknown.length > 0;
}

export function auditLabel(auditObserved) {
  if (!auditObserved || auditObserved.status === 'unknown' || auditObserved.status === undefined) return { code: 'unaudited', text: '未审计' };
  if (tainted(auditObserved)) return { code: 'tainted', text: '审查回合里观测到写操作或非只读命令' };
  return { code: 'no_write_observed', text: '在该方法下未观测到写操作' };
}

// ---------------------------------------------------------------------------------------------
// Disclosure (plan §5.3, tests #25, #26, #30)
// ---------------------------------------------------------------------------------------------

// Argv prefix match: every element of an allowlist entry equals the same-index element of argv.
// No shell parsing, no globbing, case-sensitive. Returns the first matching entry or null.
export function matchAllowlist(argv, allowlist) {
  if (!isArgv(argv) || !Array.isArray(allowlist)) return null;
  for (const entry of allowlist) {
    if (!isArgv(entry) || entry.length > argv.length) continue;
    let ok = true;
    for (let i = 0; i < entry.length; i++) if (entry[i] !== argv[i]) { ok = false; break; }
    if (ok) return entry.slice();
  }
  return null;
}

// Argument rule for what a seat may append after a matched room prefix (NI-11; plan §1.6 clauses 1
// and 3, §9.1). A prefix match alone let `git diff --output=<file>` write outside the snapshot and
// `git diff --no-index <abs> x` read an agent's key file. So:
//  - every appended argument must be NUL-free;
//  - an operand (anything that is not a flag, and everything after `--`) must be a relative path or
//    revision that stays inside the working copy: not absolute, no drive letter, no `..` segment;
//  - a flag is allowed only for git, and only from a fixed read-only set, compared exactly. A
//    denylist would not hold: git accepts unique abbreviations of long options (`--outp=` is
//    `--output=`), so only exact known-safe spellings pass;
//  - for a non-git prefix no flag may be appended at all: the user configured the prefix, the seat
//    may only add operands.
const GIT_READONLY_FLAGS = new Set([
  // diff
  '--stat', '--numstat', '--shortstat', '--summary', '--name-only', '--name-status', '--cached', '--staged',
  '--patch', '-p', '--raw', '--no-color', '--color=never', '--no-ext-diff', '--no-textconv', '--minimal',
  '--patience', '--histogram', '--ignore-all-space', '-w', '--ignore-space-change', '-b', '--ignore-blank-lines',
  '--ignore-space-at-eol', '--check', '--find-renames', '-M', '--no-renames', '--full-index', '--abbrev',
  '--word-diff', '--compact-summary', '--dirstat', '-R', '--text', '-a', '--exit-code', '--quiet',
  // status
  '--short', '-s', '--branch', '--porcelain', '--long', '--untracked-files', '-u', '--ignored', '--renames', '--ahead-behind', '--no-ahead-behind',
]);
const GIT_READONLY_FLAG_PATTERNS = [
  /^-U\d{1,4}$/, /^--unified=\d{1,4}$/, /^--stat=\d{1,4}(?:,\d{1,4}){0,2}$/, /^--diff-filter=[ACDMRTUXBacdmrtuxb*]+$/,
  /^-M\d{1,3}%?$/, /^--find-renames=\d{1,3}%?$/, /^--abbrev=\d{1,2}$/, /^--word-diff=(?:color|plain|porcelain|none)$/,
  /^--porcelain=v[12]$/, /^--untracked-files=(?:no|normal|all)$/, /^-u(?:no|normal|all)$/, /^--ignored=(?:traditional|matching|no)$/,
];

function isGitCommand(argv0) {
  return path.win32.basename(String(argv0)).toLowerCase().replace(/\.exe$/, '') === 'git';
}

function unsafeOperand(arg) {
  if (path.win32.isAbsolute(arg) || path.posix.isAbsolute(arg)) return '绝对路径';
  if (/^[A-Za-z]:/.test(arg)) return '带盘符的路径';
  if (arg.split(/[\\/]/).some((seg) => seg === '..')) return '含 .. 的路径';
  return null;
}

// checkTrailingArgs(prefix, trailing) -> null | {arg, why}. `prefix` is the matched allowlist entry,
// `trailing` the arguments after it.
export function checkTrailingArgs(prefix, trailing) {
  const git = Array.isArray(prefix) && prefix.length > 0 && isGitCommand(prefix[0]);
  let operandsOnly = false;
  for (const arg of Array.isArray(trailing) ? trailing : []) {
    if (typeof arg !== 'string' || arg.length === 0) return { arg: String(arg), why: '空参数' };
    if (arg.includes('\u0000')) return { arg, why: '参数含 NUL' };
    if (!operandsOnly && arg === '--') { operandsOnly = true; continue; }
    if (!operandsOnly && arg.startsWith('-')) {
      if (git && (GIT_READONLY_FLAGS.has(arg) || GIT_READONLY_FLAG_PATTERNS.some((re) => re.test(arg)))) continue;
      return { arg, why: git ? '不在只读选项清单内的选项' : '白名单前缀之后不能追加选项' };
    }
    const why = unsafeOperand(arg);
    if (why) return { arg, why };
  }
  return null;
}

function argRefusal(found) {
  return { denyReason: 'ARG_NOT_ALLOWED', message: `参数不被允许：${JSON.stringify(found.arg)}（${found.why}）；披露命令只能在快照副本内只读执行` };
}

// The effective allowlist: the room's configured prefixes plus the acceptance commands from the
// confirmed task sheet (plan §5.3: 任务单里声明的验收命令自动加入). Duplicates removed.
export function effectiveAllowlist(allowlist, acceptanceCommands) {
  const outList = [];
  const seen = new Set();
  const push = (e) => { if (!isArgv(e)) return; const k = JSON.stringify(e); if (seen.has(k)) return; seen.add(k); outList.push(e.slice()); };
  for (const e of Array.isArray(allowlist) ? allowlist : DEFAULT_ALLOWLIST) push(e);
  for (const e of Array.isArray(acceptanceCommands) ? acceptanceCommands : []) push(Array.isArray(e) ? e : e && e.argv);
  return outList;
}

export function sameArgv(a, b) {
  return isArgv(a) && isArgv(b) && a.length === b.length && a.every((x, i) => x === b[i]);
}

// requestDisclosure({argv, reason, allowlist, acceptanceCommands, seatId, attemptId, id, now})
//   -> request {id, seatId, attemptId, argv, reason, allowed, matched, matchKind, status, history}
// Acceptance commands from the confirmed task sheet are exact argv and must match exactly
// (matchKind 'exact'); the room's configured entries are prefixes (matchKind 'prefix') and whatever
// follows the prefix must pass checkTrailingArgs. A request that fails either is denied immediately
// (status 'denied', by 'room', denyReason NOT_IN_ALLOWLIST or ARG_NOT_ALLOWED); it still exists as a
// record so the UI can show it and the user can extend the allowlist.
export function requestDisclosure({ argv, reason, allowlist, acceptanceCommands, seatId = null, attemptId = null, id, now } = {}) {
  const ts = typeof now === 'function' ? now() : now || nowIso();
  const reqId = id || `d${randomHex(4)}`;
  const base = { id: reqId, seatId, attemptId, argv: isArgv(argv) ? argv.slice() : argv, reason: typeof reason === 'string' ? reason : '', requestedAt: ts, history: [] };
  if (!isArgv(argv)) {
    return { ...base, allowed: false, matched: null, status: 'denied', deniedBy: 'room', denyReason: 'ARGV_INVALID', message: 'argv 必须是非空字符串数组', history: [{ to: 'denied', by: 'room', ts }] };
  }
  const m = matchDisclosureArgv(argv, { allowlist, acceptanceCommands });
  if (!m.ok) {
    return { ...base, allowed: false, matched: m.matched, status: 'denied', deniedBy: 'room', denyReason: m.denyReason, message: m.message, history: [{ to: 'denied', by: 'room', ts }] };
  }
  return { ...base, allowed: true, matched: m.matched, matchKind: m.matchKind, status: 'requested', history: [{ to: 'requested', by: seatId || 'seat', ts }] };
}

// The whole match rule in one place: exact acceptance command, else room prefix plus argument rule.
// -> {ok:true, matched, matchKind} | {ok:false, matched, denyReason, message}
export function matchDisclosureArgv(argv, { allowlist, acceptanceCommands } = {}) {
  if (!isArgv(argv)) return { ok: false, matched: null, denyReason: 'ARGV_INVALID', message: 'argv 必须是非空字符串数组' };
  const exact = effectiveAllowlist([], acceptanceCommands).find((e) => sameArgv(e, argv));
  if (exact) return { ok: true, matched: exact, matchKind: 'exact' };
  const matched = matchAllowlist(argv, effectiveAllowlist(allowlist, []));
  if (!matched) return { ok: false, matched: null, denyReason: 'NOT_IN_ALLOWLIST', message: `argv 不在白名单内：${JSON.stringify(argv)}` };
  const bad = checkTrailingArgs(matched, argv.slice(matched.length));
  if (bad) return { ok: false, matched, ...argRefusal(bad) };
  return { ok: true, matched, matchKind: 'prefix' };
}

// Re-applies the argument rule to an argv about to run. Uses, in order: what the request recorded
// (`matched`/`matchKind`, set by requestDisclosure); else the allowlist context when the caller
// passes one (the full rule is re-run); else, for a request rebuilt without either (e.g. from the
// event log), a conservative fallback that treats `git <subcommand>` as the prefix and checks the
// rest. Returns null when the argv may run, else {arg, why}.
function argvPolicyViolation(req, argv, ctx = {}) {
  if (!isArgv(argv)) return { arg: String(argv), why: 'argv 无效' };
  const matched = isArgv(req.matched) ? req.matched : null;
  if (matched && req.matchKind === 'exact') return sameArgv(matched, argv) ? null : { arg: JSON.stringify(argv), why: '验收命令必须与任务单完全一致' };
  if (matched) {
    if (!matchAllowlist(argv, [matched])) return { arg: JSON.stringify(argv), why: '与登记的白名单前缀不符' };
    return checkTrailingArgs(matched, argv.slice(matched.length));
  }
  if (ctx.allowlist !== undefined || ctx.acceptanceCommands !== undefined) {
    const m = matchDisclosureArgv(argv, ctx);
    if (m.ok) return null;
    return m.denyReason === 'ARG_NOT_ALLOWED' ? checkTrailingArgs(m.matched, argv.slice(m.matched.length)) : { arg: JSON.stringify(argv), why: '不在白名单内' };
  }
  if (isGitCommand(argv[0])) return checkTrailingArgs(argv.slice(0, 2), argv.slice(2));
  return null;
}

function transition(req, to, by, ts, extra) {
  return { ...req, status: to, ...(extra || {}), history: [...(req.history || []), { to, by, ts }] };
}

// approveDisclosure(request, {by:'admin', argv?, now}) -> {ok, request, reason}
// Only a 'requested' request can be approved. If the approver passes an argv that differs from the
// requested one, the approval is refused and the caller must open a new request (test #30).
export function approveDisclosure(req, { by = 'admin', argv, now } = {}) {
  const ts = typeof now === 'function' ? now() : now || nowIso();
  if (!req || req.status !== 'requested') return { ok: false, request: req || null, reason: 'INVALID_TRANSITION', message: `只能批准 requested 状态的请求（当前 ${req ? req.status : '无'}）` };
  if (!req.allowed) return { ok: false, request: req, reason: 'NOT_ALLOWED', message: '不在白名单内的请求不能批准' };
  if (argv !== undefined && !sameArgv(argv, req.argv)) return { ok: false, request: req, reason: 'ARGV_CHANGED', message: 'argv 与请求不一致，视为新请求' };
  return { ok: true, request: transition(req, 'approved', by, ts, { approvedBy: by, approvedAt: ts, approvedArgv: req.argv.slice() }), reason: null };
}

export function denyDisclosure(req, { by = 'admin', reason = '', now } = {}) {
  const ts = typeof now === 'function' ? now() : now || nowIso();
  if (!req || !['requested', 'approved'].includes(req.status)) return { ok: false, request: req || null, reason: 'INVALID_TRANSITION', message: `只能拒绝 requested/approved 状态的请求（当前 ${req ? req.status : '无'}）` };
  return { ok: true, request: transition(req, 'denied', by, ts, { deniedBy: by, denyReason: reason || 'DENIED' }), reason: null };
}

// canExecuteDisclosure(request, argv, ctx?) -> {ok, reason}. Pure gate used before any child process:
// the request must be approved, the argv about to run must equal the approved argv exactly, and it
// must still pass the argument rule (reason ARG_NOT_ALLOWED otherwise). `ctx` = {allowlist,
// acceptanceCommands} lets a caller whose request object lacks `matched` re-run the full rule.
export function canExecuteDisclosure(req, argv, ctx = {}) {
  if (!req) return { ok: false, reason: 'NO_REQUEST', message: '没有披露请求' };
  if (req.status === 'executed') return { ok: false, reason: 'ALREADY_EXECUTED', message: '该请求已执行过' };
  if (req.status !== 'approved') return { ok: false, reason: 'NOT_APPROVED', message: `未批准的披露不执行（当前 ${req.status}）` };
  const want = argv === undefined ? req.approvedArgv || req.argv : argv;
  if (!sameArgv(want, req.approvedArgv || req.argv)) return { ok: false, reason: 'ARGV_CHANGED', message: '批准后 argv 发生变化，视为新请求' };
  // Defence in depth (NI-11): the approved argv must still satisfy the argument rule.
  const bad = argvPolicyViolation(req, want, ctx || {});
  if (bad) { const r = argRefusal(bad); return { ok: false, reason: r.denyReason, message: r.message }; }
  return { ok: true, reason: null };
}

// executeDisclosure(request, {argv, run, manifestSha, now}) -> {ok, request, result, reason, newRequest?}
// `run` is the injected runner (lib/workspace runInSnapshot wrapped by the caller) that receives
// the approved argv and returns {exitCode, outputSha256, truncated, privatePath}. Nothing is
// spawned here. When the argv changed after approval, a fresh request is returned in 'requested'
// state (or 'denied' if the new argv is outside the allowlist) and nothing runs.
export async function executeDisclosure(req, { argv, run, manifestSha = null, allowlist, acceptanceCommands, now } = {}) {
  const ts = typeof now === 'function' ? now() : now || nowIso();
  const ctx = {};
  if (allowlist !== undefined) ctx.allowlist = allowlist;
  if (acceptanceCommands !== undefined) ctx.acceptanceCommands = acceptanceCommands;
  const gate = canExecuteDisclosure(req, argv, ctx);
  if (!gate.ok) {
    const res = { ok: false, request: req || null, result: null, reason: gate.reason, message: gate.message };
    if (gate.reason === 'ARGV_CHANGED' && req) {
      res.newRequest = requestDisclosure({ argv, reason: req.reason, allowlist, acceptanceCommands, seatId: req.seatId, attemptId: req.attemptId, now: ts });
      res.newRequest.supersedes = req.id;
    }
    return res;
  }
  if (typeof run !== 'function') return { ok: false, request: req, result: null, reason: 'NO_RUNNER', message: '没有注入执行器' };
  const toRun = (req.approvedArgv || req.argv).slice();
  const result = await run(toRun, { manifestSha, request: req });
  const summary = {
    exitCode: result && typeof result.exitCode === 'number' ? result.exitCode : null,
    outputSha256: result && result.outputSha256 ? result.outputSha256 : null,
    truncated: Boolean(result && result.truncated),
    privatePath: result && result.privatePath ? result.privatePath : null,
  };
  const executed = transition(req, 'executed', 'room', ts, { executedAt: ts, manifestSha, result: summary });
  return { ok: true, request: executed, result: summary, reason: null, event: { type: 'disclose_executed', id: req.id, manifestSha, ...summary } };
}

// ---------------------------------------------------------------------------------------------
// Adjudications (plan §5.3, test #28)
// ---------------------------------------------------------------------------------------------

// Lives under appRoot() (%USERPROFILE%\room-dev, or ROOM_DEV_HOME), never under AppData: an MSIX
// packaged caller would have AppData writes redirected (INTERFACES §1).
export function defaultAdjudicationsPath() {
  return path.join(appRoot(), 'adjudications.jsonl');
}

// appendAdjudication(filePath, {roomId, reviewerAgent, preset, verdict, ts}, {guard}) -> entry
// Append-only through the guard (allowed root: the file's directory). Throws on a malformed entry
// so a bad verdict never reaches the cross-room log.
export function appendAdjudication(filePath, entry, { guard } = {}) {
  const abs = path.resolve(filePath || defaultAdjudicationsPath());
  if (!entry || typeof entry !== 'object') throw new Error('adjudication entry must be an object');
  const rec = { roomId: entry.roomId, reviewerAgent: entry.reviewerAgent, preset: entry.preset, verdict: entry.verdict, ts: entry.ts || nowIso() };
  if (entry.artifactSha) rec.artifactSha = entry.artifactSha;
  if (entry.annotation) rec.annotation = entry.annotation;
  for (const k of ['roomId', 'reviewerAgent', 'preset']) if (!isNonEmptyString(rec[k])) throw new Error(`adjudication entry missing ${k}`);
  if (!VERDICTS.includes(rec.verdict)) throw new Error(`adjudication verdict must be one of ${VERDICTS.join('|')}`);
  const dir = path.dirname(abs);
  const g = guard || createGuard({ allowed: [dir], logPath: path.join(dir, 'write-log.jsonl'), who: 'adjudications' });
  g.mkdir(dir);
  g.appendFsync(abs, `${JSON.stringify(rec)}\n`);
  return rec;
}

export function readAdjudications(filePath) {
  return readJsonl(path.resolve(filePath || defaultAdjudicationsPath())).filter((e) => e && typeof e === 'object' && VERDICTS.includes(e.verdict));
}

// rejectRateSignal(entries, {reviewerAgent, preset, n=14, assumedRejectRate=0.2})
//   -> {n, k, status:'insufficient'|'ok'|'suspicious', probability, threshold, message}
// n = number of verdicts for this (reviewerAgent, preset); k = rejects among them. With fewer than
// `threshold` samples we say 样本不足; with >= threshold samples and zero rejects we flag the
// reviewer as possibly not working, quoting the probability (1-p)^n of seeing zero rejects if the
// true reject rate were at least p (0.8^14 ≈ 4.4%).
export function rejectRateSignal(entries, { reviewerAgent, preset, n = 14, assumedRejectRate = 0.2 } = {}) {
  const threshold = Math.max(1, Number.isFinite(Number(n)) ? Number(n) : 14);
  const p = Math.min(1, Math.max(0, Number(assumedRejectRate) || 0));
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e && VERDICTS.includes(e.verdict)
    && (reviewerAgent === undefined || e.reviewerAgent === reviewerAgent)
    && (preset === undefined || e.preset === preset));
  const total = list.length;
  const k = list.filter((e) => e.verdict === 'reject').length;
  const probability = Math.pow(1 - p, total);
  const rooms = new Set(list.map((e) => e.roomId)).size;
  if (total < threshold) return { n: total, k, rooms, status: 'insufficient', probability, threshold, assumedRejectRate: p, message: `样本不足（${total}/${threshold}）` };
  if (k === 0) return { n: total, k, rooms, status: 'suspicious', probability, threshold, assumedRejectRate: p, message: `审方可能没在工作：${total} 次 verdict 零驳回；若真实驳回率至少 ${Math.round(p * 100)}%，出现这种情况的概率约 ${(probability * 100).toFixed(1)}%` };
  return { n: total, k, rooms, status: 'ok', probability, threshold, assumedRejectRate: p, message: `${total} 次 verdict 中驳回 ${k} 次` };
}
