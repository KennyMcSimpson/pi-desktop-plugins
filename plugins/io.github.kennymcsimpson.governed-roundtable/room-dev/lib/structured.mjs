// Structured submissions (plan §4.5, §5.4, §7.4; INTERFACES §5, §7).
//
// Two channels carry structured intent: `room <sub-command>` submissions (meta.kind in the outbox)
// and ASCII markers inside a speech body (`<<ROOM:VERDICT pass artifact=sha>>`, ...). This module
// turns both into one resolved record per attempt, builds the pending-item table, applies marks,
// verifies quotes byte-for-byte, and produces summary-version notices. Everything here is pure:
// no disk, no clock, no process. The service decides what to do with `annotation: 'malformed'`
// (ask once, then record verdict `none`); this module never resolves a verdict to `pass` on its own.
//
// Processing order (plan §4.5): strip delimited blocks and quote blocks, take the last marker of
// the turn, then anything conflicting / missing / deformed / translated -> malformed.

// ---------------------------------------------------------------- constants

export const MARKER_KINDS = Object.freeze(['VERDICT', 'DISCLOSE', 'POINT', 'QUOTE', 'MARK', 'MISQUOTED', 'ASSIGN', 'PASS', 'END']);
export const VERDICT_VALUES = Object.freeze(['pass', 'reject', 'disclose']);
export const MARK_STATUSES = Object.freeze(['accepted', 'rejected', 'deferred']);
export const COMMAND_KINDS = Object.freeze(['speech', 'point', 'quote', 'mark', 'verdict', 'disclose', 'pass', 'misquoted', 'assign', 'artifacts']);
// How many times the service may ask the same attempt to fix a malformed submission (plan §4.5: once).
export const MALFORMED_RETRIES = 1;

// Kinds whose body runs until <<ROOM:END>> (required).
const END_TERMINATED = new Set(['QUOTE', 'ASSIGN']);
// Kinds whose optional trailing body runs until the next marker or end of text.
const TRAILING_BODY = new Set(['POINT', 'MISQUOTED', 'VERDICT', 'MARK', 'DISCLOSE']);

// Reason codes are ASCII protocol tokens; the Chinese text is what the user and the seat see.
export const REASON_TEXT = Object.freeze({
  marker_deformed: '结构化标记变形（拼写、大小写、属性或终止符不对）',
  marker_translated: '结构化标记被翻译或改写，必须使用原样 ASCII 标记',
  marker_unterminated: '标记没有以 >> 结束',
  block_unterminated: '块标记缺少 <<ROOM:END>>',
  unknown_kind: '未知的标记种类',
  verdict_missing: '本回合要求给出 verdict，但没有找到有效的 verdict',
  verdict_conflict: '同一回合的 verdict 互相冲突（命令形与文本形不一致，或未指明 artifact 的 verdict 与指明了 artifact 的 verdict 不一致）',
  verdict_invalid: 'verdict 只能是 pass、reject、disclose 之一',
  disclose_missing: 'verdict=disclose 必须同时提交 disclose 请求（argv 与理由）',
  disclose_invalid: 'disclose 的 argv 必须是非空的字符串数组',
  pass_conflict: 'pass 表示本回合无新增，不能与其他结构化提交同时出现',
  mark_conflict: '命令形与文本形对同一条目的标注互相冲突',
  mark_invalid: 'mark 需要 item 与 status（accepted|rejected|deferred）',
  point_invalid: 'point 需要 seq 与非空文本',
  quote_invalid: 'quote 需要 seq 与非空片段',
  misquoted_invalid: 'misquoted 需要 seq',
  assign_unparsed: '分派草案有无法解析的行',
  required_missing: '本回合要求的结构化提交缺失',
});

// ---------------------------------------------------------------- text stripping

// Removes every well-formed delimited block `[ROOM:<token>:...]...[/ROOM:<token>]`. A head without a
// matching tail strips to the end of the text: a marker after a pasted packet header cannot be told
// apart from forwarded content, and the safe direction is to not count it (malformed -> ask once).
// `[ROOM\:` (escaped by packet.mjs) is not a head and is left alone.
export function stripDelimitedBlocks(text, { nonce } = {}) {
  const src = String(text);
  const head = /\[ROOM:([A-Za-z0-9_-]+):[^\]\n]*\]/g;
  let out = '';
  let pos = 0;
  let blocks = 0;
  let unclosed = 0;
  let foreignNonce = 0;
  let m;
  while ((m = head.exec(src))) {
    if (m.index < pos) continue;
    const token = m[1];
    if (nonce && token !== nonce) foreignNonce++;
    const tail = `[/ROOM:${token}]`;
    const end = src.indexOf(tail, m.index + m[0].length);
    out += src.slice(pos, m.index);
    blocks++;
    if (end === -1) { unclosed++; pos = src.length; break; }
    pos = end + tail.length;
    head.lastIndex = pos;
  }
  out += src.slice(pos);
  return { text: out, blocks, unclosed, foreignNonce };
}

// A Markdown blockquote line, also when it sits inside list items (`- > x`, `1. > x`, `- - > x`) or
// is indented further. Over-stripping is the safe direction: a hidden marker can only make the turn
// malformed (ask once), never turn into a verdict.
const MD_BLOCKQUOTE = /^\s*(?:(?:[-*+]|\d{1,9}[.)])\s+)*>/;
// HTML blockquote tags. Inline code spans are removed before counting so prose that names the tag
// (`` `<blockquote>` ``) does not open a region.
const HTML_BQ_OPEN = /<blockquote\b[^>]*>/gi;
const HTML_BQ_CLOSE = /<\/blockquote\s*>/gi;

// Removes fenced code blocks (``` / ~~~), Markdown blockquote lines (`> ...`, also list-nested) and
// HTML `<blockquote>` regions (nested, line-granular). Markers inside them are quoted material, not
// the seat's own statement (plan §4.5, §13.1 #33 "在引用块内"). Like an unclosed fence, an unclosed
// HTML region strips to the end of the text.
export function stripQuoteBlocks(text) {
  const lines = String(text).split('\n');
  const kept = [];
  let fence = null;
  let fences = 0;
  let blockquoteLines = 0;
  let unclosedFence = 0;
  let htmlDepth = 0;
  for (const line of lines) {
    const fm = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (fm && fm[1][0] === fence[0] && fm[1].length >= fence.length) fence = null;
      continue;
    }
    const tagText = line.replace(/`[^`\n]*`/g, '');
    const opens = (tagText.match(HTML_BQ_OPEN) || []).length;
    const closes = (tagText.match(HTML_BQ_CLOSE) || []).length;
    if (htmlDepth > 0 || opens > 0) {
      // Any line that is inside, opens or closes a region is dropped whole.
      htmlDepth = Math.max(0, htmlDepth + opens - closes);
      blockquoteLines++;
      continue;
    }
    if (fm) { fence = fm[1]; fences++; continue; }
    if (MD_BLOCKQUOTE.test(line)) { blockquoteLines++; continue; }
    kept.push(line);
  }
  if (fence) unclosedFence = 1;
  return { text: kept.join('\n'), fences, blockquoteLines, unclosedFence, unclosedBlockquote: htmlDepth > 0 ? 1 : 0 };
}

// ---------------------------------------------------------------- marker grammar

// Reads `key=value` pairs and bare positional tokens. A value is a JSON array `[...]`, a quoted
// string `"..."`, or a bare token. Returns null when the text cannot be tokenised.
export function parseAttrs(raw) {
  const attrs = { _: [] };
  const s = String(raw || '');
  let i = 0;
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const readQuoted = () => {
    let v = '';
    i++; // opening quote
    while (i < s.length) {
      const c = s[i];
      if (c === '\\' && i + 1 < s.length) { v += s[i + 1]; i += 2; continue; }
      if (c === '"') { i++; return v; }
      v += c; i++;
    }
    return null; // unterminated
  };
  const readArray = () => {
    const start = i;
    let depth = 0;
    let inStr = false;
    while (i < s.length) {
      const c = s[i];
      if (inStr) {
        if (c === '\\') { i += 2; continue; }
        if (c === '"') inStr = false;
        i++; continue;
      }
      if (c === '"') inStr = true;
      else if (c === '[') depth++;
      else if (c === ']') { depth--; if (depth === 0) { i++; break; } }
      i++;
    }
    if (depth !== 0) return null;
    try { return JSON.parse(s.slice(start, i)); } catch { return null; }
  };
  // An empty bare value (`artifact=`) is deformed, not an empty string.
  const readBare = () => { const st = i; while (i < s.length && !/\s/.test(s[i])) i++; return i > st ? s.slice(st, i) : null; };
  while (true) {
    ws();
    if (i >= s.length) break;
    const keyStart = i;
    while (i < s.length && /[A-Za-z0-9_-]/.test(s[i])) i++;
    const key = s.slice(keyStart, i);
    if (s[i] === '=') {
      if (!key) return null;
      i++;
      let value;
      if (s[i] === '"') value = readQuoted();
      else if (s[i] === '[') value = readArray();
      else value = readBare();
      if (value === null) return null;
      if (Object.prototype.hasOwnProperty.call(attrs, key) && key !== '_') return null; // duplicate attr
      attrs[key] = value;
    } else {
      // A positional token: any run of non-whitespace. It is kept verbatim (a translated value such
      // as `通过` is then reported by the kind-specific validation); a `=` inside it means a key that
      // is not ASCII (`裁决=通过`), which is a deformed attribute.
      i = keyStart;
      const word = readBare();
      if (word === null || word.includes('=')) return null;
      attrs._.push(word);
    }
  }
  return attrs;
}

function looksTranslated(content) {
  const c = content.trim();
  if (/^room\s*[:：]/i.test(c) && !/^ROOM:/.test(c)) return true; // wrong case or full-width colon
  if (/^[^\x00-\x7f]+\s*[:：]/.test(c)) return true; // `<<房间:裁决>>`
  if (/^ROOM\s*：/.test(c)) return true;
  return false;
}

// Finds markers in a text that has already been stripped. Returns markers in order of appearance.
// Deformed/translated/unterminated candidates are returned with kind 'INVALID' and a `reason` so
// the resolver can mark the submission malformed instead of silently dropping them.
export function scanMarkers(text) {
  const s = String(text);
  const markers = [];
  const strayEnds = [];
  const cand = /<<([^<>\n]*)>>/g;
  let pos = 0;
  const invalid = (index, raw, reason) => markers.push({ kind: 'INVALID', attrs: { _: [] }, body: '', index, raw, reason });

  const checkUnterminated = (from, to) => {
    const seg = s.slice(from, to);
    const re = /<<ROOM:/g;
    let u;
    while ((u = re.exec(seg))) invalid(from + u.index, seg.slice(u.index, u.index + 40), 'marker_unterminated');
  };

  while (pos < s.length) {
    cand.lastIndex = pos;
    const m = cand.exec(s);
    if (!m) { checkUnterminated(pos, s.length); break; }
    checkUnterminated(pos, m.index);
    const raw = m[0];
    const content = m[1];
    const after = m.index + raw.length;
    if (!/^ROOM:/.test(content)) {
      if (looksTranslated(content)) invalid(m.index, raw, 'marker_translated');
      pos = after;
      continue;
    }
    const km = /^ROOM:([A-Za-z]+)(?:\s+([\s\S]*))?$/.exec(content);
    if (!km) { invalid(m.index, raw, 'marker_deformed'); pos = after; continue; }
    const kind = km[1];
    if (kind !== kind.toUpperCase()) { invalid(m.index, raw, 'marker_deformed'); pos = after; continue; }
    if (!MARKER_KINDS.includes(kind)) { invalid(m.index, raw, 'unknown_kind'); pos = after; continue; }
    if (kind === 'END') { strayEnds.push(m.index); pos = after; continue; }
    const attrs = parseAttrs(km[2] || '');
    if (!attrs) { invalid(m.index, raw, 'marker_deformed'); pos = after; continue; }

    let body = '';
    let next = after;
    if (END_TERMINATED.has(kind)) {
      const endIdx = s.indexOf('<<ROOM:END>>', after);
      if (endIdx === -1) { invalid(m.index, raw, 'block_unterminated'); pos = after; continue; }
      body = s.slice(after, endIdx);
      // One line break on each side is layout, not content.
      body = body.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
      next = endIdx + '<<ROOM:END>>'.length;
    } else if (TRAILING_BODY.has(kind)) {
      const re = /<<[^<>\n]*>>/g;
      re.lastIndex = after;
      const n = re.exec(s);
      // The next `<<...>>` of any shape ends the body; translated/deformed candidates are still
      // boundaries so they are reported instead of being swallowed as prose.
      const stop = n ? n.index : s.length;
      body = s.slice(after, stop).trim();
      const isEnd = n && n[0] === '<<ROOM:END>>';
      next = isEnd ? n.index + n[0].length : stop;
    }
    markers.push({ kind, attrs, body, index: m.index, raw });
    pos = next;
  }
  return { markers, strayEnds };
}

// Full pipeline for one speech body. `stripped` reports what was removed so the record can say
// "a marker was found inside a quote block" rather than "no marker".
export function parseMarkers(text, { nonce } = {}) {
  const d = stripDelimitedBlocks(text, { nonce });
  const q = stripQuoteBlocks(d.text);
  const { markers, strayEnds } = scanMarkers(q.text);
  // Count what the strip pass hid so the resolver can explain an otherwise empty result.
  const hidden = countHiddenMarkers(String(text), q.text);
  return {
    markers,
    stripped: {
      text: q.text,
      delimitedBlocks: d.blocks,
      unclosedDelimited: d.unclosed,
      foreignNonce: d.foreignNonce,
      fences: q.fences,
      blockquoteLines: q.blockquoteLines,
      unclosedFence: q.unclosedFence,
      unclosedBlockquote: q.unclosedBlockquote,
      hiddenMarkers: hidden,
      strayEnds: strayEnds.length,
    },
  };
}

function countHiddenMarkers(original, remaining) {
  const count = (t) => (t.match(/<<ROOM:[A-Z]+/g) || []).length;
  return Math.max(0, count(original) - count(remaining));
}

// ---------------------------------------------------------------- normalisation

function toInt(v) {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  return null;
}
function isArgv(v) { return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x.length > 0); }
function nonEmpty(v) { return typeof v === 'string' && v.trim().length > 0; }

// Both channels are normalised to entries {kind, source, order, ...fields} or {kind:'invalid', reason}.
function normaliseMarker(mk, order) {
  const a = mk.attrs || { _: [] };
  const base = { source: 'text', order, index: mk.index, raw: mk.raw };
  switch (mk.kind) {
    case 'INVALID': return { ...base, kind: 'invalid', reason: mk.reason };
    case 'VERDICT': {
      const value = a.verdict !== undefined ? a.verdict : a._[0];
      if (!VERDICT_VALUES.includes(value)) {
        const translated = typeof value === 'string' && /[^\x00-\x7f]/.test(value);
        return { ...base, kind: 'invalid', reason: translated ? 'marker_translated' : 'verdict_invalid' };
      }
      return { ...base, kind: 'verdict', verdict: value, artifact: nonEmpty(a.artifact) ? a.artifact : null, text: mk.body || '' };
    }
    case 'DISCLOSE': {
      if (!isArgv(a.argv)) return { ...base, kind: 'invalid', reason: 'disclose_invalid' };
      return { ...base, kind: 'disclose', argv: a.argv.slice(), reason: nonEmpty(a.reason) ? a.reason : (mk.body || '') };
    }
    case 'POINT': {
      const seq = toInt(a.seq);
      if (seq === null || !nonEmpty(mk.body)) return { ...base, kind: 'invalid', reason: 'point_invalid' };
      return { ...base, kind: 'point', seq, text: mk.body };
    }
    case 'QUOTE': {
      const seq = toInt(a.seq);
      if (seq === null || !nonEmpty(mk.body)) return { ...base, kind: 'invalid', reason: 'quote_invalid' };
      return { ...base, kind: 'quote', seq, text: mk.body };
    }
    case 'MARK': {
      const item = nonEmpty(a.item) ? a.item : null;
      if (!item || !MARK_STATUSES.includes(a.status)) return { ...base, kind: 'invalid', reason: 'mark_invalid' };
      return { ...base, kind: 'mark', item, status: a.status, text: nonEmpty(a.text) ? a.text : (mk.body || '') };
    }
    case 'MISQUOTED': {
      const seq = toInt(a.seq);
      if (seq === null) return { ...base, kind: 'invalid', reason: 'misquoted_invalid' };
      return { ...base, kind: 'misquoted', seq, text: mk.body || '' };
    }
    case 'ASSIGN': return { ...base, kind: 'assign', draft: mk.body || '' };
    case 'PASS': return { ...base, kind: 'pass' };
    default: return { ...base, kind: 'invalid', reason: 'unknown_kind' };
  }
}

function normaliseCommand(c, order) {
  const base = { source: 'command', order, submissionId: c.submissionId || null };
  const kind = c && typeof c.kind === 'string' ? c.kind : null;
  switch (kind) {
    case 'verdict': {
      if (!VERDICT_VALUES.includes(c.verdict)) return { ...base, kind: 'invalid', reason: 'verdict_invalid' };
      return { ...base, kind: 'verdict', verdict: c.verdict, artifact: nonEmpty(c.artifact) ? c.artifact : null, text: c.text || '' };
    }
    case 'disclose': {
      if (!isArgv(c.argv)) return { ...base, kind: 'invalid', reason: 'disclose_invalid' };
      return { ...base, kind: 'disclose', argv: c.argv.slice(), reason: c.reason || '' };
    }
    case 'point': {
      const seq = toInt(c.seq);
      if (seq === null || !nonEmpty(c.text)) return { ...base, kind: 'invalid', reason: 'point_invalid' };
      return { ...base, kind: 'point', seq, text: c.text };
    }
    case 'quote': {
      const seq = toInt(c.seq);
      if (seq === null || !nonEmpty(c.text)) return { ...base, kind: 'invalid', reason: 'quote_invalid' };
      return { ...base, kind: 'quote', seq, text: c.text };
    }
    case 'mark': {
      if (!nonEmpty(c.item) || !MARK_STATUSES.includes(c.status)) return { ...base, kind: 'invalid', reason: 'mark_invalid' };
      return { ...base, kind: 'mark', item: c.item, status: c.status, text: c.text || '' };
    }
    case 'misquoted': {
      const seq = toInt(c.seq);
      if (seq === null) return { ...base, kind: 'invalid', reason: 'misquoted_invalid' };
      return { ...base, kind: 'misquoted', seq, text: c.text || '' };
    }
    case 'assign': return { ...base, kind: 'assign', draft: typeof c.draft === 'string' ? c.draft : (c.text || '') };
    case 'pass': return { ...base, kind: 'pass' };
    case 'speech': case 'artifacts': return { ...base, kind, ...stripKind(c) };
    default: return { ...base, kind: 'invalid', reason: 'unknown_kind' };
  }
}
function stripKind(c) { const { kind, ...rest } = c; return rest; }

// ---------------------------------------------------------------- resolution

// Last-wins inside one channel, keyed by artifact (verdict) or item (mark); the two channels must
// agree with each other on every key they both touch, otherwise the submission is malformed.
function lastPerKey(entries, keyOf) {
  const byChannel = { command: new Map(), text: new Map() };
  for (const e of entries) byChannel[e.source].set(keyOf(e), e);
  return byChannel;
}

function mergeChannels(byChannel, equal) {
  const merged = new Map();
  const conflicts = [];
  for (const source of ['command', 'text']) {
    for (const [k, e] of byChannel[source]) {
      const prev = merged.get(k);
      if (prev && prev.source !== e.source && !equal(prev, e)) conflicts.push({ key: k, command: prev.source === 'command' ? prev : e, text: prev.source === 'text' ? prev : e });
      // The text channel is the submit body, which closes the turn, so it is "last" when both agree
      // on the key; a disagreement is already recorded as a conflict above.
      merged.set(k, e);
    }
  }
  return { merged, conflicts };
}

export function resolveSubmission({ commandSubmissions = [], textMarkers = [], required = [], discloseRequested = false } = {}) {
  const entries = [];
  let order = 0;
  for (const c of commandSubmissions) entries.push(normaliseCommand(c, order++));
  for (const m of textMarkers) entries.push(normaliseMarker(m, order++));

  const reasons = [];
  const addReason = (code, detail) => reasons.push({ code, text: REASON_TEXT[code] || code, ...(detail ? { detail } : {}) });

  for (const e of entries) if (e.kind === 'invalid') addReason(e.reason, { source: e.source, raw: e.raw, index: e.index });

  const of = (k) => entries.filter((e) => e.kind === k);

  // verdict: last per artifact per channel; channels must agree.
  const vch = lastPerKey(of('verdict'), (e) => e.artifact || '');
  const vm = mergeChannels(vch, (a, b) => a.verdict === b.verdict);
  for (const c of vm.conflicts) addReason('verdict_conflict', { artifact: c.key || null, command: c.command.verdict, text: c.text.verdict });
  // An artifact-less verdict is resolved later (by the service) to a pending artifact, possibly the
  // very one another verdict names. So an artifact-less verdict that disagrees with any
  // artifact-specific verdict of the same turn is a conflict here, in whichever channel(s) they came,
  // rather than two records for one artifact (plan §4.5: conflicting markers -> malformed).
  const unscoped = vm.merged.get('');
  if (unscoped) {
    for (const [k, e] of vm.merged) {
      if (k !== '' && e.verdict !== unscoped.verdict) addReason('verdict_conflict', { artifact: k, unscoped: unscoped.verdict, scoped: e.verdict });
    }
  }
  const verdicts =[...vm.merged.values()].map((e) => ({ verdict: e.verdict, artifact: e.artifact, text: e.text, source: e.source }));
  const lastVerdictEntry = of('verdict').reduce((acc, e) => (acc && acc.order > e.order ? acc : e), null);
  const verdictCandidate = lastVerdictEntry ? verdicts.find((v) => (v.artifact || '') === (lastVerdictEntry.artifact || '')) || null : null;

  // marks: last per item per channel; channels must agree.
  const mch = lastPerKey(of('mark'), (e) => e.item);
  const mm = mergeChannels(mch, (a, b) => a.status === b.status);
  for (const c of mm.conflicts) addReason('mark_conflict', { item: c.key, command: c.command.status, text: c.text.status });
  const marks = [...mm.merged.values()].map((e) => ({ itemId: e.item, status: e.status, text: e.text, source: e.source }));

  const disclose = of('disclose').map((e) => ({ argv: e.argv, reason: e.reason, source: e.source }));
  const points = of('point').map((e) => ({ seq: e.seq, text: e.text, source: e.source }));
  const quotes = of('quote').map((e) => ({ seq: e.seq, text: e.text, source: e.source }));
  const misquoted = of('misquoted').map((e) => ({ seq: e.seq, text: e.text, source: e.source }));
  const pass = of('pass').length > 0;

  // assign: the last draft wins; parse errors are malformed (the user still sees the draft).
  const assignEntry = of('assign').reduce((acc, e) => (acc && acc.order > e.order ? acc : e), null);
  let assign = null;
  if (assignEntry) {
    const parsed = parseAssignDraft(assignEntry.draft);
    assign = { draft: assignEntry.draft, assignments: parsed.assignments, errors: parsed.errors, source: assignEntry.source };
    if (parsed.errors.some((er) => er.fatal)) addReason('assign_unparsed', { errors: parsed.errors.filter((er) => er.fatal) });
  }

  // verdict=disclose needs a disclose request in the same turn (or one already recorded for the attempt).
  if (verdicts.some((v) => v.verdict === 'disclose') && disclose.length === 0 && !discloseRequested) addReason('disclose_missing');

  // pass means "nothing to add": any substantive structured submission beside it is a contradiction.
  const substantive = verdicts.length + marks.length + disclose.length + points.length + quotes.length + misquoted.length + (assign ? 1 : 0);
  if (pass && substantive > 0) addReason('pass_conflict');

  // required kinds: a pass never satisfies a required verdict.
  for (const r of required) {
    const present = r === 'verdict' ? verdicts.length > 0 : r === 'pass' ? pass : r === 'assign' ? !!assign : of(r).length > 0;
    if (!present) addReason(r === 'verdict' ? 'verdict_missing' : 'required_missing', { required: r });
  }

  const malformed = reasons.length > 0;
  return {
    // When malformed the verdict is withheld entirely: the service records `none`, never a default.
    verdict: malformed ? null : verdictCandidate,
    verdicts: malformed ? [] : verdicts,
    disclose, points, quotes, marks, misquoted, pass, assign,
    annotation: malformed ? 'malformed' : 'none',
    reason: malformed ? reasons[0].code : null,
    reasons,
    candidates: { verdict: verdictCandidate, verdicts },
  };
}

// Second conflict check, for after the caller has resolved each verdict's artifact (an artifact-less
// verdict becomes the single pending sha). Groups by resolved artifact: one sha with two different
// values is a conflict and none of that sha's verdicts is kept; identical duplicates collapse to the
// later one. `verdicts` keep their order otherwise. The caller turns any conflict into reason
// {code:'verdict_conflict', text: REASON_TEXT.verdict_conflict, detail:{artifact}} so the turn goes
// malformed -> ask once -> none, never a recorded pass beside a reject.
export function checkResolvedVerdicts(verdicts = []) {
  const bySha = new Map();
  for (const v of verdicts) {
    const k = v && v.artifact ? v.artifact : '';
    if (!bySha.has(k)) bySha.set(k, []);
    bySha.get(k).push(v);
  }
  const conflicts = [];
  const bad = new Set();
  for (const [k, list] of bySha) {
    const values = [...new Set(list.map((v) => v.verdict))];
    if (values.length > 1) { conflicts.push({ artifact: k || null, verdicts: values }); bad.add(k); }
  }
  const out = [];
  for (const [k, list] of bySha) if (!bad.has(k)) out.push(list[list.length - 1]);
  // Preserve first-appearance order of the kept artifacts.
  return { verdicts: out, conflicts };
}

// The one follow-up the service may send for a malformed submission (plan §4.5: ask once).
// `resubmit` is the line naming how to resubmit: the service passes surfaceLine(seatSurface(seat),
// 'resubmit') (lib/surface.mjs), and undefined means the CLI line.
const RESUBMIT_CLI = '请只用原样 ASCII 标记或 room 子命令重新提交；标记示例：<<ROOM:VERDICT pass artifact=<manifestSha>>>、<<ROOM:PASS>>。';
export function malformedFollowUp({ reasons = [], attemptId, retriesLeft = MALFORMED_RETRIES, resubmit = RESUBMIT_CLI } = {}) {
  const lines = [];
  lines.push(`结构化提交无法解析（attempt=${attemptId || '-'}），本回合追问一次。`);
  for (const r of reasons) lines.push(`- ${r.code}：${r.text || REASON_TEXT[r.code] || ''}`);
  lines.push(resubmit);
  lines.push(retriesLeft > 0
    ? `还可以更正 ${retriesLeft} 次；再次失败将按 verdict=none 交给用户处理，房间不会默认记为 pass。`
    : '追问次数已用完；本回合 verdict 记为 none，交给用户处理，房间不会默认记为 pass。');
  return lines.join('\n');
}

// ---------------------------------------------------------------- item table (plan §5.4)

function isSeatMessage(m) {
  if (!m || typeof m !== 'object') return false;
  if (m.authority && m.authority !== 'none') return false;
  if (m.seatId === 'user' || m.seatId === 'room') return false;
  return Number.isInteger(m.seq) && typeof m.seatId === 'string';
}

export function pointItemId(seq, n) { return `m${seq}p${n}`; }
export function messageItemId(seq) { return `m${seq}`; }

// One item per point; a message that has no points is one item on its own (plan §5.4). Only the
// message's own author can split it into points: a point another seat files about that message (a
// response, or a lead paraphrasing an objection in its summary turn) is an extra item with
// `foreign: true` and `respondsTo: seq`, and never replaces the author's item, so an objection cannot
// be dropped from the table by someone else rewording it. A point without a seatId cannot prove
// authorship and counts as foreign. Points about a seq that is not in `messages` still become items
// (the point was accepted; the referenced message may have been dropped from this packet by the
// budget rule), with `orphan: true`. A point without an itemId is numbered by its position among all
// points about that seq, in filing order, so ids do not depend on who filed them.
export function buildItemTable(messages = [], points = []) {
  const bySeq = new Map();
  for (const p of points) {
    const seq = toInt(p.aboutSeq !== undefined ? p.aboutSeq : p.seq);
    if (seq === null) continue;
    if (!bySeq.has(seq)) bySeq.set(seq, []);
    bySeq.get(seq).push({ p, itemId: p.itemId || pointItemId(seq, bySeq.get(seq).length + 1) });
  }
  const pointItem = (e, seq, seatId, extra) => ({ itemId: e.itemId, seq, seatId, text: e.p.text || '', status: 'open', markedBy: null, markText: '', kind: 'point', ...extra });
  const items = [];
  const seen = new Set();
  const seatMessages = messages.filter(isSeatMessage).slice().sort((a, b) => a.seq - b.seq);
  for (const m of seatMessages) {
    seen.add(m.seq);
    const ps = bySeq.get(m.seq) || [];
    const own = ps.filter((e) => e.p.seatId === m.seatId);
    const others = ps.filter((e) => e.p.seatId !== m.seatId);
    if (own.length === 0) items.push({ itemId: messageItemId(m.seq), seq: m.seq, seatId: m.seatId, text: m.text || '', status: 'open', markedBy: null, markText: '', kind: 'message' });
    else for (const e of own) items.push(pointItem(e, m.seq, m.seatId));
    for (const e of others) items.push(pointItem(e, m.seq, e.p.seatId || null, { foreign: true, respondsTo: m.seq }));
  }
  const orphanSeqs = [...bySeq.keys()].filter((s) => !seen.has(s)).sort((a, b) => a - b);
  for (const seq of orphanSeqs) {
    for (const e of bySeq.get(seq)) items.push(pointItem(e, seq, e.p.seatId || null, { orphan: true }));
  }
  return items;
}

// Returns a new table; items are never mutated. Marks for unknown ids are ignored here and listed by
// `unknownMarks` so the service can reject them in the reply.
export function applyMarks(items = [], marks = []) {
  const byId = new Map(items.map((it) => [it.itemId, { ...it }]));
  for (const mk of marks) {
    const it = byId.get(mk.itemId || mk.item);
    if (!it || !MARK_STATUSES.includes(mk.status)) continue;
    it.status = mk.status;
    it.markedBy = mk.by || mk.markedBy || mk.seatId || null;
    it.markText = mk.text || '';
  }
  return items.map((it) => byId.get(it.itemId));
}

export function unknownMarks(items = [], marks = []) {
  const ids = new Set(items.map((it) => it.itemId));
  return marks.filter((mk) => !ids.has(mk.itemId || mk.item)).map((mk) => mk.itemId || mk.item);
}

export function unanswered(items = []) {
  return items.filter((it) => it.status === 'open').map((it) => it.itemId);
}

// Markdown for the summary-round packet. ASCII status words stay; labels are Chinese.
export function renderItemTable(items = []) {
  const label = { open: '未回应', accepted: '已接受', rejected: '已驳回', deferred: '已搁置' };
  const lines = ['| 条目 | 消息 | 席位 | 状态 | 内容 |', '|---|---|---|---|---|'];
  for (const it of items) {
    const text = String(it.text || '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').slice(0, 200);
    const status = it.status === 'open' ? `**${label.open}** (open)` : `${label[it.status] || it.status} (${it.status})`;
    lines.push(`| ${it.itemId} | seq=${it.seq} | ${it.seatId || '-'} | ${status} | ${text} |`);
  }
  if (items.length === 0) lines.push('| - | - | - | - | （没有待回应条目） |');
  return lines.join('\n');
}

// ---------------------------------------------------------------- quotes (plan §7.4)

// Exact substring of the referenced message. Whitespace-normalised matches are reported as a hint
// (`whitespace_only`) but are still `verified: false`.
export function verifyQuote({ seq, text } = {}, messages = []) {
  const s = toInt(seq);
  if (s === null) return { verified: false, reason: 'seq_invalid', seq: null };
  if (typeof text !== 'string' || text.length === 0) return { verified: false, reason: 'empty_quote', seq: s };
  const msg = messages.find((m) => m && m.seq === s);
  if (!msg) return { verified: false, reason: 'seq_not_found', seq: s };
  // A speech superseded by an interrupt (round_reopened) or voided is no longer in the public
  // record: quoting it is flagged even when the fragment is verbatim (plan §6.4, #29).
  if (msg.superseded || msg.voided) return { verified: false, reason: 'superseded', seq: s, seatId: msg.seatId };
  const src = String(msg.text || '');
  const at = src.indexOf(text);
  if (at !== -1) return { verified: true, reason: 'ok', seq: s, seatId: msg.seatId, offset: at };
  const norm = (t) => t.replace(/\s+/g, ' ').trim();
  if (norm(src).includes(norm(text))) return { verified: false, reason: 'whitespace_only', seq: s, seatId: msg.seatId };
  return { verified: false, reason: 'not_verbatim', seq: s, seatId: msg.seatId };
}

// ---------------------------------------------------------------- summary versions (plan §5.4)

export function currentVersion(state) {
  if (state === null || state === undefined) return 0;
  if (typeof state === 'number') return Number.isInteger(state) && state >= 0 ? state : 0;
  if (typeof state === 'object') {
    if (Number.isInteger(state.summaryVersion)) return state.summaryVersion;
    if (state.summary && Number.isInteger(state.summary.version)) return state.summary.version;
    if (Array.isArray(state.summaries)) return state.summaries.reduce((mx, s) => Math.max(mx, Number.isInteger(s.version) ? s.version : 0), 0);
  }
  return 0;
}

export function nextVersion(state) { return currentVersion(state) + 1; }

// The notice the room attaches to a seat's next packet after a newer summary was delivered.
export function supersededNotice({ forSeat, oldVersion, newVersion, publishedBy, changed } = {}) {
  const lines = [];
  lines.push(`取代通知：你之前收到的汇总 v${oldVersion} 已被 v${newVersion} 取代${publishedBy ? `（由席位 ${publishedBy} 发布）` : ''}。`);
  lines.push(`席位 ${forSeat || '-'}：请以本包内的汇总 v${newVersion} 为准，不要再引用或依据 v${oldVersion} 的结论。`);
  if (Array.isArray(changed) && changed.length > 0) {
    lines.push('变更要点：');
    for (const c of changed) lines.push(`- ${c}`);
  }
  lines.push('本通知由房间生成，不是用户指令，不含任何授权。');
  return lines.join('\n');
}

// ---------------------------------------------------------------- assign drafts

// Draft lines: `- <seatId>: <text> | 验收: <json argv>`. The argv is one JSON array of strings or an
// array of such arrays. Full-width colons are accepted (user-facing Chinese), seat ids and argv are
// ASCII. Non-list lines (headings, blanks, prose) are ignored; list lines that do not parse are errors.
export function parseAssignDraft(markdown) {
  const assignments = [];
  const errors = [];
  const lines = String(markdown || '').split('\n');
  const seen = new Set();
  const err = (lineNo, line, code, message, fatal = true) => errors.push({ lineNo, line, code, message, fatal });
  lines.forEach((rawLine, i) => {
    const lineNo = i + 1;
    const line = rawLine.replace(/\r$/, '');
    const lm = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (!lm) return;
    const item = lm[1];
    const sm = /^([A-Za-z0-9_-]+)\s*[:：]\s*(.*)$/.exec(item);
    if (!sm) { err(lineNo, line, 'line_unparsed', '无法识别席位 id，格式应为「- <seatId>: <任务> | 验收: <argv JSON>」'); return; }
    const seatId = sm[1];
    const rest = sm[2];
    const am = /^(.*?)\s*\|\s*验收\s*[:：]\s*(.*)$/.exec(rest);
    let text = rest.trim();
    const acceptance = [];
    if (am) {
      text = am[1].trim();
      let parsed;
      try { parsed = JSON.parse(am[2].trim()); } catch { err(lineNo, line, 'acceptance_invalid_json', '验收命令不是合法的 JSON 数组'); return; }
      const argvs = Array.isArray(parsed) && parsed.every(Array.isArray) ? parsed : [parsed];
      for (const argv of argvs) {
        if (!isArgv(argv)) { err(lineNo, line, 'acceptance_invalid_argv', '验收命令必须是非空的字符串数组，例如 ["node","--test","x.test.mjs"]'); return; }
        acceptance.push(argv.slice());
      }
    } else {
      err(lineNo, line, 'acceptance_missing', '没有验收命令；该任务将没有自动加入白名单的验收命令', false);
    }
    if (!text) { err(lineNo, line, 'text_missing', '任务描述为空'); return; }
    if (seen.has(seatId)) { err(lineNo, line, 'duplicate_seat', `席位 ${seatId} 出现了多次`); return; }
    seen.add(seatId);
    assignments.push({ seatId, text, acceptance });
  });
  if (assignments.length === 0 && !errors.some((e) => e.fatal)) err(0, '', 'empty_draft', '草案里没有任何分派行');
  return { assignments, errors };
}
