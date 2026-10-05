// Packet budget (plan §7.6, INTERFACES §6): a deterministic, room-side rule at whole-message
// granularity. Pinned messages (the current round's speeches, anything quoted, the current summary)
// are never dropped; everything else goes oldest first until the budget fits. Dropped seqs are
// reported as closed ranges so the manifest and the packet can say exactly what is missing.
// Pure functions only: nothing here touches the disk or the clock.

function defaultSizeOf(m) {
  return Buffer.byteLength(String(m && m.text != null ? m.text : ''), 'utf8');
}

function seqOf(m) {
  const n = Number(m && m.seq);
  return Number.isFinite(n) ? n : 0;
}

// Collapse a list of dropped positions into [{fromSeq,toSeq}] ranges. Two dropped messages join
// one range only when they are adjacent in the ordered list, so a kept message between them always
// splits the range (a range therefore never hides a message that is actually in the packet).
function rangesOf(ordered, droppedIdx) {
  const ranges = [];
  let lastIdx = -2;
  for (let i = 0; i < ordered.length; i++) {
    if (!droppedIdx.has(i)) continue;
    const seq = seqOf(ordered[i]);
    if (i === lastIdx + 1 && ranges.length) ranges[ranges.length - 1].toSeq = seq;
    else ranges.push({ fromSeq: seq, toSeq: seq });
    lastIdx = i;
  }
  return ranges;
}

// trimMessages({messages, pinnedSeqs, maxBytes, sizeOf}) -> {kept, dropped, bytes, overBudget}
//   messages   : [{seq, text, ...}] in any order; the input array and its items are not mutated.
//   pinnedSeqs : iterable of seqs that must stay (see computePins).
//   maxBytes   : budget for the sum of sizeOf(message); null/undefined/Infinity = no budget.
//   sizeOf     : optional (message) => bytes; defaults to UTF-8 length of message.text.
// kept keeps ascending seq order. overBudget is true when pins alone exceed the budget.
export function trimMessages({ messages = [], pinnedSeqs = [], maxBytes, sizeOf } = {}) {
  const size = typeof sizeOf === 'function' ? sizeOf : defaultSizeOf;
  const pins = new Set(Array.from(pinnedSeqs || [], (s) => Number(s)));
  const ordered = [...messages].sort((a, b) => seqOf(a) - seqOf(b));
  const sizes = ordered.map((m) => Math.max(0, Number(size(m)) || 0));
  let total = sizes.reduce((a, b) => a + b, 0);
  const limit = maxBytes == null ? Infinity : Number(maxBytes);
  const droppedIdx = new Set();
  if (Number.isFinite(limit) && total > limit) {
    for (let i = 0; i < ordered.length && total > limit; i++) {
      if (pins.has(seqOf(ordered[i]))) continue;
      droppedIdx.add(i);
      total -= sizes[i];
    }
  }
  const kept = ordered.filter((_, i) => !droppedIdx.has(i));
  return { kept, dropped: rangesOf(ordered, droppedIdx), bytes: total, overBudget: Number.isFinite(limit) && total > limit };
}

// What §7.6 pins: every message of the current round, every message something quotes, and the
// current summary. Messages carry `roundId` once the service records it; a message without a
// roundId cannot be matched to the round and is not pinned by that rule (quotes still pin it).
//   quotes on a message may be [seq, ...] or [{seq}, ...].
export function computePins({ messages = [], roundId = null, quotedSeqs = [], summarySeq = null, extra = [] } = {}) {
  const pins = new Set();
  for (const m of messages) {
    if (roundId != null && m && m.roundId != null && Number(m.roundId) === Number(roundId)) pins.add(seqOf(m));
    const quotes = Array.isArray(m && m.quotes) ? m.quotes : [];
    for (const q of quotes) {
      const s = typeof q === 'object' && q !== null ? Number(q.seq) : Number(q);
      if (Number.isFinite(s)) pins.add(s);
    }
  }
  for (const s of quotedSeqs || []) if (Number.isFinite(Number(s))) pins.add(Number(s));
  if (summarySeq != null && Number.isFinite(Number(summarySeq))) pins.add(Number(summarySeq));
  for (const s of extra || []) if (Number.isFinite(Number(s))) pins.add(Number(s));
  return pins;
}

// Merge two dropped-range lists (e.g. ranges a caller already applied plus ranges the renderer
// added). Overlapping or touching ranges collapse; output is sorted by fromSeq.
export function mergeDropped(a = [], b = []) {
  const all = [...(a || []), ...(b || [])]
    .filter((r) => r && Number.isFinite(Number(r.fromSeq)) && Number.isFinite(Number(r.toSeq)))
    .map((r) => ({ fromSeq: Math.min(Number(r.fromSeq), Number(r.toSeq)), toSeq: Math.max(Number(r.fromSeq), Number(r.toSeq)) }))
    .sort((x, y) => x.fromSeq - y.fromSeq || x.toSeq - y.toSeq);
  const out = [];
  for (const r of all) {
    const last = out[out.length - 1];
    if (last && r.fromSeq <= last.toSeq + 1) last.toSeq = Math.max(last.toSeq, r.toSeq);
    else out.push({ ...r });
  }
  return out;
}

export function sumBytes(messages = [], sizeOf) {
  const size = typeof sizeOf === 'function' ? sizeOf : defaultSizeOf;
  let t = 0;
  for (const m of messages) t += Math.max(0, Number(size(m)) || 0);
  return t;
}

// User-facing one-liner for a dropped list (Chinese), e.g. "seq 2–5、seq 9".
export function describeDropped(dropped = []) {
  if (!dropped || dropped.length === 0) return '';
  return dropped.map((r) => (r.fromSeq === r.toSeq ? `seq ${r.fromSeq}` : `seq ${r.fromSeq}–${r.toSeq}`)).join('、');
}
