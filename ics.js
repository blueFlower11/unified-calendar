// Minimal, dependency-free iCalendar (.ics) parser with basic recurrence support.
// Handles: line unfolding, VEVENT, DTSTART/DTEND (UTC, floating, TZID, all-day),
// SUMMARY/LOCATION/DESCRIPTION, RRULE (DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL,
// COUNT, UNTIL, BYDAY, BYMONTHDAY), EXDATE, RECURRENCE-ID overrides.

function unfold(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '');
}

function unescapeText(s) {
  return (s || '').replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

function parseLine(line) {
  const idx = line.indexOf(':');
  if (idx < 0) return null;
  const head = line.slice(0, idx);
  const value = line.slice(idx + 1);
  const parts = head.split(';');
  const name = parts[0].toUpperCase();
  const params = {};
  for (const p of parts.slice(1)) {
    const [k, v] = p.split('=');
    if (k) params[k.toUpperCase()] = (v || '').replace(/^"|"$/g, '');
  }
  return { name, params, value };
}

// Offset (ms) of a named time zone at a given UTC instant.
function tzOffsetMs(tz, utcMs) {
  try {
    const f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map(x => [x.type, x.value]));
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    return asUtc - Math.floor(utcMs / 1000) * 1000;
  } catch { return 0; }
}

function wallToUtc(tz, wall) {
  let guess = wall - tzOffsetMs(tz, wall);
  guess = wall - tzOffsetMs(tz, guess);
  return guess;
}

// Returns { ms, allDay } for an iCal date/date-time value.
function parseDate(value, params, defaultTz) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (h === undefined) {
    // all-day: keep as local-midnight in the viewer's zone later; store as UTC midnight marker
    return { ms: Date.UTC(+y, +mo - 1, +d), allDay: true };
  }
  const wall = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  if (z) return { ms: wall, allDay: false };
  const tz = params.TZID || defaultTz;
  if (tz) {
    // Convert wall-clock in tz to UTC (two-pass for DST edges).
    return { ms: wallToUtc(tz, wall), allDay: false, tz, wall };
  }
  return { ms: wall, allDay: false }; // floating, treated as UTC
}

function parseDuration(v) {
  const m = /^(-)?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v);
  if (!m) return 0;
  const sign = m[1] ? -1 : 1;
  return sign * (((+m[2] || 0) * 7 + (+m[3] || 0)) * 86400 + (+m[4] || 0) * 3600 + (+m[5] || 0) * 60 + (+m[6] || 0)) * 1000;
}

function parseRRule(v) {
  const r = {};
  for (const part of v.split(';')) {
    const [k, val] = part.split('=');
    r[k.toUpperCase()] = val;
  }
  return r;
}

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function parseICS(text, opts = {}) {
  const lines = unfold(text).split('\n');
  const calTz = (lines.map(parseLine).find(l => l && l.name === 'X-WR-TIMEZONE') || {}).value;
  const events = [];
  let cur = null;
  for (const raw of lines) {
    if (raw === 'BEGIN:VEVENT') { cur = { props: [] }; continue; }
    if (raw === 'END:VEVENT') {
      if (cur) {
        const ev = buildEvent(cur.props, calTz || opts.defaultTz);
        if (ev) events.push(ev);
      }
      cur = null; continue;
    }
    if (cur) { const l = parseLine(raw); if (l) cur.props.push(l); }
  }
  return events;
}

function buildEvent(props, defaultTz) {
  const get = n => props.find(p => p.name === n);
  const all = n => props.filter(p => p.name === n);
  const ds = get('DTSTART');
  if (!ds) return null;
  const start = parseDate(ds.value, ds.params, defaultTz);
  if (!start) return null;
  let end;
  const de = get('DTEND');
  const dur = get('DURATION');
  if (de) end = parseDate(de.value, de.params, defaultTz);
  else if (dur) end = { ms: start.ms + parseDuration(dur.value), allDay: start.allDay };
  else end = { ms: start.ms + (start.allDay ? 86400000 : 0), allDay: start.allDay };
  if (!end) end = start;
  const status = (get('STATUS') || {}).value;
  const ex = [];
  for (const e of all('EXDATE')) for (const v of e.value.split(',')) {
    const d = parseDate(v, e.params, defaultTz); if (d) ex.push(d.ms);
  }
  const rid = get('RECURRENCE-ID');
  return {
    uid: (get('UID') || {}).value || `${start.ms}-${(get('SUMMARY') || {}).value}`,
    title: unescapeText((get('SUMMARY') || {}).value) || '(no title)',
    location: unescapeText((get('LOCATION') || {}).value),
    description: unescapeText((get('DESCRIPTION') || {}).value),
    start: start.ms,
    end: end.ms,
    tz: start.tz || null,
    wall: start.wall !== undefined ? start.wall : null,
    allDay: start.allDay,
    cancelled: status === 'CANCELLED',
    rrule: get('RRULE') ? parseRRule(get('RRULE').value) : null,
    exdates: ex,
    recurrenceId: rid ? (parseDate(rid.value, rid.params, defaultTz) || {}).ms : null,
  };
}

// Expand events into concrete occurrences inside [fromMs, toMs).
function expand(events, fromMs, toMs) {
  const out = [];
  const overrides = new Map();
  for (const e of events) if (e.recurrenceId != null) overrides.set(`${e.uid}|${e.recurrenceId}`, e);
  const push = (e, start, end) => {
    if (e.cancelled) return;
    if (end <= fromMs || start >= toMs) return;
    out.push({ uid: e.uid, title: e.title, location: e.location, description: e.description, start, end, allDay: e.allDay });
  };
  for (const e of events) {
    if (e.recurrenceId != null) { push(e, e.start, e.end); continue; }
    if (!e.rrule) { push(e, e.start, e.end); continue; }
    const length = e.end - e.start;
    const src = e.tz ? { ...e, start: e.wall } : e;
    const hardEnd = e.tz ? toMs + 86400000 * 2 : toMs;
    for (const gen of occurrences(src, hardEnd)) {
      const startMs = e.tz ? wallToUtc(e.tz, gen) : gen;
      if (e.exdates.includes(startMs)) continue;
      const ov = overrides.get(`${e.uid}|${startMs}`);
      if (ov) continue; // override is emitted on its own
      push(e, startMs, startMs + length);
    }
  }
  return out;
}

function* occurrences(e, hardEnd) {
  const r = e.rrule;
  const freq = r.FREQ;
  const interval = Math.max(1, parseInt(r.INTERVAL || '1', 10));
  const count = r.COUNT ? parseInt(r.COUNT, 10) : Infinity;
  const until = r.UNTIL ? (parseDate(r.UNTIL, {}, null) || {}).ms : Infinity;
  const limit = Math.min(until === undefined ? Infinity : until + 86400000, hardEnd);
  const s = new Date(e.start);
  const dayMs = 86400000;
  let emitted = 0;
  const byday = r.BYDAY ? r.BYDAY.split(',').map(x => x.replace(/^[+-]?\d+/, '')) : null;
  const bymonthday = r.BYMONTHDAY ? r.BYMONTHDAY.split(',').map(Number) : null;

  if (freq === 'DAILY') {
    for (let i = 0; ; i += interval) {
      const t = e.start + i * dayMs;
      if (t >= limit || emitted >= count) return;
      emitted++; yield t;
    }
  } else if (freq === 'WEEKLY') {
    const days = byday ? byday.map(d => DAYS.indexOf(d)).filter(i => i >= 0) : [s.getUTCDay()];
    const weekStart = e.start - s.getUTCDay() * dayMs; // Sunday of first week (same time of day)
    for (let w = 0; ; w += interval) {
      for (const d of [...days].sort((a, b) => a - b)) {
        const t = weekStart + (w * 7 + d) * dayMs;
        if (t < e.start) continue;
        if (t >= limit || emitted >= count) return;
        emitted++; yield t;
      }
      if (weekStart + w * 7 * dayMs > limit) return;
    }
  } else if (freq === 'MONTHLY') {
    for (let m = 0; ; m += interval) {
      const base = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + m, 1, s.getUTCHours(), s.getUTCMinutes(), s.getUTCSeconds()));
      if (base.getTime() >= limit) return;
      const dim = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
      const cands = [];
      if (r.BYDAY && /\d/.test(r.BYDAY)) {
        for (const tok of r.BYDAY.split(',')) {
          const mm = /^([+-]?\d+)(\w\w)$/.exec(tok); if (!mm) continue;
          const n = +mm[1], dow = DAYS.indexOf(mm[2]);
          const dates = [];
          for (let d = 1; d <= dim; d++) if (new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), d)).getUTCDay() === dow) dates.push(d);
          const pick = n > 0 ? dates[n - 1] : dates[dates.length + n];
          if (pick) cands.push(pick);
        }
      } else if (byday) {
        for (let d = 1; d <= dim; d++) if (byday.includes(DAYS[new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), d)).getUTCDay()])) cands.push(d);
      } else if (bymonthday) {
        for (const d of bymonthday) cands.push(d > 0 ? d : dim + d + 1);
      } else cands.push(s.getUTCDate());
      for (const d of cands.sort((a, b) => a - b)) {
        if (d > dim) continue;
        const t = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), d, s.getUTCHours(), s.getUTCMinutes(), s.getUTCSeconds());
        if (t < e.start) continue;
        if (t >= limit || emitted >= count) return;
        emitted++; yield t;
      }
    }
  } else if (freq === 'YEARLY') {
    for (let y = 0; ; y += interval) {
      const t = Date.UTC(s.getUTCFullYear() + y, s.getUTCMonth(), s.getUTCDate(), s.getUTCHours(), s.getUTCMinutes(), s.getUTCSeconds());
      if (t >= limit || emitted >= count) return;
      emitted++; yield t;
    }
  }
}

module.exports = { parseICS, expand };
